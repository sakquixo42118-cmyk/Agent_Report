import {getDb} from '../db/database'
import {at,day,dateKey} from '../planning/engine'
import type {FrozenPlan,FrozenPlanItem,StatisticsReport,TaskEvent} from '@shared/statistics'

export function enabledAt():string{return (getDb().prepare('SELECT enabled_at FROM statistics_meta WHERE id=1').get() as {enabled_at:string}).enabled_at}
interface CompletionRow {id:string;task_id:number;title:string;stats_day:string;created_at:string;deadline_at:string|null;deadline_confirmed:number;group_key:string;estimate_source:string;base_min:number;planned_min:number;actual_min:number|null;interrupted:number|null;scope_changed:number|null}
interface EventRow {id:number;task_id:number;kind:string;actor:'user'|'system';source:string;reason:string;note:string;before_json:string|null;after_json:string|null;source_ref:string|null;occurred_at:string;local_day:string}
function events(startAt?:string,endAt?:string,startDay?:string,endDay?:string):EventRow[]{
  const where:string[]=[],params:string[]=[]
  if(startAt){where.push('occurred_at>=?');params.push(startAt)}if(endAt){where.push('occurred_at<=?');params.push(endAt)}
  if(startDay){where.push('local_day>=?');params.push(startDay)}if(endDay){where.push('local_day<=?');params.push(endDay)}
  return getDb().prepare(`SELECT * FROM task_events ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id`).all(...params) as EventRow[]
}
export function frozenPlan(date:string,now=Date.now()):FrozenPlan|null {
  day(date)
  const snapshot=getDb().prepare('SELECT * FROM day_plan_snapshots WHERE date=?').get(date) as {frozen_at:string;method:string;time_zone:string}|undefined
  if(!snapshot)return null
  const rows=getDb().prepare(`SELECT i.*,t.status,p.start_at FROM day_plan_items i JOIN tasks t ON t.id=i.task_id
    LEFT JOIN plan_blocks p ON p.task_id=i.task_id WHERE i.date=? ORDER BY i.planned_start,i.task_id`).all(date) as {task_id:number;title:string;planned_start:number;planned_end:number;status:string;start_at:number|null}[]
  const cutoff=new Date(Math.min(now,at(date,1440))).toISOString()
  const done=getDb().prepare(`SELECT DISTINCT task_id FROM completion_events WHERE stats_tracked=1 AND stats_valid=1
    AND stats_day<=? AND created_at>=? AND created_at<=?`).all(date,snapshot.frozen_at,cutoff) as {task_id:number}[]
  const doneIds=new Set(done.map(r=>r.task_id))
  const items:FrozenPlanItem[]=rows.map(r=>({taskId:r.task_id,title:r.title,plannedStart:r.planned_start,plannedEnd:r.planned_end,
    state:doneIds.has(r.task_id)?'completed':r.status==='archived'?'archived':r.start_at===null||dateKey(r.start_at)!==date?'moved_out':'pending'}))
  const added=new Set<number>()
  const original=new Set(items.map(i=>i.taskId))
  for(const e of events(snapshot.frozen_at,new Date(now).toISOString()).filter(e=>['plan_created','rescheduled','postponed'].includes(e.kind))){
    const after=e.after_json?JSON.parse(e.after_json):null
    if(after?.date===date&&!original.has(e.task_id))added.add(e.task_id)
  }
  const completed=items.filter(i=>i.state==='completed').length
  return{date,frozenAt:snapshot.frozen_at,method:snapshot.method,timeZone:snapshot.time_zone,denominator:items.length,completed,
    rate:items.length?completed/items.length:null,addedTaskIds:[...added],items}
}
export function freezeDay(date:string,now=Date.now(),method:'user_freeze'|'first_plan_confirmation'='user_freeze'):FrozenPlan {
  day(date)
  if((method==='user_freeze'&&date!==dateKey(now))||(method==='first_plan_confirmation'&&date<dateKey(now)))throw new Error('只能建立今日或新确认的未来日期计划基线，不能回填过去。')
  return getDb().transaction(()=>{
    const existing=frozenPlan(date,now);if(existing)return existing
    const rows=getDb().prepare(`SELECT t.id,t.content,t.summary,t.deadline_at,t.base_estimate_min,p.start_at,p.end_at
      FROM plan_blocks p JOIN tasks t ON t.id=p.task_id WHERE t.status='pending' AND p.start_at>=? AND p.start_at<? ORDER BY p.start_at,t.id`).all(at(date,0),at(date,1440)) as {id:number;content:string;summary:string|null;deadline_at:string|null;base_estimate_min:number;start_at:number;end_at:number}[]
    if(!rows.length)throw new Error('该日没有待办任务的已保存执行安排，暂不能冻结计划。')
    getDb().prepare('INSERT INTO day_plan_snapshots(date,frozen_at,method,time_zone) VALUES(?,?,?,?)').run(date,new Date(now).toISOString(),method,Intl.DateTimeFormat().resolvedOptions().timeZone)
    const insert=getDb().prepare('INSERT INTO day_plan_items(date,task_id,title,planned_start,planned_end,deadline_at,base_min) VALUES(?,?,?,?,?,?,?)')
    rows.forEach(r=>insert.run(date,r.id,r.summary||r.content,r.start_at,r.end_at,r.deadline_at,r.base_estimate_min))
    return frozenPlan(date,now)!
  })()
}
const mean=(values:number[]):number|null=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null
export function readStatistics(endDate=dateKey(Date.now()),now=Date.now()):StatisticsReport {
  const end=day(endDate)
  if(endDate>dateKey(now))throw new Error('统计截止日期不能晚于今天。')
  const dates=Array.from({length:7},(_,i)=>{const d=new Date(end);d.setDate(d.getDate()-6+i);return dateKey(d)})
  const startDate=dates[0],start=enabledAt(),isoNow=new Date(now).toISOString()
  const completions=getDb().prepare(`SELECT e.*,f.actual_min,f.interrupted,f.scope_changed FROM completion_events e
    LEFT JOIN completion_feedback f ON f.event_id=e.id WHERE e.stats_tracked=1 AND e.stats_valid=1 AND e.stats_day>=? AND e.stats_day<=? AND e.created_at<=?`).all(startDate,endDate,isoNow) as CompletionRow[]
  const changes=events(undefined,isoNow,startDate,endDate)
  const moves=changes.filter(e=>['rescheduled','postponed'].includes(e.kind))
  const postponed=changes.filter(e=>e.kind==='postponed'&&e.actor==='user'&&e.reason==='user_postpone')
  const universe=new Set(changes.filter(e=>['plan_created','rescheduled','postponed'].includes(e.kind)).map(e=>e.task_id))
  const days:StatisticsReport['days']=dates.map(date=>{
    const coverage=at(date,1440)<=new Date(start).getTime()?'none':at(date,0)<new Date(start).getTime()?'partial':'full'
    const baseline=frozenPlan(date,now)
    baseline?.items.forEach(i=>universe.add(i.taskId))
    return{date,coverage,completed:coverage==='none'?null:new Set(completions.filter(c=>c.stats_day===date).map(c=>c.task_id)).size,
      postponed:coverage==='none'?null:postponed.filter(e=>e.local_day===date).length,baseline}
  })
  const eligible=completions.filter(c=>c.deadline_confirmed===1&&c.deadline_at)
  const onTime=eligible.filter(c=>new Date(c.created_at).getTime()<=new Date(c.deadline_at!).getTime())
  const samples=completions.filter(c=>c.actual_min!==null&&Number.isFinite(c.actual_min)&&c.actual_min>0&&c.base_min>0&&c.planned_min>0&&c.interrupted===0&&c.scope_changed===0)
  const baseError=(c:CompletionRow):number=>Math.abs(c.actual_min!-c.base_min)/c.base_min*100
  const plannedError=(c:CompletionRow):number=>Math.abs(c.actual_min!-c.planned_min)/c.planned_min*100
  const groups:StatisticsReport['estimates']['groups']=[]
  for(const key of new Set(samples.map(c=>JSON.stringify([c.group_key,c.estimate_source])))){
    const [group,source]=JSON.parse(key),rows=samples.filter(c=>c.group_key===group&&c.estimate_source===source)
    groups.push({group,source,count:rows.length,baseMape:mean(rows.map(baseError))!,plannedMape:mean(rows.map(plannedError))!})
  }
  const reasonCounts=new Map<string,number>();moves.forEach(e=>reasonCounts.set(e.reason,(reasonCounts.get(e.reason)??0)+1))
  return{endDate,startDate,enabledAt:start,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,days,
    completedTasks:days.some(d=>d.coverage!=='none')?new Set(completions.map(c=>c.task_id)).size:null,
    onTime:{eligible:eligible.length,completedOnTime:onTime.length,rate:eligible.length?onTime.length/eligible.length:null,withoutDeadline:completions.length-eligible.length},
    changes:{postponeEvents:postponed.length,postponedTasks:new Set(postponed.map(e=>e.task_id)).size,plannedTasks:universe.size,
      postponeRate:universe.size?new Set(postponed.map(e=>e.task_id)).size/universe.size:null,
      otherManualMoves:moves.filter(e=>e.source==='manual'&&e.kind!=='postponed').length,
      agentConfirmedMoves:moves.filter(e=>e.source==='agent_confirmed').length,systemMoves:moves.filter(e=>e.actor==='system').length,
      reasons:[...reasonCounts].map(([reason,count])=>({reason,count}))},
    estimates:{sampleCount:samples.length,excluded:completions.length-samples.length,baseMape:mean(samples.map(baseError)),plannedMape:mean(samples.map(plannedError)),
      meanAbsoluteMin:mean(samples.map(c=>Math.abs(c.actual_min!-c.base_min))),groups},
    currentBaseline:days.at(-1)!.baseline,recentEvents:changes.slice(-40).reverse().map(e=>({id:e.id,taskId:e.task_id,kind:e.kind,actor:e.actor,source:e.source,reason:e.reason,note:e.note,
      before:e.before_json?JSON.parse(e.before_json):null,after:e.after_json?JSON.parse(e.after_json):null,sourceRef:e.source_ref,occurredAt:e.occurred_at,localDay:e.local_day}))}
}
