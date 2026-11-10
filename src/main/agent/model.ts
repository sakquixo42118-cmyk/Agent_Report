import type { AppSettings } from '@shared/types'
import { normalizeBaseUrl } from '../ai/client'
import { rawFetch, fetchFailureText, isRetryableFetchError, sleep } from '../ai/http'

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}
export interface ToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
export type ModelTransport = (
  settings: AppSettings, messages: ModelMessage[], tools: ToolDefinition[], signal: AbortSignal, control?: { forceResponse: boolean }
) => Promise<ModelMessage>

/** 单次响应最多接受的调用数：只防失控，不作为格式合法性的判据 */
const MAX_CALLS = 24
/** 与 registry.executeSceneTool 的参数上限保持一致，超过后执行层也会拒绝 */
const MAX_ARGUMENT_CHARS = 16000
/** 单次请求等待上限：批量草案最长会生成 4000 token，30 秒不够 */
const TIMEOUT_MS = 60_000
const NET_ATTEMPTS = 2

/**
 * 把供应商返回的 tool_calls 归一化成可执行调用。
 * 不同实现会给出对象形式的 arguments、缺失/重复的 id、或多于一个调用；
 * 这些都是可修复的差异，不该让整轮对话失败。真正无法解释的才返回 null。
 */
export function normalizeModelMessage(raw: unknown): ModelMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const message = raw as { content?: unknown; tool_calls?: unknown }
  const content = typeof message.content === 'string' ? message.content.slice(0, 12000) : null
  const calls = normalizeCalls(message.tool_calls)
  if (!calls.length) return content ? { role: 'assistant', content } : null
  return { role: 'assistant', content, tool_calls: calls }
}

function normalizeCalls(value: unknown): ToolCall[] {
  if (value === undefined || value === null) return []
  // 有些实现把单个调用直接给成对象而不是数组
  const list = Array.isArray(value) ? value : [value]
  const calls: ToolCall[] = []
  const seen = new Set<string>()
  for (const item of list.slice(0, MAX_CALLS)) {
    if (!item || typeof item !== 'object') continue
    const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const name = call.function?.name
    if (typeof name !== 'string' || !name.trim()) continue
    const args = normalizeArguments(call.function?.arguments)
    if (args === null) continue
    let id = typeof call.id === 'string' && call.id.trim() ? call.id.trim().slice(0, 200) : ''
    // 缺 id 或 id 重复都无法和后续 tool 消息对应，补一个稳定可读的编号
    if (!id || seen.has(id)) id = `call_${calls.length + 1}_${id ? 'dup' : 'auto'}`
    while (seen.has(id)) id = `${id}_`
    seen.add(id)
    calls.push({ id, type: 'function', function: { name: name.trim(), arguments: args } })
  }
  return calls
}

function normalizeArguments(value: unknown): string | null {
  if (typeof value === 'string') return value.length > MAX_ARGUMENT_CHARS ? null : value
  if (value === undefined || value === null) return '{}'
  // 少数实现直接回传已解析的对象
  try {
    const text = JSON.stringify(value)
    return text.length > MAX_ARGUMENT_CHARS ? null : text
  } catch { return null }
}

/** 诊断用：说明原始响应为何不可用，避免只回一句"格式无效" */
function diagnose(raw: { tool_calls?: unknown; content?: unknown }): string {
  if (!('tool_calls' in raw) || raw.tool_calls === null || raw.tool_calls === undefined) {
    return typeof raw.content === 'string' && raw.content.trim() ? '模型只返回了文字' : '响应里既没有文字也没有工具调用'
  }
  const list = Array.isArray(raw.tool_calls) ? raw.tool_calls : [raw.tool_calls]
  if (!list.length) return '工具调用为空数组'
  const bad = list.find(item => !item || typeof item !== 'object' || typeof (item as { function?: { name?: unknown } }).function?.name !== 'string')
  return bad ? `有 ${list.length} 个调用，其中至少一个缺少函数名` : `有 ${list.length} 个调用，但参数不可解析`
}

// 独立保留原生tool_calls消息，不改变0.1文字分析客户端的接口。
export const requestAgentTurn: ModelTransport = async (settings, messages, tools, signal, control) => {
  const url = `${normalizeBaseUrl(settings.aiBaseUrl)}/chat/completions`
  const body = JSON.stringify({ model: settings.aiModel, messages,
    tools: control?.forceResponse ? tools.filter(t => t.function.name === 'respond') : tools,
    tool_choice: control?.forceResponse ? { type: 'function', function: { name: 'respond' } } : 'auto',
    parallel_tool_calls: false, temperature: 0.2, max_tokens: 4000 })
  let response: Response | null = null
  for (let attempt = 1; response === null; attempt++) {
    try {
      response = await rawFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.aiApiKey}` },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
      }, TIMEOUT_MS)
    } catch (error) {
      if (signal.aborted) throw error
      // 连接抖动重试一次；用户取消、自设超时不重试
      if (attempt < NET_ATTEMPTS && isRetryableFetchError(error)) { await sleep(600 * attempt); continue }
      throw new Error(fetchFailureText(error, TIMEOUT_MS))
    }
    // 限流与服务端临时故障也值得重试一次
    if (!response.ok && attempt < NET_ATTEMPTS && (response.status === 429 || response.status >= 500)) {
      await sleep(800 * attempt)
      response = null
    }
  }
  if (!response.ok) {
    // 不把可能包含凭据/原文的服务端错误正文持久化到运行日志。
    throw new Error(`模型请求失败（HTTP ${response.status}），请检查设置、额度和工具调用支持。`)
  }
  const data = await response.json() as { choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string }[] }
  const choice = data.choices?.[0]
  const raw = choice?.message
  if (!raw) throw new Error('模型未返回消息。')
  const answer = normalizeModelMessage(raw)
  if (!answer) {
    // 输出被上限截断时，参数往往只写了一半；说明清楚比笼统报错更有用
    if (choice?.finish_reason === 'length') throw new Error('模型输出被长度上限截断，请把目标拆小后重试（已生成的内容不会执行）。')
    throw new Error(`模型工具调用格式无效：${diagnose(raw)}。`)
  }
  return answer
}
