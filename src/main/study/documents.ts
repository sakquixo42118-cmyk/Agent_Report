// ===== 学习资料登记与解析 =====
// 只保存原文件路径引用：不复制文件、不把正文写入数据库。
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { getDb } from '../db/database'
import { STUDY_ALLOWED_EXTS, STUDY_MAX_BYTES, type StudyDocStatus, type StudyDocument, type StudyExt, type StudyOcrState } from '@shared/study'
import { extractStudyFile, isLikelyScan } from './extract'

const COLUMNS = `id,path,name,ext,size_bytes,content_hash,page_count,char_count,status,parser,outline_confidence,ocr_state,last_error,created_at,updated_at`
// 读取时附带"确实有文字的页数"：这是区分"整本已解析"和"只识别了前 30 页"的唯一依据
const SELECT_COLUMNS = `${COLUMNS},
  (SELECT COUNT(*) FROM study_pages p WHERE p.doc_id=study_documents.id AND TRIM(p.text) <> '') AS recognized_pages`

const now = (): string => new Date().toISOString()

/** 取前 16 位足够识别"同名换文件"，且不把完整指纹写进库 */
const hashOf = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex').slice(0, 16)

function mapRow(row: Record<string, unknown>): StudyDocument {
  const pages=new Set((getDb().prepare("SELECT page_no FROM study_pages WHERE doc_id=? AND TRIM(text)<>''").all(row.id) as {page_no:number}[]).map(p=>p.page_no))
  let first=1;while(pages.has(first))first++
  return {
    id: String(row.id),
    path: String(row.path),
    name: String(row.name),
    ext: String(row.ext) as StudyExt,
    sizeBytes: Number(row.size_bytes),
    contentHash: String(row.content_hash),
    pageCount: Number(row.page_count),
    charCount: Number(row.char_count),
    status: String(row.status) as StudyDocStatus,
    parser: String(row.parser),
    outlineConfidence: Number(row.outline_confidence),
    ocrState: String(row.ocr_state ?? 'none') as StudyOcrState,
    recognizedPages: Number(row.recognized_pages ?? 0),
    firstMissingPage:first<=Number(row.page_count)?first:null,
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

export function listDocuments(): StudyDocument[] {
  const rows = getDb().prepare(`SELECT ${SELECT_COLUMNS} FROM study_documents ORDER BY created_at DESC`).all() as Record<string, unknown>[]
  return rows.map(mapRow)
}

export function getDocument(id: string): StudyDocument | null {
  if (typeof id !== 'string' || !id.trim() || id.length > 64) return null
  const row = getDb().prepare(`SELECT ${SELECT_COLUMNS} FROM study_documents WHERE id=?`).get(id) as Record<string, unknown> | undefined
  return row ? mapRow(row) : null
}

/**
 * 登记文件：真实路径 + 大小 + 扩展名 + 内容指纹。
 * 同一路径同一内容只保留一条；同一路径内容变化时清理旧记录。
 */
export async function registerFile(filePath: string): Promise<StudyDocument> {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('文件路径无效。')
  const resolved = await realpath(filePath).catch(() => { throw new Error(`文件不存在或无法访问：${filePath}`) })
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error('只能选择普通文件。')
  const ext = extname(resolved).slice(1).toLowerCase() as StudyExt
  if (!STUDY_ALLOWED_EXTS.includes(ext)) throw new Error(`仅支持 ${STUDY_ALLOWED_EXTS.join(' / ')} 格式。`)
  if (info.size > STUDY_MAX_BYTES) throw new Error(`文件超过 ${Math.round(STUDY_MAX_BYTES / 1024 / 1024)}MB 上限。`)
  if (info.size === 0) throw new Error('文件内容为空。')
  const hash = hashOf(await readFile(resolved))
  const db = getDb()
  return db.transaction(() => {
    const existing = db.prepare('SELECT id,content_hash AS hash FROM study_documents WHERE path=?').all(resolved) as { id: string; hash: string }[]
    const same = existing.find(r => r.hash === hash)
    if (same) {
      const doc = getDocument(same.id)
      if (doc) return doc
    }
    for (const row of existing) db.prepare('DELETE FROM study_documents WHERE id=?').run(row.id)
    const id = randomUUID()
    db.prepare(`INSERT INTO study_documents(${COLUMNS}) VALUES(?,?,?,?,?,?,0,0,'registered','',0,'none',NULL,?,?)`)
      .run(id, resolved, basename(resolved), ext, info.size, hash, now(), now())
    return getDocument(id)!
  })()
}

/**
 * 解析文件并刷新页数/字数。失败只记录状态，不抛错，便于界面逐条展示原因。
 * 用户主动重新解析时允许内容变化（指纹随之更新）；付费分析前的指纹校验在后续阶段做。
 */
export async function parseDocument(id: string): Promise<StudyDocument> {
  const doc = getDocument(id)
  if (!doc) throw new Error('资料记录不存在。')
  const db = getDb()
  const info = await stat(doc.path).catch(() => null)
  if (!info?.isFile()) {
    const message = `文件已不可访问：${doc.path}。请重新添加该文件。`
    db.prepare(`UPDATE study_documents SET status='failed',last_error=?,updated_at=? WHERE id=?`).run(message, now(), id)
    return getDocument(id)!
  }
  try {
    const hash = hashOf(await readFile(doc.path))
    const extracted = await extractStudyFile(doc.path, doc.ext)
    const scanned = isLikelyScan(extracted, doc.ext)
    const changedContent = hash !== doc.contentHash
    // 内容变了，旧识别结果对应的是另一份文件，不能算"已识别"
    // 只统计有文字的页：此前渲染失败留下的空页不能视为"已识别"，否则会永远显示 0 字且不再提供识别入口
    const recognized = changedContent
      ? 0
      : Number((db.prepare("SELECT COUNT(*) AS n FROM study_pages WHERE doc_id=? AND TRIM(text) <> ''").get(id) as { n: number })?.n ?? 0)
    // 已识别过的扫描件重新解析时保留识别结果，不把用户花过钱的成果抹掉
    const keepOcr = scanned && recognized > 0
    const message = scanned && !keepOcr
      ? doc.ext === 'pdf'
        ? `这份 PDF 没有文字层（疑似扫描版），共 ${extracted.pageCount} 页，可交给 AI 逐页识别。`
        : '文件里没有可分析的文字内容。'
      : null
    db.transaction(() => {
      if (changedContent) {
        db.prepare('DELETE FROM study_pages WHERE doc_id=?').run(id)
        db.prepare('DELETE FROM study_documents WHERE path=? AND id<>?').run(doc.path, id)
        db.prepare('UPDATE study_documents SET content_hash=? WHERE id=?').run(hash, id)
      }
      // 有文字层的文件按页落库：模型读教材时不必每次重新解析原文件，
      // 也让"已解析了多少页"和 OCR 结果用同一张表表达
      if (!scanned && extracted.pages.length) {
        const saveTextPage = db.prepare(`INSERT INTO study_pages(doc_id,page_no,text,source,engine,ink_ratio,latency_ms,created_at)
          VALUES(?,?,?,'text',?,0,0,?)
          ON CONFLICT(doc_id,page_no) DO UPDATE SET text=excluded.text,source='text',engine=excluded.engine,created_at=excluded.created_at`)
        const at = now()
        for (const page of extracted.pages) if (page.text.trim()) saveTextPage.run(id, page.page, page.text, extracted.parser, at)
      }
      db.prepare(`UPDATE study_documents SET status=?,page_count=?,char_count=?,parser=?,ocr_state=?,last_error=?,updated_at=? WHERE id=?`)
        .run(
          scanned && !keepOcr ? 'failed' : 'parsed',
          extracted.pageCount,
          keepOcr ? Math.max(doc.charCount, extracted.charCount) : extracted.charCount,
          keepOcr ? doc.parser : extracted.parser,
          keepOcr ? 'done' : scanned && doc.ext === 'pdf' ? 'needed' : changedContent ? 'none' : doc.ocrState,
          message,
          now(),
          id
        )
    })()
  } catch (e) {
    const message = e instanceof Error ? e.message : '解析失败。'
    db.prepare(`UPDATE study_documents SET status='failed',last_error=?,updated_at=? WHERE id=?`).run(message, now(), id)
  }
  return getDocument(id)!
}

/** 只删记录，不动用户的原文件 */
export function removeDocument(id: string): void {
  if (typeof id !== 'string' || !id.trim()) throw new Error('资料编号无效。')
  getDb().prepare('DELETE FROM study_documents WHERE id=?').run(id)
}
