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

/** XML の数値/基本エンティティを戻す（pptx の <a:t> 内テキスト用） */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'').replace(/&amp;/g, '&')
}

async function extractPptx(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  // スライド番号順（slide1.xml, slide2.xml, ...）。ノート（notesSlides）は対象外の設計判断
  const slideNames = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
  const slides: string[] = []
  for (const name of slideNames) {
    const xml = await zip.files[name]!.async('string')
    const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map(m => decodeXmlEntities(m[1] ?? ''))
    const body = texts.join(' ').trim()
    if (body) slides.push(body)
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
