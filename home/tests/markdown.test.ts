import { describe, expect, it } from 'vitest'
import { linkifyRoutes, parseInline, parseMarkdown } from '../app/utils/markdown'

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

  it('インライン: 太字・コード・リンクを分解する', () => {
    expect(parseInline('**太字**と`code`')).toEqual([
      { t: 'bold', text: '太字' },
      { t: 'text', text: 'と' },
      { t: 'code', text: 'code' },
    ])
    expect(parseInline('[社内リンク](https://example.com/a?b=1)')).toEqual([
      { t: 'link', text: '社内リンク', href: 'https://example.com/a?b=1' },
    ])
    // URL 中の丸括弧は 1 段まで許容（末尾の ) で切れない）
    expect(parseInline('[t](https://ex.com/a(b)c)')).toEqual([
      { t: 'link', text: 't', href: 'https://ex.com/a(b)c' },
    ])
  })

  it('孤立した * は整形しない（既存プレーン文の保護 = 単独アスタリスク斜体は非対応）', () => {
    // 「3*4 と 5*6」のような文で * 同士がクロスマッチして斜体化しない
    expect(parseInline('3*4 と 5*6')).toEqual([{ t: 'text', text: '3*4 と 5*6' }])
    // 孤立 * があっても後続の太字は正しく分解される
    expect(parseInline('3*4 と **強調**')).toEqual([
      { t: 'text', text: '3*4 と ' },
      { t: 'bold', text: '強調' },
    ])
    expect(parseInline('*斜体記法は非対応*')).toEqual([{ t: 'text', text: '*斜体記法は非対応*' }])
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

  it('番号リストは開始番号を保持し、空のリスト項目はスキップする', () => {
    expect(parseMarkdown('3. 三\n4. 四')[0]).toMatchObject({ t: 'ol', start: 3 })
    expect(parseMarkdown('1. 一\n2. 二')[0]).toMatchObject({ t: 'ol', start: 1 })
    // 本文のない項目（「- 」だけの行）は空 li にしない。全項目が空ならブロック自体を出さない
    expect(parseMarkdown('- 有効\n- \n- 有効2')[0]).toMatchObject({
      t: 'ul', items: [[{ t: 'text', text: '有効' }], [{ t: 'text', text: '有効2' }]],
    })
    expect(parseMarkdown('- \n本文').map(b => b.t)).toEqual(['paragraph'])
  })
})

describe('パイプテーブル + ルートリンク化（AI チャット対応 2026-08-20）', () => {
  it('ヘッダー + 区切り行 + 本体行をテーブルに分解する（外側パイプ除去・セル trim・インライン記法対応）', () => {
    const blocks = parseMarkdown('| 項目 | **値** |\n|---|:---:|\n| 有給 | 10 日 |\n| 残業 | `5h` |')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      t: 'table',
      header: [[{ t: 'text', text: '項目' }], [{ t: 'bold', text: '値' }]],
      rows: [
        [[{ t: 'text', text: '有給' }], [{ t: 'text', text: '10 日' }]],
        [[{ t: 'text', text: '残業' }], [{ t: 'code', text: '5h' }]],
      ],
    })
  })

  it('区切り行のないパイプ行はテーブルにせずパラグラフへフェイルオープン（本文中の | を壊さない）', () => {
    expect(parseMarkdown('| これは表ではない |').map(b => b.t)).toEqual(['paragraph'])
    expect(parseMarkdown('A | B のような本文').map(b => b.t)).toEqual(['paragraph'])
  })

  it('ヘッダーと区切り行のセル数不一致はテーブルにしない（GFM 同様 = レビュー R2。水平線は hr のまま）', () => {
    expect(parseMarkdown('| a | b |\n---\n本文').map(b => b.t)).toEqual(['paragraph', 'hr', 'paragraph'])
    expect(parseMarkdown('| a | b |\n| --- |\n| 1 | 2 |').map(b => b.t)).toEqual(['paragraph'])
    // 単一列はセル数が一致するため表になる（GitHub の描画と同じ）
    expect(parseMarkdown('| a |\n|---|\n| 1 |').map(b => b.t)).toEqual(['table'])
  })

  it('パラグラフ中にテーブルが始まったらパラグラフを区切ってテーブルとして分解する', () => {
    const blocks = parseMarkdown('前置きの文\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(blocks.map(b => b.t)).toEqual(['paragraph', 'table'])
  })

  it('本体中のダッシュ行（| - | - |）は通常セルとして扱い表を分断しない（レビュー R1 回帰）', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n| - | - |\n| 3 | 4 |')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      t: 'table',
      rows: [
        [[{ t: 'text', text: '1' }], [{ t: 'text', text: '2' }]],
        [[{ t: 'text', text: '-' }], [{ t: 'text', text: '-' }]],
        [[{ t: 'text', text: '3' }], [{ t: 'text', text: '4' }]],
      ],
    })
  })

  it('本体行のセル数はヘッダーに正規化する（不足は空セル・超過は切詰め = GFM と同じ）', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |')
    expect(blocks[0]).toMatchObject({
      t: 'table',
      rows: [
        [[{ t: 'text', text: '1' }], []],
        [[{ t: 'text', text: '2' }], [{ t: 'text', text: '3' }]],
      ],
    })
  })

  it('linkifyRoutes は許可リストのパスだけを route ノード化する（最長一致・非破壊・リスト/表の中も対象）', () => {
    const routes = { '/attendance': '勤怠管理', '/support/documents': 'ドキュメント管理' }
    const src = parseMarkdown('- 詳細は /attendance を確認\n\n/support/documents と /unknown はどうか')
    const linked = linkifyRoutes(src, routes)
    expect(linked[0]).toMatchObject({
      t: 'ul',
      items: [[
        { t: 'text', text: '詳細は ' },
        { t: 'route', path: '/attendance', label: '勤怠管理' },
        { t: 'text', text: ' を確認' },
      ]],
    })
    expect(linked[1]).toMatchObject({
      t: 'paragraph',
      lines: [[
        { t: 'route', path: '/support/documents', label: 'ドキュメント管理' },
        { t: 'text', text: ' と /unknown はどうか' },
      ]],
    })
    // 非破壊: 元の AST は変わらない
    expect(src[0]).toMatchObject({ t: 'ul', items: [[{ t: 'text', text: '詳細は /attendance を確認' }]] })
  })

  it('linkifyRoutes はコードブロック・インラインコードの中はリンク化しない', () => {
    const routes = { '/attendance': '勤怠管理' }
    const linked = linkifyRoutes(parseMarkdown('```\n/attendance\n```\n\n`/attendance` はコード'), routes)
    expect(linked[0]).toMatchObject({ t: 'codeblock', code: '/attendance' })
    expect(linked[1]).toMatchObject({ t: 'paragraph', lines: [[{ t: 'code', text: '/attendance' }, { t: 'text', text: ' はコード' }]] })
  })
})
