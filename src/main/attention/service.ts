import {createHash,randomUUID} from 'node:crypto'
import {getDb} from '../db/database'
import {getSettings} from '../db/settingsDao'
import {isAiConfigured} from '../ai/client'
import * as planning from '../planning/service'
import {at,dateKey} from '../planning/engine'
import {preferences,quiet,muted} from './preferences'
import type {AttentionEvidence,AttentionMessage,AttentionState} from '@shared/attention'
export {preferences,savePreferences,quiet,taskMuted,unmute} from './preferences'
const hash=(data:unknown):string=>createHash('sha256').update(JSON.stringify(data)).digest('hex')
const stateRow=():{enabled_at:number;last_check_at:number;last_desktop_at:number}=>getDb().prepare('SELECT * FROM attention_state WHERE id=1').get() as ReturnType<typeof stateRow>
interface TaskRow{id:number;title:string;status:string;deadline_at:string|null;deadline_confirmed:number}
function tasks():TaskRow[]{return getDb().prepare("SELECT id,COALESCE(summary,content) AS title,status,deadline_at,deadline_confirmed FROM tasks WHERE status='pending'").all() as TaskRow[]}
function evidence(data:Omit<AttentionEvidence,'version'>):AttentionEvidence{return{...data,version:hash(data)}}
export function candidates(now=Date.now()):AttentionEvidence[]{
  const p=preferences();if(!p.proactiveEnabled)return[]
  const enabled=stateRow().enabled_at,today=dateKey(now),yesterday=dateKey(now-86400000),result:AttentionEvidence[]=[]
  if(p.courseEnabled){
    for(const c of planning.snapshot(yesterday,today).occupied.filter(o=>o.kind==='course'&&o.courseId&&o.end<=now&&o.end>=Math.max(enabled,now-3*3600000))){
      const subjectKey=`course:${c.courseId}`;if(muted(subjectKey))continue
      result.push(evidence({key:`course:${c.courseId}:${c.start}:${c.end}`,kind:'course',subjectKey,title:c.title,courseId:c.courseId,start:c.start,end:c.end,sourceRefs:[`calendar:${c.courseId}:${c.start}:${c.end}`],expiresAt:c.end+3*3600000}))
    }
  }
  if(p.nudgeEnabled){
    const blocks=planning.listBlocks()
    for(const t of tasks()){
      const subjectKey=`task:${t.id}`;if(muted(subjectKey))continue
      const b=blocks.find(b=>b.taskId===t.id),due=t.deadline_confirmed&&t.deadline_at?new Date(t.deadline_at).getTime():null
      const pressure=due!==null&&due>=enabled&&due>=now-6*3600000&&due<=now+24*3600000
      const missed=!!b&&b.end>=enabled&&b.end<=now&&b.end>=now-2*3600000
      if(!pressure&&!missed)continue
      const expiresAt=Math.min(at(today,1440),pressure?due!+6*3600000:b!.end+2*3600000)
      if(expiresAt<=now)continue
      result.push(evidence({key:`risk:${t.id}:${today}`,kind:'risk',subjectKey,title:t.title.slice(0,160),taskId:t.id,deadlineAt:t.deadline_at,deadlineConfirmed:!!t.deadline_confirmed,
        plannedStart:b?.start??null,plannedEnd:b?.end??null,flags:[...(pressure?['deadline_pressure']:[]),...(missed?['planned_block_ended']:[])],sourceRefs:[`task:${t.id}`,...(b?[`plan:${b.id}:${b.start}:${b.end}`]:[])],expiresAt}))
    }
  }
  return result
}
interface Reminder {key:string;kind:'start_reminder'|'deadline_reminder';title:string;text:string;evidence:AttentionEvidence;expiresAt:number}
export function reminderCandidates(now=Date.now()):Reminder[]{
  const settings=getSettings();if(!settings.notifyEnabled)return[]
  const p=preferences(),enabled=stateRow().enabled_at,rows=tasks(),result:Reminder[]=[]
  const textTime=(n:number):string=>new Date(n).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})
  for(const b of planning.listBlocks()){
    const t=rows.find(t=>t.id===b.taskId);if(!t||muted(`task:${t.id}`)||b.start<enabled||now<b.start-p.startAdvanceMin*60000||now>b.end+12*3600000)continue
    const key=`start:${t.id}:${b.start}`,expiresAt=b.end+12*3600000
    result.push({key,kind:'start_reminder',title:t.title.slice(0,160),text:`${now>=b.end?'这段执行安排已结束，任务尚未标记完成':now>=b.start?'这段执行安排已开始':'执行安排即将开始'}：${textTime(b.start)}—${textTime(b.end)}。可核对完成状态或讨论调整。`,
      evidence:evidence({key,kind:'risk',subjectKey:`task:${t.id}`,taskId:t.id,title:t.title.slice(0,160),plannedStart:b.start,plannedEnd:b.end,flags:['start_reminder'],sourceRefs:[`plan:${b.id}:${b.start}`],expiresAt}),expiresAt})
  }
  for(const t of rows){
    const due=t.deadline_confirmed&&t.deadline_at?new Date(t.deadline_at).getTime():NaN
    if(!Number.isFinite(due)||muted(`task:${t.id}`)||due<enabled||now<due-settings.notifyAdvanceHours*3600000||now>due+24*3600000)continue
    const key=`deadline:${t.id}:${due}`,expiresAt=due+24*3600000
    result.push({key,kind:'deadline_reminder',title:t.title.slice(0,160),text:`${now>due?'截止时间已过，任务尚未标记完成':'截止提醒'}：${textTime(due)}。请核对当前状态；执行改期不会改变这个截止。`,
      evidence:evidence({key,kind:'risk',subjectKey:`task:${t.id}`,taskId:t.id,title:t.title.slice(0,160),deadlineAt:t.deadline_at,deadlineConfirmed:true,flags:['deadline_reminder'],sourceRefs:[`deadline:${t.id}:${due}`],expiresAt}),expiresAt})
  }
  return result.sort((a,b)=>(a.evidence.plannedStart??new Date(a.evidence.deadlineAt!).getTime())-(b.evidence.plannedStart??new Date(b.evidence.deadlineAt!).getTime()))
}
interface MessageRow{id:string;source_key:string;kind:AttentionMessage['kind'];title:string;body:string;state:AttentionMessage['state'];is_read:number;created_at:number;expires_at:number;snoozed_until:number|null;payload_json:string;run_id:string|null}
function rows():MessageRow[]{return getDb().prepare("SELECT * FROM attention_messages WHERE state IN ('open','snoozed')").all() as MessageRow[]}
const payload=(r:MessageRow):AttentionEvidence[]=>JSON.parse(r.payload_json)
export function reconcile(now=Date.now()):void{
  const p=preferences(),current=new Map(candidates(now).map(e=>[e.key,e])),reminders=new Map(reminderCandidates(now).map(r=>[r.key,r]))
  getDb().transaction(()=>{
    for(const r of rows()){
      let valid=true
      if(r.expires_at<=now){getDb().prepare("UPDATE attention_messages SET state='expired',is_read=1 WHERE id=?").run(r.id);continue}
      if(r.kind==='start_reminder'||r.kind==='deadline_reminder'){
        const latest=reminders.get(r.source_key);valid=!!latest
        if(latest)getDb().prepare('UPDATE attention_messages SET title=?,body=?,payload_json=?,expires_at=? WHERE id=?').run(latest.title,latest.text,JSON.stringify([latest.evidence]),latest.expiresAt,r.id)
      }else valid=p.proactiveEnabled&&payload(r).every(e=>current.get(e.key)?.version===e.version)
      if(!valid){getDb().prepare("UPDATE attention_messages SET state='cancelled',is_read=1 WHERE id=?").run(r.id);continue}
      if(r.state==='snoozed'&&r.snoozed_until!==null&&r.snoozed_until<=now&&!quiet(now))getDb().prepare("UPDATE attention_messages SET state='open',is_read=0,snoozed_until=NULL WHERE id=?").run(r.id)
    }
  })()
}
export function refreshAttention(now=Date.now()):void{
  reconcile(now)
  const all=candidates(now),p=preferences(),today=dateKey(now)
  getDb().transaction(()=>{
    getDb().prepare("UPDATE attention_events SET state='cancelled' WHERE expires_at<=? AND state IN ('new','queued')").run(now)
    for(const e of all)getDb().prepare(`INSERT INTO attention_events(key,kind,payload_json,version,expires_at) VALUES(?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json,version=excluded.version,expires_at=excluded.expires_at WHERE attention_events.state IN ('new','queued')`).run(e.key,e.kind,JSON.stringify(e),e.version,e.expiresAt)
    if(quiet(now))return
    let count=(getDb().prepare("SELECT COUNT(*) AS n FROM attention_messages WHERE kind IN ('start_reminder','deadline_reminder') AND created_at>=?").get(at(today,0)) as {n:number}).n
    for(const r of reminderCandidates(now)){
      if(count>=p.reminderDailyLimit)break
      const info=getDb().prepare(`INSERT OR IGNORE INTO attention_messages(id,source_key,kind,title,body,created_at,expires_at,payload_json) VALUES(?,?,?,?,?,?,?,?)`)
        .run(randomUUID(),r.key,r.kind,r.title,r.text,now,r.expiresAt,JSON.stringify([r.evidence]))
      if(info.changes)count++
    }
  })()
}
export function attentionState(now=Date.now()):AttentionState{
  reconcile(now)
  const active=rows(),history=getDb().prepare("SELECT * FROM attention_messages WHERE state NOT IN ('open','snoozed') ORDER BY created_at DESC,rowid DESC LIMIT 15").all() as MessageRow[]
  const messages=[...active,...history].sort((a,b)=>b.created_at-a.created_at).map(r=>({id:r.id,kind:r.kind,title:r.title,text:r.body,state:r.state,read:!!r.is_read,createdAt:r.created_at,expiresAt:r.expires_at,snoozedUntil:r.snoozed_until,evidence:payload(r),runId:r.run_id}))
  const p=preferences(),s=stateRow(),day=dateKey(now)
  return{settings:p,messages,unread:active.filter(r=>r.state==='open'&&!r.is_read).length,muted:getDb().prepare('SELECT subject_key AS subjectKey,label FROM attention_mutes ORDER BY label').all() as {subjectKey:string;label:string}[],
    checksToday:(getDb().prepare('SELECT COUNT(*) AS n FROM attention_attempts WHERE day=?').get(day) as {n:number}).n,
    messagesToday:(getDb().prepare("SELECT COUNT(*) AS n FROM attention_messages WHERE kind NOT IN ('start_reminder','deadline_reminder') AND created_at>=?").get(at(day,0)) as {n:number}).n,
    lastCheckAt:s.last_check_at,nextCheckAt:s.last_check_at+p.intervalMin*60000,quiet:quiet(now),
    pending:(getDb().prepare("SELECT COUNT(*) AS n FROM attention_jobs WHERE status IN ('pending','running')").get() as {n:number}).n,
    failed:(getDb().prepare("SELECT COUNT(*) AS n FROM attention_jobs WHERE status='failed'").get() as {n:number}).n,
    remindersEnabled:getSettings().notifyEnabled,advanceHours:getSettings().notifyAdvanceHours,modelConfigured:isAiConfigured(getSettings())}
}
export function message(id:string,now=Date.now()):AttentionMessage{
  if(typeof id!=='string'||id.length>100)throw new Error('消息编号无效。')
  const result=attentionState(now).messages.find(m=>m.id===id)
  if(!result)throw new Error('消息不存在或不在最近记录中。')
  return result
}
export function action(id:string,kind:'read'|'dismiss'|'none'|'later'|'mute',minutes=60,now=Date.now()):void{
  const m=message(id,now)
  if(!['read','dismiss','none','later','mute'].includes(kind))throw new Error('消息操作无效。')
  if(!['open','snoozed'].includes(m.state))return
  getDb().transaction(()=>{
    if(kind==='read'){getDb().prepare('UPDATE attention_messages SET is_read=1 WHERE id=?').run(id);return}
    if(kind==='later'){
      if(!Number.isInteger(minutes)||minutes<5||minutes>240||now+minutes*60000>=m.expiresAt)throw new Error('稍后时间需为5—240分钟且早于消息过期；也可直接忽略。')
      getDb().prepare("UPDATE attention_messages SET state='snoozed',is_read=1,snoozed_until=? WHERE id=?").run(now+minutes*60000,id);return
    }
    if(kind==='mute')for(const e of m.evidence)getDb().prepare('INSERT OR REPLACE INTO attention_mutes(subject_key,label) VALUES(?,?)').run(e.subjectKey,e.title)
    getDb().prepare('UPDATE attention_messages SET state=?,is_read=1 WHERE id=?').run(kind==='none'?'answered':'dismissed',id)
  })()
  reconcile(now)
}
export function linkRun(id:string,runId:string):void{getDb().prepare("UPDATE attention_messages SET run_id=?,state='answered',is_read=1 WHERE id=?").run(runId,id)}
export function retryFailures(now=Date.now()):void{
  getDb().prepare("UPDATE attention_jobs SET status='pending',attempts=0,retry_at=? WHERE status='failed'").run(now)
}
export interface AttentionJob {id:string;keys:string[];versions:Record<string,string>;settingsVersion:number;attempts:number;token:string;attemptId:number}
export function cancelJob(job:AttentionJob,now:number):void{
  const fresh=new Map(candidates(now).map(e=>[e.key,e]))
  getDb().transaction(()=>{
    const row=getDb().prepare("SELECT 1 FROM attention_jobs WHERE id=? AND token=? AND status='running'").get(job.id,job.token);if(!row)return
    getDb().prepare("UPDATE attention_jobs SET status='cancelled',token=NULL WHERE id=?").run(job.id)
    for(const key of job.keys)getDb().prepare("UPDATE attention_events SET state=? WHERE key=? AND state='queued'").run(fresh.has(key)?'new':'cancelled',key)
    getDb().prepare("UPDATE attention_attempts SET outcome='stale' WHERE id=?").run(job.attemptId)
  })()
}
export function jobCurrent(job:AttentionJob,now:number):boolean{
  const p=preferences()
  if(!p.proactiveEnabled||p.version!==job.settingsVersion||quiet(now))return false
  if(!getDb().prepare("SELECT 1 FROM attention_jobs WHERE id=? AND status='running' AND token=? AND lease_until>?").get(job.id,job.token,now))return false
  const fresh=new Map(candidates(now).map(e=>[e.key,e.version]));return job.keys.every(k=>fresh.get(k)===job.versions[k])
}
export function claimJob(now:number):AttentionJob|null{
  refreshAttention(now)
  const p=preferences(),state=attentionState(now)
  if(!p.proactiveEnabled||state.quiet||state.checksToday>=p.dailyChecks||state.messagesToday>=p.dailyMessages||now<state.nextCheckAt)return null
  return getDb().transaction(()=>{
    const current=attentionState(now)
    if(!current.settings.proactiveEnabled||current.quiet||current.checksToday>=current.settings.dailyChecks||current.messagesToday>=current.settings.dailyMessages||now<current.nextCheckAt)return null
    getDb().prepare("UPDATE attention_jobs SET status=CASE WHEN attempts<2 THEN 'pending' ELSE 'failed' END,token=NULL WHERE status='running' AND lease_until<=?").run(now)
    if(getDb().prepare("SELECT 1 FROM attention_jobs WHERE status='running' AND lease_until>? LIMIT 1").get(now))return null
    let row=getDb().prepare("SELECT * FROM attention_jobs WHERE status='pending' AND retry_at<=? ORDER BY created_at LIMIT 1").get(now) as {id:string;event_keys_json:string;versions_json:string;settings_version:number;attempts:number}|undefined
    if(row){
      const fresh=new Map(candidates(now).map(e=>[e.key,e.version])),versions=JSON.parse(row.versions_json) as Record<string,string>,keys=JSON.parse(row.event_keys_json) as string[]
      if(row.settings_version!==p.version||keys.some(k=>fresh.get(k)!==versions[k])){
        getDb().prepare("UPDATE attention_jobs SET status='cancelled',token=NULL WHERE id=?").run(row.id)
        keys.forEach(k=>getDb().prepare("UPDATE attention_events SET state=? WHERE key=? AND state='queued'").run(fresh.has(k)?'new':'cancelled',k));row=undefined
      }
    }
    if(!row){
      const fresh=new Set(candidates(now).map(e=>e.key))
      const candidatesRows=(getDb().prepare("SELECT key,kind,version FROM attention_events WHERE state='new' AND expires_at>? ORDER BY CASE kind WHEN 'course' THEN 0 ELSE 1 END,expires_at,key").all(now) as {key:string;kind:string;version:string}[]).filter(e=>fresh.has(e.key))
      const selected=candidatesRows.filter(e=>e.kind===candidatesRows[0]?.kind).slice(0,3);if(!selected.length)return null
      const id=randomUUID(),versions=Object.fromEntries(selected.map(e=>[e.key,e.version]))
      getDb().prepare('INSERT INTO attention_jobs(id,event_keys_json,versions_json,settings_version,created_at) VALUES(?,?,?,?,?)').run(id,JSON.stringify(selected.map(e=>e.key)),JSON.stringify(versions),p.version,now)
      selected.forEach(e=>getDb().prepare("UPDATE attention_events SET state='queued' WHERE key=?").run(e.key))
      row={id,event_keys_json:JSON.stringify(selected.map(e=>e.key)),versions_json:JSON.stringify(versions),settings_version:p.version,attempts:0}
    }
    const token=randomUUID()
    getDb().prepare("UPDATE attention_jobs SET status='running',attempts=attempts+1,lease_until=?,token=? WHERE id=?").run(now+120000,token,row.id)
    const info=getDb().prepare('INSERT INTO attention_attempts(job_id,started_at,day) VALUES(?,?,?)').run(row.id,now,dateKey(now))
    getDb().prepare('UPDATE attention_state SET last_check_at=? WHERE id=1').run(now)
    return{id:row.id,keys:JSON.parse(row.event_keys_json),versions:JSON.parse(row.versions_json),settingsVersion:row.settings_version,attempts:row.attempts+1,token,attemptId:Number(info.lastInsertRowid)}
  })()
}
export function publish(job:AttentionJob,mode:'silent'|'ask'|'suggest',text:string,selected:string[],trace:unknown[],now:number):boolean{
  if(!jobCurrent(job,now)){cancelJob(job,now);return false}
  const current=new Map(candidates(now).map(e=>[e.key,e])),items=selected.map(k=>current.get(k)!)
  return getDb().transaction(()=>{
    if(!jobCurrent(job,now))return false
    let status='silent'
    const state=attentionState(now)
    if(mode!=='silent'&&state.messagesToday<preferences().dailyMessages){
      const kind=items.every(e=>e.kind==='course')?'course_question':mode==='suggest'?'suggestion':'nudge'
      getDb().prepare('INSERT OR IGNORE INTO attention_messages(id,source_key,kind,title,body,created_at,expires_at,payload_json) VALUES(?,?,?,?,?,?,?,?)')
        .run(randomUUID(),`job:${job.id}`,kind,kind==='course_question'?'课后事项':'计划回顾',text,now,Math.min(...items.map(e=>e.expiresAt)),JSON.stringify(items));status='published'
    }
    getDb().prepare('UPDATE attention_jobs SET status=?,token=NULL,trace_json=? WHERE id=? AND token=?').run(status,JSON.stringify(trace),job.id,job.token)
    job.keys.forEach(k=>getDb().prepare("UPDATE attention_events SET state='checked' WHERE key=?").run(k))
    getDb().prepare('UPDATE attention_attempts SET outcome=? WHERE id=?').run(status,job.attemptId)
    return true
  })()
}
export function desktopBatch(now=Date.now()):{id:string;messages:AttentionMessage[]}|null{
  const p=preferences();if(!p.desktopEnabled||quiet(now)||!getSettings().notifyEnabled||now-stateRow().last_desktop_at<5*60000)return null
  const count=(getDb().prepare('SELECT COUNT(*) AS n FROM attention_desktop_batches WHERE day=?').get(dateKey(now)) as {n:number}).n;if(count>=6)return null
  const messages=attentionState(now).messages.filter(m=>m.state==='open'&&(m.kind==='start_reminder'||m.kind==='deadline_reminder')&&getDb().prepare("SELECT 1 FROM attention_messages WHERE id=? AND desktop_status='pending'").get(m.id))
  if(!messages.length)return null
  const id=randomUUID()
  getDb().transaction(()=>{
    messages.forEach(m=>getDb().prepare("UPDATE attention_messages SET desktop_status='submitted' WHERE id=?").run(m.id))
    getDb().prepare('INSERT INTO attention_desktop_batches(id,day,created_at,ids_json,status) VALUES(?,?,?,?,?)').run(id,dateKey(now),now,JSON.stringify(messages.map(m=>m.id)),'submitted')
    getDb().prepare('UPDATE attention_state SET last_desktop_at=? WHERE id=1').run(now)
  })()
  return{id,messages}
}
export function desktopResult(id:string,status:'shown'|'failed'):void{getDb().prepare('UPDATE attention_desktop_batches SET status=? WHERE id=?').run(status,id)}
