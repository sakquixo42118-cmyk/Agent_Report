import { randomUUID, createHash } from 'node:crypto'
import { getDb } from '../db/database'
import type { MemoryFact, MemoryInput, DurationEstimate } from '@shared/profile'
import type { Task } from '@shared/types'

export function scopeKey(value: string): string { return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ') }
export function listFacts(now = Date.now()): MemoryFact[] {
  return getDb().prepare(`SELECT id,scope,key,value,source,version,expires_at AS expiresAt,updated_at AS updatedAt
    FROM memory_facts ORDER BY updated_at DESC,id LIMIT 500`).all() as MemoryFact[]
}
export function validateFact(input: MemoryInput): MemoryInput {
  if (!input || typeof input.scope !== 'string' || !input.scope.trim() || input.scope.length > 60 || typeof input.key !== 'string' || !input.key.trim() || input.key.length > 60 || typeof input.value !== 'string' || !input.value.trim() || input.value.length > 800) throw new Error('记忆需要分组、名称和内容，长度分别不超过60、60、800字。')
  const expiry = input.expiresAt || null
  if (expiry && (typeof expiry !== 'string' || !Number.isFinite(new Date(expiry).getTime()))) throw new Error('记忆有效期无效。')
  return { scope: scopeKey(input.scope), key: input.key.trim(), value: input.value.trim(), expiresAt: expiry ? new Date(expiry).toISOString() : null }
}
export function findFact(scope: string, key: string): MemoryFact | null {
  return getDb().prepare(`SELECT id,scope,key,value,source,version,expires_at AS expiresAt,updated_at AS updatedAt
    FROM memory_facts WHERE scope=? AND key=?`).get(scopeKey(scope), key.trim()) as MemoryFact | undefined ?? null
}
export function hasScope(scope: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM memory_facts WHERE scope=? LIMIT 1').get(scopeKey(scope))
}
export function saveFact(input: MemoryInput, expectedVersion: number | null, source = 'user'): MemoryFact {
  const fact = validateFact(input)
  return getDb().transaction(() => {
    const existing = findFact(fact.scope, fact.key)
    if ((existing?.version ?? null) !== expectedVersion) throw new Error('记忆已变化，请刷新后确认。')
    const now = new Date().toISOString()
    if (existing) getDb().prepare('UPDATE memory_facts SET value=?,expires_at=?,source=?,version=version+1,updated_at=? WHERE id=?')
      .run(fact.value, fact.expiresAt, source, now, existing.id)
    else getDb().prepare('INSERT INTO memory_facts(id,scope,key,value,source,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), fact.scope, fact.key, fact.value, source, fact.expiresAt, now)
    return findFact(fact.scope, fact.key)!
  })()
}
export function removeFact(id: string, version: number): void {
  if (typeof id !== 'string' || !Number.isInteger(version)) throw new Error('记忆参数无效。')
  if (!getDb().prepare('DELETE FROM memory_facts WHERE id=? AND version=?').run(id, version).changes) throw new Error('记忆已变化，请刷新。')
}
export function memoryTopics(now = Date.now()): { scope: string; key: string }[] {
  return getDb().prepare(`SELECT scope,key FROM memory_facts WHERE expires_at IS NULL OR expires_at>? ORDER BY updated_at DESC,id LIMIT 12`)
    .all(new Date(now).toISOString()) as { scope: string; key: string }[]
}
export function searchMemory(query: string, scope?: string, limit = 5, now = Date.now()): object[] {
  if (typeof query !== 'string' || !query.trim() || query.length > 100 || !Number.isInteger(limit) || limit < 1 || limit > 5 || (scope !== undefined && (typeof scope !== 'string' || scope.length > 60))) throw new Error('检索参数无效。')
  const q = scopeKey(query), words = q.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? []
  const tokens = [...new Set(words.flatMap(w => /[\u4e00-\u9fff]/.test(w) && w.length > 2 ? Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)) : [w]))].slice(0, 40)
  const candidates = getDb().prepare(`SELECT id,scope,key,value,source,version,expires_at AS expiresAt,updated_at AS updatedAt FROM memory_facts
    WHERE (expires_at IS NULL OR expires_at>?) ${scope ? "AND (scope=? OR scope='全局')" : ''} ORDER BY updated_at DESC,id LIMIT 2000`)
    .all(new Date(now).toISOString(), ...(scope ? [scopeKey(scope)] : [])) as MemoryFact[]
  return candidates.map(f => {
    const content = scopeKey(`${f.scope} ${f.key} ${f.value}`)
    const score = (content.includes(q) ? 10 : 0) + tokens.filter(t => content.includes(t)).length
    return { ...f, score, sourceRef: `memory:${f.id}:v${f.version}`, confirmed: true }
  }).filter(f => f.score > 0).sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
}
export function calibrate(baseMin: number, ratios: number[], enabled = true): { estimateMin: number; sampleCount: number; factor: number } {
  const values = ratios.filter(Number.isFinite).slice(0, 10).map(r => Math.max(.5, Math.min(2.5, r))).sort((a, b) => a - b)
  const n = values.length, median = n ? (values[Math.floor(n / 2)] + values[Math.ceil(n / 2) - 1]) / 2 : 1
  const factor = enabled ? 1 + n / (n + 5) * (median - 1) : 1
  return { estimateMin: Math.max(5, Math.ceil(baseMin * factor / 5) * 5), sampleCount: n, factor }
}
export function durationEstimate(task: Pick<Task, 'baseEstimateMin' | 'estimateGroup' | 'estimateSource'>): DurationEstimate {
  const enabled = !!(getDb().prepare('SELECT calibration_enabled FROM profile_settings WHERE id=1').get() as { calibration_enabled: number }).calibration_enabled
  const group = scopeKey(task.estimateGroup)
  const samples = getDb().prepare(`SELECT f.actual_min AS actual,e.base_min AS base FROM completion_feedback f
    JOIN completion_events e ON e.id=f.event_id JOIN tasks t ON t.id=e.task_id
    WHERE e.valid=1 AND t.status='done' AND t.completion_seq=e.cycle AND e.group_key=? AND e.estimate_source=?
    AND f.actual_min>0 AND e.base_min>0 AND f.interrupted=0 AND f.scope_changed=0 ORDER BY f.updated_at DESC,f.rowid DESC LIMIT 10`)
    .all(group, task.estimateSource) as { actual: number; base: number }[]
  const data = calibrate(task.baseEstimateMin, samples.map(s => s.actual / s.base), enabled)
  return { baseMin: task.baseEstimateMin, ...data, groupKey: group, source: task.estimateSource, applied: enabled && data.sampleCount > 0 }
}
export function calibrationVersion(): string {
  const records = getDb().prepare(`SELECT f.*,e.valid,e.cycle,t.status,t.completion_seq FROM completion_feedback f
    JOIN completion_events e ON e.id=f.event_id JOIN tasks t ON t.id=e.task_id ORDER BY f.event_id`).all()
  const config = getDb().prepare('SELECT calibration_enabled FROM profile_settings WHERE id=1').get()
  return createHash('sha256').update(JSON.stringify([records, config])).digest('hex')
}
export function recentFeedback(scope: string, limit = 5): object[] {
  if (typeof scope !== 'string' || !scope.trim() || scope.length > 60 || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('反馈检索参数无效。')
  return getDb().prepare(`SELECT e.id AS eventId,e.title,e.group_key AS scope,e.base_min AS baseMin,e.planned_min AS plannedMin,
    f.actual_min AS actualMin,f.difficulty,f.interrupted,f.scope_changed AS scopeChanged,f.note,f.updated_at AS recordedAt
    FROM completion_feedback f JOIN completion_events e ON e.id=f.event_id JOIN tasks t ON t.id=e.task_id
    WHERE e.valid=1 AND t.status='done' AND t.completion_seq=e.cycle AND e.group_key=? ORDER BY f.updated_at DESC,f.rowid DESC LIMIT ?`)
    .all(scopeKey(scope), limit).map(row => ({ ...(row as object), sourceRef: `completion:${(row as { eventId: string }).eventId}`, kind: 'single_execution_evidence' }))
}
