/** 课表文本解析：把从教务系统/表格里粘出来的每行一门课，解析成课程记录。
 *  约定格式（分隔符可用逗号、制表符、顿号、分号、竖线）：
 *    课程名, 周一, 08:00-09:40[, 2026-09-01~2027-01-15]
 *  也兼容空格分隔与"周一 08:00-09:40 数学分析"这种星期在前的写法。 */
export interface TimetableRow {
  name: string
  weekday: number
  startMin: number
  endMin: number
  fromDate: string
  toDate: string
}
export interface TimetableIssue {
  line: number
  text: string
  message: string
}
export interface TimetableParseResult {
  rows: TimetableRow[]
  issues: TimetableIssue[]
}

const WEEKDAYS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7
}

/** 周几：周一/星期一/礼拜一/一/1/Mon 都认 */
export function parseWeekday(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, '')
  const cn = text.match(/^(?:周|星期|礼拜)?([一二三四五六日天])$/)
  if (cn) return WEEKDAYS[cn[1]] ?? null
  const num = text.match(/^(?:周|星期|礼拜)?([1-7])$/)
  if (num) return Number(num[1])
  const en = text.match(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)/)
  return en ? WEEKDAYS[en[1].slice(0, 3)] ?? null : null
}

/** 08:00-09:40 / 8:00~9:40 / 0800—0940 / 08:00 至 09:40 */
export function parseTimeRange(raw: string): { startMin: number; endMin: number } | null {
  const m = raw.match(/(\d{1,2})\s*[:：.]?\s*(\d{2})\s*(?:-|–|—|~|～|至|到)\s*(\d{1,2})\s*[:：.]?\s*(\d{2})/)
  if (!m) return null
  if(Number(m[1])>23||Number(m[2])>59||Number(m[3])>24||Number(m[4])>59||(Number(m[3])===24&&Number(m[4])!==0))return null
  const startMin = Number(m[1]) * 60 + Number(m[2])
  const endMin = Number(m[3]) * 60 + Number(m[4])
  if (!(startMin >= 0 && endMin <= 1440 && startMin < endMin)) return null
  return { startMin, endMin }
}

function pad(v: number): string {
  return String(v).padStart(2, '0')
}
function ymd(y: string, m: string, d: string): string | null {
  const out = `${y}-${pad(Number(m))}-${pad(Number(d))}`
  const date = new Date(`${out}T12:00:00`)
  if (Number.isNaN(date.getTime()) || date.getMonth() + 1 !== Number(m) || date.getDate() !== Number(d)) return null
  return out
}

/** 2026-09-01~2027-01-15 / 2026/9/1 至 2027/1/15 */
export function parseDateRange(raw: string): { fromDate: string; toDate: string } | null {
  const m = raw.match(/(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*(?:~|～|至|到|—|–|\.\.)\s*(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/)
  if (!m) return null
  const fromDate = ymd(m[1], m[2], m[3]), toDate = ymd(m[4], m[5], m[6])
  if (!fromDate || !toDate || fromDate > toDate) return null
  return { fromDate, toDate }
}

function parseLine(line: string, defaultFrom: string, defaultTo: string): TimetableRow | string {
  const fields = line.split(/\s*[,\t，、;；|]\s*/).map(s => s.trim()).filter(Boolean)
  let name = '', weekdayText = '', rest = ''
  if (fields.length >= 3) {
    name = fields[0]; weekdayText = fields[1]; rest = fields.slice(2).join(' ')
  } else {
    // 没有明显分隔符：拆出周几，剩下的部分里再找时间与生效范围
    const head = line.match(/^(.+?)\s+(周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|[1-7])\s+(.+)$/)
    const tail = line.match(/^(周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天])\s+(.+?)\s+(.+)$/)
    if (head) { name = head[1]; weekdayText = head[2]; rest = head[3] }
    else if (tail) { weekdayText = tail[1]; rest = tail[2]; name = tail[3] }
    else return '缺少星期，写法如「数学分析, 周一, 08:00-09:40」'
  }
  const weekday = parseWeekday(weekdayText)
  if (!weekday) return `无法识别星期「${weekdayText}」`
  const time = parseTimeRange(rest)
  if (!time) return '缺少或无法识别起止时间，如 08:00-09:40'
  const dates = parseDateRange(rest) ?? { fromDate: defaultFrom, toDate: defaultTo }
  const trimmed = name.trim()
  if (!trimmed) return '缺少课程名'
  if (trimmed.length > 80) return '课程名超过80字'
  if (!dates.fromDate || !dates.toDate || dates.fromDate > dates.toDate) return '生效起止日期无效'
  return { name: trimmed, weekday, startMin: time.startMin, endMin: time.endMin, ...dates }
}

export function parseTimetable(text: string, defaultFrom: string, defaultTo: string): TimetableParseResult {
  const rows: TimetableRow[] = []
  const issues: TimetableIssue[] = []
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) return
    const parsed = parseLine(line, defaultFrom, defaultTo)
    if (typeof parsed === 'string') issues.push({ line: index + 1, text: line, message: parsed })
    else rows.push(parsed)
  })
  return { rows, issues }
}
