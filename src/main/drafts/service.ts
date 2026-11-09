import { randomUUID } from 'node:crypto'
import { getDb } from '../db/database'
import * as store from '../agent/store'
import type { DraftItem, TaskDraft } from '@shared/drafts'
import { day } from '../planning/engine'
import {withAudit} from '../statistics/ledger'

export type DraftInput = Partial<Omit<DraftItem, 'id' | 'origin'>>
interface DraftRow { id: string; run_id: string; version: number; state: TaskDraft['state']; items_json: string; created_ids_json: string; updated_at: string }
export function attachSource(runId: string, kind: 'manual' | 'batch' | 'mock_study' | 'study', raw: string, evidenceRef: string): void {
  if (!raw.trim() || raw.length > 12000) throw new Error('原文请保留1—12000字。')
  getDb().prepare('INSERT INTO task_sources(run_id,kind,raw_text,evidence_ref) VALUES(?,?,?,?)').run(runId, kind, raw, evidenceRef)
}
export function readSource(runId: string): { kind: string; raw_text: string; evidence_ref: string } {
  const s = getDb().prepare('SELECT kind,raw_text,evidence_ref FROM task_sources WHERE run_id=?').get(runId) as {kind:string;raw_text:string;evidence_ref:string}|undefined
  if(s)return s
  const r=store.row(runId), messages=JSON.parse(r.messages_json) as {role:string;content:string}[]
  return {kind:'manual',raw_text:messages.filter(m=>m.role==='user').map(m=>m.content).join('\n\n补充：')||r.goal,evidence_ref:`input:${runId}`}
}
function source(runId: string): { kind: string; raw_text: string; evidence_ref: string } {
  let result = getDb().prepare('SELECT * FROM task_sources WHERE run_id=?').get(runId) as { kind: string; raw_text: string; evidence_ref: string } | undefined
  if (!result) {
    const run = store.row(runId), messages = JSON.parse(run.messages_json) as { role: string; content: string }[]
    const raw = messages.filter(m => m.role === 'user').map(m=>m.content).join('\n\n补充：') || run.goal
    attachSource(runId, 'manual', raw, `input:${runId}`)
    result = getDb().prepare('SELECT * FROM task_sources WHERE run_id=?').get(runId) as typeof result
  }
  return result!
}
export function getDraft(id: string): TaskDraft {
  if (typeof id !== 'string' || id.length > 100) throw new Error('草案编号无效。')
  const r = getDb().prepare('SELECT * FROM task_drafts WHERE id=?').get(id) as DraftRow | undefined
  if (!r) throw new Error('草案不存在。')
  const s = source(r.run_id)
  return { id: r.id, runId: r.run_id, version: r.version, state: r.state, sourceKind: s.kind, sourceText: s.raw_text,
    sourceRef: s.evidence_ref, items: JSON.parse(r.items_json), createdTaskIds: JSON.parse(r.created_ids_json), updatedAt: r.updated_at }
}
export function forRun(runId: string): TaskDraft | null {
  const row = getDb().prepare('SELECT id FROM task_drafts WHERE run_id=?').get(runId) as { id: string } | undefined
  return row ? getDraft(row.id) : null
}
export function ensureDraft(runId: string): TaskDraft {
  store.row(runId); source(runId)
  const existing = forRun(runId)
  if (existing) return existing
  const id = randomUUID()
  getDb().prepare('INSERT INTO task_drafts(id,run_id,items_json,updated_at) VALUES(?,?,?,?)').run(id, runId, '[]', new Date().toISOString())
  getDb().prepare('INSERT INTO task_draft_revisions(draft_id,version,items_json,actor,created_at) VALUES(?,?,?,?,?)').run(id,1,'[]','initial',new Date().toISOString())
  return getDraft(id)
}
const fields = ['content', 'estimateMin', 'estimateGroup', 'importance', 'urgency', 'category', 'deadlineMode', 'deadlineAt', 'windowStart', 'windowEnd', 'included', 'note']
export function normalizeItem(input: DraftInput, existing?: DraftItem, origin: DraftItem['origin'] = 'model'): DraftItem {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) throw new Error('草案包含未知字段。')
  const item: DraftItem = { id: existing?.id ?? randomUUID(), content: '', estimateMin: null, estimateGroup: '其他', importance: 3, urgency: 3, category: '其他',
    deadlineMode: 'unknown', deadlineAt: null, windowStart: null, windowEnd: null, included: true, note: '', ...existing, ...input, origin }
  if (typeof item.content !== 'string' || !item.content.trim() || item.content.length > 500) throw new Error('事项名称需要1—500字。')
  if (item.estimateMin !== null && (!Number.isInteger(item.estimateMin) || item.estimateMin < 5 || item.estimateMin > 1440)) throw new Error('原始耗时应为5—1440分钟，未知可留空。')
  if (typeof item.estimateGroup !== 'string' || !item.estimateGroup.trim() || item.estimateGroup.length > 60) throw new Error('请填写1—60字估时分组。')
  if (![item.importance, item.urgency].every(v => Number.isInteger(v) && v >= 1 && v <= 5) || !['工作','生活','学习','其他'].includes(item.category)) throw new Error('评分或分类无效。')
  if (!['unknown','none','set'].includes(item.deadlineMode) || typeof item.included !== 'boolean' || typeof item.note !== 'string' || item.note.length > 500) throw new Error('草案日期状态或备注无效。')
  if (item.deadlineMode === 'set') {
    if (typeof item.deadlineAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(item.deadlineAt) || !Number.isFinite(new Date(item.deadlineAt).getTime())) throw new Error('请提供明确的截止日期时间。')
    day(item.deadlineAt.slice(0, 10))
    item.deadlineAt = new Date(item.deadlineAt).toISOString()
  } else item.deadlineAt = null
  if (item.windowStart !== null) day(item.windowStart)
  if (item.windowEnd !== null) day(item.windowEnd)
  if (item.windowStart && item.windowEnd && item.windowStart > item.windowEnd) throw new Error('执行窗口起止反向。')
  item.content = item.content.trim(); item.estimateGroup = item.estimateGroup.trim(); item.note = item.note.trim()
  return item
}
function update(d: TaskDraft, items: DraftItem[],actor='model'): TaskDraft {
  if (d.state !== 'editing') throw new Error('此草案已提交或放弃，请新建录入。')
  if (items.length > 60) throw new Error('每批最多60项，请分批处理。')
  const info = getDb().prepare('UPDATE task_drafts SET items_json=?,version=version+1,updated_at=? WHERE id=? AND version=? AND state=\'editing\'')
    .run(JSON.stringify(items), new Date().toISOString(), d.id, d.version)
  if (!info.changes) throw new Error('草案已变化，请刷新后再修改。')
  getDb().prepare('INSERT INTO task_draft_revisions(draft_id,version,items_json,actor,created_at) VALUES(?,?,?,?,?)').run(d.id,d.version+1,JSON.stringify(items),actor,new Date().toISOString())
  const next = getDraft(d.id), run = store.getRun(d.runId)
  if (run.status === 'awaiting_confirmation' && run.pending && 'type' in run.pending && run.pending.type === 'task_draft' && run.pending.draftId === d.id) {
    const messages = JSON.parse(store.row(d.runId).messages_json)
    store.save(d.runId, messages, 'awaiting_confirmation', { type: 'task_draft', draftId: d.id, expectedVersion: next.version })
  }
  return next
}
export function addItem(runId: string, input: DraftInput, origin: DraftItem['origin'] = 'model'): TaskDraft {
  return getDb().transaction(() => {
    const d = ensureDraft(runId), item = normalizeItem(input, undefined, origin)
    const duplicate = d.items.find(i => fields.every(k => JSON.stringify(i[k as keyof DraftItem]) === JSON.stringify(item[k as keyof DraftItem])))
    if (duplicate && origin === 'model') return d
    return update(d, [...d.items, item],origin)
  })()
}
export function patchItem(runId: string, draftId: string, version: number, itemId: string, input: DraftInput): TaskDraft {
  return getDb().transaction(() => {
    const d = getDraft(draftId)
    if (d.runId !== runId || d.version !== version) throw new Error('草案归属或版本不符，请读取最新草案。')
    const old = d.items.find(i => i.id === itemId)
    if (!old) throw new Error('候选事项不存在。')
    return update(d, d.items.map(i => i.id === itemId ? normalizeItem(input, old) : i))
  })()
}
export function saveFromUI(id: string, version: number, incoming: DraftItem[]): TaskDraft {
  return getDb().transaction(() => {
    const d = getDraft(id)
    if (store.row(d.runId).status === 'running') throw new Error('请等待当前模型运行结束后再编辑。')
    if (d.version !== version || !Array.isArray(incoming) || incoming.length !== d.items.length || new Set(incoming.map(i => i.id)).size !== incoming.length) throw new Error('草案已变化或条目不一致，请刷新。')
    const items = incoming.map(item => {
      const old = d.items.find(i => i.id === item.id)
      if (!old || Object.keys(item).some(k => ![...fields,'id','origin'].includes(k))) throw new Error('不允许替换来源或候选身份。')
      const patch = Object.fromEntries(fields.map(k => [k, item[k as keyof DraftItem]])) as DraftInput
      return normalizeItem(patch, old, 'user')
    })
    return update(d, items,'user')
  })()
}
export function propose(runId: string, draftId: string, version: number): TaskDraft {
  const d = getDraft(draftId)
  if (d.runId !== runId || d.version !== version || d.state !== 'editing') throw new Error('草案归属、状态或版本不符。')
  validateCommit(d)
  return d
}
function validateCommit(d: TaskDraft): void {
  const included = d.items.filter(i => i.included)
  if (!included.length) throw new Error('至少选择1项任务，或放弃本草案。')
  if (included.some(i => i.estimateMin === null)) throw new Error('所选任务还有未知耗时，请询问用户或提出标明为建议的估时，再让用户核对。')
  included.forEach(i => normalizeItem(Object.fromEntries(fields.map(k => [k, i[k as keyof DraftItem]])) as DraftInput, i, i.origin))
}
export function commit(runId: string, id: string, expectedVersion: number): { saved: true; taskIds: number[]; sourceRef: string } {
  return withAudit({actor:'user',source:'draft_confirmed',sourceRef:`draft:${id}`},()=>{
  return getDb().transaction(() => {
    const d = getDraft(id)
    if (d.runId !== runId || d.version !== expectedVersion) throw new Error('草案版本已变化，请重新核对卡片。')
    if (d.state === 'committed') return { saved: true as const, taskIds: d.createdTaskIds, sourceRef: d.sourceRef }
    if (d.state !== 'editing') throw new Error('草案已放弃。')
    validateCommit(d)
    const ids: number[] = [], now = new Date().toISOString()
    const insert = getDb().prepare(`INSERT INTO tasks(content,summary,status,category,importance,urgency,estimate_min,base_estimate_min,estimate_group,estimate_source,
      deadline_at,deadline_confirmed,deadline_source,ai_status,manual_locked,range_start,range_end,created_at,updated_at)
      VALUES(?,?,'pending',?,?,?,?,?,?,'user',?,?,?,'confirmed',1,?,?,?,?)`)
    for (const i of d.items.filter(i => i.included)) {
      const info = insert.run(i.content, i.content.slice(0, 50), i.category, i.importance, i.urgency, i.estimateMin, i.estimateMin, i.estimateGroup,
        i.deadlineAt, i.deadlineMode === 'unknown' ? 0 : 1, i.deadlineMode === 'unknown' ? 'draft_unconfirmed' : 'user', i.windowStart, i.windowEnd, now, now)
      const taskId = Number(info.lastInsertRowid); ids.push(taskId)
      getDb().prepare('INSERT INTO task_draft_links(task_id,draft_id,item_id,source_ref) VALUES(?,?,?,?)').run(taskId, d.id, i.id, d.sourceRef)
    }
    getDb().prepare("UPDATE task_drafts SET state='committed',created_ids_json=?,updated_at=? WHERE id=? AND version=?").run(JSON.stringify(ids), now, id, expectedVersion)
    return { saved: true as const, taskIds: ids, sourceRef: d.sourceRef }
  })()
  })
}
export function discard(runId: string, id: string): void {
  getDb().prepare("UPDATE task_drafts SET state='discarded',updated_at=? WHERE id=? AND run_id=? AND state='editing'").run(new Date().toISOString(), id, runId)
}
export function seedBatch(runId: string, raw: string): TaskDraft {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!lines.length || lines.length > 60) throw new Error('每次预览1—60行，请分批导入；原文不会被丢弃。')
  for (const line of lines) {
    const heading = /^@\S+$|^(各位同学|同学们|大家好|温馨提示|通知)[！!：:，,。\s]*$|^第[一二三四五六七八九十\d]+周|^\d{1,2}\/\d{1,2}(?:\s*周[一二三四五六日天])?$|^下?周[一二三四五六日天]$/.test(line)
    addItem(runId, { content: line.length>500?line.slice(0,497)+'…':line, estimateMin: 30, estimateGroup: '其他', deadlineMode: 'unknown', included: !heading && line.length<=500,
      note: line.length>500?'长行候选已缩短且默认排除，请对照完整原文修订后再纳入。':heading ? '可能为称呼或标题，默认不纳入；请核对原文。' : '按行候选，30分钟仅为待核对建议；日期未确认为截止。' }, 'import')
  }
  return forRun(runId)!
}
