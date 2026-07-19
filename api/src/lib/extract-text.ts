/**
 * ドキュメントからのテキスト抽出（ナレッジ/ノート取込 = .md/.txt/.pdf/.docx、AI タスク添付 = + .pptx）。
 * - PDF: pdfjs-dist（公式 legacy ビルド。旧 pdf-parse は Node 22 で動作しないため不採用）。
 *   日本語 PDF の CMap・標準フォントはパッケージ同梱データをファイルパスで供給する
 * - DOCX: mammoth（extractRawText）。旧 .doc は非対応（呼び出し側で案内）
 * - PPTX: jszip でスライド XML（ppt/slides/slideN.xml）を読み、<a:t> のテキストを順に抽出（バッチ7f）
 * - 失敗は null を返し、呼び出し側が AKO-KNW-003 等を返す（画像のみの PDF 等）
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'))

async function extractPdf(bytes: Buffer): Promise<string> {
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    cMapUrl: `${PDFJS_DIR}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_DIR}/standard_fonts/`,
  }).promise
  try {
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      pages.push(tc.items.map(it => ('str' in it ? it.str : '')).join(' '))
    }
    return pages.join('\n')
  } finally {
    await doc.destroy()
  }
}

/** XML の数値/基本エンティティを戻す（pptx の <a:t> 内テキスト用。1 パス置換 = &amp;lt; の二重復号を防ぐ） */
function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (_, ent: string) => {
    const e = ent.toLowerCase()
    if (e.startsWith('#x') || e.startsWith('#')) {
      const cp = e.startsWith('#x') ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      // 範囲外（> U+10FFFF）は fromCodePoint が throw し外側 catch で全損するため、当該エンティティのみ落とす
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : ''
    }
    return { lt: '<', gt: '>', quot: '"', apos: '\'', amp: '&' }[e] ?? ''
  })
}

// zip 爆弾対策（入口の 10MB 制限は「圧縮後」サイズのみ = deflate は最大 ~1000 倍まで伸長し得る）。
// 抽出テキストの累積上限で打ち切り、スライド数にも上限を置く（呼び出し側の cap より十分大きい値）
const PPTX_TEXT_CAP = 100_000
const PPTX_MAX_SLIDES = 300
const MAX_SLIDE_XML_BYTES = 20 * 1024 * 1024 // 1 スライド XML の伸長上限（超過エントリはスキップ）

async function extractPptx(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  // スライド番号順（slide1.xml, slide2.xml, ...）。ノート（notesSlides）は対象外の設計判断
  const slideNames = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
    .slice(0, PPTX_MAX_SLIDES)
  const slides: string[] = []
  let total = 0
  for (const name of slideNames) {
    // エントリ単位の伸長サイズ事前チェック（1 スライドが数 GB へ伸長する zip 爆弾は伸長前にスキップ。
    // uncompressedSize は zip セントラルディレクトリ由来 = jszip 内部フィールドを参照する設計判断）
    const entry = zip.files[name]! as unknown as { _data?: { uncompressedSize?: number } }
    const inflated = entry._data?.uncompressedSize
    if (typeof inflated === 'number' && inflated > MAX_SLIDE_XML_BYTES) continue
    const xml = await zip.files[name]!.async('string')
    const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map(m => decodeXmlEntities(m[1] ?? ''))
    const body = texts.join(' ').trim()
    if (body) {
      slides.push(body.length > PPTX_TEXT_CAP - total ? body.slice(0, PPTX_TEXT_CAP - total) : body)
      total += body.length
      if (total >= PPTX_TEXT_CAP) break
    }
  }
  return slides.join('\n')
}

/** 拡張子ごとのテキスト抽出（対応外・失敗は null） */
export async function extractDocumentText(ext: string, bytes: Buffer): Promise<string | null> {
  try {
    if (ext === 'md' || ext === 'txt') {
      return bytes.toString('utf8').replace(/^﻿/, '') // BOM 除去
    }
    if (ext === 'pdf') return await extractPdf(bytes)
    if (ext === 'docx') {
      const result = await mammoth.extractRawText({ buffer: bytes })
      return result.value
    }
    if (ext === 'pptx') return await extractPptx(bytes)
    return null
  } catch (e) {
    console.warn('document text extract failed:', (e as Error).message)
    return null
  }
}
