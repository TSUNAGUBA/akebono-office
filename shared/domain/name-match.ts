/**
 * 会社名の正規化照合（フロント/API 共有。オペレーター報告 2026-07-18 #3）
 *
 * 実障害: 「つなぐばの取引先は?」が正式名「つなぐば株式会社」と完全一致せず照合できなかった。
 * 法人格（株式会社・(株) 等）と空白を除去した正規化文字列で部分一致させ、
 * 複数一致時は「今回の質問を優先・より長い名前を優先（最長一致）」で決定的に選ぶ。
 */

/** 法人格・記号ゆらぎ（前株・後株の両方に対応するため単純除去） */
const LEGAL_FORMS = /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|（株）|\(株\)|㈱|（有）|\(有\)|㈲/g

/** 会社名の正規化（小文字化・空白除去・法人格除去・全角英数→半角） */
export function normalizeCompanyName(s: string): string {
  return s
    .replace(LEGAL_FORMS, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/\s+/g, '')
}

/** text（質問文等）が会社名 name（または別名）へ言及しているか（正規化部分一致。2 文字未満は誤爆防止で不一致） */
export function mentionsCompanyName(text: string, name: string): boolean {
  const n = normalizeCompanyName(name)
  return n.length >= 2 && normalizeCompanyName(text).includes(n)
}

export interface CompanyNameRow {
  name: string
  aliases?: string[] | null
}

/**
 * text に言及されている会社を選ぶ（最長一致 = 「アパレル商事」と「アパレル商事東京」が両方あれば後者）。
 * 一致なしは undefined。呼び出し側で「今回の質問 → 履歴（新しい順）」の優先順に呼ぶこと
 */
export function findCompanyIn<T extends CompanyNameRow>(text: string, companies: T[]): T | undefined {
  let best: T | undefined
  let bestLen = 0
  for (const c of companies) {
    for (const n of [c.name, ...(c.aliases ?? [])]) {
      if (!n || !mentionsCompanyName(text, n)) continue
      const len = normalizeCompanyName(n).length
      if (len > bestLen) {
        best = c
        bestLen = len
      }
    }
  }
  return best
}

/** 自社への言及（会社名を出さない指示語） */
export const SELF_COMPANY_PATTERN = /自社|わが社|我が社|うちの会社|弊社|当社/
