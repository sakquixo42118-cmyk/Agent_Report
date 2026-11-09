import {getDb} from '../db/database'
import {dateKey} from '../planning/engine'
import type {PlanAuditInput,PlanChangeReason} from '@shared/statistics'
export interface AuditContext {actor:'user'|'system';source:string;reason?:string;note?:string;sourceRef?:string|null}
export function withAudit<T>(context:AuditContext,fn:()=>T):T {
  return getDb().transaction(()=>{
    const old=getDb().prepare('SELECT * FROM audit_context WHERE id=1').get() as {actor:string;source:string;reason:string;note:string;source_ref:string|null}
    const set=getDb().prepare('UPDATE audit_context SET actor=?,source=?,reason=?,note=?,source_ref=? WHERE id=1')
    set.run(context.actor,context.source,context.reason??'unspecified',context.note??'',context.sourceRef??null)
    try{return fn()}finally{set.run(old.actor,old.source,old.reason,old.note,old.source_ref)}
  })()
}
export function validatePlanAudit(input?:PlanAuditInput):PlanAuditInput {
  if(input===undefined)return{reason:'unspecified',note:''}
  if(!input||Object.keys(input).some(k=>!['reason','note'].includes(k))||!['unspecified','user_postpone','calendar_change','capacity_change','other'].includes(input.reason)||typeof input.note!=='string'||input.note.length>200)throw new Error('改期原因或备注无效。')
  return {reason:input.reason as PlanChangeReason,note:input.note.trim()}
}
export function recordPlanEvent(taskId:number,before:Record<string,unknown>|null,after:Record<string,unknown>|null,runId:string|null,key:string,now:number,audit?:PlanAuditInput):void {
  const meta=validatePlanAudit(audit)
  if(before&&after&&before.start===after.start&&before.end===after.end)return
  const later=!!before&&!!after&&Number(after.start)>Number(before.start)
  const kind=!after?'plan_removed':!before?'plan_created':later&&meta.reason==='user_postpone'?'postponed':'rescheduled'
  getDb().prepare(`INSERT INTO task_events(task_id,kind,actor,source,reason,note,before_json,after_json,source_ref,occurred_at,local_day,idempotency_key)
    VALUES(?,?,'user',?,?,?,?,?,?,?,?,?)`).run(taskId,kind,runId?'agent_confirmed':'manual',meta.reason,meta.note,
    before?JSON.stringify({...before,date:dateKey(Number(before.start))}):null,after?JSON.stringify({...after,date:dateKey(Number(after.start))}):null,
    runId?`run:${runId}`:null,new Date(now).toISOString(),dateKey(now),key)
}
