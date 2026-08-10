/**
 * 字句マッチング（フロント/API 共有。AI 検索最適化基盤）。
 * 日本語は分かち書きが不要な文字バイグラムの被覆率で照合する（DB 拡張・外部 API に依存しない）。
 */

/**
 * 検索用のテキスト正規化（フロント JS / API PG で**同一セマンティクス**）。
 * Unicode NFKC で全角⇔半角を畳み込み（全角 ASCII → 半角・半角カナ → 全角カナ〔濁点合成〕・
 * 全角記号 → 半角 等）、小文字化する。これにより「ＡＫＥＢＯＮＯ / akebono / ｱｹﾎﾞﾉ / アケボノ」の
 * 表記ゆれを吸収して検索がヒットする。
 * API 側は `app_office.akebono_norm(text) = lower(normalize(t, NFKC))`（migration 0056）が本関数と
 * バイト単位で一致する（PostgreSQL 16 の normalize(NFKC) = JS String.normalize('NFKC') を検証済み）。
 */
export function normalizeSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

/**
 * 正規化した部分一致（大文字小文字・全角半角を無視して needle が haystack に含まれるか）。
 * needle が空（trim 後）なら常に true（フィルタ未入力 = 絞り込みなし）。
 */
export function normalizedIncludes(haystack: string, needle: string): boolean {
  const n = normalizeSearch(needle.trim())
  if (!n) return true
  return normalizeSearch(haystack).includes(n)
}

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
