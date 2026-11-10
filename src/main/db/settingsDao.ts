import { getDb } from './database'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'

/** settings 表键名 ↔ AppSettings 字段映射 */
const KEY_MAP: Record<string, keyof AppSettings> = {
  ai_base_url: 'aiBaseUrl',
  ai_api_key: 'aiApiKey',
  ai_model: 'aiModel',
  ocr_model: 'ocrModel',
  notify_enabled: 'notifyEnabled',
  notify_advance_hours: 'notifyAdvanceHours',
  lan_enabled: 'lanEnabled',
  lan_port: 'lanPort',
  lan_token: 'lanToken'
}

const FIELD_TO_KEY: Record<keyof AppSettings, string> = Object.fromEntries(
  Object.entries(KEY_MAP).map(([k, v]) => [v, k])
) as Record<keyof AppSettings, string>

export function getSettings(): AppSettings {
  const db = getDb()
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]
  const result: AppSettings = { ...DEFAULT_SETTINGS }
  for (const row of rows) {
    const field = KEY_MAP[row.key]
    if (field) {
      try {
        ;(result as unknown as Record<string, unknown>)[field] = JSON.parse(row.value)
      } catch {
        // 忽略损坏的值，用默认值
      }
    }
  }
  return result
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  const tx = db.transaction((entries: [string, string][]) => {
    for (const [k, v] of entries) stmt.run(k, v)
  })
  const entries: [string, string][] = []
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const key = FIELD_TO_KEY[field as keyof AppSettings]
    if (key) entries.push([key, JSON.stringify(value)])
  }
  tx(entries)
  return getSettings()
}
