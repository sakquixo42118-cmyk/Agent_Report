import type {AttentionEvidence} from '@shared/attention'
export function deadlineClock(e: AttentionEvidence, now: number): {deadlineRemainingMin: number|null;deadlineStatus: string} {
  const value=e.deadlineConfirmed&&e.deadlineAt?Date.parse(e.deadlineAt):NaN
  if(!Number.isFinite(value))return{deadlineRemainingMin:null,deadlineStatus:'无已确认截止'}
  const remaining=Math.ceil((value-now)/60000)
  return{deadlineRemainingMin:remaining,deadlineStatus:value<now?'截止已过':remaining===0?'截止已到':'尚未截止'}
}
/** Reject a numeric future-countdown claim unsupported by the selected real deadlines. */
export function relativeTimeIssue(text: string, evidence: AttentionEvidence[], now: number): string|null {
  const claims=[...text.matchAll(/(?:距离|离)(?:截止|到期|最后期限)(?:还有|还剩|剩余)?\s*(\d+)\s*分钟|(?:还有|剩余|还剩)\s*(\d+)\s*分钟(?:就|才)?(?:截止|到期)|(\d+)\s*分钟后(?:截止|到期)/g)].map(m=>Number(m[1]??m[2]??m[3]))
  if(!claims.length)return null
  const times=evidence.map(e=>deadlineClock(e,now)).filter(e=>e.deadlineRemainingMin!==null)
  if(!times.length)return '本次证据没有可支持倒计时的已确认截止，请省略剩余分钟数。'
  if(claims.some(n=>!times.some(t=>t.deadlineStatus!=='截止已过'&&t.deadlineRemainingMin!>=0&&Math.abs(t.deadlineRemainingMin!-n)<=1)))return '剩余分钟数与当前截止证据不一致。任务标题中的相对时间不会自动更新，请以deadlineLocal为准，改用绝对时刻或“临近/已过截止”。'
  return null
}
