/**
 * 日報に併記する「改善のタネ」（poipoi ノート）の抽出（改修依頼 2026-08-19。原則3: 再利用）。
 * - 全員の日報／チームの日報詳細ドロワー（他者分を含むプール）
 * - 自分の日報の提出済み表示（本人分のみ）
 * の両方で、指定した著者・指定した日付（YYYY-MM-DD）の投稿を古い順に取り出す共通純関数。
 *
 * 可視範囲（本人のみ / 管理者の全ポスト等）は呼び出し側が渡す posts で表現する（ここでは権限を広げない）。
 * 時刻（hh:mm）の表示可否は表示側の責務（改修7 で日報詳細では非表示）。
 */
export function poipoiPostsOnDay<T extends { memberId: string; createdAt: string }>(
  posts: T[],
  memberId: string,
  date: string,
): T[] {
  return posts
    .filter(n => n.memberId === memberId && n.createdAt.slice(0, 10) === date)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
