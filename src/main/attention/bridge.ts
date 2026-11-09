import {getDb} from '../db/database'
import {prepareSceneRun} from '../agent/runner'
import {message,linkRun} from './service'
export function prepareMessageRun(id:string,mode:'capture'|'planning',input?:string,now=Date.now()):string{
  if(!['capture','planning'].includes(mode))throw new Error('对话场景无效。')
  return getDb().transaction(()=>{
    const m=message(id,now)
    if(m.runId)return m.runId
    if(!['open','snoozed'].includes(m.state))throw new Error('消息已处理或失效，可直接在今日发起新对话。')
    if(mode==='capture'&&!m.evidence.some(e=>e.kind==='course'))throw new Error('这条消息没有课后来源。')
    if(mode==='planning'&&!m.evidence.some(e=>e.taskId))throw new Error('这条消息没有关联任务。')
    if(mode==='capture'&&(typeof input!=='string'||!input.trim()||input.length>1000))throw new Error('请填写1—1000字的新增事项。')
    const goal=mode==='capture'?`用户补充课后事项：${input!.trim()}。请按需澄清并形成待确认草案，不把课表本身当作作业要求。`:
      `用户从今日消息进入讨论。请先读取任务编号${m.evidence.filter(e=>e.taskId).map(e=>e.taskId).join(',')}的真实当前状态，帮助核对完成情况或讨论执行调整；需要改期先试排并确认，不改变截止。`
    const run=prepareSceneRun(mode,goal,{ref:`attention:${id}`,text:JSON.stringify({message:m.text,userInput:input??null,evidence:m.evidence})})
    linkRun(id,run);return run
  })()
}
