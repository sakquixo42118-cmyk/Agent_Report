// ===== 学习资料：解析、章节与考点分析的类型契约 =====

export type StudyExt = 'pdf' | 'docx' | 'txt' | 'md'
export type StudyDocStatus = 'registered' | 'parsed' | 'failed'

/**
 * 扫描件识别状态：
 * none   — 不需要（文字版或非 PDF）
 * needed — 判定为扫描版，等待用户确认后逐页识别
 * done   — 已识别，正文存在 study_pages
 * failed — 识别过程报错，可重试
 */
export type StudyOcrState = 'none' | 'needed' | 'done' | 'failed'

/** 文档登记记录：只保存原文件路径引用，不复制、不存正文 */
export interface StudyDocument {
  id: string
  path: string
  name: string
  ext: StudyExt
  sizeBytes: number
  contentHash: string
  pageCount: number
  charCount: number
  status: StudyDocStatus
  parser: string
  outlineConfidence: number
  ocrState: StudyOcrState
  /** 已抽出文字的页数（OCR 结果或文字层写入 study_pages 的页），用于区分"部分识别"与"整本" */
  recognizedPages: number
  firstMissingPage: number | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

/** 抽取后的一行文本；size/y 供目录识别使用，level 仅 DOCX/MD 有 */
export interface StudyLine {
  text: string
  size: number
  y: number
  level?: number
}

export interface StudyPage {
  page: number
  text: string
  lines: StudyLine[]
}

export interface StudyExtract {
  pageCount: number
  charCount: number
  pages: StudyPage[]
  parser: string
}

export interface StudyPickError {
  path: string
  message: string
}

export interface StudyPickResult {
  canceled: boolean
  documents: StudyDocument[]
  errors: StudyPickError[]
}

/** 扫描件识别进度：running 期间按页推送，结束态只推一次 */
export interface StudyOcrProgress {
  docId: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  done: number
  total: number
  page: number
  message: string
}

export interface StudyOcrResult {
  document: StudyDocument
  /** 本次真正调用模型的页数 */
  recognized: number
  /** 命中已识别缓存而跳过的页数 */
  skipped: number
  total: number
  cancelled: boolean
  /** 首段识别文本，便于用户直接判断识别质量，不必另做阅读界面 */
  preview: string
}

export const STUDY_IPC = {
  pick: 'study:pick',
  list: 'study:list',
  parse: 'study:parse',
  remove: 'study:remove',
  ocr: 'study:ocr',
  ocrCancel: 'study:ocr:cancel',
  ocrProgress: 'study:ocr:progress',
  changed: 'study:changed'
} as const

/** 单文件上限：超过后整份读入内存会明显拖慢主进程 */
export const STUDY_MAX_BYTES = 100 * 1024 * 1024
/** 每页去空白字符低于该值即判为扫描件/图片版，不产出空考点（纯图 PDF 文字层通常接近 0） */
export const STUDY_SCAN_MIN_CHARS_PER_PAGE = 20
export const STUDY_ALLOWED_EXTS: StudyExt[] = ['pdf', 'docx', 'txt', 'md']

/** 单次识别页数上限：防止误选整本 300 页教材后长时间占用与费用失控 */
export const STUDY_OCR_MAX_PAGES = 200
/** 并发页数：过高容易触发限流，过低则整份文档太慢 */
export const STUDY_OCR_CONCURRENCY = 3
/** 渲染倍率：2 倍 A4 约 1224x1584，小字与公式可辨，图片体积也在合理范围 */
export const STUDY_OCR_RENDER_SCALE = 2
/** 单页识别超时：视觉模型逐页转录通常 3–15 秒，留足余量 */
export const STUDY_OCR_TIMEOUT_MS = 90_000
/** 提示词版本：改动转录规则时同步升级，便于日后区分识别结果来源 */
export const STUDY_OCR_PROMPT_VERSION = 'ocr-v1'
/** 墨迹比例低于该值视为整页空白，不发给模型（空白页白花钱） */
export const STUDY_OCR_BLANK_INK_RATIO = 0.0005

/** 单次读取页数上限：模型一次读太多会挤占对话预算（runner 上限 6 万字符） */
export const STUDY_READ_MAX_PAGES = 12
/** 单次读取字符上限：留出余量给工具调用与历史消息 */
export const STUDY_READ_MAX_CHARS = 5000
