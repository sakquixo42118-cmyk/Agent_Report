// ===== 教材读取（供 Agent 工具使用） =====
// 只读 study_pages：文字层与 OCR 结果共用这张表，因此模型读到什么完全取决于已解析/已识别的页。
import { getDb } from '../db/database'
import { STUDY_READ_MAX_CHARS, STUDY_READ_MAX_PAGES } from '@shared/study'
import type { ToolResult } from '../agent/contracts'
import { getDocument } from './documents'

export interface StudyDocView {
  docId: string
  name: string
  pageCount: number
  recognizedPages: number
  charCount: number
  /** 可读页数 > 0 才能读取正文 */
  readable: boolean
  /** 尚未解析出正文时的原因，直接告诉模型下一步该做什么 */
  hint: string
  readablePageRanges: {from:number;to:number}[]
}

export function listForAgent(): StudyDocView[] {
  const rows = getDb().prepare(`SELECT d.id,d.name,d.ext,d.page_count,d.char_count,d.ocr_state,d.status,d.last_error,
      (SELECT COUNT(*) FROM study_pages p WHERE p.doc_id=d.id AND TRIM(p.text) <> '') AS recognized_pages
    FROM study_documents d ORDER BY d.created_at DESC`).all() as Record<string, unknown>[]
  return rows.map(row => {
    const pageCount = Number(row.page_count)
    const recognized = Number(row.recognized_pages)
    const ocrState = String(row.ocr_state)
    const readablePageRanges:{from:number;to:number}[]=[]
    for(const p of getDb().prepare("SELECT page_no FROM study_pages WHERE doc_id=? AND TRIM(text)<>'' ORDER BY page_no").all(row.id) as {page_no:number}[]){
      const last=readablePageRanges.at(-1);if(last&&p.page_no===last.to+1)last.to=p.page_no;else readablePageRanges.push({from:p.page_no,to:p.page_no})
    }
    const hint = recognized > 0
      ? recognized < pageCount
        ? `共 ${pageCount} 页，已有 ${recognized} 页有文字（不保证从第1页连续）；请按实际可读页码读取，其余页需识别。`
        : ''
      : ocrState === 'needed'
        ? '这份 PDF 没有文字层，需要用户在界面点「识别文字」后才能读取。'
        : row.last_error
          ? String(row.last_error)
          : '还没有可读正文，请用户重新添加或解析这份资料。'
    return {
      docId: String(row.id),
      name: String(row.name),
      pageCount,
      recognizedPages: recognized,
      charCount: Number(row.char_count),
      readable: recognized > 0,
      hint
      ,readablePageRanges
    }
  })
}

/** 读取一段页码：页标记保留，方便模型引用"第几页" */
export function readForAgent(docId: string, fromPage: number, toPage: number): ToolResult {
  const doc = getDocument(docId)
  if (!doc) return { ok: false, errorCode: 'NOT_FOUND', message: '找不到这份资料；先调用 get_study_documents 取得真实 docId，不要猜测。' }
  const lastPage = Math.max(doc.pageCount, 1)
  const from = Math.min(Math.max(1, fromPage), lastPage)
  let to = Math.min(Math.max(from, toPage), lastPage)
  const requested = toPage - fromPage + 1
  if (to - from + 1 > STUDY_READ_MAX_PAGES) to = from + STUDY_READ_MAX_PAGES - 1

  const rows = getDb().prepare(`SELECT page_no,text FROM study_pages
    WHERE doc_id=? AND page_no>=? AND page_no<=? AND TRIM(text) <> '' ORDER BY page_no`).all(docId, from, to) as { page_no: number; text: string }[]

  if (!rows.length) {
    const detail = doc.recognizedPages > 0
      ? `第 ${from}–${to} 页没有文字（已识别的页为 ${doc.recognizedPages}/${doc.pageCount} 页）。`
      : `这份资料当前没有任何可读正文（${doc.pageCount} 页）。`
    return {
      ok: false,
      errorCode: 'NO_TEXT',
      message: `${detail}不要编造内容；如需分析这些页，请让用户在界面点「识别文字」，或改读已识别的页。`
    }
  }

  const pages: { page: number; text: string }[] = []
  let chars = 0
  let cutInPage = false
  for (const row of rows) {
    const text = row.text.trim()
    if (chars + text.length <= STUDY_READ_MAX_CHARS) {
      pages.push({ page: row.page_no, text })
      chars += text.length
      continue
    }
    const room = STUDY_READ_MAX_CHARS - chars
    if (room > 200) {
      pages.push({ page: row.page_no, text: `${text.slice(0, room)}…` })
      chars += room
      cutInPage = true
    }
    break
  }

  const lastRead = pages[pages.length - 1].page
  const nextPage = cutInPage ? lastRead : lastRead < to ? lastRead + 1 : to < lastPage ? to + 1 : null
  return {
    ok: true,
    sourceRefs:[`study:${doc.id}:${doc.contentHash}:pages:${pages[0].page}-${lastRead}`],
    stateVersion:doc.contentHash,
    data: {
      docId,
      name: doc.name,
      pageCount: doc.pageCount,
      recognizedPages: doc.recognizedPages,
      fromPage: pages[0].page,
      toPage: lastRead,
      pages,
      chars,
      truncated: cutInPage || lastRead < to || requested > to - from + 1,
      nextPage,
      note: nextPage ? `还有内容未读，继续读时用 fromPage=${nextPage}。` : '这一段已读完。'
    }
  }
}
