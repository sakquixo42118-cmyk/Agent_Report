import { randomUUID } from 'node:crypto'
import { getDb } from '../db/database'
import type { AgentRun, AgentEvent, AgentQuestion, PendingChange, RunStatus, RunSummary } from '@shared/agent'
import type { ModelMessage } from './model'

interface RunRow { id: string; goal: string; status: RunStatus; messages_json: string; pending_json: string | null; question_json: string | null; turns: number; updated_at: string; scene: string }
export function createRun(goal: string, messages: ModelMessage[], scene = 'planning'): string {
  const id = randomUUID(), now = new Date().toISOString()
  getDb().prepare('INSERT INTO agent_runs(id,goal,status,messages_json,created_at,updated_at,scene) VALUES(?,?,?,?,?,?,?)')
    .run(id, goal, 'running', JSON.stringify(messages), now, now, scene)
  addEvent(id, 'user', goal)
  return id
}
export function row(id: string): RunRow {
  const value = getDb().prepare('SELECT * FROM agent_runs WHERE id=?').get(id) as RunRow | undefined
  if (!value) throw new Error('对话不存在。')
  return value
}
export function getRun(id: string): AgentRun {
  const r = row(id)
  const draft = getDb().prepare('SELECT id,state,created_ids_json FROM task_drafts WHERE run_id=?').get(id) as { id: string; state: AgentRun['draftState']; created_ids_json: string } | undefined
  const events = getDb().prepare('SELECT id,kind,text,created_at AS createdAt FROM agent_events WHERE run_id=? ORDER BY id').all(id) as AgentEvent[]
  return { id, goal: r.goal, status: r.status, scene: r.scene, draftId: draft?.id ?? null, draftState: draft?.state ?? null,
    createdTaskIds: draft ? JSON.parse(draft.created_ids_json) : [], updatedAt: r.updated_at, events,
    pending: r.pending_json ? JSON.parse(r.pending_json) : null,
    question: r.question_json ? JSON.parse(r.question_json) : null }
}
export function runHistory(): RunSummary[] {
  return getDb().prepare(`SELECT r.id,r.goal,r.status,r.scene,r.updated_at AS updatedAt,d.state AS draftState FROM agent_runs r
    LEFT JOIN task_drafts d ON d.run_id=r.id ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 30`).all() as RunSummary[]
}
export function latestRun(): AgentRun | null {
  const r = getDb().prepare('SELECT id FROM agent_runs ORDER BY updated_at DESC, rowid DESC LIMIT 1').get() as { id: string } | undefined
  return r ? getRun(r.id) : null
}
export function addEvent(id: string, kind: AgentEvent['kind'], text: string): void {
  getDb().prepare('INSERT INTO agent_events(run_id,kind,text,created_at) VALUES(?,?,?,?)').run(id, kind, text, new Date().toISOString())
}
/** question 仅在 waiting_user 期间生效：一旦用户回复或本轮结束，旧选项必须失效，避免点到过期按钮 */
export function save(id: string, messages: ModelMessage[], status: RunStatus, pending: PendingChange | null = null, question: AgentQuestion | null = null): void {
  const options = question && status === 'waiting_user'
    ? JSON.stringify({ text: question.text, options: question.options.filter(o => o.trim()).slice(0, 4) })
    : null
  getDb().prepare('UPDATE agent_runs SET messages_json=?,status=?,pending_json=?,question_json=?,updated_at=? WHERE id=?')
    .run(JSON.stringify(messages), status, pending ? JSON.stringify(pending) : null, options, new Date().toISOString(), id)
}
export function recoverInterruptedRuns(): void {
  const runs = getDb().prepare("SELECT id FROM agent_runs WHERE status='running'").all() as { id: string }[]
  for (const r of runs) {
    const data = row(r.id)
    // 移除尚未配齐观察的assistant工具批次，避免向API提交悬空tool_call。
    const messages = completeMessages(JSON.parse(data.messages_json))
    save(r.id, messages, 'failed')
    addEvent(r.id, 'status', '上次运行中断，已保留记录。可发送消息继续；未确认的修改不会执行。')
  }
}
export function completeMessages(messages: ModelMessage[]): ModelMessage[] {
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i].tool_calls
    if (!calls?.length) continue
    const following = messages.slice(i + 1, i + 1 + calls.length)
    if (following.length !== calls.length || calls.some(c => !following.some(m => m.role === 'tool' && m.tool_call_id === c.id))) return messages.slice(0, i)
  }
  return messages
}
