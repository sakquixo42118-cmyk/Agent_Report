import * as tasks from '../db/taskDao'
import { getDb } from '../db/database'
import type { PriorityChange, PendingChange } from '@shared/agent'
import * as planning from '../planning/service'
import type { Task } from '@shared/types'
import type { ToolDefinition } from './model'
import { createHash } from 'node:crypto'
import * as memory from '../memory/service'
import { registerTool } from './registry'
import type { ToolContext, ToolResult } from './contracts'
export type { ToolContext, ToolResult } from './contracts'

type Field = { type: 'string' | 'integer' | 'array'; description?: string; enum?: string[]; minimum?: number; maximum?: number; maxLength?: number; items?: object; minItems?: number; maxItems?: number }
interface Spec { name: string; description: string; fields: Record<string, Field>; required: string[] }
const specs: Spec[] = [
  { name: 'search_memory', description: '按当前目标检索相关的用户确认记忆。可按估时分组scope筛选（并包含相关全局记忆），最多5条；无命中如实为空。记忆有来源/版本/有效期，本次明确要求优先。', fields: {
    query: { type: 'string', maxLength: 100 }, scope: { type: 'string', maxLength: 60, description: '可选，使用实际分组原文如“数学分析”或“全局”，不要加course:等前缀；不知道真实分组时省略。' }, limit: { type: 'integer', minimum: 1, maximum: 5 }
  }, required: ['query'] },
  { name: 'estimate_duration', description: '读取真实任务的分组、原始估时和个人历史样本校准。只知道名称时先list_tasks按关键词取得真实taskId，不猜测或使用示例ID。不会改变已有计划或反复乘系数；试排会使用同一结果。', fields: { taskId: { type: 'integer', minimum: 1 } }, required: ['taskId'] },
  { name: 'get_feedback_history', description: '读取指定估时分组最近最多5条有效完成反馈及用户补充，属于单次执行证据，不等同长期画像。撤销完成的记录不返回。', fields: { scope: { type: 'string', maxLength: 60 }, limit: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['scope'] },
  { name: 'propose_memory', description: '提出长期记忆草案，用户确认后保存。分组scope可为全局或课程/估时分组；单次反馈不要直接泛化。更新现有记忆时预览原值。', fields: {
    scope: { type: 'string', maxLength: 60 }, key: { type: 'string', maxLength: 60 }, value: { type: 'string', maxLength: 800 }, expiresAt: { type: 'string', maxLength: 50, description: '可选ISO有效期，空字符串表示无到期时间。' }
  }, required: ['scope', 'key', 'value'] },
  { name: 'respond', description: '向用户展示本轮完整答复。text必须自包含，其他assistant content不会展示；查到事实后须在text中回答原问题，不能只问是否要继续规划。mode=question仅在确需补充信息时等待回答，事实已足够用mode=answer结束。不能声称未提交操作已保存。', fields: {
    mode: { type: 'string', enum: ['question', 'answer'] }, text: { type: 'string', maxLength: 3000 }
  }, required: ['mode', 'text'] },
  { name: 'get_calendar', description: '读取最多7天的课程、停补课/临时占用、单日正常或轻量设置、有效容量、显式任务依赖和已有执行计划。effectiveDays是各日真实设置；日期格式YYYY-MM-DD。', fields: { startDate: { type: 'string', maxLength: 10 }, endDate: { type: 'string', maxLength: 10 } }, required: ['startDate', 'endDate'] },
  { name: 'get_free_slots', description: '计算日期范围内避开课程、已有安排和休息后的空档及每日剩余容量；空档不是已保存安排。', fields: { startDate: { type: 'string', maxLength: 10 }, endDate: { type: 'string', maxLength: 10 } }, required: ['startDate', 'endDate'] },
  { name: 'preview_plan', description: '为指定的真实未完成任务试排连续执行时段，避开课程和其他任务、不超过已确认截止。可移动所选任务尚未开始且未锁定的安排。返回试排ID、安排、未安排原因；不会写正式计划。先查询任务ID。', fields: {
    taskIds: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 20 }, startDate: { type: 'string', maxLength: 10 }, endDate: { type: 'string', maxLength: 10 },
    dailyStartMin: { type: 'integer', minimum: 0, maximum: 1439, description: '可选，每天候选开始下界，午夜起分钟；下午可设720或更晚。' }, dailyEndMin: { type: 'integer', minimum: 1, maximum: 1440, description: '可选，每天候选结束上界。' }
  }, required: ['taskIds', 'startDate', 'endDate'] },
  { name: 'propose_plan', description: '将本次对话的试排结果交给用户确认。必须引用preview_plan返回的previewId；无可行块不能提交。存在未安排任务时说明部分成功，不得说全部安排。', fields: { previewId: { type: 'string', maxLength: 100 } }, required: ['previewId'] },
  { name: 'list_tasks', description: '查询任务。按关键词和状态筛选，返回真实字段及updatedAt；不会修改数据。',
    fields: { query: { type: 'string', maxLength: 100 }, status: { type: 'string', enum: ['active', 'done', 'all'] }, limit: { type: 'integer', minimum: 1, maximum: 20 }, taskIds: { type: 'array', items: { type:'integer',minimum:1 },minItems:1,maxItems:20 } }, required: [] },
  { name: 'get_task', description: '按已知真实ID读取一条任务最新状态。只知道名称时必须先list_tasks查询ID，不猜测或使用示例ID。提出调级前先读取；归档任务不可修改。',
    fields: { taskId: { type: 'integer', minimum: 1 } }, required: ['taskId'] },
  { name: 'propose_priority_change', description: '提出重要度/紧急度修改草案，必须使用刚读取的ID和updatedAt。不会立即写入；用户点击确认后应用。至少指定一种评分。',
    fields: { taskId: { type: 'integer', minimum: 1 }, importance: { type: 'integer', minimum: 1, maximum: 5 }, urgency: { type: 'integer', minimum: 1, maximum: 5 },
      expectedUpdatedAt: { type: 'string', maxLength: 60 }, reason: { type: 'string', maxLength: 200 } }, required: ['taskId', 'expectedUpdatedAt', 'reason'] },
  { name: 'ask_user', description: '信息不足或任务指代有歧义时向用户提出一个简短问题，保存并等待回复；信息充分时不必调用。',
    fields: { question: { type: 'string', maxLength: 500 } }, required: ['question'] },
  { name: 'finish_reply', description: '本轮信息已充分时，以简短答复结束；不可用于提出需要用户回答的问题，不可声称尚未确认的操作已执行。',
    fields: { text: { type: 'string', maxLength: 3000 } }, required: ['text'] }
]
export const toolDefinitions: ToolDefinition[] = specs.map(s => ({ type: 'function', function: {
  name: s.name, description: s.description,
  parameters: { type: 'object', properties: s.fields, required: s.required, additionalProperties: false }
} }))
for (const definition of toolDefinitions) registerTool({ definition,
  effect: definition.function.name.startsWith('propose_') ? 'propose' : ['ask_user','respond','finish_reply'].includes(definition.function.name) ? 'respond' : 'read',
  execute: (args, context) => executeTool(definition.function.name, JSON.stringify(args), context) })

function fail(errorCode: string, message: string): ToolResult { return { ok: false, errorCode, message } }
function readableTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readableTimes)
  if (!value || typeof value !== 'object') return value
  const obj = value as Record<string, unknown>, result = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, readableTimes(v)]))
  if (typeof obj.start === 'number' && typeof obj.end === 'number') {
    result.startLocal = new Date(obj.start).toLocaleString('sv-SE')
    result.endLocal = new Date(obj.end).toLocaleString('sv-SE')
  }
  return result
}
function view(t: Task): object {
  return { id: t.id, content: t.content.slice(0, 400), summary: t.summary, status: t.status, importance: t.importance,
    urgency: t.urgency, deadlineAt: t.deadlineAt, deadlineLocal: t.deadlineAt ? new Date(t.deadlineAt).toLocaleString('sv-SE') : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, deadlineConfirmed: t.deadlineConfirmed, deadlineSource: t.deadlineSource,
    legacyDueAt: t.legacyDueAt, executionWindowStart: t.rangeStart, executionWindowEnd: t.rangeEnd, estimateMin: t.estimateMin, baseEstimateMin: t.baseEstimateMin,
    estimateGroup: t.estimateGroup, estimateSource: t.estimateSource, personalEstimate: memory.durationEstimate(t),
    prerequisites: planning.listDependencies().filter(d=>d.taskId===t.id).map(d=>({taskId:d.prerequisiteId,title:d.prerequisiteTitle,status:d.prerequisiteStatus})),
    manualLocked: t.manualLocked, updatedAt: t.updatedAt }
}
export function executeTool(name: string, raw: string, context: ToolContext): ToolResult {
  const spec = specs.find(s => s.name === name)
  if (!spec) return fail('UNKNOWN_TOOL', '工具不存在；只能使用已注册的工具。')
  let args: Record<string, unknown>
  try { args = JSON.parse(raw) } catch { return fail('INVALID_ARGUMENTS', '参数不是有效JSON。') }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('INVALID_ARGUMENTS', '参数必须是对象。')
  if (Object.keys(args).some(k => !Object.hasOwn(spec.fields, k)) || spec.required.some(k => !Object.hasOwn(args, k))) return fail('INVALID_ARGUMENTS', '参数缺失或包含不允许的字段。')
  for (const [key, value] of Object.entries(args)) {
    const field = spec.fields[key]
    if (field.type === 'string' && (typeof value !== 'string' || value.length > (field.maxLength ?? 500) || (field.enum && !field.enum.includes(value)))) return fail('INVALID_ARGUMENTS', `${key}不是允许的字符串。`)
    if (field.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (field.minimum ?? 0) || value > (field.maximum ?? Number.MAX_SAFE_INTEGER))) return fail('INVALID_ARGUMENTS', `${key}不是范围内整数。`)
    if (field.type === 'array' && (!Array.isArray(value) || value.length < 1 || value.length > 20 || value.some(v => !Number.isSafeInteger(v) || v < 1) || new Set(value).size !== value.length)) return fail('INVALID_ARGUMENTS', `${key}必须是1—20个不同的任务编号。`)
    if (spec.required.includes(key) && typeof value === 'string' && !value.trim()) return fail('INVALID_ARGUMENTS', `${key}不能为空。`)
  }
  try {
    if (name === 'get_feedback_history') return { ok: true, data: { records: memory.recentFeedback(String(args.scope), Number(args.limit ?? 5)) } }
    if (name === 'search_memory') {
      if (args.scope !== undefined && !memory.hasScope(String(args.scope))) return fail('UNKNOWN_MEMORY_SCOPE', '没有这个记忆分组。scope需使用保存时的原文，不要加course:等前缀；请省略scope按关键词重查，不要据此断言没有相关记忆。')
      return { ok: true, data: { facts: memory.searchMemory(String(args.query), args.scope as string | undefined, Number(args.limit ?? 5)) } }
    }
    if (name === 'propose_memory') {
      const fact = memory.validateFact({ scope: String(args.scope), key: String(args.key), value: String(args.value), expiresAt: args.expiresAt as string | undefined })
      const before = memory.findFact(fact.scope, fact.key)
      return { ok: true, data: { fact, before, saved: false }, pause: 'awaiting_confirmation', pending: { type: 'memory', fact, before, expectedVersion: before?.version ?? null } }
    }
    if (name === 'get_calendar') return { ok: true, data: readableTimes(planning.snapshot(String(args.startDate), String(args.endDate))) }
    if (name === 'get_free_slots') return { ok: true, data: readableTimes(planning.getFree(String(args.startDate), String(args.endDate))) }
    if (name === 'preview_plan') {
      if (!context.runId) return fail('INVALID_CONTEXT', '缺少当前对话。')
      if ((args.taskIds as number[]).some(id => !context.observed.has(id))) return fail('READ_REQUIRED', '请先查询本次运行中所需的任务。')
      const result = planning.preview(args.taskIds as number[], String(args.startDate), String(args.endDate), context.runId, Date.now(), { startMin: args.dailyStartMin as number | undefined, endMin: args.dailyEndMin as number | undefined })
      return { ok: true, data: readableTimes({ ...result, previewId: result.id, saved: false }) }
    }
    if (name === 'propose_plan') {
      if (!context.runId) return fail('INVALID_CONTEXT', '缺少当前对话。')
      const p = planning.loadPreview(String(args.previewId), context.runId)
      if (!p.blocks.length) return fail('NO_FEASIBLE_PLAN', '没有可行安排，请读取未安排原因，必要时询问用户。')
      if (planning.snapshot(p.startDate, p.endDate).version !== p.version) return fail('VERSION_CONFLICT', '计划或课表已变化，请重新试排。')
      return { ok: true, data: { preview: p, saved: false }, pause: 'awaiting_confirmation', pending: { type: 'plan', preview: p } }
    }
  } catch (e) { return fail('PLANNING_ERROR', e instanceof Error ? e.message : '规划工具执行失败。') }
  if (name === 'list_tasks') {
    const list = tasks.listTasks(args.status === 'all' ? {} : { status: args.status === 'done' ? 'done' : 'active' })
      .filter(t => !args.taskIds || (args.taskIds as number[]).includes(t.id))
      .filter(t => !args.query || `${t.content} ${t.summary ?? ''}`.toLocaleLowerCase().includes(String(args.query).toLocaleLowerCase()))
    const selected = list.slice(0, Number(args.limit ?? (Array.isArray(args.taskIds) ? args.taskIds.length : 10)))
    selected.forEach(t => context.observed.set(t.id, t.updatedAt))
    return { ok: true, data: { tasks: selected.map(view), totalMatches: list.length, truncated: selected.length < list.length } }
  }
  if (name === 'ask_user') return { ok: true, data: { question: args.question }, pause: 'waiting_user' }
  if (name === 'finish_reply') return { ok: true, data: { text: args.text }, pause: 'completed' }
  if (name === 'respond') return { ok: true, data: args.mode === 'question' ? { question: args.text } : { text: args.text }, pause: args.mode === 'question' ? 'waiting_user' : 'completed' }
  const task = tasks.getTaskById(Number(args.taskId))
  if (!task || task.status === 'archived') return fail('NOT_FOUND', '该任务不存在或已归档。')
  if (name === 'get_task') { context.observed.set(task.id, task.updatedAt); return { ok: true, data: view(task) } }
  if (name === 'estimate_duration') return { ok: true, data: memory.durationEstimate(task) }
  if (task.status !== 'pending') return fail('INVALID_STATE', '只可调整已分析、未完成的任务。')
  if (context.observed.get(task.id) !== task.updatedAt) return fail('READ_REQUIRED', '请先读取本次运行中的最新任务数据。')
  if (args.expectedUpdatedAt !== task.updatedAt) return fail('VERSION_CONFLICT', '任务已变化，请重新读取。')
  if (args.importance === undefined && args.urgency === undefined) return fail('INVALID_ARGUMENTS', '至少指定重要度或紧急度。')
  const after = { importance: Number(args.importance ?? task.importance), urgency: Number(args.urgency ?? task.urgency) }
  if (after.importance === task.importance && after.urgency === task.urgency) return { ok: true, data: { unchanged: true }, message: '评分未变化，无需修改。' }
  const pending: PriorityChange = { taskId: task.id, title: task.summary || task.content, expectedUpdatedAt: task.updatedAt,
    before: { importance: task.importance, urgency: task.urgency }, after, reason: String(args.reason) }
  return { ok: true, data: { proposed: pending, saved: false }, pause: 'awaiting_confirmation', pending }
}

// 仅由可信UI确认路径调用，不注册给模型。
export function applyPriorityChange(runId: string, pending: PriorityChange): object {
  return getDb().transaction(() => {
    const actionKey = createHash('sha256').update(JSON.stringify(pending)).digest('hex')
    const previous = getDb().prepare('SELECT result_json FROM agent_actions WHERE run_id=? AND action_key=?').get(runId, actionKey) as { result_json: string } | undefined
    if (previous) return JSON.parse(previous.result_json)
    const current = tasks.getTaskById(pending.taskId)
    if (!current || current.status !== 'pending' || current.updatedAt !== pending.expectedUpdatedAt ||
      current.importance !== pending.before.importance || current.urgency !== pending.before.urgency) throw new Error('任务已变化，本草案已失效。请重新查询后再调整。')
    const changed = tasks.updateTask({ id: current.id, ...pending.after })!
    const result = { taskId: current.id, before: pending.before, after: pending.after, updatedAt: changed.updatedAt, saved: true }
    getDb().prepare('INSERT INTO agent_actions(run_id,action_key,result_json,created_at) VALUES(?,?,?,?)')
      .run(runId, actionKey, JSON.stringify(result), new Date().toISOString())
    return result
  })()
}
