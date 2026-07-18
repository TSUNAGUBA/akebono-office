/**
 * ドキュメントからのテキスト抽出（ナレッジ取込 = .md/.txt/.pdf/.docx）。
 * - PDF: pdfjs-dist（公式 legacy ビルド。旧 pdf-parse は Node 22 で動作しないため不採用）。
 *   日本語 PDF の CMap・標準フォントはパッケージ同梱データをファイルパスで供給する
 * - DOCX: mammoth（extractRawText）。旧 .doc は非対応（呼び出し側で案内）
 * - 失敗は null を返し、呼び出し側が AKO-KNW-003 を返す（画像のみの PDF 等）
 */
import { createRequire } from 'node:module'
import path from 'node:path'
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
    return null
  } catch (e) {
    console.warn('document text extract failed:', (e as Error).message)
    return null
  }
}
