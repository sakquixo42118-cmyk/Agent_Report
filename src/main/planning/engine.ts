import type { Course, Interval, Occupancy, PlanningSettings, PlanBlock, Unscheduled, CalendarException, DayOverride, TaskDependency } from '@shared/planning'

export function day(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期请使用YYYY-MM-DD。')
  const [y, m, d] = value.split('-').map(Number), result = new Date(y, m - 1, d)
  if (result.getFullYear() !== y || result.getMonth() !== m - 1 || result.getDate() !== d) throw new Error('日期不存在。')
  return result
}
export function dateKey(date: Date | number): string {
  const d = new Date(date), pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export function daysBetween(start: string, end: string): string[] {
  const a = day(start), b = day(end)
  if (a > b) throw new Error('结束日期不能早于开始日期。')
  const list: string[] = []
  while (a <= b) { list.push(dateKey(a)); if (list.length > 7) throw new Error('每次最多规划7天。'); a.setDate(a.getDate() + 1) }
  return list
}
export function at(date: string, minutes: number): number {
  const d = day(date); d.setMinutes(minutes); return d.getTime()
}
export function overlaps(a: Interval, b: Interval): boolean { return a.start < b.end && b.start < a.end }
export function subtract(window: Interval, busy: Interval[]): Interval[] {
  let free = [window]
  for (const block of [...busy].sort((a, b) => a.start - b.start)) {
    free = free.flatMap(slot => !overlaps(slot, block) ? [slot] : [
      ...(block.start > slot.start ? [{ start: slot.start, end: block.start }] : []),
      ...(block.end < slot.end ? [{ start: block.end, end: slot.end }] : [])
    ])
  }
  return free.filter(s => s.end > s.start)
}
export function courseOccupancy(courses: Course[], dates: string[]): Occupancy[] {
  return dates.flatMap(date => courses.filter(c => c.weekday === (day(date).getDay() || 7) && c.fromDate <= date && date <= c.toDate)
    .map(c => ({ start: at(date, c.startMin), end: at(date, c.endMin), kind: 'course' as const, title: c.name, courseId: c.id })))
}
export function calendarOccupancy(courses: Course[], dates: string[], exceptions: CalendarException[]): Occupancy[] {
  const base = courseOccupancy(courses, dates).filter(b => !exceptions.some(e => e.kind === 'cancel_course' && e.date === dateKey(b.start) && e.courseId === b.courseId))
  return [...base, ...exceptions.filter(e => dates.includes(e.date) && e.kind !== 'cancel_course')
    .map(e => ({ start: at(e.date, e.startMin), end: at(e.date, e.endMin), kind: e.kind === 'busy' ? 'busy' as const : 'course' as const,
      title: e.kind === 'makeup_course' ? `补课：${e.name}` : e.name, ...(e.courseId ? {courseId:e.courseId} : {}) }))]
}
export function daySettings(base: PlanningSettings, overrides: DayOverride[], date: string): PlanningSettings {
  const override = overrides.find(o => o.date === date)
  const startMin = override?.startMin ?? base.startMin, endMin = override?.endMin ?? base.endMin
  const limit = override?.dailyMaxMin ?? (override?.mode === 'light' ? Math.max(15, Math.floor(base.dailyMaxMin / 2 / 15) * 15) : base.dailyMaxMin)
  return { ...base, startMin, endMin, dailyMaxMin: Math.min(limit, endMin - startMin) }
}
export function freeIntervals(date: string, settings: PlanningSettings, busy: Occupancy[], now: number): Interval[] {
  const start = Math.max(at(date, settings.startMin), now), end = at(date, settings.endMin)
  if (start >= end) return []
  // 任务两侧保留间隔；课程/临时占用按真实起止，重叠占用由区间减法自然合并。
  return subtract({ start, end }, busy.map(b => ({ start: b.start - (b.kind === 'task' ? settings.breakMin * 60000 : 0), end: b.end + (b.kind === 'task' ? settings.breakMin * 60000 : 0) })))
}
export interface SchedulableTask {
  id: number; title: string; duration: number; score: number; deadline: number | null
  confirmed: boolean; earliestDate: string | null; latestDate: string | null
}
export interface TrialOptions {
  dayOverrides?: DayOverride[]; dependencies?: TaskDependency[]; existingBlocks?: PlanBlock[]
  timeWindow?: { startMin: number; endMin: number }
}
export function trial(tasks: SchedulableTask[], dates: string[], settings: PlanningSettings, occupied: Occupancy[], now: number, options: TrialOptions = {}): { blocks: PlanBlock[]; unscheduled: Unscheduled[] } {
  const busy = [...occupied], blocks: PlanBlock[] = [], unscheduled: Unscheduled[] = []
  const sorted = [...tasks].sort((a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || b.score - a.score || a.id - b.id)
  const dependencies = options.dependencies ?? [], existing = options.existingBlocks ?? []
  const remaining = [...sorted], selected = new Set(tasks.map(t => t.id))
  const daily = (date: string): PlanningSettings => {
    const config = daySettings(settings, options.dayOverrides ?? [], date)
    return { ...config, startMin: Math.max(config.startMin, options.timeWindow?.startMin ?? 0), endMin: Math.min(config.endMin, options.timeWindow?.endMin ?? 1440) }
  }
  while (remaining.length) {
    const index = remaining.findIndex(t => !dependencies.some(d => d.taskId === t.id && d.prerequisiteStatus !== 'done' && remaining.some(p => p.id === d.prerequisiteId)))
    if (index < 0) { remaining.forEach(t => unscheduled.push({taskId:t.id,title:t.title,reason:'前置关系存在环，无法安排；请先修正依赖。'})); break }
    const t = remaining.splice(index, 1)[0]
    const reject = (reason: string): void => { unscheduled.push({ taskId: t.id, title: t.title, reason }) }
    if (!t.confirmed) { reject('日期来源不明确，请先在任务的时间设置中确认截止或明确无截止。'); continue }
    if (busy.some(b => b.taskId === t.id && b.locked)) { reject('已有锁定安排，请先在日程中解锁。'); continue }
    if (!Number.isFinite(t.duration) || t.duration <= 0) { reject('预计耗时无效，请先设置耗时。'); continue }
    let earliest = now, dependencyError = ''
    for (const d of dependencies.filter(d => d.taskId === t.id && d.prerequisiteStatus !== 'done')) {
      const planned = selected.has(d.prerequisiteId) ? blocks.filter(b => b.taskId === d.prerequisiteId) : existing.filter(b => b.taskId === d.prerequisiteId)
      if (d.prerequisiteStatus !== 'pending' || !planned.length || planned.some(b => b.end <= now)) {
        dependencyError = `前置任务「${d.prerequisiteTitle}」尚未完成，且没有本次可用的执行安排；请一并选择前置任务试排，或核对完成状态。`; break
      }
      earliest = Math.max(earliest, ...planned.map(b => b.end))
    }
    if (dependencyError) { reject(dependencyError); continue }
    const successorStart = existing.filter(b => b.end > now && dependencies.some(d => d.prerequisiteId === t.id && d.taskId === b.taskId && d.taskStatus === 'pending')).map(b => b.start)
    const latest = Math.min(t.deadline ?? Infinity, ...successorStart)
    const duration = Math.ceil(t.duration / 15) * 15
    let chosen: PlanBlock | undefined
    for (const date of dates) {
      const config = daily(date)
      if ((t.earliestDate && date < t.earliestDate) || (t.latestDate && date > t.latestDate)) continue
      const load = busy.filter(b => b.kind === 'task' && dateKey(b.start) === date).reduce((sum, b) => sum + (b.end - b.start) / 60000, 0)
      if (load + duration > config.dailyMaxMin) continue
      for (const slot of freeIntervals(date, config, busy, earliest)) {
        const local = new Date(slot.start), minuteOfDay = local.getHours() * 60 + local.getMinutes() + local.getSeconds() / 60 + local.getMilliseconds() / 60000
        const start = at(date, Math.ceil(minuteOfDay / 15) * 15), end = start + duration * 60000
        if (start < slot.start || end > slot.end || end > latest) continue
        chosen = { taskId: t.id, title: t.title, start, end, locked: false,
          reason: `避开课程、临时占用和已有任务；连续预留${duration}分钟，采用最早可行时段${t.deadline ? '且不晚于截止' : ''}。${earliest > now ? ' 排在未完成前置任务的执行块之后。' : ''}${options.dayOverrides?.some(o => o.date === date) ? ` 遵守当天${options.dayOverrides.find(o => o.date === date)!.mode === 'light' ? '轻量' : '单日'}设置，上限${config.dailyMaxMin}分钟。` : ''}` }
        break
      }
      if (chosen) break
    }
    if (!chosen) {
      let maxFree = 0, totalCapacity = 0
      for (const date of dates) {
        const config = daily(date)
        if ((t.earliestDate && date < t.earliestDate) || (t.latestDate && date > t.latestDate)) continue
        const load = busy.filter(b => b.kind === 'task' && dateKey(b.start) === date).reduce((sum, b) => sum + (b.end - b.start) / 60000, 0)
        const remaining = Math.max(0, config.dailyMaxMin - load)
        const slots = freeIntervals(date, config, busy, earliest).map(s => {
          const local = new Date(s.start), minutes = local.getHours() * 60 + local.getMinutes() + local.getSeconds() / 60 + local.getMilliseconds() / 60000
          return Math.max(0, (Math.min(s.end, latest) - at(date, Math.ceil(minutes / 15) * 15)) / 60000)
        })
        maxFree = Math.max(maxFree, Math.min(remaining, Math.max(0, ...slots)))
        totalCapacity += Math.min(remaining, slots.reduce((a, b) => a + b, 0))
      }
      reject(`需要连续${duration}分钟；日期/截止、前后置及当天容量限制内最大可用连续空档${Math.floor(maxFree)}分钟，可用容量合计${Math.floor(totalCapacity)}分钟。请调整窗口或由用户确认拆分。`)
    }
    else { blocks.push(chosen); busy.push({ ...chosen, kind: 'task' }) }
  }
  return { blocks, unscheduled }
}
