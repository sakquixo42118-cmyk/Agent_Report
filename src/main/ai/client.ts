// ===== OpenAI 兼容接口客户端（主进程 fetch 直连）=====

import type { AppSettings } from '@shared/types'
import { rawFetch, fetchFailureText } from './http'

export interface ChatTextPart {
  type: 'text'
  text: string
}

export interface ChatImagePart {
  type: 'image_url'
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' }
}

/** 内容既可以是纯文本，也可以是 OpenAI 兼容的多模态块数组（视觉模型用） */
export type ChatContent = string | Array<ChatTextPart | ChatImagePart>

export interface ChatMessage {
  role: string
  content: ChatContent
}

/** 把本地图片转成 data URL，供视觉模型内联读取（不依赖外网可访问的图片链接） */
export function imageDataUrl(buffer: Buffer, mime = 'image/png'): ChatImagePart {
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } }
}

/** 归一化 baseURL：去尾部 /；纯域名（无 path）自动补 /v1 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  if (/^https?:\/\/[^/]+$/i.test(url)) url += '/v1'
  return url
}

/** 是否已配置 AI */
export function isAiConfigured(s: Pick<AppSettings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel'>): boolean {
  return Boolean(s.aiBaseUrl.trim() && s.aiApiKey.trim() && s.aiModel.trim())
}

export class AiClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiClientError'
  }
}

interface ChatOptions {
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  timeoutMs?: number
}

/** 调 chat/completions，返回首条消息文本。response_format 不被支持时自动去字段重试一次 */
export async function chatCompletion(
  settings: AppSettings,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<string> {
  const { temperature = 0.2, maxTokens, jsonMode, timeoutMs = 30_000 } = opts
  const url = `${normalizeBaseUrl(settings.aiBaseUrl)}/chat/completions`

  const doFetch = async (withJsonMode: boolean): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const body: Record<string, unknown> = {
        model: settings.aiModel,
        messages,
        temperature
      }
      if (maxTokens) body.max_tokens = maxTokens
      if (withJsonMode && jsonMode) body.response_format = { type: 'json_object' }
      return await rawFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.aiApiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }, timeoutMs)
    } finally {
      clearTimeout(timer)
    }
  }

  let res: Response
  try {
    res = await doFetch(true)
  } catch (e) {
    throw new AiClientError(networkErrMessage(e, timeoutMs))
  }

  // response_format 不支持（部分兼容端点）→ 去掉字段重试一次
  if (!res.ok && jsonMode && (res.status === 400 || res.status === 422)) {
    try {
      const retry = await doFetch(false)
      if (retry.ok) return extractContent(await retry.json())
    } catch {
      // 忽略，走下面的错误处理
    }
  }

  if (!res.ok) {
    throw new AiClientError(await httpErrMessage(res))
  }
  const data = await res.json()
  return extractContent(data)
}

function extractContent(data: unknown): string {
  const msg = (data as { choices?: { message?: { content?: string; reasoning_content?: string } }[] })
    ?.choices?.[0]?.message
  let text = msg?.content
  // 推理模型：max_tokens 用尽时 content 为空但 reasoning_content 有值 → 提示用户调整
  if ((typeof text !== 'string' || !text.trim()) && typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim()) {
    throw new AiClientError('模型只返回了思考过程没有正文，请换非推理模型或调大 max_tokens')
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new AiClientError('AI 返回内容为空（可能模型无响应或额度耗尽）')
  }
  return text
}

async function httpErrMessage(res: Response): Promise<string> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    const err = body?.error
    detail = typeof err === 'string' ? err : err?.message ?? ''
  } catch {
    detail = ''
  }
  if (res.status === 401) return `API Key 无效或未授权${detail ? `（${detail}）` : ''}`
  if (res.status === 404) return `接口路径不存在，请检查 Base URL${detail ? `（${detail}）` : ''}`
  if (res.status === 429) return `请求过于频繁或额度不足${detail ? `（${detail}）` : ''}`
  if (res.status >= 500) return `服务商暂时不可用（HTTP ${res.status}）`
  return `请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`
}

/** 超时文案按实际设置渲染：扫描件识别是 90 秒，写死 30 秒会误导用户 */
function networkErrMessage(e: unknown, timeoutMs: number): string {
  // 统一解析 cause：Node 的 fetch 只报 "fetch failed"，看不出是代理、DNS 还是连接被重置
  return fetchFailureText(e, timeoutMs)
}

/** 测试连接：最小请求，返回延迟 ms。不限 max_tokens（推理模型思考会耗尽小 token 导致正文为空） */
export async function testConnection(settings: AppSettings): Promise<number> {
  const start = Date.now()
  await chatCompletion(settings, [{ role: 'user', content: '回复"OK"两个字母即可' }], { timeoutMs: 20_000 })
  return Date.now() - start
}
