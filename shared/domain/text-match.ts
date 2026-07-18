/**
 * 字句マッチング（フロント/API 共有。AI 検索最適化基盤）。
 * 日本語は分かち書きが不要な文字バイグラムの被覆率で照合する（DB 拡張・外部 API に依存しない）。
 */

/** クエリの文字バイグラムのうち、文書に含まれる割合（0〜1）。2 文字未満は 0 */
export function bigramCoverage(query: string, doc: string): number {
  const norm = (s: string): string => s.toLowerCase().replace(/[\s、。・,.!?！？「」（）()]/g, '')
  const q = norm(query)
  const d = norm(doc)
  if (q.length < 2 || d.length < 2) return 0
  const qGrams = new Set<string>()
  for (let i = 0; i < q.length - 1; i++) qGrams.add(q.slice(i, i + 2))
  const dGrams = new Set<string>()
  for (let i = 0; i < d.length - 1; i++) dGrams.add(d.slice(i, i + 2))
  let hit = 0
  for (const g of qGrams) if (dGrams.has(g)) hit++
  return hit / qGrams.size
}
