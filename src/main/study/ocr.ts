// ===== 扫描件识别：PDF 页 → 图片 → 视觉模型转录 → 落库 =====
// 三条硬约束：
// 1. pdfjs 在 Node 环境没有 Canvas，必须由 @napi-rs/canvas 提供画布；
// 2. 识别结果必须落库（study_pages），否则每次重跑都会重新付费；
// 3. 扫描件没有文字层，无法做目录识别，因此识别是考点分析的前置步骤。
import { randomUUID,createHash } from 'node:crypto'
import { stat,readFile } from 'node:fs/promises'
import { createCanvas } from '@napi-rs/canvas'
import { chatCompletion, imageDataUrl, isAiConfigured } from '../ai/client'
import { getSettings } from '../db/settingsDao'
export function ocrSettings():ReturnType<typeof getSettings>{const s=getSettings();return{...s,aiModel:s.ocrModel||s.aiModel}}
import { getDb } from '../db/database'
import {
  STUDY_OCR_CONCURRENCY,
  STUDY_OCR_MAX_PAGES,
  STUDY_OCR_PROMPT_VERSION,
  STUDY_OCR_RENDER_SCALE,
  STUDY_OCR_TIMEOUT_MS,
  STUDY_OCR_BLANK_INK_RATIO,
  type StudyDocument,
  type StudyOcrProgress,
  type StudyOcrResult
} from '@shared/study'
import { getDocument } from './documents'
import { openPdf, type PdfHandle } from './extract'

const now = (): string => new Date().toISOString()

const OCR_SYSTEM_PROMPT = [
  '你是教材与试卷的 OCR 引擎，任务是把图片中的文字逐字转录为纯文本。',
  '规则：',
  '1. 只输出转录结果，不要任何解释、前言、总结或“以下是识别结果”之类的话。',
  '2. 保留原有的段落与题号，一道题或一个自然段占一行。',
  '3. 数学公式用单行纯文本表示，例如 x^2、∫f(x)dx、lim(x→0)、a/b。',
  '4. 图形、表格若无法用文字表达，直接跳过，不要编造内容。',
  '5. 页面确实没有可识别文字时，输出空内容，不要写“本页无文字”。'
].join('\n')

/** 模型明确拒绝识别时的表现：此类回帖不能当作正文入库 */
const REFUSAL = /(无法识别|不能识别|抱歉|看不清|请提供清晰)/

export interface OcrPageRecord {
  page: number
  text: string
  source: 'text' | 'ocr'
  engine: string
  inkRatio: number
}

export interface OcrDeps {
  /** 单页转录：默认调用视觉模型，测试可注入桩函数 */
  transcribe?: (png: Buffer, pageNo: number, totalPages: number) => Promise<string>
  /** 渲染倍率，默认 2 倍 A4 */
  scale?: number
}

export interface OcrOptions extends OcrDeps {
  fromPage?: number
  toPage?: number
  onProgress?: (progress: StudyOcrProgress) => void
}

/** 进行中的识别任务：按 docId 记录取消标记，取消后已识别的页仍然保留 */
const cancelling = new Set<string>()
const running = new Set<string>()

export function cancelOcr(docId: string): void {
  cancelling.add(docId)
}

export function isOcrRunning(docId: string): boolean {
  return running.has(docId)
}

/** 已识别的页：用于跳过重复付费 */
export function listOcrPages(docId: string, fromPage = 1, toPage = Number.MAX_SAFE_INTEGER): OcrPageRecord[] {
  const rows = getDb()
    .prepare('SELECT page_no,text,source,engine,ink_ratio FROM study_pages WHERE doc_id=? AND page_no>=? AND page_no<=? ORDER BY page_no')
    .all(docId, fromPage, toPage) as Record<string, unknown>[]
  return rows.map(row => ({
    page: Number(row.page_no),
    text: String(row.text),
    source: String(row.source) as 'text' | 'ocr',
    engine: String(row.engine),
    inkRatio: Number(row.ink_ratio)
  }))
}

export function countOcrPages(docId: string): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM study_pages WHERE doc_id=?').get(docId) as { n: number }
  return Number(row?.n ?? 0)
}

/** 只统计真正有文字的页：整份都是空白页不能算识别成功 */
export function countRecognizedPages(docId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM study_pages WHERE doc_id=? AND TRIM(text) <> ''").get(docId) as { n: number }
  return Number(row?.n ?? 0)
}

/** 取已识别正文，拼成下游（章节识别 / 考点抽取）直接可用的文本 */
export function loadDocumentText(docId: string, fromPage = 1, toPage = Number.MAX_SAFE_INTEGER): string {
  return listOcrPages(docId, fromPage, toPage).map(p => p.text.trim()).filter(Boolean).join('\n\n')
}

/** 渲染单页并统计墨迹，返回 PNG 与墨迹比例；墨迹过低视为空白页，不送模型 */
export async function renderPageToPng(
  handle: PdfHandle,
  pageNo: number,
  scale = STUDY_OCR_RENDER_SCALE
): Promise<{ png: Buffer; inkRatio: number; width: number; height: number }> {
  const page = await handle.getPage(pageNo)
  try {
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    // 先铺白底：扫描件常有透明区域，不铺白会得到黑底图，模型无法识别
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport, canvas }).promise
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let ink = 0
    for (let i = 0; i < data.length; i += 4) {
      // 亮度低于 200 视为有墨迹
      if (data[i] < 200) ink++
    }
    const total = canvas.width * canvas.height
    return {
      png: canvas.toBuffer('image/png'),
      inkRatio: total > 0 ? ink / total : 0,
      width: canvas.width,
      height: canvas.height
    }
  } finally {
    page.cleanup()
  }
}

/** 默认转录器：把整页图片作为多模态块发给当前配置的模型 */
function visionTranscriber(settings=ocrSettings()): (png: Buffer, pageNo: number, totalPages: number) => Promise<string> {
  if (!isAiConfigured(settings)) throw new Error('识别扫描件需要模型：请先在设置中填写接口地址、模型名和密钥。')
  return async (png, pageNo, totalPages) => {
    try {
      const text = await chatCompletion(
        settings,
        [
          { role: 'system', content: OCR_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: `请转录第 ${pageNo} 页（共 ${totalPages} 页）。` },
              imageDataUrl(png, 'image/png')
            ]
          }
        ],
        { temperature: 0, timeoutMs: STUDY_OCR_TIMEOUT_MS, maxTokens: 4000 }
      )
      return normalizeOcrText(text)
    } catch (e) {
      throw new Error(visionErrorMessage(e, settings.aiModel))
    }
  }
}

/**
 * 把接口报错翻译成用户能行动的提示。
 * 最常见的是模型或中转服务不支持图片输入，原始报错只有 HTTP 400，看不出原因。
 */
export function visionErrorMessage(error: unknown, model: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/image|vision|multimodal|图片|多模态|content.?type|content.*array/i.test(raw) && /400|415|422|不支持|unsupported|invalid|unexpected/i.test(raw)) {
    return `当前识别模型「${model}」似乎不支持图片输入，请在设置中填写支持视觉的扫描件识别模型后重试。原始报错：${raw}`
  }
  return raw
}

/** 去掉模型可能加的代码围栏与客套话；空页统一归一为空串 */
export function normalizeOcrText(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n')
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text.trim())
  if (fenced) text = fenced[1]
  text = text.replace(/^\s*(以下是|这是).{0,12}(识别|转录)结果[:：]?\s*\n?/, '')
  return text.split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 简单并发池：保持页序无关的顺序执行，避免一次开几百个请求 */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}

function updateDocumentOcrState(docId: string, patch: { ocrState: string; status?: string; parser?: string; message?: string | null }): void {
  const db = getDb()
  // 识别完成后字数以 study_pages 为准，避免沿用扫描件为 0 的旧值
  const rows = db.prepare('SELECT text FROM study_pages WHERE doc_id=?').all(docId) as { text: string }[]
  const charCount = rows.reduce((sum, r) => sum + String(r.text).replace(/\s/g, '').length, 0)
  const fields = ['ocr_state=?', 'char_count=?', 'updated_at=?']
  const values: unknown[] = [patch.ocrState, charCount, now()]
  if (patch.status) { fields.push('status=?'); values.push(patch.status) }
  if (patch.parser) { fields.push('parser=?'); values.push(patch.parser) }
  if (patch.message !== undefined) { fields.push('last_error=?'); values.push(patch.message) }
  values.push(docId)
  db.prepare(`UPDATE study_documents SET ${fields.join(',')} WHERE id=?`).run(...values)
}

/**
 * 识别扫描件：逐页渲染 + 转录，结果逐页入库。
 * 已识别过的页直接跳过，因此中断后重新发起不会重复付费。
 */
export async function ocrDocument(docId: string, options: OcrOptions = {}): Promise<StudyOcrResult> {
  const doc = getDocument(docId)
  if (!doc) throw new Error('资料记录不存在。')
  if (doc.ext !== 'pdf') throw new Error('只有 PDF 需要识别；Word 与文本请直接重新解析。')
  if (running.has(docId)) throw new Error('这份资料正在识别中，请等待完成或先取消。')
  const info = await stat(doc.path).catch(() => null)
  if (!info?.isFile()) throw new Error(`原文件已不可访问：${doc.path}。请重新添加该文件。`)
  const fingerprint=async():Promise<string>=>createHash('sha256').update(await readFile(doc.path)).digest('hex').slice(0,16)
  if(await fingerprint()!==doc.contentHash)throw new Error('原文件内容已变化，请重新解析后再识别。')
  if (doc.pageCount < 1) throw new Error('还不清楚这份 PDF 有多少页，请先重新解析一次。')

  const from = clampPage(options.fromPage ?? 1, doc.pageCount)
  const to = clampPage(options.toPage ?? doc.pageCount, doc.pageCount)
  if (to < from) throw new Error(`页码范围无效：起始页 ${from} 大于结束页 ${to}。`)
  const total = to - from + 1
  if (total > STUDY_OCR_MAX_PAGES) {
    throw new Error(`单次最多识别 ${STUDY_OCR_MAX_PAGES} 页，本次选了 ${total} 页，请缩小页码范围。`)
  }

  const scale = options.scale ?? STUDY_OCR_RENDER_SCALE
  // 延迟到第一页真正需要时才创建：全部命中缓存或整份空白页时不必要求用户先配好模型
  let transcriber = options.transcribe
  const transcribe = (png: Buffer, pageNo: number, totalPages: number): Promise<string> => {
    transcriber ??= visionTranscriber(settings)
    return transcriber(png, pageNo, totalPages)
  }
  const settings = ocrSettings()
  const runId = randomUUID()
  const db = getDb()
  db.prepare(`INSERT INTO study_ocr_runs(id,doc_id,from_page,to_page,status,model,prompt_version,total_pages,done_pages,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)`)
    .run(runId, docId, from, to, 'running', settings.aiModel || '', STUDY_OCR_PROMPT_VERSION, total, now())

  cancelling.delete(docId)
  running.add(docId)

  // 只把"真的识别出文字"的页当缓存：空白页（含解码失败渲染成白页）必须重试，
  // 否则一次失败的识别会永久挡住这份文件的再识别。
  const cached = new Set(listOcrPages(docId, from, to).filter(p => p.text.trim() !== '').map(p => p.page))
  const pending: number[] = []
  for (let n = from; n <= to; n++) if (!cached.has(n)) pending.push(n)

  let done = cached.size
  let recognized = 0
  let failed = 0
  let blanks = 0
  let lastError = ''

  const emit = (state: StudyOcrProgress['state'], page: number, message = ''): void => {
    options.onProgress?.({ docId, state, done, total, page, message })
  }

  emit('running', from)
  let handle: PdfHandle | null = null
  try {
    handle = await openPdf(doc.path)
    const savePage = db.prepare(`INSERT INTO study_pages(doc_id,page_no,text,source,engine,ink_ratio,latency_ms,created_at)
      VALUES(?,?,?,'ocr',?,?,?,?)
      ON CONFLICT(doc_id,page_no) DO UPDATE SET text=excluded.text,source='ocr',engine=excluded.engine,ink_ratio=excluded.ink_ratio,latency_ms=excluded.latency_ms,created_at=excluded.created_at`)

    await runPool(pending, STUDY_OCR_CONCURRENCY, async (pageNo) => {
      if (cancelling.has(docId)) { done++; return }
      const started = Date.now()
      try {
        const shot = await renderPageToPng(handle!, pageNo, scale)
        // 空白页不发模型：省一次调用，也避免模型对空白页瞎编内容
        const blank = shot.inkRatio < STUDY_OCR_BLANK_INK_RATIO
        const text = blank ? '' : await transcribe(shot.png, pageNo, total)
        const current=getDocument(docId),currentFile=await stat(doc.path).catch(()=>null)
        if(!current||current.contentHash!==doc.contentHash||!currentFile||currentFile.size!==info.size||currentFile.mtimeMs!==info.mtimeMs)throw new Error('识别期间资料已移除或内容已变化，请重新解析后再识别。')
        if (blank) blanks++
        if (text && REFUSAL.test(text) && text.length < 60) {
          throw new Error(`第 ${pageNo} 页模型拒绝识别，可能是图片太模糊`)
        }
        savePage.run(docId, pageNo, text, settings.aiModel || 'vision', shot.inkRatio, Date.now() - started, now())
        recognized++
      } catch (e) {
        failed++
        lastError = e instanceof Error ? e.message : '识别失败'
        // 单页失败不阻断整份：记下原因，其余页继续，最后汇总
      } finally {
        done++
        emit('running', pageNo, failed > 0 ? `第 ${pageNo} 页未识别：${lastError}` : '')
      }
    })
  } catch (e) {
    lastError = e instanceof Error ? e.message : '识别失败'
    db.prepare('UPDATE study_ocr_runs SET status=?,error=?,done_pages=?,finished_at=? WHERE id=?').run('failed', lastError, done, now(), runId)
    updateDocumentOcrState(docId, { ocrState: 'failed', message: lastError })
    running.delete(docId)
    emit('failed', 0, lastError)
    throw new Error(lastError)
  } finally {
    if (handle) await handle.dispose()
    running.delete(docId)
  }

  const cancelled = cancelling.has(docId)
  cancelling.delete(docId)
  const latest=getDocument(docId),file=await stat(doc.path).catch(()=>null)
  if(!latest||latest.contentHash!==doc.contentHash||!file||file.size!==info.size||file.mtimeMs!==info.mtimeMs||await fingerprint().catch(()=>null)!==doc.contentHash){
    db.prepare("UPDATE study_ocr_runs SET status='cancelled',error=?,finished_at=? WHERE id=?").run('来源已变化，未覆盖新资料状态。',now(),runId)
    emit('failed',0,'资料已移除或更新，请重新解析。')
    throw new Error('识别期间资料已移除或内容已变化，未覆盖新资料。')
  }

  // 只有拿到正文才算识别成功；整份都失败时回退到 failed，允许重试
  const produced = countRecognizedPages(docId)
  const state = produced > 0 ? 'done' : 'failed'
  // 整份都是空白页时，"没有识别出文字"会误导成文件没内容；
  // 实际更常见的原因是页面图用了 pdfjs 解不开的编码（JPEG2000 / JBIG2）
  const blankMessage = `这 ${blanks} 页渲染后都是空白：可能是扫描图使用了无法解码的编码（如 JPEG2000 / JBIG2），也可能页面本身没有内容。`
  updateDocumentOcrState(docId, {
    ocrState: state,
    status: produced > 0 ? 'parsed' : 'failed',
    parser: produced > 0 ? `ocr-${settings.aiModel || 'vision'}` : undefined,
    message: produced > 0
      ? (cancelled ? '识别已取消，已识别的页已保存。' : null)
      : (blanks > 0 && blanks >= pending.length ? blankMessage : lastError || '没有识别出任何文字。')
  })

  db.prepare('UPDATE study_ocr_runs SET status=?,done_pages=?,error=?,finished_at=? WHERE id=?')
    .run(cancelled ? 'cancelled' : failed > 0 ? 'partial' : 'done', done, lastError || null, now(), runId)

  emit(cancelled ? 'cancelled' : state === 'done' ? 'done' : 'failed', to, lastError)
  return {
    document: getDocument(docId) as StudyDocument,
    recognized,
    skipped: cached.size,
    total,
    cancelled,
    preview: loadDocumentText(docId).slice(0, 120)
  }
}

function clampPage(n: number, max: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(Math.max(Math.round(n), 1), Math.max(max, 1))
}
