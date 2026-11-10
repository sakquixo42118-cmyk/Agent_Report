import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import JSZip from 'jszip'
import {resolveDate,calendarReference,clockTimes,explicitlyRequestsPlan} from '../src/main/agent/grounding'
import {executeTool} from '../src/main/agent/tools'
import {getDb} from '../src/main/db/database'
import * as tasks from '../src/main/db/taskDao'
import * as memory from '../src/main/memory/service'
import * as study from '../src/main/study/documents'
import * as store from '../src/main/agent/store'
import {dateKey} from '../src/main/planning/engine'
import {readForAgent} from '../src/main/study/reader'
import type {ToolContext} from '../src/main/agent/contracts'

type Test=(name:string,fn:()=>unknown|Promise<unknown>)=>Promise<void>
export async function hardeningTests(test:Test):Promise<void>{
  const now=new Date(2026,10,10,19),ids:number[]=[],facts:string[]=[]
  await test('相对日期按本地周一开周解析，周四与下周四不混淆',()=>{
    assert.equal(resolveDate('这周四',now).date,'2026-11-12')
    assert.equal(resolveDate('下周四',now).date,'2026-11-19')
    assert.equal(resolveDate('后天',now).weekday,'周四')
    assert.match(calendarReference(now),/这周四=2026-11-12/)
  })
  await test('日期跨年跨月仍按本地日历；不存在日期和矛盾星期必须澄清',()=>{
    assert.equal(resolveDate('明天',new Date(2026,11,31,23)).date,'2027-01-01')
    assert.equal(resolveDate('下周一',new Date(2026,11,31)).date,'2027-01-04')
    assert.throws(()=>resolveDate('2026-02-30',now),/不存在/)
    assert.throws(()=>resolveDate('2026年11月13日（周四）',now),/实际为周五/)
    assert.throws(()=>resolveDate('周末',now),/不唯一/)
  })
  await test('日期工具返回确切星期和来源，错误不是任意默认日期',()=>{
    const result=executeTool('resolve_date',JSON.stringify({expression:'2026-11-12'}),{observed:new Map()})
    assert.equal(result.ok,true);assert.equal((result.data as {weekday:string}).weekday,'周四');assert.ok(result.sourceRefs?.length)
    assert.equal(executeTool('resolve_date','{"expression":"随便找一天"}',{observed:new Map()}).errorCode,'DATE_NEEDS_CLARIFICATION')
  })
  const ctx:ToolContext={observed:new Map()}
  for(let i=0;i<2;i++){const t=tasks.createTask({content:'核对-同名报告'});ids.push(t.id);tasks.applyAnalysis(t.id,{summary:'核对-同名报告',importance:3,urgency:3,category:'学习',tags:[],estimateMin:30,dueAt:null},'none')}
  await test('任务候选由真实编号生成，同名可区分，未查询不能猜编号',()=>{
    const args=JSON.stringify({question:'选择要修改的任务',taskIds:ids})
    assert.equal(executeTool('ask_task_selection',args,ctx).errorCode,'READ_REQUIRED')
    executeTool('list_tasks',JSON.stringify({taskIds:ids}),ctx)
    const result=executeTool('ask_task_selection',args,ctx),data=result.data as {options:string[];tasks:{taskId:number}[]}
    assert.equal(result.pause,'waiting_user');assert.deepEqual(data.tasks.map(t=>t.taskId),ids)
    assert.equal(new Set(data.options).size,2);assert.ok(data.options.every(o=>o.includes('核对-同名报告')))
    assert.equal(executeTool('ask_task_selection',JSON.stringify({question:'选择',taskIds:[ids[0],999999999]}),ctx).errorCode,'NOT_FOUND')
  })
  await test('明确要求实际试排时，不允许只读空档后口头冒充结果；仍允许澄清',()=>{
    assert.equal(explicitlyRequestsPlan('请实际试排'),true);assert.equal(explicitlyRequestsPlan('不要实际试排，只讨论'),false)
    assert.equal(explicitlyRequestsPlan('请解释实际试排是什么意思'),false);assert.equal(explicitlyRequestsPlan('能帮我实际试排一下吗'),true)
    const evidence:ToolContext={observed:new Map(),requirePlanAttempt:true,runId:store.createRun('执行证据测试',[{role:'system',content:''},{role:'user',content:'请实际试排'}])}
    executeTool('list_tasks',JSON.stringify({taskIds:ids}),evidence)
    assert.equal(executeTool('respond','{"mode":"answer","text":"已经实际试排，不可行"}',evidence).errorCode,'PLAN_ATTEMPT_REQUIRED')
    assert.equal(executeTool('ask_user','{"question":"要安排在哪个日期？"}',evidence).pause,'waiting_user')
    const unique:ToolContext={observed:new Map([[ids[0],evidence.observed.get(ids[0])!]]),requirePlanAttempt:true}
    assert.equal(executeTool('respond','{"mode":"question","text":"不试排，先修改截止吗？"}',unique).errorCode,'PLAN_ATTEMPT_REQUIRED')
    const day=dateKey(Date.now()+4*86400000)
    const p=executeTool('preview_plan',JSON.stringify({taskIds:ids,startDate:day,endDate:day}),evidence);assert.equal(p.ok,true)
    assert.equal(evidence.planAttempted,true)
    assert.equal(executeTool('respond','{"mode":"answer","text":"返回实际试排观察"}',evidence).pause,'completed')
    evidence.requirePlanProposal=true
    assert.equal(executeTool('respond','{"mode":"answer","text":"请确认是否合适"}',evidence).errorCode,'PLAN_CARD_REQUIRED')
    assert.equal(executeTool('propose_plan',JSON.stringify({previewId:(p.data as {previewId:string}).previewId}),evidence).pause,'awaiting_confirmation')
  })
  await test('候选任务在读取后变化时要求重查，不能用旧状态创建选项',()=>{
    getDb().prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z',ids[0])
    assert.equal(executeTool('ask_task_selection',JSON.stringify({question:'选择',taskIds:ids}),ctx).errorCode,'READ_REQUIRED')
  })
  const fact=memory.saveFact({scope:'全局',key:'核对-办公室值班',value:'SECRET_PROFILE_VALUE 每周四下午值班，可能被打断'},null);facts.push(fact.id)
  const expired=memory.saveFact({scope:'核对',key:'核对-已到期',value:'不该出现在索引',expiresAt:new Date(Date.now()-1000).toISOString()},null);facts.push(expired.id)
  await test('记忆空检索给主题索引供重新查询，不把事实正文一股脑注入',()=>{
    const result=executeTool('search_memory','{"query":"ZXQ_01872952"}',ctx),data=result.data as {facts:unknown[];availableTopics:{scope:string;key:string}[]}
    assert.deepEqual(data.facts,[]);assert.ok(data.availableTopics.some(t=>t.key==='核对-办公室值班'))
    assert.ok(!JSON.stringify(data).includes('SECRET_PROFILE_VALUE'));assert.ok(!data.availableTopics.some(t=>t.key==='核对-已到期'))
    const retry=executeTool('search_memory','{"query":"办公室值班","scope":"全局"}',ctx)
    assert.ok((retry.data as {facts:unknown[]}).facts.length>0)
  })
  await test('明确要求参考记忆时不能只看课表就结束，执行检索后仍由模型判断相关性',()=>{
    const context:ToolContext={observed:new Map(),requireMemoryRead:true}
    assert.equal(executeTool('respond','{"mode":"answer","text":"你完全有空"}',context).errorCode,'MEMORY_READ_REQUIRED')
    executeTool('search_memory','{"query":"办公室值班"}',context)
    assert.equal(executeTool('respond','{"mode":"answer","text":"已依据检索到的值班事实给建议"}',context).pause,'completed')
  })
  await test('未知记忆分组同样提供有效主题元数据，不掩盖成没有记忆',()=>{
    const result=executeTool('search_memory','{"query":"报告","scope":"不存在的分组"}',ctx)
    assert.equal(result.errorCode,'UNKNOWN_MEMORY_SCOPE');assert.ok(JSON.stringify(result.data).includes('核对-办公室值班'))
  })
  await test('记忆草案不能把第一节课凭空转换成具体钟点',()=>{
    const result=executeTool('propose_memory',JSON.stringify({scope:'核对',key:'值班',value:'上午08:00–08:45在办公室'}),{observed:new Map(),evidenceText:'上午第一节课时段在办公室'})
    assert.equal(result.errorCode,'UNSUPPORTED_MEMORY_TIME');assert.equal(memory.findFact('核对','值班'),null)
    const exact=executeTool('propose_memory',JSON.stringify({scope:'核对',key:'值班',value:'上午第一节课时段在办公室，具体钟点未确认'}),{observed:new Map(),evidenceText:'上午第一节课时段在办公室'})
    assert.equal(exact.pause,'awaiting_confirmation')
  })
  await test('用户明确中文时刻可等价写成24小时钟点，工具只是核验来源',()=>{
    assert.ok(clockTimes('下午两点半在办公室，上午八点五十分上课').includes('14:30'))
    const result=executeTool('propose_memory',JSON.stringify({scope:'核对',key:'时间',value:'14:30到办公室，08:50上课'}),{observed:new Map(),evidenceText:'下午两点半到办公室，上午八点五十分上课'})
    assert.equal(result.pause,'awaiting_confirmation')
  })
  await test('真实OOXML格式DOCX中的中文、标题和公式文本能解析并供工具读取',async()=>{
    const zip=new JSZip()
    zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>中文公式练习</w:t></w:r></w:p><w:p><w:r><w:t>已知 f(x)=x^2，求导得 f\'(x)=2x。</w:t></w:r></w:p></w:body></w:document>')
    const file=join(mkdtempSync(join(tmpdir(),'suishou-docx-')),'中文练习.docx');writeFileSync(file,await zip.generateAsync({type:'nodebuffer'}))
    const doc=await study.registerFile(file),parsed=await study.parseDocument(doc.id)
    try{assert.equal(parsed.status,'parsed');const result=readForAgent(doc.id,1,1);assert.equal(result.ok,true);assert.match(JSON.stringify(result.data),/中文公式练习/);assert.match(JSON.stringify(result.data),/x\^2/);assert.ok(result.sourceRefs?.length)}finally{await study.removeDocument(doc.id)}
  })
  for(const id of ids)tasks.deleteTask(id)
  for(const id of facts)getDb().prepare('DELETE FROM memory_facts WHERE id=?').run(id)
}
