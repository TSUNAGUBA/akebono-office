/**
 * KB: 集約とユーティリティ（フロント/API 共有・純関数のみ）。
 *
 * - KB_DOCS = 全カテゴリの結合（id 昇順）。1 ドキュメント = 1 RAG チャンク（KB_DOCUMENT_FORMAT）。
 * - kbFindRelated = shared/domain/text-match の bigramCoverage による決定的な字句検索。
 *   タイトル > キーワード > 本文 の重み付けで合成し、微弱一致（score < 0.06）は根拠に
 *   ならないため返さない。Date・乱数不使用（同一入力 → 同一出力）。
 * - kbSearchText = RAG 素材化（search_docs の body に入れる想定の索引用テキスト）。
 * - 物理配置を TS モジュールとするのは設計判断（types.ts の docblock を参照）。
 */

import { bigramCoverage } from '../text-match'
import { KB_FAQ_DOCS } from './faq'
import { KB_OPS_GUIDE_DOCS } from './ops-guide'
import { KB_SPEC_DOCS } from './spec'
import type { KbDoc } from './types'
import { KB_USER_GUIDE_DOCS } from './user-guide'

export * from './types'
export { KB_SPEC_DOCS } from './spec'
export { KB_USER_GUIDE_DOCS } from './user-guide'
export { KB_OPS_GUIDE_DOCS } from './ops-guide'
export { KB_FAQ_DOCS } from './faq'

/** 全ドキュメント（id 昇順・不変の配列として公開） */
export const KB_DOCS: KbDoc[] = [
  ...KB_SPEC_DOCS,
  ...KB_USER_GUIDE_DOCS,
  ...KB_OPS_GUIDE_DOCS,
  ...KB_FAQ_DOCS,
].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** id → doc の索引（モジュール初期化時に 1 回だけ構築） */
const KB_BY_ID: ReadonlyMap<string, KbDoc> = new Map(KB_DOCS.map(d => [d.id, d]))

/** id でドキュメントを取得する（存在しなければ undefined） */
export function kbDocById(id: string): KbDoc | undefined {
  return KB_BY_ID.get(id)
}

/** 検索スコアの重み（タイトル一致 > キーワード > 本文）。合計 1.0 */
const KB_WEIGHT_TITLE = 0.5
const KB_WEIGHT_KEYWORDS = 0.3
const KB_WEIGHT_BODY = 0.2

/** これ未満のスコアは「根拠にならない微弱一致」として除外する */
export const KB_MIN_SCORE = 0.06

/**
 * クエリに関連するドキュメントを決定的に検索する（既定 5 件）。
 * - bigramCoverage（文字バイグラム被覆率）を title / keywords / body で計算し重み付き合成。
 * - score 降順・同点は id 昇順で安定（Date・乱数不使用 = 同一入力なら常に同一出力）。
 * - 空クエリ（trim 後に空）は []。score < KB_MIN_SCORE は返さない。
 */
export function kbFindRelated(query: string, limit = 5): { doc: KbDoc; score: number }[] {
  const q = query.trim()
  if (!q || limit <= 0) return []
  const hits: { doc: KbDoc; score: number }[] = []
  for (const doc of KB_DOCS) {
    const score =
      KB_WEIGHT_TITLE * bigramCoverage(q, doc.title) +
      KB_WEIGHT_KEYWORDS * bigramCoverage(q, doc.keywords.join(' ')) +
      KB_WEIGHT_BODY * bigramCoverage(q, doc.body)
    if (score >= KB_MIN_SCORE) hits.push({ doc, score })
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0
  })
  return hits.slice(0, limit)
}

/**
 * RAG 素材化: 検索インデックス（search_docs の body）へ入れる想定の索引用テキスト。
 * タイトル + 本文を結合する（キーワードは kbFindRelated 側の重みで扱うため含めない =
 * インデックス本文に同義語を混ぜて表示文を汚さない）。
 */
export function kbSearchText(doc: KbDoc): string {
  return doc.title + '\n' + doc.body
}
