import { getDb } from '../db/database'
import type { CalendarException, DayOverride, TaskDependency, PlanBlock } from '@shared/planning'

export function listExceptions(): CalendarException[] {
  return getDb().prepare(`SELECT id,kind,date,course_id AS courseId,name,start_min AS startMin,end_min AS endMin
    FROM calendar_exceptions ORDER BY date,start_min,id`).all() as CalendarException[]
}
export function listDayOverrides(): DayOverride[] {
  return getDb().prepare(`SELECT date,mode,daily_max_min AS dailyMaxMin,start_min AS startMin,end_min AS endMin,note
    FROM day_overrides ORDER BY date`).all() as DayOverride[]
}
export function listDependencies(): TaskDependency[] {
  return getDb().prepare(`SELECT d.task_id AS taskId,d.prerequisite_id AS prerequisiteId,
    COALESCE(t.summary,t.content) AS title,COALESCE(p.summary,p.content) AS prerequisiteTitle,
    p.status AS prerequisiteStatus,t.status AS taskStatus FROM task_dependencies d
    JOIN tasks t ON t.id=d.task_id JOIN tasks p ON p.id=d.prerequisite_id ORDER BY d.task_id,d.prerequisite_id`).all() as TaskDependency[]
}
/** 只验证未来/正在执行的依赖计划，不将过去的计划块当作已经完成。 */
export function assertDependencies(blocks: PlanBlock[], dependencies: TaskDependency[], now: number): void {
  for (const d of dependencies.filter(d => d.taskStatus === 'pending' && d.prerequisiteStatus !== 'done')) {
    const successors = blocks.filter(b => b.taskId === d.taskId && b.end > now)
    if (!successors.length) continue
    const predecessors = blocks.filter(b => b.taskId === d.prerequisiteId)
    if (d.prerequisiteStatus !== 'pending' || !predecessors.length || predecessors.some(b => b.end <= now) ||
      successors.some(b => predecessors.some(p => p.end > b.start))) {
      throw new Error(`「${d.title}」的前置任务「${d.prerequisiteTitle}」尚未完成且执行顺序不满足；请先处理关联安排。`)
    }
  }
}
// 供任务DAO使用，避免删除/撤销完成把依赖安排静默变成无效状态。
export function guardTaskDependencyChange(id: number, kind: 'archive' | 'undo' | 'inbox'): void {
  const deps = listDependencies()
  if (kind === 'archive' && deps.some(d => d.prerequisiteId === id && d.taskStatus !== 'archived')) {
    throw new Error('此任务仍是其他任务的前置项，请先在日程中移除相应前置关系。')
  }
  if (kind !== 'archive') {
    const blocks = getDb().prepare(`SELECT task_id AS taskId,start_at AS start,end_at AS end FROM plan_blocks`).all() as PlanBlock[]
    assertDependencies(blocks, deps.filter(d=>d.prerequisiteId===id).map(d => ({...d,prerequisiteStatus:kind === 'undo' ? 'pending' : 'inbox'})), Date.now())
  }
}
