import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {getDb} from '../src/main/db/database'
import {runMigrations} from '../src/main/db/migrations'
import * as tasks from '../src/main/db/taskDao'
import * as planning from '../src/main/planning/service'
import * as statistics from '../src/main/statistics/service'
import * as feedback from '../src/main/feedback/service'
import {withAudit,validatePlanAudit} from '../src/main/statistics/ledger'
import {at,dateKey} from '../src/main/planning/engine'
import {executeTool} from '../src/main/agent/tools'
import {startBatch,confirmTaskDraft,drive,confirmChange} from '../src/main/agent/runner'
import * as drafts from '../src/main/drafts/service'
import * as store from '../src/main/agent/store'
import type {ModelMessage} from '../src/main/agent/model'
type Test=(name:string,fn:()=>unknown|Promise<unknown>)=>Promise<void>
export async function statisticsTests(test:Test):Promise<void>{
  const db=getDb(),date='2030-01-07',next='2030-01-08',now=at(date,420),later=at(date,1080),ownIds:number[]=[]
  const enabled=statistics.enabledAt()
  const config={startMin:480,endMin:1200,dailyMaxMin:600,breakMin:0}
  function reset():void{
    db.exec('DELETE FROM day_plan_items; DELETE FROM day_plan_snapshots; DELETE FROM task_events; DELETE FROM task_dependencies; DELETE FROM plan_blocks; DELETE FROM calendar_exceptions; DELETE FROM calendar_courses; DELETE FROM day_overrides; DELETE FROM plan_previews;')
    for(const id of ownIds){db.prepare('UPDATE completion_events SET stats_valid=0 WHERE task_id=?').run(id);tasks.deleteTask(id)}
    db.prepare('UPDATE statistics_meta SET enabled_at=? WHERE id=1').run(enabled);planning.saveSettings(config)
  }
  function task(name:string,duration=60,source:'user'|'model'='user'):number{
    const t=tasks.createTask({content:`S6-${name}`});ownIds.push(t.id)
    tasks.applyAnalysis(t.id,{summary:t.content,importance:3,urgency:3,category:'学习',tags:[],estimateMin:duration,dueAt:null},source==='model'?'ok':'none')
    tasks.updateTask({id:t.id,deadlineAt:null,estimateGroup:'S6-同类',...(source==='user'?{estimateMin:duration}:{})});return t.id
  }
  function plan(ids:number[],day=date,time=now,startMin?:number):string{const p=planning.preview(ids,day,day,null,time,startMin===undefined?undefined:{startMin});planning.commit(p.id,null,time);return p.id}
  function complete(id:number,time=at(date,600)):string{tasks.completeTask(id,true,time);return feedback.completionForTask(id)!.event.id}
  function sample(id:string,actualMin:number|null,interrupted=false,scopeChanged=false):void{feedback.submitFeedback({eventId:id,actualMin,difficulty:'fit',interrupted,scopeChanged,note:''})}
  const report=()=>statistics.readStatistics(date,later)
  await test('v10升级不伪造历史完成/事件，迁移重复执行保持基线数据',()=>{
    const old=new Database(':memory:');runMigrations(old)
    old.exec('DROP TRIGGER task_event_created; DROP TRIGGER task_event_updated; DROP TABLE day_plan_items; DROP TABLE day_plan_snapshots; DROP TABLE task_events; DROP TABLE audit_context; DROP TABLE statistics_meta;')
    // 模拟v10：移除新增列，保留一条真实旧完成事件。
    for(const column of ['stats_tracked','stats_valid','stats_day','stats_timezone','deadline_at','deadline_confirmed'])old.exec(`ALTER TABLE completion_events DROP COLUMN ${column}`)
    old.exec("INSERT INTO tasks(id,content,status,created_at,updated_at) VALUES(1,'legacy','done','2026-01-01','2026-01-01'); INSERT INTO completion_events(id,task_id,cycle,title,group_key,estimate_source,base_min,planned_min,had_plan,created_at) VALUES('old',1,1,'legacy','旧','user',30,30,0,'2026-01-01'); PRAGMA user_version=10")
    runMigrations(old);runMigrations(old);assert.equal(old.pragma('user_version',{simple:true}),11)
    assert.equal((old.prepare('SELECT COUNT(*) AS n FROM task_events').get() as {n:number}).n,0)
    assert.equal((old.prepare('SELECT stats_tracked FROM completion_events WHERE id=?').get('old') as {stats_tracked:number}).stats_tracked,0);old.close()
  })
  await test('创建/分析/人工修改按来源记账，无变化不产生重复事件',()=>{
    reset();const id=task('来源');const rows=db.prepare('SELECT kind,actor,source,before_json,after_json FROM task_events WHERE task_id=? ORDER BY id').all(id) as {kind:string;actor:string;source:string;before_json:string;after_json:string}[]
    assert.equal(rows[0].kind,'created');assert.equal(rows[0].source,'manual');assert.ok(rows.some(r=>r.actor==='system'&&r.source==='analyzer'))
    tasks.updateTask({id,importance:4},'agent');const last=db.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 1').get(id) as {source:string;actor:string;before_json:string;after_json:string}
    assert.equal(last.source,'agent_confirmed');assert.equal(last.actor,'user');assert.equal(JSON.parse(last.before_json).importance,3);assert.equal(JSON.parse(last.after_json).importance,4)
    const count=(db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as {n:number}).n;tasks.updateTask({id,importance:4});assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as {n:number}).n,count)
  })
  await test('草案确认只创建一次事项及创建事件，来源指向原草案',()=>{
    reset();const run=startBatch('S6-草案'),d=drafts.getDraft(run.draftId!);confirmTaskDraft(d.id,d.version,true);const ids=drafts.getDraft(d.id).createdTaskIds;ownIds.push(...ids);confirmTaskDraft(d.id,d.version,true)
    const rows=db.prepare("SELECT source,source_ref FROM task_events WHERE task_id=? AND kind='created'").all(ids[0]) as {source:string;source_ref:string}[]
    assert.equal(rows.length,1);assert.equal(rows[0].source,'draft_confirmed');assert.equal(rows[0].source_ref,`draft:${d.id}`)
  })
  await test('任务账本写失败会回滚创建与修改，来源上下文不会泄漏',()=>{
    reset();const id=task('回滚');db.exec("CREATE TRIGGER reject_stats_ledger BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'ledger rollback'); END")
    try{const count=tasks.listTasks().length;assert.throws(()=>tasks.createTask({content:'不会保留'}),/rollback/);assert.equal(tasks.listTasks().length,count);assert.throws(()=>tasks.updateTask({id,importance:5}),/rollback/);assert.equal(tasks.getTaskById(id)!.importance,3)}finally{db.exec('DROP TRIGGER reject_stats_ledger')}
    const context=db.prepare('SELECT actor,source FROM audit_context').get() as {actor:string;source:string};assert.equal(context.actor,'system');assert.equal(context.source,'system')
    assert.throws(()=>withAudit({actor:'user',source:'manual'},()=>{throw new Error('test')}));assert.deepEqual(db.prepare('SELECT actor,source FROM audit_context').get(),context)
  })
  await test('首次确认冻结日期基线，重复提交不重复计划事件或分母',()=>{
    reset();const a=task('初始A'),b=task('初始B'),id=plan([a,b]);const f=statistics.frozenPlan(date,later)!
    assert.equal(f.denominator,2);assert.equal(f.method,'first_plan_confirmation');const count=(db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE kind='plan_created'").get() as {n:number}).n
    planning.commit(id,null,now);assert.equal(statistics.frozenPlan(date,later)!.denominator,2);assert.equal((db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE kind='plan_created'").get() as {n:number}).n,count)
  })
  await test('后加任务单列，完成非基线任务不扩大分母也不冒充原计划完成',()=>{
    reset();const a=task('基线'),b=task('后加');plan([a]);plan([b],date,now+60000);complete(b)
    const r=report();assert.equal(r.completedTasks,1);assert.equal(r.currentBaseline!.denominator,1);assert.equal(r.currentBaseline!.completed,0);assert.deepEqual(r.currentBaseline!.addedTaskIds,[b])
  })
  await test('移出或归档不缩冻结分母，完成归档任务保留统计事实',()=>{
    reset();const a=task('移出'),b=task('完成归档'),c=task('未完成归档');plan([a,b,c]);complete(b)
    const p=planning.preview([a],next,next,null,now+60000);planning.commit(p.id,null,now+60000,{reason:'user_postpone',note:'主动改到明天'})
    tasks.deleteTask(b);tasks.deleteTask(c);const r=report(),f=r.currentBaseline!
    assert.equal(f.denominator,3);assert.equal(f.completed,1);assert.equal(f.rate,1/3);assert.equal(f.items.find(i=>i.taskId===a)!.state,'moved_out');assert.equal(f.items.find(i=>i.taskId===c)!.state,'archived');assert.equal(r.completedTasks,1)
  })
  await test('重复完成只计一次，撤销后修正，重做不重复累计',()=>{
    reset();const id=task('重做');plan([id]);const event=complete(id);tasks.completeTask(id,true,at(date,650));assert.equal(report().completedTasks,1)
    tasks.completeTask(id,false);assert.equal(report().completedTasks,0);assert.equal(report().currentBaseline!.completed,0)
    const nextEvent=complete(id,at(date,660));assert.notEqual(nextEvent,event);assert.equal(report().completedTasks,1);assert.equal(report().currentBaseline!.completed,1)
  })
  await test('提前完成归属实际完成日，并满足未来日期已冻结目标',()=>{
    reset();const id=task('提前');plan([id],next);complete(id)
    const r=report();assert.equal(r.days.at(-1)!.completed,1);assert.equal(statistics.frozenPlan(next,at(next,720))!.completed,1)
  })
  await test('跨午夜完成不归入前一天，时间范围外不算完成',()=>{
    reset();const id=task('跨午夜');complete(id,at(next,0));assert.equal(report().completedTasks,0)
    const r=statistics.readStatistics(next,at(next,720));assert.equal(r.days.at(-1)!.completed,1);assert.equal(r.days.at(-2)!.completed,0)
  })
  await test('无计划基线和零样本均为未知，不返回100%',()=>{
    reset();const r=report();assert.equal(r.currentBaseline,null);assert.equal(r.onTime.rate,null);assert.equal(r.estimates.baseMape,null);assert.equal(r.changes.postponeRate,null)
    assert.throws(()=>statistics.freezeDay(date,now),/没有/);assert.throws(()=>statistics.freezeDay('2030-01-06',now),/过去/);assert.throws(()=>statistics.readStatistics(next,now),/今天/)
  })
  await test('启用前日期显示未启用，不用最终任务状态回填历史',()=>{
    reset();db.prepare('UPDATE statistics_meta SET enabled_at=? WHERE id=1').run(new Date(at(date,600)).toISOString());const r=report()
    assert.equal(r.days[0].coverage,'none');assert.equal(r.days[0].completed,null);assert.equal(r.days.at(-1)!.coverage,'partial');assert.equal(r.days.at(-1)!.completed,0)
    assert.equal(statistics.readStatistics('2030-01-06',later).completedTasks,null)
  })
  await test('截止按完成当时快照计算，后来修改截止不改变按时率',()=>{
    reset();const id=task('截止快照');tasks.updateTask({id,deadlineAt:new Date(at(date,720)).toISOString()});complete(id,at(date,660));tasks.updateTask({id,deadlineAt:new Date(at(date,600)).toISOString()})
    assert.equal(report().onTime.rate,1);assert.equal(report().onTime.eligible,1)
  })
  await test('截止临界值按时，逾期与无截止分开计入',()=>{
    reset();const a=task('临界'),b=task('逾期'),c=task('无截止');for(const id of [a,b])tasks.updateTask({id,deadlineAt:new Date(at(date,600)).toISOString()})
    complete(a,at(date,600));complete(b,at(date,600)+1);complete(c,at(date,610));const r=report()
    assert.equal(r.onTime.eligible,2);assert.equal(r.onTime.completedOnTime,1);assert.equal(r.onTime.rate,.5);assert.equal(r.onTime.withoutDeadline,1)
  })
  await test('只有明确主动且开始时间后移才计延期，重复确认不增次数',()=>{
    reset();const id=task('主动'),b=task('未说明');plan([id,b]);let p=planning.preview([id],date,date,null,now+60000,{startMin:720});planning.commit(p.id,null,now+60000,{reason:'user_postpone',note:'个人决定'})
    planning.commit(p.id,null,now+60000,{reason:'user_postpone',note:'重复'});p=planning.preview([b],date,date,null,now+120000,{startMin:900});planning.commit(p.id,null,now+120000)
    let r=report();assert.equal(r.changes.postponeEvents,1);assert.equal(r.changes.postponedTasks,1);assert.equal(r.changes.plannedTasks,2);assert.equal(r.changes.postponeRate,.5);assert.equal(r.changes.otherManualMoves,1)
    p=planning.preview([id],date,date,null,now+180000,{startMin:480});planning.commit(p.id,null,now+180000,{reason:'user_postpone',note:'实际提前了，不应计延期'});r=report();assert.equal(r.changes.postponeEvents,1)
  })
  await test('同一任务两次主动推迟：次数2、唯一任务1',()=>{
    reset();const id=task('两次');plan([id]);for(const startMin of [720,900]){const p=planning.preview([id],date,date,null,now+startMin,{startMin});planning.commit(p.id,null,now+startMin,{reason:'user_postpone',note:''})}
    assert.equal(report().changes.postponeEvents,2);assert.equal(report().changes.postponedTasks,1)
  })
  await test('课表原因与助理确认单独记录，不能把助理建议称为系统自动改期',()=>{
    reset();const id=task('助理');plan([id]);const p=planning.preview([id],date,date,'S6-test-run',now+60000,{startMin:720})
    planning.commit(p.id,'S6-test-run',now+60000,{reason:'calendar_change',note:'避开新增课程'});const r=report();assert.equal(r.changes.agentConfirmedMoves,1);assert.equal(r.changes.systemMoves,0);assert.equal(r.changes.postponeEvents,0);assert.equal(r.changes.reasons[0].reason,'calendar_change')
    assert.throws(()=>validatePlanAudit({reason:'invented',note:''} as never));assert.throws(()=>validatePlanAudit({reason:'other',note:'',actor:'system'} as never))
  })
  await test('无变化试排不制造改期，移除安排保留基线与原值',()=>{
    reset();const id=task('不变');plan([id]);plan([id]);assert.equal(report().changes.otherManualMoves,0)
    planning.removeBlock(planning.listBlocks()[0].id!);const r=report();assert.equal(r.currentBaseline!.denominator,1);assert.equal(r.currentBaseline!.items[0].state,'moved_out')
    const row=db.prepare("SELECT before_json,after_json FROM task_events WHERE kind='plan_removed' AND task_id=?").get(id) as {before_json:string;after_json:null};assert.ok(JSON.parse(row.before_json).start);assert.equal(row.after_json,null)
  })
  await test('计划/账本/基线任一写入失败会整体回滚',()=>{
    reset();const id=task('原子');let p=planning.preview([id],date,date,null,now)
    db.exec("CREATE TRIGGER reject_plan_ledger BEFORE INSERT ON task_events WHEN NEW.kind='plan_created' BEGIN SELECT RAISE(ABORT,'rollback'); END")
    try{assert.throws(()=>planning.commit(p.id,null,now),/rollback/);assert.equal(planning.listBlocks().length,0);assert.equal(statistics.frozenPlan(date,later),null)}finally{db.exec('DROP TRIGGER reject_plan_ledger')}
    db.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON day_plan_items BEGIN SELECT RAISE(ABORT,'snapshot rollback'); END")
    try{assert.throws(()=>planning.commit(p.id,null,now),/rollback/);assert.equal(planning.listBlocks().length,0);assert.equal(statistics.frozenPlan(date,later),null);assert.equal((db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE kind='plan_created'").get() as {n:number}).n,0)}finally{db.exec('DROP TRIGGER reject_snapshot')}
    planning.commit(p.id,null,now);assert.equal(planning.listBlocks().length,1)
  })
  await test('完成事件和任务账本一起回滚，撤销的样本不再计误差',()=>{
    reset();const id=task('完成回滚');db.exec("CREATE TRIGGER reject_done_ledger BEFORE INSERT ON task_events WHEN NEW.kind='completed' BEGIN SELECT RAISE(ABORT,'done rollback'); END")
    try{assert.throws(()=>complete(id),/rollback/);assert.equal(tasks.getTaskById(id)!.status,'pending');assert.equal(report().completedTasks,0)}finally{db.exec('DROP TRIGGER reject_done_ledger')}
    const event=complete(id);sample(event,90);assert.equal(report().estimates.sampleCount,1);tasks.completeTask(id,false);assert.equal(report().estimates.sampleCount,0)
  })
  await test('耗时误差按有效样本手算，原始/计划时长和来源分组独立',()=>{
    reset();const a=task('用户样本',60),b=task('模型样本',60,'model');plan([a]);let event=complete(a);sample(event,90)
    event=complete(b);sample(event,30);const r=report();assert.equal(r.estimates.sampleCount,2);assert.equal(r.estimates.baseMape,50);assert.equal(r.estimates.plannedMape,50);assert.equal(r.estimates.meanAbsoluteMin,30);assert.equal(r.estimates.groups.length,2)
  })
  await test('缺耗时、中断、范围变化均排除；后补有效反馈才加入',()=>{
    reset();const ids=['缺失','中断','范围'].map(name=>task(name)),events=ids.map(id=>complete(id));sample(events[0],null);sample(events[1],90,true);sample(events[2],90,false,true)
    assert.equal(report().estimates.sampleCount,0);assert.equal(report().estimates.excluded,3);sample(events[0],90);assert.equal(report().estimates.sampleCount,1)
  })
  await test('统计读取不产生写操作，近期事件限40条，工具不暴露原始流水',()=>{
    reset();const id=task('只读');for(let i=0;i<45;i++){tasks.updateTask({id,importance:i%2+1});db.prepare('UPDATE task_events SET occurred_at=?,local_day=? WHERE id=(SELECT MAX(id) FROM task_events)').run(new Date(now+i*1000).toISOString(),date)}
    const before=(db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as {n:number}).n;assert.equal(report().recentEvents.length,40);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as {n:number}).n,before)
    const result=executeTool('get_statistics','{}',{observed:new Map()});assert.equal(result.ok,true);assert.equal(Object.hasOwn(result.data as object,'recentEvents'),false);assert.ok(result.sourceRefs!.length)
  })
  await test('Agent只读统计后回答，不编造冻结或写入操作',async()=>{
    reset();const run=store.createRun('查统计',[{role:'system',content:''},{role:'user',content:'我的完成率？'}]);let step=0
    const call=(name:string,args:object):ModelMessage=>({role:'assistant',content:null,tool_calls:[{id:`stat-${++step}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]})
    await drive(run,async(_s,m)=>{if(step===0)return call('get_statistics',{});assert.equal(JSON.parse(m.at(-1)!.content!).data.days.at(-1).baseline,null);return call('respond',{mode:'answer',text:'今天尚未冻结计划，暂不能计算计划完成率。'})})
    assert.equal(store.getRun(run).status,'completed');assert.equal((db.prepare('SELECT COUNT(*) AS n FROM day_plan_snapshots').get() as {n:number}).n,0)
  })
  await test('改期原因仅经可信确认进入账本，模型参数不能伪造原因',async()=>{
    reset();const id=task('确认理由'),dateNow=dateKey(Date.now()+86400000)
    planning.commit(planning.preview([id],dateNow,dateNow).id,null)
    const run=store.createRun('改到下午',[{role:'system',content:''},{role:'user',content:'改到下午'}]);let step=0
    const call=(name:string,args:object):ModelMessage=>({role:'assistant',content:null,tool_calls:[{id:`reason-${++step}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]})
    await drive(run,async(_s,m)=>{if(step===0)return call('get_task',{taskId:id});if(step===1)return call('preview_plan',{taskIds:[id],startDate:dateNow,endDate:dateNow,dailyStartMin:720});return call('propose_plan',{previewId:JSON.parse(m.at(-1)!.content!).data.previewId})})
    assert.equal(store.getRun(run).status,'awaiting_confirmation')
    assert.equal(executeTool('propose_plan',JSON.stringify({previewId:'x',reason:'user_postpone'}),{observed:new Map(),runId:run}).errorCode,'INVALID_ARGUMENTS')
    confirmChange(run,true,undefined,{reason:'user_postpone',note:'用户确认原因'})
    const event=db.prepare("SELECT kind,actor,source,reason,note FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 1").get(id) as {kind:string;actor:string;source:string;reason:string;note:string}
    assert.equal(event.kind,'postponed');assert.equal(event.actor,'user');assert.equal(event.source,'agent_confirmed');assert.equal(event.note,'用户确认原因')
  })
  reset()
}
