// ===== 学习资料文本抽取：PDF / DOCX / TXT / MD → 统一分页结构 =====
// 关键约束：Electron 33 内置 Node 20 不支持 require(ESM)，pdfjs-dist 必须走动态 import。
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { STUDY_SCAN_MIN_CHARS_PER_PAGE, type StudyExt, type StudyExtract, type StudyLine, type StudyPage } from '@shared/study'

const MAMMOTH_ENTRY = 'mammoth'
const CHARS_PER_PAGE = 2500
const CJK = /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/
const LATIN = /[A-Za-z0-9]/

interface PdfTextItem { str?: string; transform?: number[] }
export interface PdfViewport { width: number; height: number }
export interface PdfPageProxy {
  getTextContent(): Promise<{ items: unknown[] }>
  getViewport(params: { scale: number }): PdfViewport
  render(params: Record<string, unknown>): { promise: Promise<void> }
  cleanup(): void
}
interface PdfDocumentProxy { numPages: number; getPage(n: number): Promise<PdfPageProxy> }
interface PdfLoadingTask { promise: Promise<PdfDocumentProxy>; destroy(): Promise<void> }
interface PdfjsModule { version: string; getDocument(src: Record<string, unknown>): PdfLoadingTask }
interface MammothModule { convertToHtml(input: { path: string }): Promise<{ value: string }> }

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * pdfjs-dist v6 是纯 ESM 包，Electron 33 的 Node 20 不支持 require(ESM)，
 * 因此必须用绝对路径 + file:// URL 动态 import；打包时该目录需从 asar 解包，
 * 否则 ESM loader 读取 asar 内的 .mjs 不可靠。
 */
function pdfjsRoot(): string {
  const override = process.env.SUISHOU_PDFJS_ASSETS?.trim()
  if (override && existsSync(path.join(override, 'legacy', 'build', 'pdf.mjs'))) return override
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'pdfjs-dist'), path.join(app.getAppPath(), 'node_modules', 'pdfjs-dist')]
    : [path.join(app.getAppPath(), 'node_modules', 'pdfjs-dist'), path.join(process.cwd(), 'node_modules', 'pdfjs-dist')]
  for (const dir of candidates) if (existsSync(path.join(dir, 'legacy', 'build', 'pdf.mjs'))) return dir
  throw new Error('未找到 PDF 解析组件 pdfjs-dist，请重新安装依赖。')
}

/**
 * pdfjs 在 Node 环境用 fs 读取资源，要求 baseUrl 以正斜杠结尾（Windows 反斜杠路径不被接受）。
 * wasmUrl 不可缺少：JPEG2000(JPX) 与 JBIG2 解码器在 v6 里是 WebAssembly，
 * 缺了它扫描件整页会解码失败、渲染成空白，OCR 自然拿不到任何文字。
 */
export function pdfjsAssets(): Record<string, unknown> {
  const base = pdfjsRoot()
  const out: Record<string, unknown> = {}
  const asDir = (dir: string): string => dir.replace(/\\/g, '/') + '/'
  const fonts = path.join(base, 'standard_fonts')
  const cmaps = path.join(base, 'cmaps')
  const wasm = path.join(base, 'wasm')
  const iccs = path.join(base, 'iccs')
  if (existsSync(fonts)) out.standardFontDataUrl = asDir(fonts)
  if (existsSync(cmaps)) { out.cMapUrl = asDir(cmaps); out.cMapPacked = true }
  if (existsSync(wasm)) out.wasmUrl = asDir(wasm)
  if (existsSync(iccs)) out.iccUrl = asDir(iccs)
  return out
}

/** 估算一段文字的横向宽度，用于判断同行的片段之间是否需要补空格 */
function textWidth(text: string, size: number): number {
  let width = 0
  for (const ch of text) width += CJK.test(ch) ? size : size * 0.52
  return width
}

/** 把 pdfjs 的文本片段按 y 聚成行，保留字号与 y 供目录识别使用 */
function linesFromPdfItems(items: unknown[]): StudyLine[] {
  const raws: { str: string; x: number; y: number; size: number }[] = []
  for (const raw of items) {
    const item = raw as PdfTextItem
    if (typeof item.str !== 'string' || !item.str.trim() || !Array.isArray(item.transform)) continue
    const t = item.transform
    const size = round1(Math.hypot(Number(t[0]) || 0, Number(t[1]) || 0)) || 12
    raws.push({ str: item.str.replace(/\s+/g, ' '), x: Number(t[4]) || 0, y: Number(t[5]) || 0, size })
  }
  // PDF 坐标 y 轴向上，按 y 降序即自上而下
  raws.sort((a, b) => b.y - a.y || a.x - b.x)

  const lines: StudyLine[] = []
  let group: typeof raws = []
  let baseY = 0
  const flush = (): void => {
    if (!group.length) return
    const sorted = [...group].sort((a, b) => a.x - b.x)
    let text = ''
    let prevEnd = Number.NEGATIVE_INFINITY
    for (const r of sorted) {
      const gap = r.x - prevEnd
      const head = text.slice(-1)
      const tail = r.str[0] ?? ''
      const threshold = LATIN.test(tail) ? 0.15 : 0.35
      if (text && gap > r.size * threshold && !CJK.test(head) && !CJK.test(tail)) text += ' '
      text += r.str
      prevEnd = r.x + textWidth(r.str, r.size)
    }
    const cleaned = text.replace(/\s+/g, ' ').trim()
    if (cleaned) lines.push({ text: cleaned, size: round1(Math.max(...sorted.map(r => r.size))), y: round1(baseY) })
    group = []
  }
  for (const r of raws) {
    if (!group.length) { group = [r]; baseY = r.y; continue }
    if (Math.abs(r.y - baseY) <= Math.max(2, r.size * 0.4)) group.push(r)
    else { flush(); group = [r]; baseY = r.y }
  }
  flush()
  return lines
}

async function extractPdf(file: string): Promise<StudyExtract> {
  const handle = await openPdf(file)
  try {
    const pages: StudyPage[] = []
    let charCount = 0
    for (let n = 1; n <= handle.numPages; n++) {
      const page = await handle.getPage(n)
      try {
        const content = await page.getTextContent()
        const lines = linesFromPdfItems(content.items)
        const text = lines.map(l => l.text).join('\n')
        charCount += text.replace(/\s/g, '').length
        pages.push({ page: n, text, lines })
      } finally { page.cleanup() }
    }
    return { pageCount: handle.numPages, charCount, pages, parser: `pdfjs-${handle.pdfjsVersion}` }
  } finally {
    await handle.dispose()
  }
}

/** PDF 文档句柄：文字抽取与扫描件渲染共用同一套打开/销毁逻辑 */
export interface PdfHandle {
  pdfjsVersion: string
  numPages: number
  getPage(n: number): Promise<PdfPageProxy>
  dispose(): Promise<void>
}

export async function openPdf(file: string): Promise<PdfHandle> {
  const entry = pathToFileURL(path.join(pdfjsRoot(), 'legacy', 'build', 'pdf.mjs')).href
  const pdfjs = (await import(/* @vite-ignore */ entry)) as unknown as PdfjsModule
  const data = new Uint8Array(await readFile(file))
  const task = pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false, ...pdfjsAssets() })
  const doc = await task.promise
  return {
    pdfjsVersion: pdfjs.version,
    numPages: doc.numPages,
    getPage: (n: number) => doc.getPage(n),
    // 销毁由 loadingTask 负责，doc.destroy 在 v6 中不存在
    dispose: async () => { await task.destroy().catch(() => undefined) }
  }
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code) || 32))
}

async function extractDocx(file: string): Promise<StudyExtract> {
  const mod = (await import(/* @vite-ignore */ MAMMOTH_ENTRY)) as unknown as { default?: MammothModule } & MammothModule
  const mammoth = (mod.default ?? mod) as MammothModule
  const { value: html } = await mammoth.convertToHtml({ path: file })
  const lines: StudyLine[] = []
  const re = /<(h[1-6]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const tag = match[1].toLowerCase()
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (!text) continue
    const level = tag === 'p' ? 0 : Number(tag.slice(1))
    // DOCX 无字号/坐标，用标题层级折算虚拟字号，复用同一套目录识别逻辑
    lines.push({ text, size: level ? 22 - level * 2 : 12, y: lines.length, level })
  }
  return paginateByChars(lines, 'mammoth')
}

/** 无真实分页的格式按字符数估算页，parser 字段会带说明 */
function paginateByChars(lines: StudyLine[], parser: string): StudyExtract {
  const pages: StudyPage[] = []
  let buffer: StudyLine[] = []
  let chars = 0
  const flush = (): void => {
    if (!buffer.length) return
    pages.push({ page: pages.length + 1, text: buffer.map(l => l.text).join('\n'), lines: buffer })
    buffer = []
    chars = 0
  }
  for (const line of lines) {
    if (chars > 0 && chars + line.text.length > CHARS_PER_PAGE) flush()
    buffer.push(line)
    chars += line.text.length
  }
  flush()
  const charCount = lines.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0)
  return { pageCount: Math.max(pages.length, 1), charCount, pages, parser: `${parser}（页码按约${CHARS_PER_PAGE}字估算）` }
}

/** 中文 txt 常见 GBK 编码：UTF-8 解出大量替换字符时改用 GBK 兜底 */
function decodeText(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8').replace(/^\uFEFF/, '')
  const broken = (utf8.match(/\uFFFD/g) ?? []).length
  if (!broken) return utf8
  try {
    const gbk = new TextDecoder('gbk').decode(buffer)
    if ((gbk.match(/\uFFFD/g) ?? []).length < broken) return gbk
  } catch { /* 运行环境无 GBK 支持时保留 UTF-8 结果 */ }
  return utf8
}

async function extractPlain(file: string, ext: StudyExt): Promise<StudyExtract> {
  const text = decodeText(await readFile(file))
  const lines: StudyLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const heading = ext === 'md' ? /^(#{1,6})\s+(.{1,100})$/.exec(trimmed) : null
    const level = heading ? heading[1].length : 0
    lines.push({ text: heading ? heading[2].trim() : trimmed, size: level ? 22 - level * 2 : 12, y: lines.length, level })
  }
  return paginateByChars(lines, 'plain-text')
}

export async function extractStudyFile(file: string, ext: StudyExt): Promise<StudyExtract> {
  if (ext === 'pdf') return extractPdf(file)
  if (ext === 'docx') return extractDocx(file)
  return extractPlain(file, ext)
}

/** 判定"抽不出文字"：PDF 按每页字符数，其余格式只看是否完全为空 */
export function isLikelyScan(doc: StudyExtract, ext: StudyExt): boolean {
  if (doc.charCount === 0) return true
  if (ext !== 'pdf') return false
  const perPage = doc.pageCount > 0 ? doc.charCount / doc.pageCount : 0
  return perPage < STUDY_SCAN_MIN_CHARS_PER_PAGE
}
