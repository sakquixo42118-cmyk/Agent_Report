import { getDb } from './database'
import type { Task, TaskCreateInput, TaskFilter, TaskUpdateInput, TaskStatus, TaskCategory, AiStatus, AiAnalysisResult, BatchParsedTask } from '@shared/types'
import { localSummary, toLocalIso } from '../ai/rules'
import { randomUUID } from 'node:crypto'
import { scopeKey } from '../memory/service'
import { guardTaskDependencyChange } from '../planning/constraints'
import { withAudit } from '../statistics/ledger'
import { dateKey } from '../planning/engine'

/** DB 行 → Task DTO */
interface TaskRow {
  id: number
  content: string
  summary: string | null
  status: string
  category: string
  tags: string
  importance: number
  urgency: number
  estimate_min: number
  due_at: string | null
  due_notified: number
  snooze_count: number
  ai_status: string
  manual_locked: number
  project_id: string | null
  chain_order: number | null
  chain_total: number | null
  range_start: string | null
  range_end: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  deadline_at: string | null
  deadline_confirmed: number
  deadline_source: string
  base_estimate_min: number
  estimate_group: string
  estimate_source: string
  completion_seq: number
}

function rowToTask(r: TaskRow): Task {
  let tags: string[] = []
  try {
    tags = JSON.parse(r.tags)
  } catch {
    tags = []
  }
  return {
    id: r.id,
    content: r.content,
    summary: r.summary ?? null,
    status: r.status as TaskStatus,
    category: r.category as TaskCategory,
    tags,
    importance: r.importance,
    urgency: r.urgency,
    estimateMin: r.estimate_min,
    baseEstimateMin: r.base_estimate_min,
    estimateGroup: r.estimate_group || r.category,
    estimateSource: r.estimate_source,
    completionSeq: r.completion_seq,
    dueAt: r.deadline_confirmed ? r.deadline_at : null,
    deadlineAt: r.deadline_at,
    deadlineConfirmed: r.deadline_confirmed === 1,
    deadlineSource: r.deadline_source,
    legacyDueAt: r.due_at,
    dueNotified: r.due_notified === 1,
    snoozeCount: r.snooze_count,
    aiStatus: r.ai_status as AiStatus,
    manualLocked: (r.manual_locked ?? 0) === 1,
    projectId: r.project_id ?? null,
    chainOrder: r.chain_order ?? 0,
    chainTotal: r.chain_total ?? 0,
    rangeStart: r.range_start ?? null,
    rangeEnd: r.range_end ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at
  }
}

function now(): string {
  return new Date().toISOString()
}

/** 新建任务：先进收件箱，由 analyzer 分析后转 pending（未配置 AI 时规则兜底同样转 pending） */
export function createTask(input: TaskCreateInput): Task {
  return withAudit({actor:'user',source:'manual'},()=>{
  const db = getDb()
  const ts = now()
  const info = db
    .prepare(
      `INSERT INTO tasks (content, status, created_at, updated_at) VALUES (?, 'inbox', ?, ?)`
    )
    .run(input.content.trim(), ts, ts)
  return getTaskById(Number(info.lastInsertRowid))!
  })
}

/** 批量创建（批量导入已带分析结果，直接进 pending；同一次导入归入同一项目链条组） */
export function batchCreateTasks(items: BatchParsedTask[], aiStatus: AiStatus): number {
  return withAudit({actor:'user',source:'manual'},()=>{
  const db = getDb()
  const ts = now()
  const projectId = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const total = items.length
  const stmt = db.prepare(
    `INSERT INTO tasks (content, summary, status, category, tags, importance, urgency, estimate_min, due_at, ai_status, project_id, chain_order, chain_total, range_start, range_end, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction((rows: BatchParsedTask[]) => {
    rows.forEach((r, i) => {
      stmt.run(
        r.content,
        localSummary(r.content),
        r.category,
        JSON.stringify(r.tags),
        r.importance,
        r.urgency,
        r.estimateMin,
        r.dueAt,
        aiStatus,
        projectId,
        i + 1,
        total,
        r.rangeStart ?? null,
        r.rangeEnd ?? null,
        ts,
        ts
      )
    })
    // 解析日期是候选截止；范围任务的范围不等同外部截止。
    const ids = db.prepare('SELECT id FROM tasks WHERE project_id=? ORDER BY chain_order').all(projectId) as { id: number }[]
    ids.forEach((row, i) => db.prepare('UPDATE tasks SET deadline_at=?,deadline_confirmed=?,deadline_source=?,base_estimate_min=?,estimate_source=? WHERE id=?')
      .run(rows[i].dueAt, rows[i].dueAt ? 0 : 1, rows[i].dueAt ? 'parsed' : 'none', rows[i].estimateMin, aiStatus === 'ok' ? 'model' : 'rule', row.id))
  })
  tx(items)
  return items.length
  })
}

/** AI/规则分析结果落库：写字段 + inbox→pending + ai_status */
export function applyAnalysis(id: number, result: AiAnalysisResult, aiStatus: AiStatus): void {
  return withAudit({actor:'system',source:'analyzer'},()=>{
  const db = getDb()
  db.prepare(
    `UPDATE tasks SET
       importance = ?, urgency = ?, category = ?, tags = ?,
       estimate_min = CASE WHEN estimate_source='user' OR EXISTS(SELECT 1 FROM plan_blocks WHERE task_id=tasks.id) THEN estimate_min ELSE ? END,
       due_at = COALESCE(due_at, ?), summary = ?,
       status = 'pending', ai_status = ?, updated_at = ?,
       deadline_at = CASE WHEN deadline_source='user' OR EXISTS(SELECT 1 FROM plan_blocks WHERE task_id=tasks.id) THEN deadline_at ELSE ? END,
       deadline_confirmed = CASE WHEN deadline_source='user' OR EXISTS(SELECT 1 FROM plan_blocks WHERE task_id=tasks.id) THEN deadline_confirmed ELSE ? END,
       deadline_source = CASE WHEN deadline_source='user' OR EXISTS(SELECT 1 FROM plan_blocks WHERE task_id=tasks.id) THEN deadline_source ELSE ? END,
       base_estimate_min = CASE WHEN estimate_source='user' OR EXISTS(SELECT 1 FROM plan_blocks WHERE task_id=tasks.id) THEN base_estimate_min ELSE ? END,
       estimate_source = CASE WHEN estimate_source='user' OR EXISTS(SELECT 1 FROM plan_blocks WHERE task_id=tasks.id) THEN estimate_source ELSE ? END
     WHERE id = ? AND status = 'inbox'`
  ).run(
    result.importance,
    result.urgency,
    result.category,
    JSON.stringify(result.tags),
    result.estimateMin,
    result.dueAt,
    result.summary,
    aiStatus,
    now(), result.dueAt, result.dueAt ? 0 : 1, result.dueAt ? 'parsed' : 'none', result.estimateMin, aiStatus === 'ok' ? 'model' : 'rule',
    id
  )
  })
}

/** 重试分析：重置 ai_status */
export function markAiStatus(id: number, status: AiStatus): void {
  const db = getDb()
  db.prepare(`UPDATE tasks SET ai_status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id)
}

/** 重试分析：pending 任务拉回收件箱重走完整流程 */
export function moveBackToInbox(id: number): void {
  return withAudit({actor:'system',source:'analyzer'},()=>{
  const db = getDb()
  guardTaskDependencyChange(id,'inbox')
  db.prepare(`UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?`).run(now(), id)
  })
}

/** 按 id 查 */
export function getTaskById(id: number): Task | null {
  const db = getDb()
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined
  return row ? rowToTask(row) : null
}

/** 任务列表（排除 archived） */
export function listTasks(filter: TaskFilter = {}): Task[] {
  const db = getDb()
  const where: string[] = [`status != 'archived'`]
  const params: unknown[] = []
  if (filter.status === 'active') {
    where.push(`status IN ('inbox','pending')`)
  } else if (filter.status) {
    where.push(`status = ?`)
    params.push(filter.status)
  }
  if (filter.category && filter.category !== 'all') {
    where.push(`category = ?`)
    params.push(filter.category)
  }
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC`)
    .all(...params) as TaskRow[]
  return rows.map(rowToTask)
}

// ===== 项目链条模块 =====

/** 项目组信息 */
export interface ProjectGroup {
  projectId: string
  title: string // 首环节摘要
  tasks: Task[] // 按 chain_order 升序
  total: number
  doneCount: number
  firstDue: string | null
  lastDue: string | null
}

/** 全部项目组（含已归档环节的组也显示，只要组内有未归档任务） */
export function listProjects(): ProjectGroup[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE project_id IS NOT NULL AND status != 'archived'
        ORDER BY project_id, chain_order ASC`
    )
    .all() as TaskRow[]
  const byProject = new Map<string, Task[]>()
  for (const r of rows) {
    if (!r.project_id) continue
    const list = byProject.get(r.project_id) ?? []
    list.push(rowToTask(r))
    byProject.set(r.project_id, list)
  }
  const groups: ProjectGroup[] = []
  for (const [projectId, tasks] of byProject) {
    const withDue = tasks.filter((t) => t.dueAt)
    groups.push({
      projectId,
      title: tasks[0]?.summary || tasks[0]?.content.slice(0, 16) || '未命名项目',
      tasks,
      total: tasks.length,
      doneCount: tasks.filter((t) => t.status === 'done').length,
      firstDue: withDue.length ? withDue.map((t) => t.dueAt!).sort()[0] : null,
      lastDue: withDue.length ? withDue.map((t) => t.dueAt!).sort().at(-1)! : null
    })
  }
  // 按最近截止排序
  return groups.sort((a, b) => (a.firstDue ?? '9999').localeCompare(b.firstDue ?? '9999'))
}

/** 给项目加一个环节（追加到链条末尾） */
export function addChainStep(projectId: string, content: string, dueAt: string | null): Task | null {
  return withAudit({actor:'user',source:'manual'},()=>{
  const db = getDb()
  const info = db
    .prepare(
      `SELECT MAX(chain_order) AS maxOrder, COUNT(*) AS total FROM tasks
        WHERE project_id = ? AND status != 'archived'`
    )
    .get(projectId) as { maxOrder: number | null; total: number }
  if (info.total === 0) return null
  const ts = now()
  const order = (info.maxOrder ?? 0) + 1
  db.prepare(
    `INSERT INTO tasks (content, status, category, importance, urgency, estimate_min, due_at, ai_status, project_id, chain_order, chain_total, created_at, updated_at)
     VALUES (?, 'pending', '其他', 3, 3, 30, ?, 'none', ?, ?, ?, ?, ?)`
  ).run(content.trim(), dueAt, projectId, order, info.total + 1, ts, ts)
  // 组内所有任务的 chain_total +1
  db.prepare(`UPDATE tasks SET chain_total = ? WHERE project_id = ?`).run(info.total + 1, projectId)
  const inserted = db.prepare(`SELECT MAX(id) AS id FROM tasks WHERE project_id = ?`).get(projectId) as { id: number }
  if (dueAt) updateTask({ id: inserted.id, deadlineAt: dueAt })
  return getTaskById(inserted.id)
  })
}

/** 环节上移/下移一位（交换 chain_order） */
export function moveChainStep(id: number, dir: 'up' | 'down'): Task[] | null {
  const db = getDb()
  const me = getTaskById(id)
  if (!me?.projectId) return null
  const neighborOrder = dir === 'up' ? me.chainOrder - 1 : me.chainOrder + 1
  const neighbor = db
    .prepare(`SELECT id FROM tasks WHERE project_id = ? AND chain_order = ? AND status != 'archived'`)
    .get(me.projectId, neighborOrder) as { id: number } | undefined
  if (!neighbor) return null

  const tx = db.transaction(() => {
    // 临时负值避免唯一性冲突（chain_order 无唯一约束，直接交换即可）
    db.prepare(`UPDATE tasks SET chain_order = ? WHERE id = ?`).run(neighborOrder, id)
    db.prepare(`UPDATE tasks SET chain_order = ? WHERE id = ?`).run(me.chainOrder, neighbor.id)
  })
  tx()
  return me ? listTasks().filter((t) => t.projectId === me.projectId) : null
}

/** 更新任务部分字段 */
export function updateTask(input: TaskUpdateInput, source: 'user' | 'review' | 'agent' = 'user'): Task | null {
  return withAudit({actor:source==='review'?'system':'user',source:source==='agent'?'agent_confirmed':source==='review'?'analyzer':'manual'},()=>{
  const db = getDb()
  const existing = getTaskById(input.id)
  if (!existing) return null

  const sets: string[] = []
  const params: unknown[] = []

  if (input.content !== undefined) {
    sets.push('content = ?')
    params.push(input.content.trim())
  }
  if (input.category !== undefined) {
    sets.push('category = ?')
    params.push(input.category)
  }
  if (input.tags !== undefined) {
    sets.push('tags = ?')
    params.push(JSON.stringify(input.tags))
  }
  if (input.importance !== undefined) {
    sets.push('importance = ?')
    params.push(clamp(input.importance, 1, 5))
    // 用户手动调重要性 → 锁定，AI 每日重评不再覆盖
    if (source !== 'review') sets.push('manual_locked = 1')
  }
  if (input.urgency !== undefined) {
    sets.push('urgency = ?')
    params.push(clamp(input.urgency, 1, 5))
    if (source !== 'review') sets.push('manual_locked = 1')
  }
  if (input.estimateMin !== undefined) {
    if (!Number.isInteger(input.estimateMin) || input.estimateMin < 5 || input.estimateMin > 1440) throw new Error('预计耗时必须是5—1440分钟的整数。')
    const planned = db.prepare('SELECT start_at,end_at FROM plan_blocks WHERE task_id=?').get(input.id) as { start_at: number; end_at: number } | undefined
    if (planned && input.estimateMin * 60000 > planned.end_at - planned.start_at) throw new Error('新耗时超过现有执行块，请先在日程移除该安排再修改。')
    sets.push('estimate_min = ?')
    params.push(Math.max(5, Math.round(input.estimateMin)))
    sets.push('base_estimate_min = ?', "estimate_source = 'user'")
    params.push(input.estimateMin)
  }
  if (input.estimateGroup !== undefined) {
    if (typeof input.estimateGroup !== 'string' || !input.estimateGroup.trim() || input.estimateGroup.length > 60) throw new Error('估时分组请填写1—60字，如“数学分析”。')
    sets.push('estimate_group = ?'); params.push(scopeKey(input.estimateGroup))
  }
  const deadline = input.deadlineAt !== undefined ? input.deadlineAt : input.dueAt
  if (deadline !== undefined) {
    if (deadline !== null && (typeof deadline !== 'string' || !Number.isFinite(new Date(deadline).getTime()))) throw new Error('截止时间无效。')
    const planned = db.prepare('SELECT end_at FROM plan_blocks WHERE task_id=?').get(input.id) as { end_at: number } | undefined
    if (deadline && planned && planned.end_at > new Date(deadline).getTime()) throw new Error('现有执行安排晚于新截止，请先移除或重排执行时间。')
    sets.push('deadline_at = ?', 'deadline_confirmed = 1', "deadline_source = 'user'")
    params.push(deadline === null ? null : new Date(deadline).toISOString())
    // 截止时间变化 → 重置通知标记，可再次提醒
    sets.push('due_notified = 0')
  }

  sets.push('updated_at = ?')
  params.push(now())
  params.push(input.id)

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getTaskById(input.id)
  })
}

/** 完成/取消完成 */
export function completeTask(id: number, done: boolean, clock = Date.now()): Task | null {
  return withAudit({actor:'user',source:'manual'},()=>{
  const db = getDb()
  if (!Number.isSafeInteger(id) || id < 1 || typeof done !== 'boolean') throw new Error('完成参数无效。')
  return db.transaction(() => {
    const task = getTaskById(id), ts = new Date(clock).toISOString()
    if (!task || task.status === 'archived') return null
    if ((task.status === 'done') === done) return task
    if (done) {
      const cycle = task.completionSeq + 1, eventId = randomUUID()
      const block = db.prepare('SELECT start_at,end_at FROM plan_blocks WHERE task_id=?').get(id) as { start_at: number; end_at: number } | undefined
      db.prepare("UPDATE tasks SET status='done',completed_at=?,updated_at=?,completion_seq=? WHERE id=?").run(ts, ts, cycle, id)
      db.prepare(`INSERT INTO completion_events(id,task_id,cycle,title,group_key,estimate_source,base_min,planned_min,had_plan,created_at,
        stats_tracked,stats_valid,stats_day,stats_timezone,deadline_at,deadline_confirmed)
        VALUES(?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?)`).run(eventId, id, cycle, task.summary || task.content, scopeKey(task.estimateGroup), task.estimateSource,
          task.baseEstimateMin, block ? (block.end_at - block.start_at) / 60000 : task.estimateMin, block ? 1 : 0, ts,
          dateKey(clock),Intl.DateTimeFormat().resolvedOptions().timeZone,task.deadlineAt,task.deadlineConfirmed?1:0)
      const config = db.prepare('SELECT enabled FROM profile_settings WHERE id=1').get() as { enabled: number }
      if (config.enabled) db.prepare('INSERT INTO completion_jobs(event_id) VALUES(?)').run(eventId)
    } else {
      guardTaskDependencyChange(id,'undo')
      db.prepare("UPDATE tasks SET status='pending',completed_at=NULL,updated_at=? WHERE id=?").run(ts, id)
      db.prepare('UPDATE completion_events SET stats_valid=0 WHERE task_id=?').run(id)
      invalidateCompletions(id)
    }
    return getTaskById(id)
  })()
  })
}

function invalidateCompletions(id: number): void {
  const db = getDb()
  db.prepare('UPDATE completion_events SET valid=0 WHERE task_id=?').run(id)
  db.prepare("UPDATE completion_jobs SET status='cancelled',token=NULL WHERE event_id IN (SELECT id FROM completion_events WHERE task_id=?)").run(id)
  db.prepare("UPDATE followup_messages SET state='cancelled',is_read=1 WHERE event_id IN (SELECT id FROM completion_events WHERE task_id=?)").run(id)
}

/** 推迟到明天：due_at = 明天（保持时间部分），无截止则明天 23:59；snooze_count+1 */
export function snoozeTask(id: number): { task: Task; chained: number } | null {
  throw new Error('旧按天推迟已停用，请在助理页试排明天的执行时段；截止时间不会随之改变。')
}

/**
 * 链条下游顺延（snoozeTask / 调度器挤占共用）：
 * 以 anchor 为锚，按 chain_order 逐个保证"下游 ≥ 锚 + 1"，能不推就不推。
 * 返回被顺延的环节数。
 */
export function cascadeChainAfter(projectId: string, fromOrder: number, anchor: Date): number {
  const db = getDb()
  const siblings = db
    .prepare(
      `SELECT id, due_at FROM tasks
        WHERE project_id = ? AND status != 'done' AND status != 'archived' AND chain_order > ?
        ORDER BY chain_order ASC`
    )
    .all(projectId, fromOrder) as { id: number; due_at: string | null }[]
  const chainStmt = db.prepare(
    `UPDATE tasks SET due_at = ?, due_notified = 0, updated_at = ? WHERE id = ?`
  )
  let cur = new Date(anchor)
  let moved = 0
  for (const s of siblings) {
    if (!s.due_at) continue
    const d = new Date(s.due_at)
    if (d.getTime() < cur.getTime()) {
      chainStmt.run(toLocalIso(cur), now(), s.id)
      moved++
      cur.setDate(cur.getDate() + 1) // 下一个环节至少再错后一天
    } else {
      // 该环节够晚，不动它，但它之后的环节以它为新锚
      cur = new Date(d)
      cur.setDate(cur.getDate() + 1)
    }
  }
  return moved
}

/**
 * 调度器挤占：把一个任务挪到 newDueIso（不涨 snooze_count），若它属于链条则下游锚定顺延。
 * 返回顺延的下游环节数。
 */
export function displaceTaskTo(id: number, newDueIso: string): number {
  const task = getTaskById(id)
  if (!task) return 0
  const db = getDb()
  db.prepare(
    `UPDATE tasks SET due_at = ?, due_notified = 0, updated_at = ? WHERE id = ?`
  ).run(newDueIso, now(), id)
  if (!task.projectId) return 0
  const anchor = new Date(newDueIso)
  anchor.setDate(anchor.getDate() + 1)
  return cascadeChainAfter(task.projectId, task.chainOrder, anchor)
}

/** 软删除 → archived */
export function deleteTask(id: number): boolean {
  return withAudit({actor:'user',source:'manual'},()=>{
  const db = getDb()
  return db.transaction(() => {
    guardTaskDependencyChange(id,'archive')
    const info = db.prepare("UPDATE tasks SET status='archived',updated_at=? WHERE id=?").run(now(), id)
    invalidateCompletions(id)
    return info.changes > 0
  })()
  })
}

// ===== 项目链条 =====

/** 链条视图 DTO：一个项目组 + 其环节列表 */
export interface ChainGroup {
  projectId: string
  chainTotal: number
  tasks: Task[] // 按 chain_order 升序
}

/** 列出所有链条（有未完成环节的优先返回，全完成的也返回） */
export function listChains(): ChainGroup[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE project_id IS NOT NULL AND status != 'archived' ORDER BY project_id, chain_order`
    )
    .all() as (TaskRow & { project_id: string })[]
  const map = new Map<string, Task[]>()
  for (const r of rows) {
    const pid = r.project_id
    if (!map.has(pid)) map.set(pid, [])
    map.get(pid)!.push(rowToTask(r))
  }
  const groups: ChainGroup[] = []
  for (const [projectId, tasks] of map) {
    groups.push({ projectId, chainTotal: tasks.length, tasks })
  }
  // 未完成多的在前；全部按创建时间排序（用组内最小 created_at）
  groups.sort((a, b) => {
    const aActive = a.tasks.some((t) => t.status === 'pending' || t.status === 'inbox')
    const bActive = b.tasks.some((t) => t.status === 'pending' || t.status === 'inbox')
    if (aActive !== bActive) return aActive ? -1 : 1
    return a.tasks[0].createdAt.localeCompare(b.tasks[0].createdAt)
  })
  return groups
}

/** 给链条追加一个环节（排到最后） */
export function appendChainTask(projectId: string, content: string): Task | null {
  return withAudit({actor:'user',source:'manual'},()=>{
  const db = getDb()
  const last = db
    .prepare(`SELECT MAX(chain_order) AS m FROM tasks WHERE project_id = ?`)
    .get(projectId) as { m: number | null }
  const order = (last.m ?? 0) + 1
  const total = order
  const ts = now()
  const info = db
    .prepare(
      `INSERT INTO tasks (content, summary, status, project_id, chain_order, chain_total, created_at, updated_at)
       VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?)`
    )
    .run(content.trim(), localSummary(content.trim()), projectId, order, total, ts, ts)
  // 更新组内 total
  db.prepare(`UPDATE tasks SET chain_total = ? WHERE project_id = ?`).run(total, projectId)
  return getTaskById(Number(info.lastInsertRowid))
  })
}

/** 链条整体平移：所有未完成环节的截止日期 +N 天 */
export function shiftChain(projectId: string, days: number): number {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, due_at FROM tasks WHERE project_id = ? AND status NOT IN ('done','archived') AND due_at IS NOT NULL`
    )
    .all(projectId) as { id: number; due_at: string }[]
  const stmt = db.prepare(`UPDATE tasks SET due_at = ?, due_notified = 0, updated_at = ? WHERE id = ?`)
  let moved = 0
  for (const r of rows) {
    const d = new Date(r.due_at)
    d.setDate(d.getDate() + days)
    stmt.run(toLocalIso(d), now(), r.id)
    moved++
  }
  return moved
}

/** 删除链条中一个环节（其余环节 order 顺序收缩） */
export function removeChainTask(id: number): boolean {
  return withAudit({actor:'user',source:'manual'},()=>{
  const db = getDb()
  const task = getTaskById(id)
  if (!task || !task.projectId) return deleteTask(id)
  guardTaskDependencyChange(id,'archive')
  db.prepare(`UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?`).run(now(), id)
  // 收缩 order
  db.prepare(
    `UPDATE tasks SET chain_order = chain_order - 1 WHERE project_id = ? AND chain_order > ?`
  ).run(task.projectId, task.chainOrder)
  // 更新 total
  db.prepare(
    `UPDATE tasks SET chain_total = (SELECT COUNT(*) FROM tasks t2 WHERE t2.project_id = tasks.project_id AND t2.status != 'archived') WHERE project_id = ?`
  ).run(task.projectId)
  return true
  })
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)))
}

// ===== 范围调度模块 =====

/** 调度器写 due_at（不碰 manual_locked 等分析字段；null = 清空，任务回未分配状态） */
export function setScheduledDue(id: number, dueAt: string | null): void {
  const db = getDb()
  db.prepare(
    `UPDATE tasks SET due_at = ?, due_notified = 0, updated_at = ? WHERE id = ?`
  ).run(dueAt, now(), id)
}

/** 调度器兜底：给孤儿范围任务补 range 字段 */
export function setRange(id: number, start: string, end: string): void {
  const db = getDb()
  db.prepare(
    `UPDATE tasks SET range_start = ?, range_end = ?, updated_at = ? WHERE id = ?`
  ).run(start, end, now(), id)
}

/** 查某项目组内未完成、未归档的任务（调度器用；按 chain_order 升序） */
export function listActiveChainTasks(projectId: string): Task[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE project_id = ? AND status NOT IN ('done','archived') ORDER BY chain_order ASC`
    )
    .all(projectId) as TaskRow[]
  return rows.map(rowToTask)
}

/** 统计 [start, end] 日期范围内每天的任务量（loadMin = 各任务 estimate_min 之和；排除 inbox/done/archived） */
export function dayLoadsBetween(start: string, end: string): Map<string, number> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT due_at, estimate_min FROM tasks
        WHERE due_at IS NOT NULL AND due_at >= ? AND due_at <= ? AND status IN ('inbox','pending')`
    )
    .all(start, end) as { due_at: string; estimate_min: number }[]
  const loads = new Map<string, number>()
  for (const r of rows) {
    const day = r.due_at.slice(0, 10)
    loads.set(day, (loads.get(day) ?? 0) + r.estimate_min)
  }
  return loads
}

/** 列出某天截止的活跃任务（inbox/pending；挤占后排用） */
export function activeTasksOnDay(day: string): Task[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE due_at IS NOT NULL AND due_at >= ? AND due_at <= ? AND status IN ('inbox','pending')
        ORDER BY importance DESC, urgency DESC, chain_order ASC`
    )
    .all(`${day}T00:00:00`, `${day}T23:59:59`) as TaskRow[]
  return rows.map(rowToTask)
}

/** 列出所有未落地（due_at 为空）的范围/链条任务。
 *  含两类：① 带 range 的正常范围任务；② 无 range 但属于链条的孤儿（AI 两头都没给时的兜底对象）。
 *  纯单任务（无 range 无链条）不在此列——用户没给日期就不强排。 */
export function listUnscheduledRangeTasks(): Task[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE due_at IS NULL AND status NOT IN ('done','archived')
        AND (range_start IS NOT NULL OR project_id IS NOT NULL)
        ORDER BY project_id, chain_order ASC`
    )
    .all() as TaskRow[]
  return rows.map(rowToTask)
}
