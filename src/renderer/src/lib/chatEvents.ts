import type { AgentEvent } from '@shared/agent'

/** 消息区的一行：要么是一条工具记录组，要么是一条普通消息 */
export interface ChatRow {
  key: string
  tools: AgentEvent[]
  event: AgentEvent | null
}

/**
 * 把连续的工具事件合并成一行。
 * 一轮对话常有七八次工具调用，逐条铺开会把真正的答复挤出视野，
 * 也会让"卡住跑不动"看起来像一堆一模一样的记录。
 */
export function groupChatEvents(events: readonly AgentEvent[]): ChatRow[] {
  const rows: ChatRow[] = []
  for (const event of events) {
    const last = rows[rows.length - 1]
    if (event.kind !== 'tool') { rows.push({ key: `e${event.id}`, tools: [], event }); continue }
    if (last && !last.event) last.tools.push(event)
    else rows.push({ key: `t${event.id}`, tools: [event], event: null })
  }
  return rows
}

/** 工具记录里存的是一段 JSON；取不出名字时退回“工具”，不影响展示 */
export function toolName(text: string): string {
  try {
    const value = JSON.parse(text) as { tool?: unknown }
    return typeof value.tool === 'string' ? value.tool : '工具'
  } catch { return '工具' }
}

export function toolSummary(tools: readonly AgentEvent[]): string {
  if (tools.length === 1) return `查看工具执行记录（${toolName(tools[0].text)}）`
  const names = [...new Set(tools.map(e => toolName(e.text)))]
  return `查看工具执行记录（${tools.length} 次：${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}）`
}
