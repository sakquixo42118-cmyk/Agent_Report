import { registerConfirmation } from './registry'
import { applyPriorityChange } from './tools'
import * as planning from '../planning/service'
import * as memory from '../memory/service'
import * as drafts from '../drafts/service'
registerConfirmation('priority',{apply:(runId,p)=>{
  if('type' in p)throw new Error('确认类型不符。')
  const details=applyPriorityChange(runId,p)
  return {details,message:`已调整「${p.title}」：重要度 ${p.before.importance} → ${p.after.importance}，紧急度 ${p.before.urgency} → ${p.after.urgency}。已保存本次人工选择。`}
}})
registerConfirmation('plan',{apply:(runId,p,audit)=>{
  if(!('type' in p)||p.type!=='plan')throw new Error('确认类型不符。')
  const details=planning.commit(p.preview.id,runId,Date.now(),audit)
  return {details,message:`已保存${details.count}项执行安排，截止时间未改变。${details.unscheduled.length?`还有${details.unscheduled.length}项未安排。`:''}`}
}})
registerConfirmation('memory',{apply:(runId,p)=>{
  if(!('type' in p)||p.type!=='memory')throw new Error('确认类型不符。')
  const fact=memory.saveFact(p.fact,p.expectedVersion,`assistant_confirmed:${runId}`)
  return {details:{id:fact.id,version:fact.version},message:`已保存「${fact.scope} / ${fact.key}」，可在个人记忆中修改或移除。`}
}})
registerConfirmation('task_draft',{apply:(runId,p)=>{
  if(!('type' in p)||p.type!=='task_draft')throw new Error('确认类型不符。')
  const details=drafts.commit(runId,p.draftId,p.expectedVersion)
  return {details,message:`已确认创建${details.taskIds.length}项任务（编号：${details.taskIds.join('、')}）。执行时段尚未保存，可继续试排。`}
}})
