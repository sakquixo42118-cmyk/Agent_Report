// ===== 两端共用的类型定义 =====

/** 任务状态：inbox=待分析(收件箱) / pending=排序池 / done=已完成 / archived=已归档(软删) */
export type TaskStatus = 'inbox' | 'pending' | 'done' | 'archived'

/** 任务分类 */
export type TaskCategory = '工作' | '生活' | '学习' | '其他'

/** AI 分析状态：pending=分析中 / ok=AI 完成 / failed=AI 失败(规则兜底) / none=未配置 AI(规则排序) / rule=规则引擎结果 */
export type AiStatus = 'pending' | 'ok' | 'failed' | 'none' | 'rule' | 'confirmed'

/** 任务对象（渲染端视角，日期均为 ISO8601 字符串） */
export interface Task {
  id: number
  content: string
  summary: string | null // AI 提炼的一句话关键信息（长文本任务用）
  status: TaskStatus
  category: TaskCategory
  tags: readonly string[]
  importance: number // 1-5
  urgency: number // 1-5
  estimateMin: number // 预估耗时(分钟)
  baseEstimateMin: number
  estimateGroup: string
  estimateSource: string
  completionSeq: number
  dueAt: string | null // 兼容评分接口：仅映射已确认的deadlineAt，永不表示执行时间
  deadlineAt: string | null
  deadlineConfirmed: boolean
  deadlineSource: string
  legacyDueAt: string | null
  dueNotified: boolean
  snoozeCount: number
  aiStatus: AiStatus
  manualLocked: boolean // 用户手动调过重要性/紧急度 → AI 每日重评跳过
  projectId: string | null // 项目链条组 id（批量导入成组）
  chainOrder: number // 组内顺序（1 起）
  chainTotal: number // 组内任务总数
  rangeStart: string | null // 范围计划起始日（"第 1 周（10/19–10/25）"类，调度器据此分配）
  rangeEnd: string | null // 范围计划结束日
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

/** 新建任务入参 */
export interface TaskCreateInput {
  content: string
}

/** 任务更新入参（部分字段） */
export interface TaskUpdateInput {
  id: number
  content?: string
  category?: TaskCategory
  tags?: string[]
  importance?: number
  urgency?: number
  estimateMin?: number
  estimateGroup?: string
  dueAt?: string | null
  deadlineAt?: string | null
}

/** 任务查询过滤条件 */
export interface TaskFilter {
  status?: TaskStatus | 'active' // active = inbox+pending
  category?: TaskCategory | 'all'
}

/** 设置键 */
export interface AppSettings {
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  ocrModel: string
  notifyEnabled: boolean
  notifyAdvanceHours: number
  lanEnabled: boolean
  lanPort: number
  lanToken: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: '',
  ocrModel: '',
  notifyEnabled: true,
  notifyAdvanceHours: 24,
  lanEnabled: false,
  lanPort: 39871,
  lanToken: ''
}

/** IPC 通道名常量（preload 与主进程共用，防拼写错） */
export const IPC = {
  taskCreate: 'task:create',
  taskBatchCreate: 'task:batchCreate',
  taskList: 'task:list',
  taskUpdate: 'task:update',
  taskComplete: 'task:complete',
  taskSnooze: 'task:snooze',
  taskDelete: 'task:delete',
  taskRetryAnalyze: 'task:retryAnalyze',
  chainList: 'chain:list',
  chainAppend: 'chain:append',
  chainShift: 'chain:shift',
  chainRemoveTask: 'chain:removeTask',
  scheduleRebalance: 'schedule:rebalance',
  projectRebalance: 'project:rebalance',
  projectList: 'project:list',
  projectAddStep: 'project:addStep',
  projectMoveStep: 'project:moveStep',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsTestAi: 'settings:testAi',
  taskChanged: 'task:changed'
} as const

/** AI 分析结果（analyzer 内部流转） */
export interface AiAnalysisResult {
  summary: string | null
  importance: number
  urgency: number
  category: TaskCategory
  tags: string[]
  estimateMin: number
  dueAt: string | null
}

/** 批量导入解析出的单个任务（批量场景多一个 content） */
export type BatchParsedTask = { content: string } & Omit<AiAnalysisResult, 'summary'> & {
  rangeStart?: string | null
  rangeEnd?: string | null
}

/** 批量导入返回 */
export interface BatchCreateResult {
  created: number
  mode: 'ai' | 'rule'
  rebalanced: number // 范围任务被智能分配到各天的数量
}

/** 范围重分配返回 */
export interface RebalanceResult {
  assigned: number // 分到具体日期的任务数
  displaced: number // 被挤占后排的已有任务数
}

/** 链条视图组 */
export interface ChainGroup {
  projectId: string
  chainTotal: number
  tasks: Task[]
}
