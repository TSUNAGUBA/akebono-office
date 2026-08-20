/**
 * マークダウンの安全なサブセットパーサ（バッチ7e・オペレーター指示 2026-07-19 #6）。
 * 議事録・日報・ぽいぽいポスト等のフリー入力文章を構造化して描画するための AST を返す。
 *
 * 設計判断:
 * - v-html を使わない（chatbot.vue と同じ規約）。HTML はエスケープではなく「そもそも生成しない」。
 *   生の HTML タグ（<script> 等）はただのテキストとして扱われるため XSS が構造的に成立しない
 * - 対応記法: 見出し(#〜####)・箇条書き(- または アスタリスク)・番号リスト(1.)・引用(>)・水平線(---)・
 *   コードブロック(```)・インラインコード(`)・強調(太字のみ)・リンク([t](https://…))・
 *   パイプテーブル(| a | b | + 区切り行。AI チャットの表回答対応 2026-08-20)
 * - 単独アスタリスクの斜体は**非対応**: `3*4 と 5*6` のような既存プレーン文で孤立した * 同士が
 *   クロスマッチして意図しない整形が起きるため（表示劣化 > 記法価値の判断。太字 ** は誤爆しない）
 * - リンクは http(s) のみ許可（javascript: 等のスキームは平文のまま）
 */

export type MdInline =
  | { t: 'text'; text: string }
  | { t: 'bold'; text: string }
  | { t: 'code'; text: string }
  | { t: 'link'; text: string; href: string }
  /** アプリ内ルートリンク（linkifyRoutes が生成。パーサ自身は生成しない = 呼び出し側の許可リスト限定） */
  | { t: 'route'; path: string; label: string }

export type MdBlock =
  | { t: 'heading'; level: 1 | 2 | 3 | 4; inline: MdInline[] }
  | { t: 'paragraph'; lines: MdInline[][] }
  | { t: 'ul'; items: MdInline[][] }
  | { t: 'ol'; items: MdInline[][]; start: number }
  | { t: 'quote'; lines: MdInline[][] }
  | { t: 'codeblock'; code: string }
  | { t: 'hr' }
  /** パイプテーブル（GFM 形式: ヘッダー行 + 区切り行 |---|。チャットボット対応 2026-08-20） */
  | { t: 'table'; header: MdInline[][]; rows: MdInline[][][] }

/** インライン記法の分解（太字 → コード → リンクの優先順で非貪欲に走査） */
export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = []
  // 1 パスの正規表現走査。一致しない部分は text として残す。
  // リンク URL は 1 段の丸括弧まで許容（https://ex.com/a(b)c 対応。空白と裸の ) は URL 終端）
  const re = /(\*\*([^*\n]+)\*\*)|(`([^`\n]+)`)|(\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\))/g
  let last = 0
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ t: 'text', text: src.slice(last, m.index) })
    if (m[2] !== undefined) out.push({ t: 'bold', text: m[2] })
    else if (m[4] !== undefined) out.push({ t: 'code', text: m[4] })
    else if (m[6] !== undefined && m[7] !== undefined) out.push({ t: 'link', text: m[6], href: m[7] })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ t: 'text', text: src.slice(last) })
  return out
}

/** リスト項目のインライン分解（本文が空の項目は null = 呼び出し側でスキップして空 li を作らない） */
function listItem(text: string): MdInline[] | null {
  return text.trim() === '' ? null : parseInline(text)
}

/** パイプテーブルの行か（`| a | b |`。先頭パイプ必須 = 本文中の `a | b` を誤爆させない） */
const tableRowRe = /^\s*\|.*\|\s*$/
/**
 * テーブルの区切り行か（`|---|:---:|`。- : | 空白のみで構成され - を含む）。
 * パイプなしの `---` にもマッチするが、isTableStart のセル数一致検査（GFM 同様）により
 * 複数列ヘッダー直後の水平線は区切り行にならずパラグラフ + hr のまま。単一列ヘッダー
 * `| a |` + `---` のみ 1 セル同士が一致してヘッダーのみの表になる（GitHub の描画と同じ = レビュー R2）
 */
const tableSepRe = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** テーブル行をセル文字列へ分解（外側のパイプを除去して | で分割。\| エスケープは非対応 = サブセット） */
function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
}

/** ブロック分解。未知の行はパラグラフとして素通し（フェイルオープン = 情報を落とさない） */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let i = 0
  /**
   * テーブルの開始位置か（ヘッダー行 + 直後に区切り行 + セル数一致。GFM と同じ判定 = レビュー R2。
   * 揃わなければパラグラフへフェイルオープン = 情報を落とさない）
   */
  const isTableStart = (at: number): boolean =>
    tableRowRe.test(lines[at] ?? '') && tableSepRe.test(lines[at + 1] ?? '')
    && tableCells(lines[at + 1]!).length === tableCells(lines[at]!).length
  while (i < lines.length) {
    const line = lines[i]!
    // コードブロック
    if (/^```/.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        buf.push(lines[i]!)
        i++
      }
      i++ // 終端の ``` をスキップ（無くても EOF で閉じる）
      blocks.push({ t: 'codeblock', code: buf.join('\n') })
      continue
    }
    // 空行はブロック区切り
    if (line.trim() === '') {
      i++
      continue
    }
    // 水平線
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    // 見出し（#〜####。##### 以上は #### に丸める）
    const hm = /^(#{1,6})\s+(.*)$/.exec(line)
    if (hm) {
      const level = Math.min(hm[1]!.length, 4) as 1 | 2 | 3 | 4
      blocks.push({ t: 'heading', level, inline: parseInline(hm[2]!) })
      i++
      continue
    }
    // 箇条書き（本文が空の項目はスキップ = 空 li を作らない）
    if (/^\s*[-*]\s+/.test(line)) {
      const items: MdInline[][] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        const item = listItem(lines[i]!.replace(/^\s*[-*]\s+/, ''))
        if (item) items.push(item)
        i++
      }
      if (items.length > 0) blocks.push({ t: 'ul', items })
      continue
    }
    // 番号リスト（開始番号を保持 = 「3. …」から始まるリストは 3 から描画）
    const om = /^\s*(\d+)[.)]\s+/.exec(line)
    if (om) {
      const start = Math.max(1, Number.parseInt(om[1]!, 10) || 1)
      const items: MdInline[][] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        const item = listItem(lines[i]!.replace(/^\s*\d+[.)]\s+/, ''))
        if (item) items.push(item)
        i++
      }
      if (items.length > 0) blocks.push({ t: 'ol', items, start })
      continue
    }
    // パイプテーブル（AI チャットの表回答対応 2026-08-20。ヘッダー + 区切り行の 2 行が揃うときのみ）。
    // 本体中のダッシュ行（| - | - | = 空セルのプレースホルダ）は通常セルとして扱う（GFM と同じ。
    // 区切り行と見なすのはヘッダー直後の 1 行のみ = レビュー R1: 表の途中分断を作らない）
    if (isTableStart(i)) {
      const header = tableCells(line).map(parseInline)
      i += 2 // ヘッダー + 区切り行
      const rows: MdInline[][][] = []
      while (i < lines.length && tableRowRe.test(lines[i]!)) {
        // セル数はヘッダーに合わせて正規化（不足は空セル・超過は切詰め = 罫線のガタつき防止。GFM と同じ）
        const cells = tableCells(lines[i]!).slice(0, header.length)
        while (cells.length < header.length) cells.push('')
        rows.push(cells.map(parseInline))
        i++
      }
      blocks.push({ t: 'table', header, rows })
      continue
    }
    // 引用
    if (/^\s*>\s?/.test(line)) {
      const qlines: MdInline[][] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        qlines.push(parseInline(lines[i]!.replace(/^\s*>\s?/, '')))
        i++
      }
      blocks.push({ t: 'quote', lines: qlines })
      continue
    }
    // パラグラフ（連続する通常行をまとめ、行ごとに改行を保持。テーブル開始行では区切る）
    const plines: MdInline[][] = []
    while (
      i < lines.length && lines[i]!.trim() !== ''
      && !/^```|^\s*[-*]\s+|^\s*\d+[.)]\s+|^\s*>\s?|^#{1,6}\s+|^\s*(---+|\*\*\*+)\s*$/.test(lines[i]!)
      && !isTableStart(i)
    ) {
      plines.push(parseInline(lines[i]!))
      i++
    }
    blocks.push({ t: 'paragraph', lines: plines })
  }
  return blocks
}

/**
 * アプリ内ルートのリンク化（AI チャット対応 2026-08-20）。text ノード中の許可リスト一致部分を
 * route ノードへ分解する（パーサ自身は内部リンクを生成しない = 呼び出し側が渡した paths のみ。
 * 最長一致優先 = /support/documents が /support より先に照合される）。非破壊（新しい AST を返す）
 */
export function linkifyRoutes(blocks: MdBlock[], routes: Record<string, string>): MdBlock[] {
  const paths = Object.keys(routes).sort((a, b) => b.length - a.length)
  if (paths.length === 0) return blocks
  const re = new RegExp(`(${paths.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join('|')})`, 'g')
  const mapInline = (nodes: MdInline[]): MdInline[] => nodes.flatMap((n) => {
    if (n.t !== 'text') return [n]
    return n.text.split(re).filter(p => p !== '').map((p): MdInline => {
      const label = routes[p]
      return label !== undefined ? { t: 'route', path: p, label } : { t: 'text', text: p }
    })
  })
  const mapLines = (ls: MdInline[][]): MdInline[][] => ls.map(mapInline)
  return blocks.map((b) => {
    if (b.t === 'heading') return { ...b, inline: mapInline(b.inline) }
    if (b.t === 'paragraph' || b.t === 'quote') return { ...b, lines: mapLines(b.lines) }
    if (b.t === 'ul' || b.t === 'ol') return { ...b, items: mapLines(b.items) }
    if (b.t === 'table') return { ...b, header: mapLines(b.header), rows: b.rows.map(mapLines) }
    return b
  })
}
