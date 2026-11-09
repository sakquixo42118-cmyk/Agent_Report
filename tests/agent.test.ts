import { app } from 'electron'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, closeDb } from '../src/main/db/database'
import { runMigrations } from '../src/main/db/migrations'
import { getSettings, setSettings } from '../src/main/db/settingsDao'
import * as tasks from '../src/main/db/taskDao'
import * as store from '../src/main/agent/store'
import { drive, confirmChange, sendMessage, cancelRun, startCapture, confirmTaskDraft, continueDraftPlan } from '../src/main/agent/runner'
import { executeTool } from '../src/main/agent/tools'
import { computeScore, isOverdue } from '../src/shared/priority'
import { extractDueDate } from '../src/main/ai/rules'
import type { ModelMessage, ModelTransport } from '../src/main/agent/model'
import { planningTests } from './planning.test'
import * as planning from '../src/main/planning/service'
import { dateKey, at } from '../src/main/planning/engine'
import { profileTests } from './profile.test'
import * as memory from '../src/main/memory/service'
import * as feedback from '../src/main/feedback/service'
import { processNext } from '../src/main/feedback/worker'
import { draftTests } from './drafts.test'
import { constraintsTests } from './constraints.test'
import { statisticsTests } from './statistics.test'
import * as statistics from '../src/main/statistics/service'
import * as drafts from '../src/main/drafts/service'
import { registerReviewProvider, startReviewProposal } from '../src/main/drafts/reviewBridge'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'suishou-agent-tests-')))
let passed = 0
async function test(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  await fn(); passed++; console.log(`PASS ${name}`)
}
function seed(content: string): number {
  const task = tasks.createTask({ content })
  tasks.applyAnalysis(task.id, { summary: content, importance: 3, urgency: 3, category: '学习', tags: [], estimateMin: 30, dueAt: null }, 'none')
  return task.id
}
let callCounter = 0
function call(name: string, args: object): ModelMessage {
  return { role: 'assistant', content: null, tool_calls: [{ id: `test-${++callCounter}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}
function create(goal = '测试任务'): string { return store.createRun(goal, [{ role: 'system', content: '' }, { role: 'user', content: goal }]) }
const configured = { aiBaseUrl: 'https://test.invalid/v1', aiApiKey: 'test-only-not-a-key', aiModel: 'mock' }

app.whenReady().then(async () => {
  try {
    setSettings(configured)
    const taskId = seed('测试报告'), otherId = seed('另一份报告')
    await test('迁移至v11且重复执行不破坏数据', () => { runMigrations(getDb()); assert.equal(getDb().pragma('user_version', { simple: true }), 11); assert.ok(tasks.getTaskById(taskId)) })
    await test('带截止的过期判定不抛异常', () => { assert.equal(isOverdue({ dueAt: '2026-01-01T12:00:00' }, new Date('2026-01-02').getTime()), true); assert.equal(isOverdue({ dueAt: null }), false); assert.ok(Number.isFinite(computeScore(tasks.getTaskById(taskId)!))) })
    await test('明天下午与分钟日期解析', () => { const now = new Date(2026, 10, 5, 10); assert.equal(extractDueDate('明天下午3:30交报告', now), '2026-11-06T15:30:00'); assert.equal(extractDueDate('明天27:00', now), null) })
    await test('自动重评不锁定、人工修改锁定', () => { tasks.updateTask({ id: taskId, importance: 4 }, 'review'); assert.equal(tasks.getTaskById(taskId)!.manualLocked, false); tasks.updateTask({ id: otherId, importance: 4 }); assert.equal(tasks.getTaskById(otherId)!.manualLocked, true) })
    await test('工具拒绝未知名称、越界参数和多余字段', () => {
      const ctx = { observed: new Map<number, string>() }
      assert.equal(executeTool('raw_sql', '{}', ctx).errorCode, 'UNKNOWN_TOOL')
      assert.equal(executeTool('list_tasks', '{"limit":100}', ctx).errorCode, 'INVALID_ARGUMENTS')
      assert.equal(executeTool('get_task', '{"taskId":1,"confirmed":true}', ctx).errorCode, 'INVALID_ARGUMENTS')
      assert.equal(executeTool('get_task', '{broken', ctx).errorCode, 'INVALID_ARGUMENTS')
      assert.equal(executeTool('get_task', '{"taskId":"1"}', ctx).errorCode, 'INVALID_ARGUMENTS')
    })
    await test('查询将特殊字符当内容，不返回设置密钥', () => {
      const result = executeTool('list_tasks', JSON.stringify({ query: "' OR 1=1--" }), { observed: new Map() })
      assert.deepEqual((result.data as { tasks: unknown[] }).tasks, [])
      assert.equal(JSON.stringify(executeTool('list_tasks', '{}', { observed: new Map() })).includes(configured.aiApiKey), false)
    })
    await test('没有本轮读取证据不能提出写入草案', () => {
      const current = tasks.getTaskById(taskId)!
      assert.equal(executeTool('propose_priority_change', JSON.stringify({ taskId, importance: 5, expectedUpdatedAt: current.updatedAt, reason: '测试' }), { observed: new Map() }).errorCode, 'READ_REQUIRED')
    })
    let proposalRun = ''
    await test('真实DAO读取结果回传后产生草案，确认前不写入', async () => {
      const before = tasks.getTaskById(taskId)!
      let round = 0
      const model: ModelTransport = async (_s, messages) => {
        if (round++ === 0) return call('get_task', { taskId })
        const observation = JSON.parse(messages.at(-1)!.content!)
        assert.equal(observation.data.id, taskId)
        return call('propose_priority_change', { taskId, importance: 5, expectedUpdatedAt: observation.data.updatedAt, reason: '用户要求' })
      }
      proposalRun = create('把报告重要度改为5')
      await drive(proposalRun, model)
      assert.equal(store.getRun(proposalRun).status, 'awaiting_confirmation')
      assert.equal(tasks.getTaskById(taskId)!.importance, before.importance)
      assert.equal(store.getRun(proposalRun).events.filter(e => e.kind === 'tool').length, 2)
    })
    await test('确认短事务保存，重复确认不重复写入', () => {
      confirmChange(proposalRun, true); confirmChange(proposalRun, true)
      assert.equal(tasks.getTaskById(taskId)!.importance, 5)
      assert.equal(tasks.getTaskById(taskId)!.manualLocked, true)
      assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_actions WHERE run_id=?').get(proposalRun) as { count: number }).count, 1)
    })
    await test('放弃草案不改变任务', async () => {
      const run = create(), current = tasks.getTaskById(taskId)!
      const ctx = { observed: new Map<number, string>() }; executeTool('get_task', JSON.stringify({ taskId }), ctx)
      const result = executeTool('propose_priority_change', JSON.stringify({ taskId, importance: 2, expectedUpdatedAt: current.updatedAt, reason: '新请求' }), ctx)
      store.save(run, [], 'awaiting_confirmation', result.pending!)
      confirmChange(run, false)
      assert.equal(tasks.getTaskById(taskId)!.importance, 5)
    })
    await test('同一对话可确认不同草案，幂等键不误复用', () => {
      for (const importance of [2, 5]) {
        const ctx = { observed: new Map<number, string>() }, current = tasks.getTaskById(taskId)!
        executeTool('get_task', JSON.stringify({ taskId }), ctx)
        const result = executeTool('propose_priority_change', JSON.stringify({ taskId, importance, expectedUpdatedAt: current.updatedAt, reason: '后续请求' }), ctx)
        const messages = JSON.parse(store.row(proposalRun).messages_json)
        store.save(proposalRun, messages, 'awaiting_confirmation', result.pending!)
        confirmChange(proposalRun, true)
        assert.equal(tasks.getTaskById(taskId)!.importance, importance)
      }
      assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_actions WHERE run_id=?').get(proposalRun) as { count: number }).count, 3)
    })
    await test('确认事务中审计写入失败会回滚任务修改', () => {
      const run = create(), ctx = { observed: new Map<number, string>() }, current = tasks.getTaskById(taskId)!
      executeTool('get_task', JSON.stringify({ taskId }), ctx)
      const result = executeTool('propose_priority_change', JSON.stringify({ taskId, urgency: 5, expectedUpdatedAt: current.updatedAt, reason: '回滚测试' }), ctx)
      store.save(run, [], 'awaiting_confirmation', result.pending!)
      getDb().exec("CREATE TRIGGER test_action_abort BEFORE INSERT ON agent_actions BEGIN SELECT RAISE(ABORT,'test rollback'); END")
      try { assert.equal(confirmChange(run, true).status, 'failed'); assert.equal(tasks.getTaskById(taskId)!.urgency, current.urgency) }
      finally { getDb().exec('DROP TRIGGER test_action_abort') }
    })
    await test('并发修改导致草案失效且不覆盖', async () => {
      const run = create(), ctx = { observed: new Map<number, string>() }, current = tasks.getTaskById(taskId)!
      executeTool('get_task', JSON.stringify({ taskId }), ctx)
      const result = executeTool('propose_priority_change', JSON.stringify({ taskId, urgency: 5, expectedUpdatedAt: current.updatedAt, reason: '测试' }), ctx)
      store.save(run, [], 'awaiting_confirmation', result.pending!)
      tasks.updateTask({ id: taskId, importance: 1 })
      assert.equal(confirmChange(run, true).status, 'failed')
      assert.equal(tasks.getTaskById(taskId)!.importance, 1)
      assert.equal(tasks.getTaskById(taskId)!.urgency, 3)
    })
    await test('工具失败观察可以驱动后续纠正调用', async () => {
      const run = create(); let step = 0
      await drive(run, async (_s, messages) => {
        if (step++ === 0) return call('unknown', {})
        if (step === 2) { assert.equal(JSON.parse(messages.at(-1)!.content!).errorCode, 'UNKNOWN_TOOL'); return call('list_tasks', { limit: 2 }) }
        return call('finish_reply', { text: '已查到任务。' })
      })
      assert.equal(store.getRun(run).status, 'completed')
    })
    await test('暂停问题与恢复上下文可读取', async () => {
      const run = create('提高优先级')
      await drive(run, async () => call('ask_user', { question: '你想调重要度还是紧急度？' }))
      assert.equal(store.getRun(run).status, 'waiting_user')
      let receivedAnswer = false
      sendMessage(run, '重要度', async (_s, messages) => { receivedAnswer = messages.at(-1)!.content === '重要度'; return call('finish_reply', { text: '收到。' }) })
      for (let i = 0; i < 100 && store.getRun(run).status === 'running'; i++) await new Promise(r => setTimeout(r, 2))
      assert.equal(receivedAnswer, true); assert.equal(store.getRun(run).status, 'completed')
    })
    await test('连续工具调用达到预算后停止', async () => {
      const run = create(); await drive(run, async () => call('list_tasks', { limit: 1 }))
      assert.equal(store.getRun(run).status, 'failed'); assert.ok(store.getRun(run).events.some(e => e.text.includes('8次')))
    })
    await test('普通文本结束会要求模型纠正为结构化等待动作', async () => {
      const run = create(); let round = 0
      await drive(run, async (_s, messages, _tools, _signal, control) => {
        if (round++ === 0) return { role: 'assistant', content: '你指哪一个任务？' }
        assert.equal(messages.at(-1)!.role, 'system')
        assert.equal(control?.forceResponse, true)
        return call('respond', { mode: 'question', text: '你指哪一个任务？' })
      })
      assert.equal(store.getRun(run).status, 'waiting_user')
    })
    await test('取消运行后迟到模型响应不执行工具', async () => {
      const run = create(); let resolve!: (m: ModelMessage) => void
      const future = drive(run, async () => new Promise<ModelMessage>(r => { resolve = r }))
      cancelRun(run); resolve(call('list_tasks', {})); await future
      assert.equal(store.getRun(run).status, 'cancelled'); assert.equal(store.getRun(run).events.some(e => e.kind === 'tool'), false)
    })
    await test('中断恢复移除未配齐的工具请求并保留用户目标', () => {
      const run = create('恢复测试'); store.save(run, [{ role: 'system', content: '' }, { role: 'user', content: '恢复测试' }, call('get_task', { taskId })], 'running')
      store.recoverInterruptedRuns(); assert.equal(store.getRun(run).status, 'failed'); assert.equal(JSON.parse(store.row(run).messages_json).length, 2)
    })
    await planningTests(test)
    await profileTests(test)
    await draftTests(test)
    await constraintsTests(test)
    await statisticsTests(test)
    if (process.argv.includes('--live')) {
      const keyFile = process.env.AGENT_TEST_KEY_FILE
      if (!keyFile) throw new Error('真实验证需要AGENT_TEST_KEY_FILE。')
      const key = readFileSync(keyFile, 'utf8').match(/sk-[A-Za-z0-9_.-]+/)?.[0]
      if (!key) throw new Error('未读到凭据。')
      setSettings({ aiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', aiApiKey: key, aiModel: 'qwen-plus' })
      if (!process.argv.includes('--profile-live')&&!process.argv.includes('--capture-live')&&!process.argv.includes('--scheduling-live')&&!process.argv.includes('--statistics-live')) {
      await test('真实千问原生工具查询并回传结果', async () => {
        const run = create('请查询当前未完成任务，只列出任务名，不修改数据。')
        await drive(run)
        const result = store.getRun(run)
        assert.equal(result.status, 'completed', result.events.filter(e => e.kind === 'status').map(e => e.text).join())
        assert.ok(result.events.some(e => e.kind === 'tool' && e.text.includes('list_tasks')))
        assert.ok(result.events.some(e => e.kind === 'assistant' && e.text.includes('报告')))
      })
      await test('真实千问生成评分草案，用户确认后才写入', async () => {
        const previous = tasks.getTaskById(taskId)!.urgency
        const run = create('把“测试报告”的紧急度改成5。')
        await drive(run)
        assert.equal(store.getRun(run).status, 'awaiting_confirmation', JSON.stringify(store.getRun(run).events))
        assert.equal(tasks.getTaskById(taskId)!.urgency, previous)
        assert.equal(store.getRun(run).pending!.taskId, taskId)
        confirmChange(run, true)
        assert.equal(tasks.getTaskById(taskId)!.urgency, 5)
      })
      await test('真实千问对报告指代不明提出澄清', async () => {
        const run = create('把报告的优先级提高一些。')
        await drive(run)
        assert.equal(store.getRun(run).status, 'waiting_user', JSON.stringify(store.getRun(run).events))
        assert.ok(store.getRun(run).events.some(e => e.kind === 'tool' && (e.text.includes('ask_user') || e.text.includes('respond'))))
      })
      await test('真实千问按明日下午课表试排，确认后写执行块且不改截止', async () => {
        const tomorrow = dateKey(Date.now() + 86400000)
        planning.saveSettings({ startMin: 480, endMin: 1320, dailyMaxMin: 240, breakMin: 10 })
        planning.saveCourse({ name: '演示课', weekday: new Date(`${tomorrow}T12:00:00`).getDay() || 7, startMin: 720, endMin: 840, fromDate: tomorrow, toDate: tomorrow })
        const deadline = new Date(at(tomorrow, 1080)).toISOString()
        tasks.updateTask({ id: taskId, deadlineAt: deadline })
        const run = create('把“测试报告”安排到明天下午，避开课表，给我计划草案确认。')
        await drive(run)
        const result = store.getRun(run)
        assert.equal(result.status, 'awaiting_confirmation', JSON.stringify(result.events))
        assert.ok(result.pending && 'type' in result.pending)
        if (!result.pending || !('type' in result.pending)) throw new Error('缺少计划草案')
        assert.equal(result.pending.preview.blocks.length, 1)
        assert.equal(result.pending.preview.blocks[0].taskId, taskId)
        assert.ok(result.pending.preview.blocks[0].start >= at(tomorrow, 840))
        assert.ok(result.pending.preview.blocks[0].end <= at(tomorrow, 1080))
        assert.equal(planning.listBlocks().length, 0)
        assert.equal(confirmChange(run, true).status, 'completed')
        assert.equal(planning.listBlocks().length, 1)
        assert.equal(tasks.getTaskById(taskId)!.deadlineAt, deadline)
      })
      await test('真实千问读取不可行试排反馈，不伪造安排或修改截止', async () => {
        const tomorrow = dateKey(Date.now() + 86400000), id = seed('不可行演示任务')
        const deadline = new Date(at(tomorrow, 735)).toISOString()
        tasks.updateTask({ id, deadlineAt: deadline })
        const run = create('把“不可行演示任务”安排到明天下午，截止时间不能更改。请实际试排；放不下就说明原因，不要提交计划。')
        await drive(run)
        const result = store.getRun(run)
        assert.ok(['completed', 'waiting_user'].includes(result.status), JSON.stringify(result.events))
        assert.ok(result.events.some(e => e.kind === 'tool' && e.text.includes('preview_plan') && e.text.includes('unscheduled')))
        assert.equal(result.pending, null); assert.equal(planning.listBlocks().some(b => b.taskId === id), false)
        assert.equal(tasks.getTaskById(id)!.deadlineAt, deadline)
      })
      }
      if(!process.argv.includes('--capture-live')&&!process.argv.includes('--scheduling-live')&&!process.argv.includes('--statistics-live')) {
      await test('真实千问按需检索确认记忆并使用来源回答', async () => {
        memory.saveFact({ scope: '数学分析', key: '学习阶段', value: '数学分析目前初学，需要先理解例题' }, null)
        const run = create('我确认过的数学分析学习阶段是什么？请先检索个人记忆，不要猜。')
        await drive(run)
        const result=store.getRun(run)
        assert.ok(['completed','waiting_user'].includes(result.status),JSON.stringify(result.events))
        assert.ok(result.events.some(e=>e.kind==='tool'&&e.text.includes('search_memory')&&e.text.includes('memory:')))
        assert.ok(result.events.some(e=>e.kind==='assistant'&&e.text.includes('初学')),JSON.stringify(result.events))
      })
      await test('真实千问读取个人耗时校准，不反复乘系数', async () => {
        for(let i=0;i<5;i++) {
          const id=seed(`真实验证-历史${i}`); tasks.updateTask({id,estimateMin:60,estimateGroup:'数学分析'}); tasks.completeTask(id,true)
          const event=feedback.completionForTask(id)!.event
          feedback.submitFeedback({eventId:event.id,actualMin:90,difficulty:'fit',interrupted:false,scopeChanged:false,note:''})
        }
        const id=seed('个人估时演示');tasks.updateTask({id,estimateMin:60,estimateGroup:'数学分析'})
        const run=create('请查询“个人估时演示”并使用estimate_duration工具，告诉我个人校准建议多少分钟，不修改数据。')
        await drive(run); const result=store.getRun(run)
        assert.ok(['completed','waiting_user'].includes(result.status),JSON.stringify(result.events))
        assert.ok(result.events.some(e=>e.kind==='tool'&&e.text.includes('estimate_duration')))
        assert.ok(result.events.some(e=>e.kind==='assistant'&&e.text.includes('75')))
        assert.equal(tasks.getTaskById(id)!.baseEstimateMin,60)
      })
      await test('真实千问后台自主选择追问或静默，完成不受影响', async () => {
        const id=seed('初次学习微积分第三章例题'); tasks.updateTask({id,estimateMin:60,estimateGroup:'微积分'}); tasks.completeTask(id,true)
        const event=feedback.completionForTask(id)!.event
        await processNext()
        const job=getDb().prepare('SELECT status FROM completion_jobs WHERE event_id=?').get(event.id) as {status:string}
        assert.ok(['asked','silent'].includes(job.status),job.status)
        assert.equal(tasks.getTaskById(id)!.status,'done')
        const messages=feedback.profileState().messages.filter(m=>m.eventId===event.id)
        assert.equal(messages.length,job.status==='asked'?1:0)
        console.log(`LIVE completion decision=${job.status}`)
      })
      }
      if(!process.argv.includes('--profile-live')&&!process.argv.includes('--scheduling-live')&&!process.argv.includes('--statistics-live')) {
      async function waitRun(id:string):Promise<ReturnType<typeof store.getRun>>{
        for(let i=0;i<600&&store.getRun(id).status==='running';i++)await new Promise(r=>setTimeout(r,100))
        return store.getRun(id)
      }
      await test('真实千问明确事项建草案，确认后唯一创建',async()=>{
        const before=tasks.listTasks().length,r=startCapture('帮我记录“整理阶段四测试笔记”，预计30分钟，无硬截止，分组为阶段四测试。请直接形成草案给我核对。')
        const state=await waitRun(r.id);assert.equal(state.status,'awaiting_confirmation',JSON.stringify(state.events));assert.ok(state.draftId)
        const d=drafts.getDraft(state.draftId!);assert.equal(tasks.listTasks().length,before);assert.equal(d.items[0].estimateMin,30)
        confirmTaskDraft(d.id,d.version,true);assert.equal(drafts.getDraft(d.id).createdTaskIds.length,1)
      })
      await test('真实千问模糊录入澄清、回答后创建并修改草案',async()=>{
        const before=tasks.listTasks().length,r=startCapture('我想学完数学分析第三章，但还没确定是只阅读例题还是做全部习题。请先问清范围，暂不估时、不创建事项。')
        let state=await waitRun(r.id);assert.equal(state.status,'waiting_user',JSON.stringify(state.events));assert.equal(tasks.listTasks().length,before)
        sendMessage(r.id,'只阅读例题，预计60分钟，无硬截止，分组为数学分析。请生成待确认草案。')
        state=await waitRun(r.id);assert.equal(state.status,'awaiting_confirmation',JSON.stringify(state.events));const d=drafts.getDraft(state.draftId!);assert.equal(d.items[0].estimateMin,60)
        sendMessage(r.id,'请把当前草案的预计耗时改为45分钟，其他不变，仍先给我核对，不要创建正式任务。')
        state=await waitRun(r.id);assert.equal(state.status,'awaiting_confirmation',JSON.stringify(state.events));assert.equal(drafts.getDraft(d.id).items[0].estimateMin,45);assert.equal(tasks.listTasks().length,before)
      })
      await test('模拟模块草案确认后转真实千问规划，截止保持独立',async()=>{
        registerReviewProvider({id:'live_mock',simulated:true,getProposal:key=>({key,scene:'study_mock',title:'模拟复习对接',evidence:[{id:'fixture-live-v1',title:'固定测试证据',text:'模拟换行忘记变号'}],items:[{content:'真实接口验证-重做行列式原题',estimateMin:30,estimateGroup:'线性代数',deadlineMode:'none',category:'学习'}]})})
        const id=startReviewProposal('live_mock','case-v1'),d=drafts.getDraft(store.getRun(id).draftId!);confirmTaskDraft(d.id,d.version,true)
        const r=continueDraftPlan(d.id),state=await waitRun(r.id);assert.equal(state.status,'awaiting_confirmation',JSON.stringify(state.events));assert.ok(state.pending&&'type' in state.pending&&state.pending.type==='plan')
        assert.equal(confirmChange(r.id,true).status,'completed');assert.equal(tasks.getTaskById(drafts.getDraft(d.id).createdTaskIds[0])!.deadlineAt,null)
      })
      }
      if(!process.argv.includes('--profile-live')&&!process.argv.includes('--capture-live')&&!process.argv.includes('--statistics-live')) {
      await test('真实千问遵守停补课、临时占用、轻量容量和前置顺序试排',async()=>{
        const db=getDb(),day=dateKey(Date.now()+86400000)
        db.exec('DELETE FROM plan_blocks; DELETE FROM calendar_exceptions; DELETE FROM day_overrides; DELETE FROM task_dependencies; DELETE FROM calendar_courses;')
        planning.saveSettings({startMin:480,endMin:1320,dailyMaxMin:240,breakMin:15})
        planning.saveCourse({name:'P5实测课程',weekday:new Date(`${day}T12:00:00`).getDay()||7,startMin:540,endMin:600,fromDate:day,toDate:day})
        const c=planning.listCourses()[0].id
        planning.saveException({kind:'cancel_course',courseId:c,date:day,name:'',startMin:0,endMin:1})
        planning.saveException({kind:'makeup_course',courseId:c,date:day,name:'',startMin:600,endMin:660})
        planning.saveException({kind:'busy',courseId:null,date:day,name:'P5实测临时占用',startMin:480,endMin:540})
        planning.saveDayOverride({date:day,mode:'light',dailyMaxMin:null,startMin:null,endMin:null,note:'合成验收数据'})
        const a=seed('P5实测先读例题'),b=seed('P5实测再做练习')
        tasks.updateTask({id:a,estimateMin:45,deadlineAt:null});tasks.updateTask({id:b,estimateMin:45,deadlineAt:null});planning.saveDependency(b,a)
        const run=create(`请查询编号${a}和${b}这两项实际任务，并读取${day}的真实课表和单日设置。只为这两项实际试排${day}的执行安排，遵守已保存的前置关系、停补课、临时占用和轻量容量；有可行安排直接给计划确认卡，不新增任务、不改截止。`)
        await drive(run);const result=store.getRun(run)
        assert.equal(result.status,'awaiting_confirmation',JSON.stringify(result.events))
        assert.ok(result.pending&&'type' in result.pending&&result.pending.type==='plan')
        if(!result.pending||!('type'in result.pending)||result.pending.type!=='plan')throw new Error('缺少第五阶段计划卡')
        const p=result.pending.preview;assert.equal(p.blocks.length,2);assert.ok(p.blocks.find(p=>p.taskId===a)!.end<=p.blocks.find(p=>p.taskId===b)!.start)
        assert.ok(p.blocks.every(b=>b.start>=at(day,540)&&!(b.start<at(day,660)&&b.end>at(day,600))))
        assert.ok(p.blocks.reduce((sum,b)=>sum+(b.end-b.start)/60000,0)<=120);assert.equal(planning.listBlocks().length,0)
        assert.equal(confirmChange(run,true).status,'completed');assert.equal(planning.listBlocks().length,2)
        assert.equal(tasks.getTaskById(a)!.deadlineAt,null);assert.equal(tasks.getTaskById(b)!.deadlineAt,null)
      })
      }
      if(!process.argv.includes('--profile-live')&&!process.argv.includes('--capture-live')&&!process.argv.includes('--scheduling-live')) {
      await test('真实千问只读统计回答有效样本与未冻结状态，不编造完成率',async()=>{
        const db=getDb();db.exec('DELETE FROM day_plan_items; DELETE FROM day_plan_snapshots; DELETE FROM task_events; UPDATE completion_events SET stats_tracked=0;')
        const id=seed('S6真实统计验证');tasks.updateTask({id,estimateMin:60,estimateGroup:'S6真实统计',deadlineAt:null});tasks.completeTask(id,true)
        const event=feedback.completionForTask(id)!.event
        feedback.submitFeedback({eventId:event.id,actualMin:90,difficulty:'fit',interrupted:false,scopeChanged:false,note:'合成统计样本'})
        const expected=statistics.readStatistics();assert.equal(expected.completedTasks,1);assert.equal(expected.estimates.baseMape,50);assert.equal(expected.currentBaseline,null)
        const count=(db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as {n:number}).n
        const run=create('请用get_statistics读取今天的记录，只告诉我近7日完成多少项、原始估时MAPE是多少、今日冻结计划完成率是否可计算。不要创建或修改任务，不把未冻结说成0%或100%。')
        await drive(run);const result=store.getRun(run);assert.equal(result.status,'completed',JSON.stringify(result.events))
        assert.ok(result.events.some(e=>e.kind==='tool'&&e.text.includes('get_statistics')))
        const answer=result.events.filter(e=>e.kind==='assistant').map(e=>e.text).join('\n')
        assert.match(answer,/1/);assert.match(answer,/50/);assert.match(answer,/未冻结|(?:没有|暂无|无).*基线|尚未.*(?:冻结|基线)/)
        assert.doesNotMatch(answer,/coverage|部分计划/)
        assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as {n:number}).n,count)
        assert.equal((db.prepare('SELECT COUNT(*) AS n FROM day_plan_snapshots').get() as {n:number}).n,0)
      })
      }
      // 测试库退出后清空密钥，日志从不打印凭据。
      setSettings({ aiApiKey: '' })
    }
    console.log(`RESULT ${passed} passed; isolated database only; mode=${process.argv.includes('--live') ? 'mock+live' : 'mock'}`)
    closeDb(); app.exit(0)
  } catch (error) {
    if (process.argv.includes('--live')) { try { setSettings({ aiApiKey: '' }) } catch { /* 不掩盖原错误 */ } }
    console.error(error instanceof Error ? error.message : String(error)); closeDb(); app.exit(1)
  }
})
