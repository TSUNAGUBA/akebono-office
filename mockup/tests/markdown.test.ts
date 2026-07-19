import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from '../app/utils/markdown'

describe('markdown パーサ（バッチ7e: 安全なサブセット）', () => {
  it('見出し・箇条書き・番号リスト・引用・水平線を分解する', () => {
    const blocks = parseMarkdown('# 議題\n- 決定事項A\n- 決定事項B\n1. 手順1\n2. 手順2\n> 引用行\n---')
    expect(blocks.map(b => b.t)).toEqual(['heading', 'ul', 'ol', 'quote', 'hr'])
    expect(blocks[0]).toMatchObject({ t: 'heading', level: 1 })
    expect(blocks[1]).toMatchObject({ items: [[{ t: 'text', text: '決定事項A' }], [{ t: 'text', text: '決定事項B' }]] })
  })

  it('コードブロックは中身をそのまま保持し、終端なしでも EOF で閉じる', () => {
    const blocks = parseMarkdown('```\nconst a = 1\n**強調されない**\n```\n本文')
    expect(blocks[0]).toEqual({ t: 'codeblock', code: 'const a = 1\n**強調されない**' })
    expect(blocks[1]!.t).toBe('paragraph')
    expect(parseMarkdown('```\n閉じない')[0]).toEqual({ t: 'codeblock', code: '閉じない' })
  })

  it('インライン: 太字・斜体・コード・リンクを分解する', () => {
    expect(parseInline('**太字**と*斜体*と`code`')).toEqual([
      { t: 'bold', text: '太字' },
      { t: 'text', text: 'と' },
      { t: 'italic', text: '斜体' },
      { t: 'text', text: 'と' },
      { t: 'code', text: 'code' },
    ])
    expect(parseInline('[社内リンク](https://example.com/a?b=1)')).toEqual([
      { t: 'link', text: '社内リンク', href: 'https://example.com/a?b=1' },
    ])
  })

  it('安全性: 生 HTML はテキストのまま・javascript: リンクは記法として成立しない', () => {
    // HTML タグはインライン記法に一致せず text として保持される（描画側は VNode 直接生成 = v-html 不使用）
    expect(parseInline('<script>alert(1)</script>')).toEqual([{ t: 'text', text: '<script>alert(1)</script>' }])
    // http(s) 以外のスキームはリンク化しない
    const nodes = parseInline('[x](javascript:alert(1))')
    expect(nodes.some(n => n.t === 'link')).toBe(false)
  })

  it('パラグラフは連続行をまとめ、空行で区切る（改行は行単位で保持）', () => {
    const blocks = parseMarkdown('1行目\n2行目\n\n次の段落')
    expect(blocks.length).toBe(2)
    expect(blocks[0]).toMatchObject({ t: 'paragraph', lines: [[{ t: 'text', text: '1行目' }], [{ t: 'text', text: '2行目' }]] })
  })

  it('##### 以上の見出しは h4 に丸める', () => {
    expect(parseMarkdown('##### 深い見出し')[0]).toMatchObject({ t: 'heading', level: 4 })
  })
})
