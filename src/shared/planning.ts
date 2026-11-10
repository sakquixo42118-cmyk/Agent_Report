export interface Course {
  id: number; name: string; weekday: number; startMin: number; endMin: number
  fromDate: string; toDate: string
}
export interface CourseInput { name: string; weekday: number; startMin: number; endMin: number; fromDate: string; toDate: string }
export interface CourseImportResult { added: number; skipped: number; warnings: string[] }
export interface PlanningSettings { startMin: number; endMin: number; dailyMaxMin: number; breakMin: number }
export interface CalendarExceptionInput {
  kind: 'cancel_course' | 'makeup_course' | 'busy'; date: string; courseId: number | null
  name: string; startMin: number; endMin: number
}
export interface CalendarException extends CalendarExceptionInput { id: number }
export interface DayOverride {
  date: string; mode: 'normal' | 'light'; dailyMaxMin: number | null
  startMin: number | null; endMin: number | null; note: string
}
export interface TaskDependency {
  taskId: number; prerequisiteId: number; title: string; prerequisiteTitle: string; prerequisiteStatus: string; taskStatus: string
}
export interface Interval { start: number; end: number }
export interface Occupancy extends Interval { kind: 'course' | 'task' | 'busy'; title: string; taskId?: number; courseId?: number; locked?: boolean }
export interface PlanBlock extends Interval { id?: number; taskId: number; title: string; locked: boolean; reason: string }
export interface Unscheduled { taskId: number; title: string; reason: string }
export interface PlanningSnapshot {
  startDate: string; endDate: string; version: string; settings: PlanningSettings
  courses: Course[]; occupied: Occupancy[]; blocks: PlanBlock[]
  exceptions: CalendarException[]; dayOverrides: DayOverride[]; dependencies: TaskDependency[]
  effectiveDays: { date: string; settings: PlanningSettings; mode: 'normal' | 'light' }[]
}
export interface PlanPreview {
  id: string; runId: string | null; startDate: string; endDate: string; version: string; createdAt: string
  taskIds: number[]; blocks: PlanBlock[]; unscheduled: Unscheduled[]; previous: PlanBlock[]
  timeWindow: { startMin: number; endMin: number }
}
export interface PlanChange { type: 'plan'; preview: PlanPreview }
/** 手动选时段：某天的可用空档及其不可用原因 */
export interface SlotCandidate { start: number; end: number; fits: boolean; reason?: string }
export interface DaySlots { date: string; remainingCapacityMin: number; candidates: SlotCandidate[]; note?: string }
export interface ManualSlots {
  previous: PlanBlock[]
  taskId: number; title: string; durationMin: number; deadline: number | null
  rangeStart: string | null; rangeEnd: string | null; days: DaySlots[]
}
export const PLANNING_IPC = {
  read: 'planning:read', saveCourse: 'planning:saveCourse', importCourses: 'planning:importCourses',
  deleteCourse: 'planning:deleteCourse',
  settings: 'planning:settings', preview: 'planning:preview', commit: 'planning:commit',
  freeSlots: 'planning:freeSlots', saveBlock: 'planning:saveBlock',
  lock: 'planning:lock', remove: 'planning:remove'
  ,exceptionSave: 'planning:exceptionSave', exceptionDelete: 'planning:exceptionDelete',
  daySave: 'planning:daySave', dayDelete: 'planning:dayDelete',
  dependencySave: 'planning:dependencySave', dependencyDelete: 'planning:dependencyDelete'
} as const
