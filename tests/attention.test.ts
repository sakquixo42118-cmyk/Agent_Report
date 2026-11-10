import assert from 'node:assert/strict'
import {getDb} from '../src/main/db/database'
import {setSettings} from '../src/main/db/settingsDao'
import * as tasks from '../src/main/db/taskDao'
import * as planning from '../src/main/planning/service'
import * as service from '../src/main/attention/service'
import {preferences,savePreferences,quiet} from '../src/main/attention/preferences'
import {configureAttention,processAttention,tickAttention,stopAttention} from '../src/main/attention/worker'
import {prepareMessageRun} from '../src/main/attention/bridge'
import {acquireBackground,releaseBackground,interruptBackground,backgroundOccupied} from '../src/main/agent/background'
import {at,dateKey} from '../src/main/planning/engine'
import {drive,confirmTaskDraft} from '../src/main/agent/runner'
import * as store from '../src/main/agent/store'
import * as drafts from '../src/main/drafts/service'
import {processNext} from '../src/main/feedback/worker'
import type {ModelMessage,ModelTransport} from '../src/main/agent/model'
import {deadlineClock,relativeTimeIssue} from '../src/main/attention/timeEvidence'
type Test=(name:string,fn:()=>unknown|Promise<unknown>)=>Promise<void>
export async function attentionTests(test:Test):Promise<void>{
  const db=getDb(),date='2030-01-07',now=at(date,720),ids:number[]=[];let serial=0
  function reset():void{
    db.exec('DELETE FROM attention_attempts; DELETE FROM attention_jobs; DELETE FROM attention_messages; DELETE FROM attention_events; DELETE FROM attention_desktop_batches; DELETE FROM attention_mutes; DELETE FROM day_plan_items; DELETE FROM day_plan_snapshots; DELETE FROM task_dependencies; DELETE FROM plan_blocks; DELETE FROM calendar_exceptions; DELETE FROM calendar_courses; DELETE FROM day_overrides; DELETE FROM plan_previews; DELETE FROM completion_jobs; DELETE FROM followup_messages;')
    ids.forEach(id=>tasks.deleteTask(id));setSettings({notifyEnabled:false,notifyAdvanceHours:1})
    planning.saveSettings({startMin:480,endMin:1380,dailyMaxMin:600,breakMin:0})
    savePreferences({proactiveEnabled:true,courseEnabled:true,nudgeEnabled:true,desktopEnabled:false,quietEnabled:false,quietStartMin:1320,quietEndMin:480,intervalMin:60,dailyChecks:3,dailyMessages:3,startAdvanceMin:10,reminderDailyLimit:12,version:preferences().version})
    db.prepare('UPDATE attention_state SET enabled_at=?,last_check_at=0,last_desktop_at=0 WHERE id=1').run(at(date,0))
    configureAttention(()=>{},()=>false,()=>{})
  }
  function course(name='验收课程',end=660):number{planning.saveCourse({name,weekday:1,startMin:end-45,endMin:end,fromDate:date,toDate:'2030-01-28'});return planning.listCourses().find(c=>c.name===name)!.id}
  function task(name='验收任务',due:number|null=at(date,1380)):number{const t=tasks.createTask({content:name});ids.push(t.id);tasks.applyAnalysis(t.id,{summary:name,importance:3,urgency:3,category:'学习',tags:[],estimateMin:30,dueAt:null},'none');tasks.updateTask({id:t.id,deadlineAt:due===null?null:new Date(due).toISOString()});return t.id}
  const call=(name:string,args:object):ModelMessage=>({role:'assistant',content:null,tool_calls:[{id:`attention-${++serial}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]})
  function model(mode:'silent'|'ask'|'suggest'='ask'):ModelTransport{let step=0,keys:string[]=[];return async(_s,m)=>{if(step++===0)return call('get_attention_context',{});keys=JSON.parse(m.at(-1)!.content!).evidence.map((e:{key:string})=>e.key);return call('respond',{mode,text:mode==='silent'?'':'按当前记录，有需要核对或补充的事项吗？',eventKeys:mode==='silent'?[]:keys})}}
  const run=(mode:'silent'|'ask'|'suggest'='ask',time=now)=>processAttention(model(mode),()=>time)
  const state=(time=now)=>service.attentionState(time)
  await test('倒计时按实际截止计算，不复述标题；预计剩余工作量不被当成截止',()=>{
    reset();const id=task('标题中的12分钟不会更新',now+15*60000),e=service.candidates(now).find(e=>e.taskId===id)!
    assert.equal(deadlineClock(e,now).deadlineRemainingMin,15)
    assert.ok(relativeTimeIssue('12分钟后截止',[e],now))
    assert.equal(relativeTimeIssue('距离截止还有15分钟',[e],now),null)
    assert.equal(relativeTimeIssue('还有5分钟就能完成报告',[e],now),null)
    assert.ok(relativeTimeIssue('还有0分钟截止',[e],now+15*60000+1))
  })
  await test('后台拒绝不实倒计时后模型可同轮纠正，不发布错误催办',async()=>{
    reset();const id=task('模拟12分钟标题',now+15*60000),key=service.candidates(now).find(e=>e.taskId===id)!.key;let step=0
    const transport:ModelTransport=async(_s,m)=>{if(step++===0)return call('get_attention_context',{});if(step===2)return call('respond',{mode:'suggest',text:'12分钟后截止，现在提交吗？',eventKeys:[key]});assert.match(m.at(-1)!.content!,/RELATIVE_TIME_MISMATCH/);return call('respond',{mode:'suggest',text:'截止临近，可以核对提交状态。',eventKeys:[key]})}
    assert.equal(await processAttention(transport,()=>now),true)
    assert.equal(state().messages.length,1);assert.doesNotMatch(state().messages[0].text,/12分钟/)
    const job=db.prepare('SELECT trace_json FROM attention_jobs ORDER BY rowid DESC LIMIT 1').get() as {trace_json:string};assert.match(job.trace_json,/RELATIVE_TIME_MISMATCH/)
  })
  await test('近期课程实例可检查；首次启用前、旧课程和停课不补问',()=>{
    reset();const c=course();assert.equal(service.candidates(now).filter(e=>e.kind==='course').length,1)
    db.prepare('UPDATE attention_state SET enabled_at=?').run(now);assert.equal(service.candidates(now).length,0)
    db.prepare('UPDATE attention_state SET enabled_at=?').run(at(date,0));planning.saveException({kind:'cancel_course',date,courseId:c,name:'',startMin:0,endMin:1});assert.equal(service.candidates(now).length,0)
    assert.equal(service.candidates(now+4*3600000).length,0)
  })
  await test('补课实例参与课后检查，不把日期标题或任务当课程',()=>{
    reset();const c=course();planning.saveException({kind:'cancel_course',date,courseId:c,name:'',startMin:0,endMin:1});planning.saveException({kind:'makeup_course',date,courseId:c,name:'',startMin:630,endMin:690})
    planning.saveException({kind:'busy',date,courseId:null,name:'临时占用',startMin:600,endMin:620});const e=service.candidates(now);assert.equal(e.length,1);assert.match(e[0].title,/补课/);assert.equal(e[0].end,at(date,690))
  })
  await test('模型选择静默不生成消息，同课程反复打开也不重问',async()=>{
    reset();course();assert.equal(await run('silent'),true);assert.equal(state().unread,0);assert.equal(state().messages.length,0)
    assert.equal(await run('ask',now+61*60000),false);assert.equal(state().checksToday,1)
  })
  await test('必要时按需检索再问，保留来源且不自动创建任务',async()=>{
    reset();course();const before=tasks.listTasks().length;let step=0,keys:string[]=[]
    await processAttention(async(_s,m)=>{if(step++===0)return call('get_attention_context',{});if(step===2){const evidence=JSON.parse(m.at(-1)!.content!).evidence;assert.equal(evidence[0].endLocal,`${date} 11:00:00`);keys=evidence.map((e:{key:string})=>e.key);return call('search_memory',{query:'课程偏好'})}return call('respond',{mode:'ask',text:'按课表，这门课刚结束。有需要记下的事项吗？',eventKeys:keys})},()=>now)
    const s=state();assert.equal(s.unread,1);assert.equal(s.messages[0].kind,'course_question');assert.ok(s.messages[0].evidence[0].sourceRefs[0].startsWith('calendar:'));assert.equal(tasks.listTasks().length,before)
  })
  await test('多个近期课程合并一次检查，消息只引用实际证据',async()=>{
    reset();course('课程A',660);course('课程B',670);await run();assert.equal(state().checksToday,1);assert.equal(state().messages.length,1);assert.equal(state().messages[0].evidence.length,2)
  })
  await test('不读上下文、伪造证据或调用写工具都不能发布',async()=>{
    reset();course();assert.equal(await processAttention(async()=>call('respond',{mode:'ask',text:'伪造',eventKeys:['forged']}),()=>now),false);assert.equal(state().unread,0)
    reset();course();assert.equal(await processAttention(async()=>call('create_task_draft',{content:'越权'}),()=>now),false);assert.equal(state().unread,0)
    reset();course();const key=service.candidates(now)[0].key;await processAttention(async()=>call('respond',{mode:'ask',text:'未读取',eventKeys:[key]}),()=>now);assert.equal(state().messages.length,0)
  })
  await test('截止压力和已结束未确认时段进入风险检查，完成任务立即退出',async()=>{
    reset();const id=task();assert.ok(service.candidates(now).some(e=>e.taskId===id));await run('suggest');assert.equal(state().messages[0].kind,'suggestion')
    tasks.completeTask(id,true);assert.equal(state().unread,0);assert.equal(state().messages[0].state,'cancelled')
    reset();const b=task('已结束时段',null);planning.commit(planning.preview([b],date,date,null,at(date,420)).id,null,at(date,420));const later=at(date,570);assert.ok(service.candidates(later).some(e=>e.flags?.includes('planned_block_ended')))
  })
  await test('没有新证据不调用模型；前台繁忙不消费检查配额',async()=>{
    reset();let calls=0;assert.equal(await processAttention(async()=>{calls++;throw new Error()},()=>now),false);assert.equal(calls,0)
    course();configureAttention(()=>{},()=>true,()=>{});assert.equal(await run(),false);assert.equal(state().checksToday,0)
  })
  await test('最短间隔、每日检查上限与消息上限分别生效',async()=>{
    reset();course();savePreferences({...preferences(),dailyChecks:1});await run('silent');task();assert.equal(await run('ask',now+61*60000),false);assert.equal(state().checksToday,1)
    reset();course();savePreferences({...preferences(),dailyMessages:1});await run();task();assert.equal(await run('ask',now+61*60000),false);assert.equal(state().messagesToday,1)
    reset();course();await run('silent');task();assert.equal(await run('ask',now+30*60000),false);assert.equal(await run('ask',now+61*60000),true)
  })
  await test('消息已读不等于已处理；没有新增事项/忽略不创建任务',async()=>{
    reset();course();await run();const m=state().messages[0];service.action(m.id,'read',60,now);assert.equal(state().unread,0);assert.equal(state().messages[0].state,'open')
    const count=tasks.listTasks().length;service.action(m.id,'none',60,now);assert.equal(state().messages[0].state,'answered');assert.equal(tasks.listTasks().length,count)
    reset();course();await run();service.action(state().messages[0].id,'dismiss',60,now);assert.equal(state().unread,0);assert.equal(await run('ask',now+61*60000),false)
  })
  await test('稍后有明确时间，同一消息恢复，不重新调用模型',async()=>{
    reset();course();await run();const id=state().messages[0].id;service.action(id,'later',60,now);assert.equal(state().unread,0);assert.equal(state().messages[0].state,'snoozed')
    assert.equal(state(now+59*60000).unread,0);assert.equal(state(now+61*60000).unread,1);assert.equal(state(now+61*60000).messages[0].id,id);assert.equal(state(now+61*60000).checksToday,1)
    assert.throws(()=>service.action(id,'later',240,now+61*60000),/过期/)
  })
  await test('稍后期间任务完成或问题过期不再亮红点',async()=>{
    reset();const id=task();await run();service.action(state().messages[0].id,'later',60,now);tasks.completeTask(id,true);assert.equal(state(now+61*60000).unread,0)
    reset();course();await run();assert.equal(state(now+4*3600000).messages[0].state,'expired');assert.equal(state(now+4*3600000).unread,0)
  })
  await test('不再提醒按对象持久保存，可恢复但不重问已处理实例',async()=>{
    reset();const c=course();await run();service.action(state().messages[0].id,'mute',60,now);assert.equal(state().muted.length,1);assert.equal(service.candidates(now+61*60000).length,0)
    const next=now+7*86400000;assert.equal(service.candidates(next).length,0);service.unmute(`course:${c}`);assert.ok(service.candidates(next).some(e=>e.courseId===c));assert.equal(await run('ask',now+61*60000),false)
  })
  await test('对象静默同时阻止完成回顾，不撤销完成',async()=>{
    reset();const id=task();await run();service.action(state().messages[0].id,'mute',60,now);db.prepare('UPDATE profile_settings SET enabled=1').run();tasks.completeTask(id,true)
    let called=false;await processNext(async()=>{called=true;throw new Error()});assert.equal(called,false);assert.equal(tasks.getTaskById(id)!.status,'done')
  })
  await test('模型请求在途完成任务，迟到消息被丢弃',async()=>{
    reset();const id=task();let release:()=>void=()=>{},started:()=>void=()=>{};const entered=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r)
    const pending=processAttention(async()=>{started();await wait;return call('respond',{mode:'silent',text:'',eventKeys:[]})},()=>now);await entered;tasks.completeTask(id,true);release();await pending
    assert.equal(state().unread,0);assert.equal(state().messages.length,0)
  })
  await test('课表在途停课或设置关闭均不发布旧问题',async()=>{
    reset();const c=course();let release:()=>void=()=>{},entered:()=>void=()=>{};const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r)
    const pending=processAttention(async()=>{entered();await hold;return call('respond',{mode:'silent',text:'',eventKeys:[]})},()=>now);await ready;planning.saveException({kind:'cancel_course',date,courseId:c,name:'',startMin:0,endMin:1});release();await pending;assert.equal(state().unread,0)
    reset();course();let step=0;await processAttention(async(_s,m)=>{if(step++===0)return call('get_attention_context',{});savePreferences({...preferences(),proactiveEnabled:false});return call('respond',{mode:'ask',text:'不应出现',eventKeys:JSON.parse(m.at(-1)!.content!).evidence.map((e:{key:string})=>e.key)})},()=>now);assert.equal(state().unread,0)
  })
  await test('在途请求跨入安静时段，不发布迟到问题',async()=>{
    reset();course('晚课',1290);savePreferences({...preferences(),quietEnabled:true});let clock=at(date,1319),step=0
    await processAttention(async(_s,m)=>{if(step++===0)return call('get_attention_context',{});clock=at(date,1321);return call('respond',{mode:'ask',text:'晚课有新事项吗？',eventKeys:JSON.parse(m.at(-1)!.content!).evidence.map((e:{key:string})=>e.key)})},()=>clock)
    assert.equal(state(clock).unread,0);assert.equal(state(clock).checksToday,1)
  })
  await test('安静时段支持跨午夜，暂停模型/时间提醒，结束后汇总近期遗漏',async()=>{
    reset();setSettings({notifyEnabled:true});savePreferences({...preferences(),quietEnabled:true,quietStartMin:1320,quietEndMin:480});const night=at(date,1380),morning=at('2030-01-08',480)
    task('跨夜截止',at('2030-01-08',60));assert.equal(quiet(night),true);assert.equal(quiet(morning),false);service.refreshAttention(night);assert.equal(state(night).messages.length,0);assert.equal(await run('ask',night),false)
    service.refreshAttention(morning);assert.equal(state(morning).messages.filter(m=>m.kind==='deadline_reminder').length,1)
  })
  await test('静默设置版本/范围校验，旧页面不覆盖新设置',()=>{
    reset();const old=preferences();savePreferences({...old,dailyChecks:4});assert.throws(()=>savePreferences(old),/变化/);assert.throws(()=>savePreferences({...preferences(),intervalMin:0}));assert.throws(()=>savePreferences({...preferences(),quietEnabled:true,quietStartMin:480,quietEndMin:480}))
    assert.throws(()=>savePreferences({...preferences()},{enabled:true,advanceHours:100}));assert.equal(preferences().dailyChecks,4)
  })
  await test('租约过期恢复新令牌，旧工作者不能重复发布',async()=>{
    reset();course();const old=service.claimJob(now)!;assert.ok(old);const later=now+61*60000;await run('ask',later)
    assert.equal(state(later).messages.length,1);assert.equal(service.publish(old,'silent','',[],[],later),false);assert.equal(state(later).messages.length,1)
  })
  await test('仍有效的检查租约阻止另一工作者新建并行任务',()=>{
    reset();course();const claimed=service.claimJob(now)!;assert.ok(claimed);task('并行保护')
    db.prepare('UPDATE attention_jobs SET lease_until=? WHERE id=?').run(now+2*3600000,claimed.id)
    assert.equal(service.claimJob(now+61*60000),null);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM attention_jobs').get() as {n:number}).n,1)
  })
  await test('网络错误有限重试，无错误红点，手动重试仍受每日配额限制',async()=>{
    reset();task();savePreferences({...preferences(),dailyChecks:3});const bad:ModelTransport=async()=>{throw new Error('network')}
    await processAttention(bad,()=>now);await processAttention(bad,()=>now+61*60000);assert.equal(state(now+61*60000).failed,1);assert.equal(state().unread,0)
    service.retryFailures(now+122*60000);await run('ask',now+122*60000);assert.equal(state(now+122*60000).checksToday,3);assert.equal(state(now+122*60000).messages.length,1)
  })
  await test('用户前台对话中断后台，后台不发布/改数据并可稍后恢复',async()=>{
    reset();course();let release:()=>void=()=>{},entered:()=>void=()=>{};const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r)
    const pending=processAttention(async()=>{entered();await hold;return call('respond',{mode:'silent',text:'',eventKeys:[]})},()=>now);await ready;assert.equal(backgroundOccupied(),true)
    const run=store.createRun('前台测试',[{role:'user',content:'前台测试'}]);await drive(run,async()=>call('respond',{mode:'answer',text:'前台已响应'}));release();await pending
    assert.equal(store.getRun(run).status,'completed');assert.equal(state().unread,0);assert.equal(backgroundOccupied(),false)
    assert.equal(await runCheckAfterYield(),true)
    async function runCheckAfterYield():Promise<boolean>{return processAttention(model('silent'),()=>now+61*60000)}
  })
  await test('完成回顾与主动检查共用后台席位，避免并行模型调用',async()=>{
    reset();course();const controller=new AbortController();assert.equal(acquireBackground('test',controller),true)
    assert.equal(await run(),false);releaseBackground('test');assert.equal(await run('silent'),true)
  })
  await test('时间提醒不需要模型，开启前不会为旧截止补发',async()=>{
    reset();setSettings({notifyEnabled:true});const id=task('时间提醒',now+30*60000);service.refreshAttention(now);let s=state();assert.equal(s.messages.length,1);assert.equal(s.messages[0].kind,'deadline_reminder');assert.equal(s.messages[0].evidence[0].taskId,id)
    db.prepare('UPDATE attention_state SET enabled_at=?').run(now+60*60000);service.refreshAttention(now);s=state();assert.equal(s.messages[0].state,'cancelled')
  })
  await test('截止或执行目标不变不重复；重评不重发，改期取消旧提醒',()=>{
    reset();setSettings({notifyEnabled:true});const id=task('截止版本',now+30*60000);service.refreshAttention(now);const first=state().messages[0]
    tasks.updateTask({id,importance:4});service.refreshAttention(now+1000);assert.equal(state(now+1000).messages[0].id,first.id)
    tasks.updateTask({id,deadlineAt:new Date(now+45*60000).toISOString()});service.refreshAttention(now+2000);const s=state(now+2000);assert.equal(s.messages.filter(m=>m.state==='open').length,1);assert.equal(s.messages.find(m=>m.id===first.id)!.state,'cancelled')
  })
  await test('执行开始提醒保留去重键，结束时间更新不重发，移到别处旧卡失效',()=>{
    reset();setSettings({notifyEnabled:true});const id=task('开始提醒',null),time=at(date,730)
    planning.commit(planning.preview([id],date,date,null,at(date,700),{startMin:735}).id,null,at(date,700));service.refreshAttention(time);const first=state(time).messages[0];assert.equal(first.kind,'start_reminder')
    db.prepare('UPDATE plan_blocks SET end_at=end_at+900000 WHERE task_id=?').run(id);service.refreshAttention(time+1000);assert.equal(state(time+1000).messages.length,1);assert.equal(state(time+1000).messages[0].id,first.id)
    db.prepare('UPDATE plan_blocks SET start_at=start_at+3600000,end_at=end_at+3600000 WHERE task_id=?').run(id);service.refreshAttention(time+2000);assert.equal(state(time+2000).unread,0);service.refreshAttention(time+3600000);assert.equal(state(time+3600000).messages.filter(m=>m.state==='open').length,1)
  })
  await test('未确认截止、已完成/归档、静默对象和过久事件不提醒',()=>{
    reset();setSettings({notifyEnabled:true});const a=task('未确认',now+600000),b=task('完成',now+600000),c=task('归档',now+600000)
    db.prepare('UPDATE tasks SET deadline_confirmed=0 WHERE id=?').run(a);tasks.completeTask(b,true);tasks.deleteTask(c);service.refreshAttention(now);assert.equal(state().unread,0)
    const d=task('已过很久',now-25*3600000);service.refreshAttention(now);assert.equal(state().unread,0);assert.ok(d)
  })
  await test('提醒每日配额和关闭开关生效，不消耗模型预算',()=>{
    reset();setSettings({notifyEnabled:true});savePreferences({...preferences(),reminderDailyLimit:1});task('提醒A',now+600000);task('提醒B',now+1200000);service.refreshAttention(now);assert.equal(state().messages.length,1);assert.equal(state().checksToday,0)
    setSettings({notifyEnabled:false});assert.equal(state().unread,0);assert.equal(state().messages[0].state,'cancelled')
  })
  await test('可选桌面通知按批汇总、冷却和持久去重，不为主动提问发通知',async()=>{
    reset();setSettings({notifyEnabled:true});savePreferences({...preferences(),desktopEnabled:true});task('桌面A',now+600000);task('桌面B',now+1200000);service.refreshAttention(now)
    const batch=service.desktopBatch(now)!;assert.equal(batch.messages.length,2);assert.equal(service.desktopBatch(now+1000),null);service.desktopResult(batch.id,'failed');assert.equal(state().messages.length,2)
    assert.equal(service.desktopBatch(now+6*60000),null)
    reset();savePreferences({...preferences(),desktopEnabled:true});course();await run();assert.equal(service.desktopBatch(now),null)
  })
  await test('对话桥接只准备Run，重复入口同一Run，网络在事务后启动',async()=>{
    reset();course();await run();const m=state().messages[0],before=tasks.listTasks().length
    const id=prepareMessageRun(m.id,'capture','完成第三次练习，30分钟，无硬截止',now),again=prepareMessageRun(m.id,'capture','第二次点击',now);assert.equal(id,again);assert.equal(tasks.listTasks().length,before)
    const source=db.prepare('SELECT evidence_ref FROM task_sources WHERE run_id=?').get(id) as {evidence_ref:string};assert.equal(source.evidence_ref,`attention:${m.id}`)
    let step=0;await drive(id,async(_s,msg)=>{if(step++===0)return call('create_task_draft',{content:'课后练习',estimateMin:30,deadlineMode:'none'});const d=JSON.parse(msg.at(-1)!.content!).data;return call('propose_task_draft',{draftId:d.id,expectedVersion:d.version})})
    const d=drafts.getDraft(store.getRun(id).draftId!);assert.equal(tasks.listTasks().length,before);confirmTaskDraft(d.id,d.version,true);ids.push(...drafts.getDraft(d.id).createdTaskIds);assert.equal(tasks.listTasks().length,before+1)
  })
  await test('消息关联失败不留下孤立Run，提醒讨论使用真实任务编号',async()=>{
    reset();course();await run();let m=state().messages[0];const count=(db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as {n:number}).n
    db.exec("CREATE TRIGGER reject_attention_link BEFORE UPDATE ON attention_messages WHEN NEW.run_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'link rollback'); END")
    try{assert.throws(()=>prepareMessageRun(m.id,'capture','新事项',now),/rollback/);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as {n:number}).n,count)}finally{db.exec('DROP TRIGGER reject_attention_link')}
    reset();const id=task();await run();m=state().messages[0];const runId=prepareMessageRun(m.id,'planning',undefined,now);assert.ok(store.getRun(runId).goal.includes(String(id)));assert.equal(planning.listBlocks().length,0)
  })
  await test('消息写入故障整体回滚，不产生半条红点或错误写任务',async()=>{
    reset();course();db.exec("CREATE TRIGGER reject_attention_message BEFORE INSERT ON attention_messages BEGIN SELECT RAISE(ABORT,'message rollback'); END")
    try{assert.equal(await run(),false);assert.equal(state().unread,0);assert.equal(state().messages.length,0)}finally{db.exec('DROP TRIGGER reject_attention_message')}
  })
  await test('时间提醒无网络时仍按时扫描，不进入自主检查队列',async()=>{
    reset();setSettings({notifyEnabled:true,aiApiKey:''});task('无模型提醒',now+600000);await tickAttention(model(),()=>now);assert.equal(state().messages.length,1);assert.equal(state().checksToday,0);setSettings({aiApiKey:'test-only-not-a-key'})
  })
  await test('关闭工作者中断在途调用并保留待处理队列，不发布迟到问题',async()=>{
    reset();course();let release:()=>void=()=>{},entered:()=>void=()=>{};const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r)
    const p=processAttention(async()=>{entered();await hold;return call('respond',{mode:'silent',text:'',eventKeys:[]})},()=>now);await ready;stopAttention();release();await p;assert.equal(state().unread,0);assert.equal(backgroundOccupied(),false);assert.equal(state().pending,1)
  })
  reset()
}
