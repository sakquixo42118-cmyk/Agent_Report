/** Local calendar facts are calculated by the harness, rather than guessed by the model. */
const weekdays = ['日', '一', '二', '三', '四', '五', '六']
export function localDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}
export function resolveDate(expression: string, now = new Date()): { date: string; weekday: string; baseDate: string; timeZone: string; isPast: boolean } {
  const text = expression.trim().replace(/\s+/g, '')
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const result = new Date(base)
  const exact = text.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?(?:[（(]?(?:周|星期)([一二三四五六日天])[）)]?)?$/)
  if (exact) {
    result.setFullYear(Number(exact[1]), Number(exact[2]) - 1, Number(exact[3]))
    if (result.getFullYear() !== Number(exact[1]) || result.getMonth() !== Number(exact[2]) - 1 || result.getDate() !== Number(exact[3])) throw new Error('日期不存在，请核对年月日。')
    if (exact[4] && weekdays[result.getDay()] !== exact[4].replace('天', '日')) throw new Error(`${localDate(result)}实际为周${weekdays[result.getDay()]}，与提供的星期不一致，请澄清。`)
  } else if (['今天', '明天', '后天', '昨天'].includes(text)) {
    result.setDate(result.getDate() + ({ 今天: 0, 明天: 1, 后天: 2, 昨天: -1 }[text] ?? 0))
  } else {
    const week = text.match(/^(下下|下|这|本)?(?:周|星期)([一二三四五六日天])$/)
    if (!week) throw new Error('请给出今天/明天、这周四/下周四，或明确年月日；周末等不唯一表达需要澄清。')
    const offset = week[1] === '下下' ? 14 : week[1] === '下' ? 7 : 0
    const target = '一二三四五六日'.indexOf(week[2].replace('天', '日'))
    result.setDate(result.getDate() - (base.getDay() + 6) % 7 + offset + target)
  }
  return { date: localDate(result), weekday: `周${weekdays[result.getDay()]}`, baseDate: localDate(base), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, isPast: result < base }
}
export function calendarReference(now = new Date()): string {
  return `当前本地日期${localDate(now)}（周${weekdays[now.getDay()]}）。` + ['今天', '明天', '后天', ...'一二三四五六日'.split('').map(d => `这周${d}`), ...'一二三四五六日'.split('').map(d => `下周${d}`)].map(expression => `${expression}=${resolveDate(expression, now).date}`).join('；')
}

function number(text: string): number {
  if (/^\d+$/.test(text)) return Number(text)
  const digits = '零一二三四五六七八九'
  const normalized = text.replace(/两/g, '二').replace(/〇/g, '零')
  if (normalized.includes('十')) { const [a, b] = normalized.split('十'); return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0) }
  return digits.indexOf(normalized)
}
/** Only a narrow provenance check for explicit clock times, not a truth classifier. */
export function clockTimes(text: string): string[] {
  const found: string[] = []
  const add = (hour: number, minute: number, period = ''): void => {
    if (/下午|晚上/.test(period) && hour < 12) hour += 12
    if (period === '中午' && hour < 11) hour += 12
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) found.push(`${hour}:${minute}`)
  }
  for (const match of text.matchAll(/(凌晨|早上|上午|中午|下午|晚上)?(\d{1,2})[:：](\d{2})/g)) add(Number(match[2]), Number(match[3]), match[1])
  for (const match of text.matchAll(/(凌晨|早上|上午|中午|下午|晚上)?([零〇一二两三四五六七八九十\d]{1,3})[点时](半|[零〇一二两三四五六七八九十\d]{1,3}分?)?/g)) add(number(match[2]), match[3] === '半' ? 30 : match[3] ? number(match[3].replace('分', '')) : 0, match[1])
  return [...new Set(found)]
}
export function unsupportedMemoryTimes(value: string, sources: string): string[] {
  const allowed = new Set(clockTimes(sources))
  return clockTimes(value).filter(t => !allowed.has(t))
}
/** A narrow execution-proof contract for an explicit request, not a general intent router. */
export function explicitlyRequestsPlan(text: string): boolean {
  if (!text.includes('实际试排') || /(?:不要|不用|无需|不必|先不|暂不|不)\s*实际试排/.test(text)) return false
  if (/(?:解释|介绍|什么是).{0,12}实际试排|实际试排.{0,8}(?:是什么|什么意思|原理|怎么实现)/.test(text)) return false
  return /请|帮我|安排|要求|先|试一下|试排一下/.test(text)
}
