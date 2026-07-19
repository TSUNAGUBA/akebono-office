/**
 * マークダウンの安全なサブセットパーサ（バッチ7e・オペレーター指示 2026-07-19 #6）。
 * 議事録・日報・ぽいぽいポスト等のフリー入力文章を構造化して描画するための AST を返す。
 *
 * 設計判断:
 * - v-html を使わない（chatbot.vue と同じ規約）。HTML はエスケープではなく「そもそも生成しない」。
 *   生の HTML タグ（<script> 等）はただのテキストとして扱われるため XSS が構造的に成立しない
 * - 対応記法: 見出し(#〜####)・箇条書き(- または アスタリスク)・番号リスト(1.)・引用(>)・水平線(---)・
 *   コードブロック(```)・インラインコード(`)・強調(太字のみ)・リンク([t](https://…))
 * - 単独アスタリスクの斜体は**非対応**: `3*4 と 5*6` のような既存プレーン文で孤立した * 同士が
 *   クロスマッチして意図しない整形が起きるため（表示劣化 > 記法価値の判断。太字 ** は誤爆しない）
 * - リンクは http(s) のみ許可（javascript: 等のスキームは平文のまま）
 */

export type MdInline =
  | { t: 'text'; text: string }
  | { t: 'bold'; text: string }
  | { t: 'code'; text: string }
  | { t: 'link'; text: string; href: string }

export type MdBlock =
  | { t: 'heading'; level: 1 | 2 | 3 | 4; inline: MdInline[] }
  | { t: 'paragraph'; lines: MdInline[][] }
  | { t: 'ul'; items: MdInline[][] }
  | { t: 'ol'; items: MdInline[][]; start: number }
  | { t: 'quote'; lines: MdInline[][] }
  | { t: 'codeblock'; code: string }
  | { t: 'hr' }

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

/** ブロック分解。未知の行はパラグラフとして素通し（フェイルオープン = 情報を落とさない） */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let i = 0
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
    // パラグラフ（連続する通常行をまとめ、行ごとに改行を保持）
    const plines: MdInline[][] = []
    while (
      i < lines.length && lines[i]!.trim() !== ''
      && !/^```|^\s*[-*]\s+|^\s*\d+[.)]\s+|^\s*>\s?|^#{1,6}\s+|^\s*(---+|\*\*\*+)\s*$/.test(lines[i]!)
    ) {
      plines.push(parseInline(lines[i]!))
      i++
    }
    blocks.push({ t: 'paragraph', lines: plines })
  }
  return blocks
}
