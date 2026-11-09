export type PlanChangeReason = 'unspecified' | 'user_postpone' | 'calendar_change' | 'capacity_change' | 'other'
export interface PlanAuditInput { reason: PlanChangeReason; note: string }
export interface TaskEvent {
  id: number; taskId: number; kind: string; actor: 'user' | 'system'; source: string; reason: string; note: string
  before: Record<string,unknown> | null; after: Record<string,unknown> | null; sourceRef: string | null; occurredAt: string; localDay: string
}
export interface FrozenPlanItem { taskId:number; title:string; plannedStart:number; plannedEnd:number; state:'completed'|'moved_out'|'archived'|'pending' }
export interface FrozenPlan {
  date:string; frozenAt:string; method:string; timeZone:string; denominator:number; completed:number; rate:number|null
  addedTaskIds:number[]; items:FrozenPlanItem[]
}
export interface StatisticsReport {
  endDate:string; startDate:string; enabledAt:string; timeZone:string
  days:{date:string; coverage:'none'|'partial'|'full'; completed:number|null; postponed:number|null; baseline:FrozenPlan|null}[]
  completedTasks:number|null; onTime:{eligible:number; completedOnTime:number; rate:number|null; withoutDeadline:number}
  changes:{postponeEvents:number; postponedTasks:number; plannedTasks:number; postponeRate:number|null; otherManualMoves:number; agentConfirmedMoves:number; systemMoves:number; reasons:{reason:string;count:number}[]}
  estimates:{sampleCount:number; excluded:number; baseMape:number|null; plannedMape:number|null; meanAbsoluteMin:number|null; groups:{group:string;source:string;count:number;baseMape:number;plannedMape:number}[]}
  currentBaseline:FrozenPlan|null; recentEvents:TaskEvent[]
}
export const STATISTICS_IPC={read:'statistics:read',freeze:'statistics:freeze'} as const
export const PLAN_REASON_LABELS:Record<PlanChangeReason,string>={unspecified:'未说明原因',user_postpone:'我主动推迟',calendar_change:'课表或临时占用变化',capacity_change:'容量或状态调整',other:'其他'}
