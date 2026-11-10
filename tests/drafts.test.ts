import assert from 'node:assert/strict'
import {getDb} from '../src/main/db/database'
import * as tasks from '../src/main/db/taskDao'
import * as drafts from '../src/main/drafts/service'
import * as store from '../src/main/agent/store'
import {startCapture,startBatch,sendMessage,confirmTaskDraft,confirmChange,startMockReview,continueDraftPlan,drive} from '../src/main/agent/runner'
import {executeSceneTool,definitionsForScene,registerScene,registerTool} from '../src/main/agent/registry'
import {registerReviewProvider,startReviewProposal} from '../src/main/drafts/reviewBridge'
import * as planning from '../src/main/planning/service'
import {dateKey} from '../src/main/planning/engine'
import type {ModelMessage,ModelTransport} from '../src/main/agent/model'
type Test=(name:string,fn:()=>unknown|Promise<unknown>)=>Promise<void>
export async function draftTests(test:Test):Promise<void>{
  let serial=0
  const ownTaskIds:number[]=[]
  function call(name:string,args:object):ModelMessage{return{role:'assistant',content:null,tool_calls:[{id:`draft-${++serial}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}
  async function idle(id:string):Promise<void>{for(let i=0;i<200&&store.getRun(id).status==='running';i++)await new Promise(r=>setTimeout(r,2));assert.notEqual(store.getRun(id).status,'running')}
  function proposalTransport(title:string):ModelTransport{let n=0;return async(_s,m)=>{if(n++===0)return call('create_task_draft',{content:title,estimateMin:60,estimateGroup:'阶段4测试',deadlineMode:'none',category:'学习'});const d=JSON.parse(m.at(-1)!.content!).data;return call('propose_task_draft',{draftId:d.id,expectedVersion:d.version})}}
  await test('事项充分时不强制提问，确认前只有草案',async()=>{
    const before=tasks.listTasks().length,r=startCapture('整理测试笔记，预计60分钟，无硬截止',proposalTransport('D4-明确事项'));await idle(r.id)
    const run=store.getRun(r.id);assert.equal(run.scene,'capture');assert.equal(run.status,'awaiting_confirmation');assert.equal(tasks.listTasks().length,before)
    assert.equal(run.events.some(e=>e.kind==='tool'&&e.text.includes('ask_user')),false)
    assert.equal(drafts.getDraft(run.draftId!).sourceText,'整理测试笔记，预计60分钟，无硬截止')
    confirmTaskDraft(run.draftId!,drafts.getDraft(run.draftId!).version,true);const d=drafts.getDraft(run.draftId!);ownTaskIds.push(...d.createdTaskIds)
    assert.equal(d.createdTaskIds.length,1);assert.equal(tasks.getTaskById(d.createdTaskIds[0])!.deadlineConfirmed,true)
  })
  await test('模糊事项暂停澄清，回答后在同一运行创建草案',async()=>{
    const r=startCapture('学习第三章',async()=>call('ask_user',{question:'是阅读还是习题？'}));await idle(r.id);assert.equal(store.getRun(r.id).status,'waiting_user')
    sendMessage(r.id,'先阅读例题，预计90分钟，无硬截止',proposalTransport('D4-阅读例题'));await idle(r.id)
    assert.equal(store.getRun(r.id).status,'awaiting_confirmation');assert.ok(drafts.getDraft(store.getRun(r.id).draftId!).sourceText.includes('学习第三章'))
  })
  await test('模型重复增加同一候选不会重复，人工/导入重复行仍保留',()=>{
    const r=startBatch('重复事项\n重复事项');const d=drafts.getDraft(r.draftId!);assert.equal(d.items.length,2)
    const base=store.createRun('D4-去重',[{role:'user',content:'D4-去重'}],'capture')
    const first=drafts.addItem(base,{content:'D4-候选',estimateMin:30}),second=drafts.addItem(base,{content:'D4-候选',estimateMin:30})
    assert.equal(first.version,second.version);assert.equal(second.items.length,1)
  })
  await test('批量原文/排除项保留，称呼不直接成为正式任务',()=>{
    const r=startBatch('@所有人\n各位同学：\n11/06\nD4-交报告\nD4-复习');const d=drafts.getDraft(r.draftId!)
    assert.equal(d.items.length,5);assert.equal(d.items.filter(i=>i.included).length,2);assert.ok(d.sourceText.includes('@所有人'))
    const items=d.items.map(i=>({...i,deadlineMode:'none' as const})),saved=drafts.saveFromUI(d.id,d.version,items)
    confirmTaskDraft(d.id,saved.version,true);const ids=drafts.getDraft(d.id).createdTaskIds;ownTaskIds.push(...ids)
    assert.equal(ids.length,2);assert.ok(ids.every(id=>tasks.getTaskById(id)!.content.startsWith('D4-')))
  })
  await test('长行明确排除且完整原文不丢，超60行不创建运行',()=>{
    const raw='长'.repeat(600),r=startBatch(raw),d=drafts.getDraft(r.draftId!);assert.equal(d.sourceText,raw);assert.equal(d.items[0].included,false);assert.ok(d.items[0].note.includes('缩短'))
    const count=(getDb().prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as {n:number}).n
    assert.throws(()=>startBatch(Array(61).fill('一项').join('\n')),/60/);assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as {n:number}).n,count)
  })
  await test('草案修改持久化，旧版本保存/确认都被拒绝',()=>{
    const r=startBatch('D4-待修改'),d=drafts.getDraft(r.draftId!),items=d.items.map(i=>({...i,content:'D4-已修改',estimateMin:45,deadlineMode:'none' as const}))
    const saved=drafts.saveFromUI(d.id,d.version,items);assert.equal(drafts.getDraft(d.id).items[0].content,'D4-已修改')
    const revision=getDb().prepare('SELECT items_json,actor FROM task_draft_revisions WHERE draft_id=? AND version=?').get(d.id,saved.version) as {items_json:string;actor:string}
    assert.equal(revision.actor,'user');assert.ok(revision.items_json.includes('D4-已修改'))
    assert.ok((getDb().prepare('SELECT items_json FROM task_draft_revisions WHERE draft_id=? AND version=?').get(d.id,d.version) as {items_json:string}).items_json.includes('D4-待修改'))
    assert.throws(()=>drafts.saveFromUI(d.id,d.version,items),/变化/);assert.throws(()=>confirmChange(r.id,true,d.version),/版本/)
    confirmTaskDraft(d.id,saved.version,true);const created=drafts.getDraft(d.id);ownTaskIds.push(...created.createdTaskIds)
    assert.equal(tasks.getTaskById(created.createdTaskIds[0])!.estimateMin,45)
  })
  await test('重复确认/重读不重复建任务，来源链接一一对应',()=>{
    const r=startBatch('D4-唯一任务'),d=drafts.getDraft(r.draftId!);confirmTaskDraft(d.id,d.version,true);const a=drafts.getDraft(d.id)
    confirmTaskDraft(d.id,d.version,true);const again=drafts.commit(r.id,d.id,d.version);assert.deepEqual(again.taskIds,a.createdTaskIds);ownTaskIds.push(...a.createdTaskIds)
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM task_draft_links WHERE draft_id=?').get(d.id) as {n:number}).n,1)
  })
  await test('批量交接按指定ID完整读取，不被默认10项截断',()=>{
    const r=startBatch(Array.from({length:12},(_,i)=>`D4-批量交接${i+1}`).join('\n')),d=drafts.getDraft(r.draftId!)
    const saved=drafts.saveFromUI(d.id,d.version,d.items.map(i=>({...i,deadlineMode:'none' as const})))
    confirmTaskDraft(d.id,saved.version,true);const ids=drafts.getDraft(d.id).createdTaskIds;ownTaskIds.push(...ids)
    const observed=new Map<number,string>(),result=executeSceneTool('capture','list_tasks',JSON.stringify({taskIds:ids}),{runId:r.id,observed})
    assert.equal(result.ok,true);assert.equal((result.data as {tasks:unknown[]}).tasks.length,12);assert.equal(observed.size,12)
  })
  await test('未知耗时阻止创建，未知截止保留但不伪造',()=>{
    const id=store.createRun('D4-未知',[{role:'user',content:'D4-未知'}],'capture'),d=drafts.addItem(id,{content:'D4-未知'})
    assert.throws(()=>drafts.commit(id,d.id,d.version),/耗时/)
    const edited=drafts.patchItem(id,d.id,d.version,d.items[0].id,{estimateMin:30});const result=drafts.commit(id,d.id,edited.version);ownTaskIds.push(...result.taskIds)
    assert.equal(tasks.getTaskById(result.taskIds[0])!.deadlineAt,null);assert.equal(tasks.getTaskById(result.taskIds[0])!.deadlineConfirmed,false)
  })
  await test('截止与执行窗口分别保存，修改草案不碰已有任务',()=>{
    const id=store.createRun('D4-时间',[{role:'user',content:'D4-时间'}],'capture'),before=tasks.listTasks().length
    const d=drafts.addItem(id,{content:'D4-不同时间',estimateMin:60,deadlineMode:'set',deadlineAt:'2030-01-09T18:00:00+08:00',windowStart:'2030-01-07',windowEnd:'2030-01-08'})
    assert.equal(tasks.listTasks().length,before);const result=drafts.commit(id,d.id,d.version);ownTaskIds.push(...result.taskIds)
    const t=tasks.getTaskById(result.taskIds[0])!;assert.equal(t.rangeEnd,'2030-01-08');assert.equal(t.deadlineAt,'2030-01-09T10:00:00.000Z')
  })
  await test('草案来源/版本越权、非法嵌套字段被阻止',()=>{
    const r=startBatch('D4-归属'),d=drafts.getDraft(r.draftId!),other=store.createRun('other',[])
    assert.throws(()=>drafts.patchItem(other,d.id,d.version,d.items[0].id,{content:'覆盖'}),/归属/)
    const result=executeSceneTool('capture','update_task_draft',JSON.stringify({draftId:d.id,expectedVersion:d.version,itemId:d.items[0].id,patch:{sourceRef:'forged'}}),{observed:new Map(),runId:r.id})
    assert.equal(result.errorCode,'INVALID_ARGUMENTS')
    assert.throws(()=>drafts.saveFromUI(d.id,d.version,[{...d.items[0],id:'forged'}]),/身份/)
  })
  await test('草案确认写入中断时任务和链接整体回滚',()=>{
    const r=startBatch('D4-回滚任务'),d=drafts.getDraft(r.draftId!),before=tasks.listTasks().length
    getDb().exec("CREATE TRIGGER reject_draft_link BEFORE INSERT ON task_draft_links BEGIN SELECT RAISE(ABORT,'test rollback'); END")
    try{const result=confirmTaskDraft(d.id,d.version,true);assert.equal(result.status,'failed');assert.equal(tasks.listTasks().length,before);assert.equal(drafts.getDraft(d.id).state,'editing')}
    finally{getDb().exec('DROP TRIGGER reject_draft_link')}
  })
  await test('停止运行保留草案，放弃草案不创建任务',()=>{
    const r=startBatch('D4-放弃'),d=drafts.getDraft(r.draftId!);confirmTaskDraft(d.id,d.version,false);assert.equal(drafts.getDraft(d.id).state,'discarded');assert.equal(drafts.getDraft(d.id).createdTaskIds.length,0)
  })
  await test('放弃后再录入重新开始，而不是卡在"已放弃"',()=>{
    const before=tasks.listTasks().length
    const r=startBatch('D4-放弃后重来'),d=drafts.getDraft(r.draftId!)
    confirmTaskDraft(d.id,d.version,false)
    const again=drafts.addItem(r.id,{content:'D4-放弃后新增',estimateMin:30,estimateGroup:'阶段4测试',deadlineMode:'none'})
    assert.equal(again.state,'editing');assert.deepEqual(again.items.map(i=>i.content),['D4-放弃后新增'])
    assert.ok(again.version>d.version,'重开要产生新版本，旧卡片不能继续生效')
    assert.equal(tasks.listTasks().length,before)
  })
  await test('同一对话里放弃草案后，模型能重新提交整份计划',async()=>{
    const before=tasks.listTasks().length
    const items=Array.from({length:3},(_,i)=>({content:`D4-重建计划${i+1}`,estimateMin:40,estimateGroup:'阶段4测试',deadlineMode:'none',category:'学习'}))
    const submit=():ModelTransport=>{let step=0;return async(_s,m)=>{
      if(step++===0)return call('create_task_drafts',{items})
      const d=JSON.parse(m.at(-1)!.content!).data
      return call('propose_task_draft',{draftId:d.id,expectedVersion:d.version})
    }}
    const r=startCapture('D4-重建计划',submit());await idle(r.id)
    const first=store.getRun(r.id),draftId=first.draftId!
    confirmTaskDraft(draftId,drafts.getDraft(draftId).version,false)
    assert.equal(store.getRun(r.id).status,'completed')
    assert.equal(drafts.getDraft(draftId).state,'discarded')
    sendMessage(r.id,'换成按章拆分的复习计划',submit());await idle(r.id)
    const run=store.getRun(r.id)
    assert.equal(run.status,'awaiting_confirmation','放弃后必须还能提出新草案')
    assert.equal(run.draftId,draftId,'同一对话仍只有一份草案')
    assert.equal(drafts.getDraft(draftId).items.length,3)
    assert.equal(tasks.listTasks().length,before)
  })
  await test('场景白名单不暴露其他写工具，不能伪造用户确认',()=>{
    const r=startMockReview(),before=tasks.listTasks().length
    assert.equal(definitionsForScene('study_mock').some(d=>d.function.name==='propose_memory'),false)
    assert.equal(executeSceneTool('study_mock','propose_memory',JSON.stringify({scope:'全局',key:'x',value:'y'}),{observed:new Map(),runId:r.id}).errorCode,'TOOL_NOT_ALLOWED')
    assert.equal(executeSceneTool('study_mock','create_task_draft',JSON.stringify({content:'x',confirmed:true}),{observed:new Map(),runId:r.id}).errorCode,'INVALID_ARGUMENTS')
    assert.equal(tasks.listTasks().length,before)
    assert.equal(executeSceneTool('planning','propose_memory',JSON.stringify({scope:'全局',key:'x',value:'y'}),{observed:new Map(),runId:r.id}).errorCode,'INVALID_CONTEXT')
  })
  await test('模块注册拒绝重名、未知工具和未支持的Schema',()=>{
    assert.throws(()=>registerScene({id:'planning',title:'overwrite',instructions:'',tools:[],confirmationKinds:[]}),/重复/)
    assert.throws(()=>registerScene({id:'bad_scene',title:'bad',instructions:'',tools:['not_registered'],confirmationKinds:[]}),/未注册/)
    assert.throws(()=>registerTool({effect:'read',definition:{type:'function',function:{name:'bad_schema',description:'test',parameters:{type:'object',properties:{},additionalProperties:false,oneOf:[]}}},execute:()=>({ok:true})}),/Schema/)
    registerReviewProvider({id:'invalid_evidence',getProposal:key=>({key,scene:'study_mock',title:'invalid',evidence:[{id:'',title:'bad',text:'bad'}],items:[{content:'bad',estimateMin:30}]})})
    assert.throws(()=>startReviewProposal('invalid_evidence','one'),/协议/)
  })
  await test('独立模块可注册工具/场景并通过同一循环运行',async()=>{
    registerTool({effect:'read',definition:{type:'function',function:{name:'test_study_read',description:'固定模块数据',parameters:{type:'object',properties:{},additionalProperties:false}}},execute:()=>({ok:true,data:{evidence:'module-fixture-v1'}})})
    registerScene({id:'test_study',title:'测试学习模块',instructions:'只读固定数据',tools:['test_study_read','respond'],confirmationKinds:[]})
    const id=store.createRun('模块测试',[{role:'system',content:''},{role:'user',content:'模块测试'}],'test_study');let step=0
    await drive(id,async(_s,m,defs)=>{assert.equal(defs.some(d=>d.function.name==='get_calendar'),false);if(step++===0)return call('test_study_read',{});assert.ok(m.at(-1)!.content!.includes('module-fixture-v1'));return call('respond',{mode:'answer',text:'已读取模块数据'})})
    assert.equal(store.getRun(id).status,'completed')
  })
  await test('模拟作业来源→确认创建→共享规划→计划保存，重复入口不重复',async()=>{
    const a=startMockReview(),b=startMockReview();assert.equal(a.id,b.id);const d=drafts.getDraft(a.draftId!)
    assert.equal(d.sourceKind,'mock_study');assert.ok(d.sourceText.includes('固定测试数据'))
    confirmTaskDraft(d.id,d.version,true);const saved=drafts.getDraft(d.id);ownTaskIds.push(...saved.createdTaskIds)
    assert.ok(saved.createdTaskIds.length);let step=0
    const tomorrow=dateKey(Date.now()+86400000)
    const model:ModelTransport=async(_s,m)=>{if(step++===0)return call('list_tasks',{taskIds:saved.createdTaskIds,status:'active'});if(step===2)return call('preview_plan',{taskIds:saved.createdTaskIds,startDate:tomorrow,endDate:tomorrow});const p=JSON.parse(m.at(-1)!.content!).data;return call('propose_plan',{previewId:p.previewId})}
    const r=continueDraftPlan(d.id,model),same=continueDraftPlan(d.id,model);assert.equal(r.id,same.id);await idle(r.id);assert.equal(store.getRun(r.id).status,'awaiting_confirmation');confirmChange(r.id,true)
    assert.ok(planning.listBlocks().some(p=>p.taskId===saved.createdTaskIds[0]));assert.equal(tasks.getTaskById(saved.createdTaskIds[0])!.deadlineAt,null)
    assert.throws(()=>registerReviewProvider({id:'mock_study',getProposal:()=>{throw new Error()}}),/重复/)
  })
  await test('整份计划用批量工具一次提交，不逐条调用',async()=>{
    const before=tasks.listTasks().length
    let steps=0,toolCalls=0
    const model:ModelTransport=async(_s,m)=>{
      toolCalls++
      if(steps++===0){
        const items=Array.from({length:8},(_,i)=>({content:`D4-第${i+1}章复习`,estimateMin:60,estimateGroup:'数学分析',deadlineMode:'none',category:'学习'}))
        return call('create_task_drafts',{items})
      }
      const d=JSON.parse(m.at(-1)!.content!).data
      return call('propose_task_draft',{draftId:d.id,expectedVersion:d.version})
    }
    const r=startCapture('按教材八章安排复习',model);await idle(r.id)
    const run=store.getRun(r.id)
    assert.equal(toolCalls,2,'八条计划应两轮完成，而不是九轮')
    assert.equal(run.status,'awaiting_confirmation')
    assert.equal(drafts.getDraft(run.draftId!).items.length,8)
    assert.equal(tasks.listTasks().length,before,'确认前不创建正式任务')
  })
  await test('批量提交超过12条或空数组会被拒绝',()=>{
    const run=store.createRun('D4-批量上限',[{role:'user',content:'D4-批量上限'}],'capture')
    const many=Array.from({length:13},(_,i)=>({content:`D4-超额${i}`}))
    assert.throws(()=>drafts.addItems(run,many),/12/)
    assert.throws(()=>drafts.addItems(run,[]),/至少提交1条/)
  })
  getDb().prepare('DELETE FROM plan_blocks WHERE task_id IN (SELECT task_id FROM task_draft_links)').run()
  ownTaskIds.forEach(id=>tasks.deleteTask(id))
}
