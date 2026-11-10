import { app, net } from 'electron'

/**
 * 主进程统一出口：优先用 Electron 的 net（Chromium 网络栈，遵循系统代理），
 * 回退到 Node 自带 fetch（不读系统代理，代理环境下会在 10 秒连接超时后报 "fetch failed"）。
 */
export function rawFetch(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  let request: Promise<Response>
  try {
    request = app.isReady() && typeof net.fetch === 'function' ? net.fetch(url, init as never) : fetch(url, init)
  } catch {
    // net 不可用（未就绪或环境不支持）时不影响主流程
    request = fetch(url, init)
  }
  // 不依赖实现是否真的响应 AbortSignal：超时必定结束等待，避免界面永久卡在"运行中"
  return timeoutMs ? withDeadline(request, timeoutMs) : request
}

function withDeadline(request: Promise<Response>, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('请求超时')
      error.name = 'TimeoutError'
      reject(error)
    }, ms)
    request.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

/** fetch 失败只给一句 "fetch failed"，真实原因在 cause 上；这里翻成可操作的中文 */
export function fetchFailureText(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return `模型响应超时（${Math.round(timeoutMs / 1000)} 秒），已停止等待。若反复出现，请确认网络或代理是否可用，或把目标拆小后重试。`
  }
  const detail = errorDetail(error)
  if (/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ERR_TIMED_OUT/i.test(detail)) {
    return '连接模型服务超时，请求没有建立。若在用代理/VPN，请确认代理已开启并对本应用生效（系统代理或 TUN 模式），也可换网络后重试。'
  }
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(detail)) {
    return '无法解析模型服务域名，请检查网络或 DNS 设置。'
  }
  if (/ECONNRESET|ECONNREFUSED|EPIPE|ERR_CONNECTION|socket hang up/i.test(detail)) {
    return '与模型服务的连接被中断，请检查代理或防火墙设置后重试。'
  }
  return `无法连接模型服务（${detail.slice(0, 120) || '网络不可达'}）。`
}

/** 只重试连接类抖动；用户取消和自设超时不重试，避免无谓等待与重复计费 */
export function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false
  return /ECONNRESET|EPIPE|socket hang up|EAI_AGAIN|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED/i.test(errorDetail(error))
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errorDetail(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause
  const code = cause && typeof cause === 'object' ? String((cause as { code?: unknown }).code ?? '') : ''
  const nested = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  return [code, nested, error instanceof Error ? error.message : String(error)].filter(Boolean).join(' ')
}
