import assert from 'node:assert/strict'
import {getDb} from '../src/main/db/database'
import * as tasks from '../src/main/db/taskDao'
import * as memory from '../src/main/memory/service'
import * as planning from '../src/main/planning/service'
import * as store from '../src/main/agent/store'
import {drive,confirmChange} from '../src/main/agent/runner'
import {resolveDate,clockTimes} from '../src/main/agent/grounding'
type Test=(name:string,fn:()=>unknown|Promise<unknown>)=>Promise<void>
export async function hardeningLiveTests(test:Test):Promise<void>{
  const db=getDb(),target=resolveDate('这周四'),ids:number[]=[]
  db.exec('DELETE FROM task_dependencies;DELETE FROM calendar_exceptions;DELETE FROM day_overrides;DELETE FROM plan_blocks;DELETE FROM calendar_courses;')
  const date=new Date(target.date+'T12:00:00'),weekday=(date.getDay()+6)%7+1
  planning.saveCourse({name:'补测日期课',weekday,startMin:600,endMin:660,fromDate:target.date,toDate:target.date})
  async function run(goal:string){const id=store.createRun(goal,[{role:'system',content:''},{role:'user',content:goal}]);await drive(id);return store.getRun(id)}
  await test('真实千问本周四映射到本地正确日期，查询真实课程而不猜日期',async()=>{
    const r=await run('这周四有哪些课程？只查这周四，直接回答课程名称和时间，不追加其他问题。')
    const calls=r.events.filter(e=>e.kind==='tool').map(e=>JSON.parse(e.text))
    const dates=calls.filter(c=>c.tool==='get_calendar').map(c=>JSON.parse(c.arguments))
    assert.equal(r.status,'completed');assert.ok(dates.length);assert.ok(dates.every(d=>d.startDate===target.date&&d.endDate===target.date));assert.ok(r.events.some(e=>e.kind==='assistant'&&e.text.includes('补测日期课')))
  })
  await test('真实千问记忆草案保留第一节等原话，不补未确认的具体钟点',async()=>{
    const r=await run('请记住这条补测信息：每周四上午第一节课时段和下午在办公室值班，可能被打断；具体钟点我还没有确认，不要推断。')
    assert.equal(r.status,'awaiting_confirmation');assert.ok(r.pending&&'type'in r.pending&&r.pending.type==='memory')
    if(r.pending&&'type'in r.pending&&r.pending.type==='memory'){assert.equal(clockTimes(r.pending.fact.value).length,0);assert.match(r.pending.fact.value,/第一节|未确认/)}
    confirmChange(r.id,false)
  })
  const fact=memory.saveFact({scope:'全局',key:'办公室值班',value:'每周四下午在办公室值班，可能被打断，不保证连续专注；具体钟点未确认。'},memory.findFact('全局','办公室值班')?.version??null)
  await test('真实千问凭记忆主题索引纠正查询，读取值班事实而非仅空查任务名',async()=>{
    const r=await run('根据你记住的我的情况，这周四下午适合连续专注两小时写报告吗？先说明判断依据，不创建任务或安排，不追加问题。')
    const hits=r.events.filter(e=>e.kind==='tool').map(e=>JSON.parse(e.text)).filter(c=>c.tool==='search_memory'&&JSON.stringify(c.result).includes(fact.id))
    assert.ok(hits.length,'必须实际读到记忆正文与来源，不只拿主题名称作答');assert.equal(r.status,'completed')
    assert.ok(r.events.some(e=>e.kind==='assistant'&&/值班|打断/.test(e.text)))
  })
  for(let i=0;i<2;i++){const t=tasks.createTask({content:'补测同名报告'});ids.push(t.id);tasks.applyAnalysis(t.id,{summary:t.content,category:'学习',tags:[],estimateMin:30,dueAt:null,importance:3,urgency:3},'none')}
  await test('真实千问用真实任务编号生成选择按钮，不提供库外示例选项',async()=>{
    const r=await run('请查找两份同名的“补测同名报告”，用真实任务选项让我选择具体哪一份，先不修改它们。')
    assert.equal(r.status,'waiting_user');assert.ok(r.events.some(e=>e.kind==='tool'&&JSON.parse(e.text).tool==='ask_task_selection'))
    assert.equal(r.question?.options.length,2);assert.ok(r.question?.options.every(o=>ids.some(id=>o.includes(`任务#${id} `))))
  })
  for(const id of ids)tasks.deleteTask(id)
  db.prepare('DELETE FROM memory_facts WHERE id=?').run(fact.id)
}
