import assert from 'node:assert/strict'
import {getDb} from '../src/main/db/database'
import * as tasks from '../src/main/db/taskDao'
import * as planning from '../src/main/planning/service'
import {at,dateKey,daySettings,calendarOccupancy,overlaps} from '../src/main/planning/engine'
import {assertDependencies} from '../src/main/planning/constraints'
import {drive,confirmChange} from '../src/main/agent/runner'
import * as store from '../src/main/agent/store'
import type {ModelMessage} from '../src/main/agent/model'
import type {DayOverride,CalendarExceptionInput} from '../src/shared/planning'
type Test=(name:string,fn:()=>unknown|Promise<unknown>)=>Promise<void>
export async function constraintsTests(test:Test):Promise<void>{
  const db=getDb(),date='2030-01-07',next='2030-01-08',now=at(date,420),ids:number[]=[]
  const defaults={startMin:480,endMin:1080,dailyMaxMin:240,breakMin:15}
  const override=(patch:Partial<DayOverride>={}):DayOverride=>({date,mode:'light',dailyMaxMin:null,startMin:null,endMin:null,note:'测试',...patch})
  function reset():void{db.exec('DELETE FROM task_dependencies; DELETE FROM day_overrides; DELETE FROM calendar_exceptions; DELETE FROM plan_blocks; DELETE FROM calendar_courses; DELETE FROM plan_previews;');ids.forEach(id=>tasks.deleteTask(id));planning.saveSettings(defaults)}
  function task(name:string,duration=60):number{const t=tasks.createTask({content:`P5-${name}`});tasks.applyAnalysis(t.id,{summary:t.content,importance:3,urgency:3,category:'学习',tags:[],estimateMin:duration,dueAt:null},'none');tasks.updateTask({id:t.id,deadlineAt:null});ids.push(t.id);return t.id}
  function course():number{planning.saveCourse({name:'P5-数学课',weekday:1,startMin:480,endMin:540,fromDate:date,toDate:'2030-02-04'});return planning.listCourses()[0].id}
  function exception(kind:CalendarExceptionInput['kind'],courseId:number|null=null,patch:Partial<CalendarExceptionInput>={}):number{return planning.saveException({kind,date,courseId,name:'P5-临时面试',startMin:480,endMin:540,...patch})}
  await test('停课只释放指定日期，重复录入不重复取消，原周课表保留',()=>{
    reset();const id=course();const a=exception('cancel_course',id),b=exception('cancel_course',id);assert.equal(a,b)
    assert.equal(planning.snapshot(date,date).occupied.length,0);assert.equal(planning.snapshot('2030-01-14','2030-01-14').occupied.length,1);assert.equal(planning.listCourses().length,1)
    assert.throws(()=>exception('cancel_course',id,{date:next}),/没有/)
  })
  await test('补课和临时占用保持真实分钟，试排避开并支持恢复常规课',()=>{
    reset();const id=course();const cancel=exception('cancel_course',id);exception('makeup_course',id,{date:next,startMin:550,endMin:617});exception('busy',null,{date:next,startMin:480,endMin:550})
    const t=task('补课避让'),p=planning.preview([t],next,next,null,now);assert.equal(p.blocks[0].start,at(next,630))
    assert.equal(planning.snapshot(next,next).occupied.filter(o=>o.kind!=='task').length,2)
    planning.deleteException(cancel);assert.equal(planning.snapshot(date,date).occupied.length,1)
  })
  await test('删除停课导致已确认计划冲突时拒绝，安排和例外均保留',()=>{
    reset();const c=course(),e=exception('cancel_course',c),t=task('停课空档')
    planning.commit(planning.preview([t],date,date,null,now).id,null,now)
    assert.throws(()=>planning.deleteException(e),/冲突/);assert.equal(planning.listExceptions().length,1);assert.equal(planning.listBlocks().length,1)
    assert.throws(()=>planning.deleteCourse(c),/例外/)
  })
  await test('临时占用与已有计划冲突时拒绝，不静默挪任务',()=>{
    reset();const t=task('保留计划');planning.commit(planning.preview([t],date,date,null,now).id,null,now);const before=planning.listBlocks()
    assert.throws(()=>exception('busy'),/冲突/);assert.deepEqual(planning.listBlocks(),before);assert.equal(planning.listExceptions().length,0)
  })
  await test('日期例外拒绝坏日期、反向时间和不存在课程',()=>{
    reset();assert.throws(()=>exception('busy',null,{date:'2030-02-30'}));assert.throws(()=>exception('busy',null,{endMin:479}));assert.throws(()=>exception('makeup_course',999999));assert.throws(()=>exception('busy',1))
  })
  await test('轻量容量只影响当天，次日仍沿用默认上限',()=>{
    reset();planning.saveDayOverride(override());const a=task('轻量A',90),b=task('轻量B',90),p=planning.preview([a,b],date,next,null,now)
    assert.equal(dateKey(p.blocks[0].start),date);assert.equal(dateKey(p.blocks[1].start),next)
    const days=planning.snapshot(date,next).effectiveDays;assert.equal(days[0].settings.dailyMaxMin,120);assert.equal(days[1].settings.dailyMaxMin,240)
    assert.deepEqual(daySettings(defaults,[],next),defaults)
  })
  await test('自定义单日窗口与零容量优先，恢复设置不污染全局',()=>{
    reset();planning.saveDayOverride(override({dailyMaxMin:0}));const t=task('休息日');assert.equal(planning.preview([t],date,date,null,now).blocks.length,0)
    planning.saveDayOverride(override({mode:'normal',dailyMaxMin:60,startMin:1140,endMin:1200}));const p=planning.preview([t],date,date,null,now)
    assert.equal(p.blocks[0].start,at(date,1140));planning.commit(p.id,null,now)
    assert.throws(()=>planning.deleteDayOverride(date),/窗口/);planning.removeBlock(planning.listBlocks()[0].id!);planning.deleteDayOverride(date)
    assert.deepEqual(planning.settings(),defaults)
  })
  await test('降低容量不覆盖现有计划，单日字段和窗口运行时校验',()=>{
    reset();const a=task('容量A',90),b=task('容量B',90);planning.commit(planning.preview([a,b],date,date,null,now).id,null,now)
    assert.throws(()=>planning.saveDayOverride(override()),/上限/);assert.equal(planning.listDayOverrides().length,0)
    assert.throws(()=>planning.saveDayOverride(override({startMin:900,endMin:800})))
    assert.throws(()=>planning.saveDayOverride(override({dailyMaxMin:-1})))
    assert.throws(()=>planning.saveDayOverride(override({dailyMaxMin:600,startMin:480,endMin:540})))
  })
  await test('当天设置、临时事件和依赖修改均使旧试排失效',()=>{
    reset();const a=task('版本A'),b=task('版本B');let p=planning.preview([a],date,date,null,now)
    planning.saveDayOverride(override());assert.throws(()=>planning.commit(p.id,null,now),/变化/)
    p=planning.preview([a],date,date,null,now);exception('busy',null,{startMin:900,endMin:960});assert.throws(()=>planning.commit(p.id,null,now),/变化/)
    p=planning.preview([a],date,date,null,now);planning.saveDependency(a,b);assert.throws(()=>planning.commit(p.id,null,now),/变化/)
  })
  await test('新增设置绑定展示版本，过期保存和删除不会覆盖',()=>{
    reset();const version=planning.snapshot(date,date).version;planning.saveDayOverride(override(),version)
    assert.throws(()=>planning.saveException({kind:'busy',date,courseId:null,name:'旧版占用',startMin:480,endMin:540},version),/变化/)
    assert.equal(planning.listExceptions().length,0)
    assert.throws(()=>planning.saveDayOverride(override({mode:'normal'}),version),/变化/);assert.equal(planning.listDayOverrides()[0].mode,'light')
  })
  await test('依赖拒绝自环和多级环，重复保存幂等',()=>{
    reset();const a=task('依赖A'),b=task('依赖B'),c=task('依赖C');planning.saveDependency(b,a);planning.saveDependency(c,b);planning.saveDependency(b,a)
    assert.equal(planning.listDependencies().length,2);assert.throws(()=>planning.saveDependency(a,c),/环/);assert.throws(()=>planning.saveDependency(a,a));assert.equal(planning.listDependencies().length,2)
  })
  await test('拓扑顺序优先于截止分数，同批前置必在后续之前',()=>{
    reset();const a=task('先阅读'),b=task('后写作');tasks.updateTask({id:b,importance:5,deadlineAt:new Date(at(date,780)).toISOString()});planning.saveDependency(b,a)
    const p=planning.preview([b,a],date,date,null,now);assert.deepEqual(p.blocks.map(b=>b.taskId),[a,b]);assert.ok(p.blocks[1].start>=p.blocks[0].end+15*60000)
    planning.commit(p.id,null,now);assert.equal(planning.listBlocks().length,2)
  })
  await test('未选且未安排前置会阻塞；前置排不下也阻塞后续',()=>{
    reset();const a=task('大前置',600),b=task('后续',30);planning.saveDependency(b,a)
    let p=planning.preview([b],date,date,null,now);assert.equal(p.blocks.length,0);assert.match(p.unscheduled[0].reason,/前置/)
    p=planning.preview([a,b],date,date,null,now);assert.equal(p.blocks.length,0);assert.equal(p.unscheduled.length,2)
  })
  await test('已完成前置不占新时段，未选但已计划前置约束后续',()=>{
    reset();const a=task('完成前置'),b=task('已规划后续');planning.saveDependency(b,a)
    planning.commit(planning.preview([a],date,date,null,now,{startMin:600}).id,null,now)
    const p=planning.preview([b],date,date,null,now);assert.ok(p.blocks[0].start>=at(date,675));planning.commit(p.id,null,now)
    tasks.completeTask(a,true);const q=planning.preview([b],date,date,null,now);assert.equal(q.blocks[0].start,at(date,480))
  })
  await test('跨规划窗口读取前置计划，过去块不冒充已完成',()=>{
    reset();const a=task('跨日前置'),b=task('跨日后续');planning.saveDependency(b,a)
    planning.commit(planning.preview([a],date,date,null,now).id,null,now)
    assert.equal(planning.preview([b],next,next,null,now).blocks.length,1)
    const p=planning.preview([b],next,next,null,at(next,420));assert.equal(p.blocks.length,0);assert.match(p.unscheduled[0].reason,/尚未完成/)
  })
  await test('未选择的后续计划限制前置重排，冲突时保留原安排',()=>{
    reset();const a=task('重排前置'),b=task('固定后续');planning.saveDependency(b,a)
    planning.commit(planning.preview([a,b],date,date,null,now).id,null,now);const old=planning.listBlocks()
    const p=planning.preview([a],next,next,null,now);assert.equal(p.blocks.length,0);assert.deepEqual(planning.listBlocks(),old)
    assert.throws(()=>planning.removeBlock(old.find(p=>p.taskId===a)!.id!),/前置/)
    assert.throws(()=>tasks.deleteTask(a),/前置/)
  })
  await test('新增依赖不能使已存计划倒序，失败不留边',()=>{
    reset();const a=task('原较晚'),b=task('原较早');planning.commit(planning.preview([b],date,date,null,now).id,null,now);planning.commit(planning.preview([a],date,date,null,now,{startMin:720}).id,null,now)
    assert.throws(()=>planning.saveDependency(b,a),/前置/);assert.equal(planning.listDependencies().length,0)
  })
  await test('多前置与传递依赖满足最晚完成者，独立检查零重叠',()=>{
    reset();const a=task('多A',30),b=task('多B',45),c=task('多C',30),d=task('多D',30);planning.saveDependency(c,a);planning.saveDependency(c,b);planning.saveDependency(d,c)
    const p=planning.preview([d,c,b,a],date,next,null,now);assert.equal(p.blocks.length,4);assert.doesNotThrow(()=>assertDependencies(p.blocks,planning.listDependencies(),now))
    for(const dep of planning.listDependencies())assert.ok(p.blocks.find(b=>b.taskId===dep.prerequisiteId)!.end<=p.blocks.find(b=>b.taskId===dep.taskId)!.start)
    for(let i=0;i<p.blocks.length;i++)assert.equal(p.blocks.slice(i+1).some(b=>overlaps(b,p.blocks[i])),false)
  })
  await test('数据库输入更改不能绕过提交时依赖校验',()=>{
    reset();const a=task('检查A'),b=task('检查B');planning.saveDependency(b,a);const p=planning.preview([a,b],date,date,null,now)
    const forged={...p,blocks:[{...p.blocks[0],start:at(date,720),end:at(date,780)},p.blocks[1]]}
    db.prepare('UPDATE plan_previews SET json=? WHERE id=?').run(JSON.stringify(forged),p.id)
    assert.throws(()=>planning.commit(p.id,null,now),/前置/);assert.equal(planning.listBlocks().length,0)
  })
  await test('撤销已完成前置会破坏后续计划时拒绝且保留完成状态',()=>{
    reset();const a=task('撤销前置'),b=task('撤销后续');tasks.completeTask(a,true);planning.saveDependency(b,a);planning.commit(planning.preview([b],date,date,null,now).id,null,now)
    assert.throws(()=>tasks.completeTask(a,false),/前置/);assert.equal(tasks.getTaskById(a)!.status,'done')
    planning.deleteDependency(b,a);tasks.completeTask(a,false);assert.equal(tasks.getTaskById(a)!.status,'pending')
  })
  await test('其他依赖链的过期待核对状态不阻塞无关任务操作',()=>{
    reset();const a=task('历史待核对'),b=task('相关后续'),c=task('无关任务')
    tasks.completeTask(a,true);planning.saveDependency(b,a);planning.commit(planning.preview([b],date,date,null,now).id,null,now)
    // 模拟时间过去后前置仍未核对完成的历史状态，不能把无关操作一起锁死。
    db.prepare("UPDATE tasks SET status='pending',completed_at=NULL WHERE id=?").run(a)
    const p=planning.preview([c],date,date,null,now);assert.doesNotThrow(()=>planning.commit(p.id,null,now))
    tasks.completeTask(c,true);assert.doesNotThrow(()=>tasks.completeTask(c,false));assert.doesNotThrow(()=>planning.removeBlock(planning.listBlocks().find(b=>b.taskId===c)!.id!))
  })
  await test('审计写入失败时日例外、轻量状态和依赖全部回滚',()=>{
    reset();const a=task('回滚A'),b=task('回滚B');db.exec("CREATE TRIGGER fail_p5_event BEFORE INSERT ON planning_events BEGIN SELECT RAISE(ABORT,'rollback'); END")
    try{assert.throws(()=>exception('busy'));assert.throws(()=>planning.saveDayOverride(override()));assert.throws(()=>planning.saveDependency(b,a));assert.equal(planning.listExceptions().length,0);assert.equal(planning.listDayOverrides().length,0);assert.equal(planning.listDependencies().length,0)}finally{db.exec('DROP TRIGGER fail_p5_event')}
  })
  await test('单日例外与容量组合跨月，区间相邻不误判重叠',()=>{
    reset();const d='2030-01-31',end='2030-02-01',t=task('月末',60);exception('busy',null,{date:d,startMin:480,endMin:540});planning.saveDayOverride(override({date:d,mode:'normal',dailyMaxMin:60}))
    const p=planning.preview([t],d,end,null,at(d,420));assert.equal(p.blocks[0].start,at(d,540));assert.equal(dateKey(p.blocks[0].start),d)
  })
  await test('Agent通过共享工具读取单日设置和依赖，确认后保留约束',async()=>{
    reset();const day=dateKey(Date.now()+86400000),a=task('Agent前置',30),b=task('Agent后续',30)
    planning.saveDayOverride(override({date:day}));exception('busy',null,{date:day,startMin:480,endMin:600});planning.saveDependency(b,a)
    const run=store.createRun('遵守今日约束安排两项',[{role:'system',content:''},{role:'user',content:'实际试排'}]);let step=0
    const call=(name:string,args:object):ModelMessage=>({role:'assistant',content:null,tool_calls:[{id:`constraints-${step}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]})
    await drive(run,async(_s,m)=>{step++;if(step===1)return call('get_calendar',{startDate:day,endDate:day});if(step===2){const data=JSON.parse(m.at(-1)!.content!).data;assert.equal(data.effectiveDays[0].mode,'light');assert.equal(data.dependencies.length,1);return call('list_tasks',{taskIds:[a,b]})}if(step===3)return call('preview_plan',{taskIds:[b,a],startDate:day,endDate:day});return call('propose_plan',{previewId:JSON.parse(m.at(-1)!.content!).data.previewId})})
    assert.equal(store.getRun(run).status,'awaiting_confirmation');assert.equal(planning.listBlocks().length,0);confirmChange(run,true);assert.equal(planning.listBlocks().length,2)
    const blocks=planning.listBlocks();assert.ok(blocks[0].start>=at(day,600));assert.ok(blocks[0].end<=blocks[1].start)
  })
  reset()
}
