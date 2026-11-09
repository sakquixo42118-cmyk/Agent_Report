import {getDb} from '../db/database'
import type {AttentionSettings} from '@shared/attention'
import {setSettings} from '../db/settingsDao'
const columns:Record<keyof AttentionSettings,string>={proactiveEnabled:'proactive_enabled',courseEnabled:'course_enabled',nudgeEnabled:'nudge_enabled',desktopEnabled:'desktop_enabled',
  quietEnabled:'quiet_enabled',quietStartMin:'quiet_start_min',quietEndMin:'quiet_end_min',intervalMin:'interval_min',dailyChecks:'daily_checks',dailyMessages:'daily_messages',
  startAdvanceMin:'start_advance_min',reminderDailyLimit:'reminder_daily_limit',version:'version'}
const bools=['proactiveEnabled','courseEnabled','nudgeEnabled','desktopEnabled','quietEnabled']
export function preferences():AttentionSettings{
  const row=getDb().prepare(`SELECT ${Object.entries(columns).map(([k,v])=>`${v} AS ${k}`).join(',')} FROM attention_settings WHERE id=1`).get() as Record<string,unknown>
  bools.forEach(k=>row[k]=!!row[k]);return row as unknown as AttentionSettings
}
export function savePreferences(input:AttentionSettings,reminders?:{enabled:boolean;advanceHours:number}):void{
  if(!input||Object.keys(input).some(k=>!Object.hasOwn(columns,k))||Object.keys(columns).some(k=>!Object.hasOwn(input,k))||bools.some(k=>typeof input[k as keyof AttentionSettings]!=='boolean'))throw new Error('主动消息设置字段无效。')
  const ranges={quietStartMin:[0,1439],quietEndMin:[0,1439],intervalMin:[5,360],dailyChecks:[1,6],dailyMessages:[1,6],startAdvanceMin:[1,120],reminderDailyLimit:[1,30],version:[1,Number.MAX_SAFE_INTEGER]}
  for(const [k,[lo,hi]] of Object.entries(ranges)){const n=input[k as keyof AttentionSettings];if(typeof n!=='number'||!Number.isInteger(n)||n<lo||n>hi)throw new Error('主动消息参数超出范围。')}
  if(input.quietEnabled&&input.quietStartMin===input.quietEndMin)throw new Error('安静时段起止不能相同；全天静默请关闭主动消息/提醒。')
  if(reminders&&(!['enabled','advanceHours'].every(k=>Object.hasOwn(reminders,k))||Object.keys(reminders).some(k=>!['enabled','advanceHours'].includes(k))||typeof reminders.enabled!=='boolean'||!Number.isInteger(reminders.advanceHours)||reminders.advanceHours<1||reminders.advanceHours>72))throw new Error('时间提醒参数无效。')
  getDb().transaction(()=>{
    if(preferences().version!==input.version)throw new Error('设置已变化，请重新读取。')
    const entries=Object.entries(columns).filter(([k])=>k!=='version')
    getDb().prepare(`UPDATE attention_settings SET ${entries.map(([,v])=>`${v}=?`).join(',')},version=version+1 WHERE id=1`).run(...entries.map(([k])=>bools.includes(k)?(input[k as keyof AttentionSettings]?1:0):input[k as keyof AttentionSettings]))
    if(!input.proactiveEnabled)getDb().prepare("UPDATE attention_messages SET state='dismissed',is_read=1 WHERE kind IN ('course_question','nudge','suggestion') AND state IN ('open','snoozed')").run()
    if(reminders)setSettings({notifyEnabled:reminders.enabled,notifyAdvanceHours:reminders.advanceHours})
  })()
}
export function quiet(now=Date.now()):boolean{
  const p=preferences();if(!p.quietEnabled)return false
  const d=new Date(now),m=d.getHours()*60+d.getMinutes()
  return p.quietStartMin<p.quietEndMin?m>=p.quietStartMin&&m<p.quietEndMin:m>=p.quietStartMin||m<p.quietEndMin
}
export function muted(subjectKey:string):boolean{return !!getDb().prepare('SELECT 1 FROM attention_mutes WHERE subject_key=?').get(subjectKey)}
export function taskMuted(id:number):boolean{return muted(`task:${id}`)}
export function unmute(subjectKey:string):void{
  if(typeof subjectKey!=='string'||!/^(task|course):\d+$/.test(subjectKey))throw new Error('提醒对象无效。')
  getDb().prepare('DELETE FROM attention_mutes WHERE subject_key=?').run(subjectKey)
}
