import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../src/main/db/database'
import { imageDataUrl } from '../src/main/ai/client'
import * as study from '../src/main/study/documents'
import * as ocr from '../src/main/study/ocr'
import { extractStudyFile, isLikelyScan, openPdf } from '../src/main/study/extract'
import * as reader from '../src/main/study/reader'
import { executeTool } from '../src/main/agent/tools'
import { definitionsForScene } from '../src/main/agent/registry'

type Test = (name: string, fn: () => unknown | Promise<unknown>) => Promise<void>

/** 按对象表拼出带 xref 的 PDF */
function assemble(objects: string[]): Buffer {
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const startxref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += String(offset).padStart(10, '0') + ' 00000 n \n'
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** 生成最小合法 PDF：首行 24pt 作标题，其余 12pt，用于验证字号与坐标抽取 */
function minimalPdf(texts: string[]): Buffer {
  const content = texts
    .map((text, i) => `BT /F1 ${i === 0 ? 24 : 12} Tf 72 ${720 - i * 30} Td (${text.replace(/[()\\]/g, '')}) Tj ET`)
    .join('\n')
  return assemble([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`
  ])
}

/** 只有矢量色块、没有文字层的 PDF：渲染后有墨迹，等价于"扫描件有内容" */
function inkedPdf(pageCount = 1): Buffer {
  const kids = Array.from({ length: pageCount }, (_, i) => 3 + i * 2)
  const bodies = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${kids.map(id => `${id} 0 R`).join(' ')}]/Count ${pageCount}>>`
  ]
  for (let i = 0; i < pageCount; i++) {
    const content = `0.1 0.1 0.1 rg 72 ${400 - i * 10} 450 300 re f`
    bodies.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents ${kids[i] + 1} 0 R>>`)
    bodies.push(`<</Length ${content.length}>>\nstream\n${content}\nendstream`)
  }
  return assemble(bodies)
}

/** 从 JPEG2000 码流的 SIZ 段读出宽高 */
function jpxSize(buf: Buffer): { width: number; height: number } {
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0x51) {
      return {
        width: buf.readUInt32BE(i + 6) - buf.readUInt32BE(i + 14),
        height: buf.readUInt32BE(i + 10) - buf.readUInt32BE(i + 18)
      }
    }
  }
  throw new Error('JPEG2000 码流缺少 SIZ 段')
}

/**
 * 生成只含一张 JPEG2000(JPX) 图片、没有文字层的 PDF。
 * 真实扫描件常用 JPX / JBIG2 编码，解码依赖 pdfjs 的 wasmUrl，
 * 缺了它整页会静默渲染成空白——这是最难排查的一类故障，必须有回归用例守着。
 * 样本取自 openjpeg-data 一致性用例 p0_02.j2k（BSD-2-Clause）。
 */
function jpxPdf(j2k: Buffer): Buffer {
  const { width, height } = jpxSize(j2k)
  const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q'
  const chunks: Buffer[] = []
  const offsets: number[] = []
  let pos = 0
  const add = (buf: Buffer): void => { offsets.push(pos); chunks.push(buf); pos += buf.length }
  const t = (s: string): Buffer => Buffer.from(s, 'latin1')

  add(t('%PDF-1.4\n'))
  add(t('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n'))
  add(t('2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n'))
  add(t('3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>\nendobj\n'))
  add(t(`4 0 obj\n<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/JPXDecode/Length ${j2k.length}>>\nstream\n`))
  add(j2k)
  add(t('\nendstream\nendobj\n'))
  add(t(`5 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`))

  const objOffsets = [offsets[1], offsets[2], offsets[3], offsets[4], offsets[7]]
  const xrefPos = pos
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (const o of objOffsets) xref += String(o).padStart(10, '0') + ' 00000 n \n'
  xref += `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`
  return Buffer.concat([...chunks, t(xref)])
}

export async function studyTests(test: Test): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'suishou-study-tests-'))
  const db = getDb()
  const created: string[] = []
  const write = (name: string, data: string | Buffer): string => {
    const file = join(dir, name)
    writeFileSync(file, data)
    return file
  }

  await test('v11 迁移建立扫描件识别相关表', () => {
    assert.equal(db.pragma('user_version', { simple: true }), 15)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'study_%'").all() as { name: string }[])
      .map(r => r.name).sort()
    assert.deepEqual(tables, ['study_analyses', 'study_analysis_calls', 'study_chapters', 'study_documents', 'study_goals', 'study_ocr_runs', 'study_pages', 'study_topics'])
    const cols = (db.prepare("SELECT name FROM pragma_table_info('study_documents')").all() as { name: string }[]).map(c => c.name)
    assert.ok(cols.includes('ocr_state'), '学习资料表应带上识别状态列')
  })

  await test('txt 文件解析出页数与字数', async () => {
    const file = write('notes.txt', '第一章 函数\n函数是映射关系。\n第二章 极限\n极限描述趋近。')
    const doc = await study.registerFile(file)
    created.push(doc.id)
    assert.equal(doc.status, 'registered')
    assert.equal(doc.ext, 'txt')
    const parsed = await study.parseDocument(doc.id)
    assert.equal(parsed.status, 'parsed')
    assert.equal(parsed.pageCount, 1)
    assert.ok(parsed.charCount > 10, `charCount=${parsed.charCount}`)
    assert.ok(parsed.parser.startsWith('plain-text'))
  })

  await test('md 标题层级被识别', async () => {
    const file = write('outline.md', '# 第三章 导数\n## 3.1 定义\n导数描述变化率。')
    const doc = await study.registerFile(file)
    created.push(doc.id)
    const extracted = await extractStudyFile(file, 'md')
    assert.deepEqual(extracted.pages[0].lines.map(l => l.level), [1, 2, 0])
    assert.equal((await study.parseDocument(doc.id)).status, 'parsed')
  })

  await test('PDF 抽取文字、字号与坐标', async () => {
    const file = write('chapter.pdf', minimalPdf(['Chapter 1 Limits', 'Definition of a limit.', 'Limits describe approach behavior.']))
    const doc = await study.registerFile(file)
    created.push(doc.id)
    const parsed = await study.parseDocument(doc.id)
    assert.equal(parsed.status, 'parsed', `解析失败原因：${parsed.lastError}`)
    assert.equal(parsed.pageCount, 1)
    assert.ok(parsed.parser.startsWith('pdfjs-'))
    const extracted = await extractStudyFile(file, 'pdf')
    const first = extracted.pages[0].lines[0]
    assert.match(first.text, /Chapter 1 Limits/)
    assert.equal(first.size, 24)
    assert.ok(first.y > 700, `y=${first.y}`)
  })

  await test('无文字 PDF 判为扫描件并标记待识别', async () => {
    const file = write('scan.pdf', minimalPdf([]))
    const doc = await study.registerFile(file)
    created.push(doc.id)
    const parsed = await study.parseDocument(doc.id)
    assert.equal(parsed.status, 'failed')
    assert.equal(parsed.ocrState, 'needed')
    assert.match(parsed.lastError ?? '', /扫描版|没有可分析/)
    assert.equal(isLikelyScan(await extractStudyFile(file, 'pdf'), 'pdf'), true)
  })

  await test('拒绝不支持的扩展名与不存在的文件', async () => {
    const image = write('picture.png', 'not a document')
    await assert.rejects(() => study.registerFile(image), /仅支持/)
    await assert.rejects(() => study.registerFile(join(dir, 'missing.pdf')), /不存在|无法访问/)
  })

  await test('同路径同内容重复登记不产生新记录', async () => {
    const file = write('same.txt', '重复内容测试文本。')
    const first = await study.registerFile(file)
    created.push(first.id)
    const second = await study.registerFile(file)
    assert.equal(first.id, second.id)
    assert.equal(study.listDocuments().filter(d => d.path === first.path).length, 1)
  })

  await test('同路径内容变化后登记为新记录并清理旧记录', async () => {
    const file = write('changing.txt', '第一版内容。')
    const first = await study.registerFile(file)
    writeFileSync(file, '第二版内容，长度与上一版不同。')
    const second = await study.registerFile(file)
    created.push(second.id)
    assert.notEqual(first.id, second.id)
    assert.equal(study.getDocument(first.id), null)
  })

  await test('源文件丢失时解析记录明确失败', async () => {
    const file = write('gone.txt', '稍后会被删除。')
    const doc = await study.registerFile(file)
    created.push(doc.id)
    rmSync(file)
    const parsed = await study.parseDocument(doc.id)
    assert.equal(parsed.status, 'failed')
    assert.match(parsed.lastError ?? '', /不可访问/)
  })

  await test('删除记录只清库、不动原文件', async () => {
    const file = write('keep.txt', '保留原文件。')
    const doc = await study.registerFile(file)
    study.removeDocument(doc.id)
    assert.equal(study.getDocument(doc.id), null)
    assert.equal(existsSync(file), true)
  })

  // ===== 扫描件识别：渲染 + 转录 + 结果复用 =====
  const scanFile = write('scanned-chapter.pdf', inkedPdf())
  const scanDoc = await study.registerFile(scanFile)
  created.push(scanDoc.id)
  await study.parseDocument(scanDoc.id)
  let transcribeCalls = 0

  await test('扫描件识别后落库并回填字数', async () => {
    assert.equal(study.getDocument(scanDoc.id)?.ocrState, 'needed')
    const result = await ocr.ocrDocument(scanDoc.id, {
      transcribe: async (png, pageNo) => {
        transcribeCalls++
        assert.ok(png.length > 500, `渲染图过小：${png.length}`)
        return `第 ${pageNo} 页正文：导数的定义是差商的极限。`
      }
    })
    assert.equal(result.recognized, 1)
    assert.equal(result.skipped, 0)
    assert.equal(transcribeCalls, 1)
    assert.equal(result.document.ocrState, 'done')
    assert.equal(result.document.status, 'parsed')
    assert.ok(result.document.charCount > 0, `charCount=${result.document.charCount}`)
    assert.match(result.document.parser, /^ocr-/)
    assert.match(ocr.loadDocumentText(scanDoc.id), /导数的定义/)
    assert.match(result.preview, /导数的定义/, '结果应带首段预览，便于判断识别质量')
  })

  await test('重复识别命中缓存，不再调用模型', async () => {
    const before = transcribeCalls
    const again = await ocr.ocrDocument(scanDoc.id, {
      transcribe: async () => { transcribeCalls++; return '不该被调用' }
    })
    assert.equal(again.recognized, 0)
    assert.equal(again.skipped, 1)
    assert.equal(transcribeCalls, before, '已识别的页不应再次请求模型')
  })

  await test('历史空识别记录不挡路，可重新识别', async () => {
    const file = write('stale-empty.pdf', inkedPdf())
    const doc = await study.registerFile(file)
    created.push(doc.id)
    await study.parseDocument(doc.id)
    // 复现修复前的坏状态：渲染失败留下"有记录但正文为空"，却被标成已识别
    const db = getDb()
    db.prepare(`INSERT INTO study_pages(doc_id,page_no,text,source,engine,ink_ratio,latency_ms,created_at) VALUES(?,?,?,'ocr','pdfjs',0,0,?)`)
      .run(doc.id, 1, '', new Date().toISOString())
    db.prepare(`UPDATE study_documents SET status='parsed',ocr_state='done',char_count=0 WHERE id=?`).run(doc.id)

    const reparsed = await study.parseDocument(doc.id)
    assert.equal(reparsed.ocrState, 'needed', '空记录不应被当成已识别')
    assert.equal(reparsed.status, 'failed')
    assert.match(reparsed.lastError ?? '', /没有文字层|扫描/)

    let calls = 0
    const result = await ocr.ocrDocument(doc.id, {
      transcribe: async () => { calls++; return '重新识别出的正文：极限与连续。' }
    })
    assert.equal(calls, 1, '空页不应命中缓存，必须重新识别')
    assert.equal(result.recognized, 1)
    assert.ok(result.document.charCount > 0, `charCount=${result.document.charCount}`)
    assert.equal(result.document.ocrState, 'done')
  })

  await test('部分识别后仍能报出已识别页数，不被当成整本完成', async () => {
    const file = write('partial-book.pdf', inkedPdf(3))
    const doc = await study.registerFile(file)
    created.push(doc.id)
    await study.parseDocument(doc.id)
    await ocr.ocrDocument(doc.id, { fromPage: 1, toPage: 2, transcribe: async (_png, pageNo) => `第 ${pageNo} 页正文` })
    const after = await study.parseDocument(doc.id)
    assert.equal(after.pageCount, 3)
    assert.equal(after.recognizedPages, 2, '已识别页数要能被界面读到')
    assert.ok(after.recognizedPages < after.pageCount, '必须能判断出这是部分完成，而不是整本')
    assert.equal(after.ocrState, 'done')
  })

  await test('页码越界自动收敛到实际页数', async () => {
    const result = await ocr.ocrDocument(scanDoc.id, { fromPage: 5, toPage: 99, transcribe: async () => 'x' })
    assert.equal(result.total, 1)
    assert.equal(result.document.pageCount, 1)
  })

  await test('非 PDF 不进入识别流程', async () => {
    const file = write('note-for-ocr.txt', '文本文件不需要识别。')
    const doc = await study.registerFile(file)
    created.push(doc.id)
    await assert.rejects(() => ocr.ocrDocument(doc.id), /只有 PDF/)
  })

  await test('整页空白不调用模型且不算识别成功', async () => {
    const file = write('blank-scan.pdf', minimalPdf([]))
    const doc = await study.registerFile(file)
    created.push(doc.id)
    await study.parseDocument(doc.id)
    let calls = 0
    const result = await ocr.ocrDocument(doc.id, {
      transcribe: async () => { calls++; return '模型不该看到空白页' }
    })
    assert.equal(calls, 0, '空白页应跳过模型调用')
    assert.equal(result.document.ocrState, 'failed')
    // 整份空白时要指向"可能是编码解不开"，而不是笼统说没有文字
    assert.match(result.document.lastError ?? '', /渲染后都是空白/)
  })

  await test('识别文本归一：去代码围栏与客套话', () => {
    assert.equal(ocr.normalizeOcrText('以下是识别结果：\n第一章 极限'), '第一章 极限')
    assert.equal(ocr.normalizeOcrText('```text\n正文内容\n```'), '正文内容')
    assert.equal(ocr.normalizeOcrText('   \n\n'), '')
  })

  await test('多页扫描件按范围识别并可断点续跑', async () => {
    const file = write('scan-3p.pdf', inkedPdf(3))
    const doc = await study.registerFile(file)
    created.push(doc.id)
    const parsed = await study.parseDocument(doc.id)
    assert.equal(parsed.pageCount, 3)
    assert.equal(parsed.ocrState, 'needed')

    const visited: number[] = []
    const first = await ocr.ocrDocument(doc.id, {
      fromPage: 1,
      toPage: 2,
      transcribe: async (_png, pageNo) => { visited.push(pageNo); return `第 ${pageNo} 页内容` }
    })
    assert.deepEqual([...visited].sort((a, b) => a - b), [1, 2])
    assert.equal(first.total, 2)
    assert.equal(first.recognized, 2)

    // 续跑：接上被跳过的第 3 页，前两页不再请求模型
    const second = await ocr.ocrDocument(doc.id, {
      fromPage: 1,
      toPage: 3,
      transcribe: async (_png, pageNo) => { visited.push(pageNo); return `第 ${pageNo} 页内容` }
    })
    assert.equal(second.skipped, 2)
    assert.equal(second.recognized, 1)
    assert.deepEqual([...visited].sort((a, b) => a - b), [1, 2, 3])
    assert.match(ocr.loadDocumentText(doc.id), /第 3 页内容/)
    assert.equal(ocr.countRecognizedPages(doc.id), 3)
  })

  await test('识别中取消保留已经完成的页，重试只补未完成页', async () => {
    const doc = await study.registerFile(write('cancel-5p.pdf', inkedPdf(5))); created.push(doc.id); await study.parseDocument(doc.id)
    let calls = 0
    const first = await ocr.ocrDocument(doc.id, { transcribe: async (_image, page) => { if (++calls === 1) ocr.cancelOcr(doc.id); return `取消前已识别的第${page}页正文` } })
    assert.equal(first.cancelled, true);assert.ok(first.recognized > 0 && first.recognized < 5)
    const cached = ocr.listOcrPages(doc.id).map(p => p.page), visited: number[] = []
    const second = await ocr.ocrDocument(doc.id, { transcribe: async (_image, page) => { visited.push(page); return `恢复后识别的第${page}页正文` } })
    assert.equal(second.skipped,cached.length);assert.equal(second.document.recognizedPages,5)
    assert.ok(visited.every(page=>!cached.includes(page)));assert.equal(second.document.firstMissingPage,null)
  })
  await test('单页接口失败保留其他页，缺页可定位并在重试时独立补齐', async () => {
    const doc = await study.registerFile(write('partial-3p.pdf', inkedPdf(3))); created.push(doc.id); await study.parseDocument(doc.id)
    const first = await ocr.ocrDocument(doc.id, { transcribe: async (_image, page) => { if(page===2)throw Error('429 模拟限流');return `已识别第${page}页正文` } })
    assert.equal(first.document.recognizedPages,2);assert.equal(first.document.firstMissingPage,2)
    const visited:number[]=[]
    const second=await ocr.ocrDocument(doc.id,{transcribe:async(_image,page)=>{visited.push(page);return `已恢复第${page}页正文`}})
    assert.deepEqual(visited,[2]);assert.equal(second.skipped,2);assert.equal(second.document.firstMissingPage,null)
  })
  await test('JPEG2000 扫描件能解码渲染（守护 wasmUrl）', async () => {
    const j2k = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'sample-jpx.j2k'))
    const file = write('scan-jpx.pdf', jpxPdf(j2k))
    const handle = await openPdf(file)
    try {
      const shot = await ocr.renderPageToPng(handle, 1)
      // 缺 wasmUrl 时 JPX 解码失败，整页会被画成纯白，墨迹比例接近 0
      assert.ok(shot.inkRatio > 0.5, `JPX 页渲染为空白（inkRatio=${shot.inkRatio}），检查 pdfjs 的 wasmUrl 是否传入`)
      assert.ok(shot.png.length > 1000, `渲染图过小：${shot.png.length}`)
    } finally {
      await handle.dispose()
    }
  })

  await test('视觉请求体携带 data URL 图片', () => {
    const part = imageDataUrl(Buffer.from([1, 2, 3]), 'image/png')
    assert.equal(part.type, 'image_url')
    assert.equal(part.image_url.url, 'data:image/png;base64,AQID')
    // 模型不支持图片时，报错要翻译成可行动的提示
    assert.match(ocr.visionErrorMessage(new Error('HTTP 400 invalid content type'), 'deepseek-chat'), /不支持图片输入/)
    assert.equal(ocr.visionErrorMessage(new Error('网络错误'), 'deepseek-chat'), '网络错误')
  })

  // ===== 模型读取教材：文字层与 OCR 共用 study_pages =====
  await test('文字版 PDF 解析后按页落库，模型可直接读取', async () => {
    const file = write('textbook-text.pdf', minimalPdf(['Chapter 1 Limits', 'Definition of a limit is the value.']))
    const doc = await study.registerFile(file)
    created.push(doc.id)
    const parsed = await study.parseDocument(doc.id)
    assert.equal(parsed.recognizedPages, 1, '文字层页也要写入 study_pages，否则模型读不到')
    const listed = reader.listForAgent().find(d => d.docId === doc.id)
    assert.ok(listed?.readable, '应标记为可读')
    const got = reader.readForAgent(doc.id, 1, 1)
    assert.equal(got.ok, true)
    const data = got.data as { pages: { page: number; text: string }[] }
    assert.equal(data.pages[0].page, 1)
    assert.match(data.pages[0].text, /Limits/)
  })

  await test('读取未识别页与不存在的资料会明确拒绝，不返回空内容', async () => {
    const file = write('reader-book.pdf', inkedPdf(2))
    const doc = await study.registerFile(file)
    created.push(doc.id)
    await study.parseDocument(doc.id)
    const listed = reader.listForAgent().find(d => d.docId === doc.id)
    assert.equal(listed?.readable, false)
    assert.match(listed?.hint ?? '', /识别/)

    const none = reader.readForAgent(doc.id, 1, 2)
    assert.equal(none.ok, false)
    assert.equal(none.errorCode, 'NO_TEXT')

    await ocr.ocrDocument(doc.id, { fromPage: 1, toPage: 1, transcribe: async () => '第 1 页：偏导数与全微分' })
    const one = reader.readForAgent(doc.id, 1, 2)
    assert.equal(one.ok, true)
    const data = one.data as { pages: { page: number; text: string }[]; nextPage: number | null }
    assert.equal(data.pages.length, 1)
    assert.equal(data.nextPage, 2, '下一段应从第 2 页继续')
    assert.equal(reader.readForAgent(doc.id, 2, 2).errorCode, 'NO_TEXT')

    const missing = reader.readForAgent('no-such-doc', 1, 1)
    assert.equal(missing.ok, false)
    assert.equal(missing.errorCode, 'NOT_FOUND')
  })

  await test('单次读取受字符预算限制并给出续读页码', async () => {
    const body = Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 段：` + '多元函数微分学的应用。'.repeat(120)).join('\n')
    const file = write('long-note.md', body)
    const doc = await study.registerFile(file)
    created.push(doc.id)
    await study.parseDocument(doc.id)
    const got = reader.readForAgent(doc.id, 1, 12)
    assert.equal(got.ok, true)
    const data = got.data as { chars: number; truncated: boolean; nextPage: number | null }
    assert.ok(data.chars <= 5000, `单次返回超预算：${data.chars}`)
    assert.equal(data.truncated, true)
    assert.ok((data.nextPage ?? 0) > 1, '被截断时必须告诉模型从哪页继续')
  })

  await test('教材工具已注册且规划场景可用', () => {
    const names = definitionsForScene('planning').map(d => d.function.name)
    assert.ok(names.includes('get_study_documents'))
    assert.ok(names.includes('read_study_pages'))
    const result = executeTool('get_study_documents', '{}', { observed: new Map() })
    assert.equal(result.ok, true)
    const docs = (result.data as { documents: { docId: string }[] }).documents
    assert.ok(docs.length > 0)
    assert.ok(executeTool('read_study_pages', '{"docId":"x"}', { observed: new Map() }).ok === false, '缺页码必须拒绝')
  })

  await test('识别前源文件已变化时拒绝，避免继续使用旧缓存',async()=>{
    const file=write('changed-before-ocr.pdf',inkedPdf()),doc=await study.registerFile(file);created.push(doc.id);await study.parseDocument(doc.id)
    writeFileSync(file,minimalPdf(['New source']))
    let calls=0;await assert.rejects(()=>ocr.ocrDocument(doc.id,{transcribe:async()=>{calls++;return 'old'}}),/变化/);assert.equal(calls,0)
  })
  await test('识别在途重新解析新版本，旧结果不覆盖新正文或解析状态',async()=>{
    const file=write('changed-during-ocr.pdf',inkedPdf()),doc=await study.registerFile(file);created.push(doc.id);await study.parseDocument(doc.id)
    await assert.rejects(()=>ocr.ocrDocument(doc.id,{transcribe:async()=>{
      writeFileSync(file,minimalPdf(['New verified source','Matrix rank and linear algebra. '.repeat(12)]));await study.parseDocument(doc.id);return 'STALE OCR'
    }}),/变化/)
    const current=study.getDocument(doc.id)!;assert.equal(current.status,'parsed');assert.doesNotMatch(current.parser,/ocr-/);assert.doesNotMatch(ocr.loadDocumentText(doc.id),/STALE/);assert.match(ocr.loadDocumentText(doc.id),/New verified source/)
  })
  for (const id of created) study.removeDocument(id)
  rmSync(dir, { recursive: true, force: true })
}
