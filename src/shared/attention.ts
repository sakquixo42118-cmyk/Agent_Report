export interface AttentionSettings {
  proactiveEnabled:boolean;courseEnabled:boolean;nudgeEnabled:boolean;desktopEnabled:boolean
  quietEnabled:boolean;quietStartMin:number;quietEndMin:number;intervalMin:number;dailyChecks:number;dailyMessages:number
  startAdvanceMin:number;reminderDailyLimit:number;version:number
}
export interface AttentionEvidence {
  key:string;kind:'course'|'risk';subjectKey:string;title:string;taskId?:number;courseId?:number
  start?:number;end?:number;deadlineAt?:string|null;deadlineConfirmed?:boolean;plannedStart?:number|null;plannedEnd?:number|null
  flags?:string[];sourceRefs:string[];version:string;expiresAt:number
}
export interface AttentionMessage {
  id:string;kind:'course_question'|'nudge'|'suggestion'|'start_reminder'|'deadline_reminder'
  title:string;text:string;state:'open'|'snoozed'|'answered'|'dismissed'|'cancelled'|'expired';read:boolean
  createdAt:number;expiresAt:number;snoozedUntil:number|null;evidence:AttentionEvidence[];runId:string|null
}
export interface AttentionState {
  settings:AttentionSettings;messages:AttentionMessage[];unread:number;muted:{subjectKey:string;label:string}[]
  checksToday:number;messagesToday:number;lastCheckAt:number;nextCheckAt:number;quiet:boolean;pending:number;failed:number
  remindersEnabled:boolean;advanceHours:number;modelConfigured:boolean
}
export const ATTENTION_IPC={state:'attention:state',settings:'attention:settings',action:'attention:action',unmute:'attention:unmute',
  check:'attention:check',capture:'attention:capture',discuss:'attention:discuss',changed:'attention:changed',navigate:'attention:navigate'} as const
