/**
 * PPTX テキスト抽出（バッチ7f: AI タスク添付の .pptx 対応）。
 * jszip で最小構成の pptx を組み立て、スライド順のテキスト抽出と XML エンティティ復元を検証する
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { extractDocumentText } from '../../src/lib/extract-text'

function slideXml(texts: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
    + texts.map(t => `<a:t>${t}</a:t>`).join('<a:t> </a:t>')
    + `</p:sld>`
}

async function buildPptx(slides: string[][]): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
  slides.forEach((texts, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(texts))
  })
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('extractDocumentText (.pptx)', () => {
  it('スライド番号順にテキストを抽出する（slide10 が slide2 の後）', async () => {
    const bytes = await buildPptx([
      ['1枚目の見出し', '本文A'],
      ['2枚目', '本文B'],
      ...Array.from({ length: 8 }, (_, i) => [`${i + 3}枚目`]),
    ])
    const text = await extractDocumentText('pptx', bytes)
    expect(text).toContain('1枚目の見出し')
    expect(text!.indexOf('2枚目')).toBeGreaterThan(text!.indexOf('1枚目の見出し'))
    expect(text!.indexOf('10枚目')).toBeGreaterThan(text!.indexOf('9枚目'))
  })

  it('XML エンティティ（&amp; &lt; &#x4E00; 等）を復元する', async () => {
    const bytes = await buildPptx([['A&amp;B &lt;比較&gt; &#x4E00;&#38911;']])
    const text = await extractDocumentText('pptx', bytes)
    expect(text).toContain('A&B <比較> 一響')
  })

  it('壊れた zip は null（呼び出し側がフェイルオープンで原本のみ保全）', async () => {
    expect(await extractDocumentText('pptx', Buffer.from('not a zip'))).toBeNull()
  })
})
