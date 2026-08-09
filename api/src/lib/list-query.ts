/**
 * 記録系一覧の共通クエリ（サーバーページング + 検索）。
 *
 * 下位互換の要: `limit` / `offset` / `q` の**いずれも無いとき**は従来どおり
 * 「maxLimit までの全件を bare 配列で返す」振る舞いを厳密に維持する（既存の全件
 * ハイドレーション経路 = useApi.loadApiCollection を壊さない = 原則7）。
 * ページングパラメータが 1 つでも来たときだけ、COUNT(*) を伴うページ取得へ切り替え、
 * レスポンスへ `total`（現在の検索条件での総件数）を**兄弟キー**として付与する
 * （配列は依然 `data` に載るため、bare 配列を期待する既存 consumer とも共存する）。
 *
 * 注意:
 * - `searchCols` はコード定義のカラム式のみ（ユーザー入力を混ぜない）。q は必ずパラメータ化する。
 * - 日付/timestamp を検索対象にする場合は呼び出し側で `col::text` を渡す。
 */
import type { Context } from 'hono'
import type pg from 'pg'

export interface ListQuerySpec {
  /** FROM 対象テーブル */
  table: string
  /** 射影（SELECT <cols>）。camelCase エイリアス込みの既存 *_COLS をそのまま渡す */
  cols: string
  /** ORDER BY 句（"order_date DESC, id" 等） */
  orderBy: string
  /** 全件（レガシー）取得時の上限 */
  maxLimit: number
  /** 検索対象カラム式（ILIKE。省略時は検索無効） */
  searchCols?: string[]
  /** ページ取得時の既定 limit（未指定 limit のとき使用。既定 50） */
  defaultLimit?: number
  /** ページ取得時の limit 上限（既定 500） */
  limitCap?: number
  /** 常時適用する静的 WHERE（"WHERE" は付けない）。両モードに適用 */
  baseWhere?: string
  /** baseWhere のバインド値 */
  baseParams?: unknown[]
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * 一覧レスポンスを構築する。ページングパラメータの有無で挙動が分岐する。
 * 返り値の `data` は常に行配列。ページ時のみ `total` を含む。
 */
export async function runListQuery(
  pool: pg.Pool, c: Context, spec: ListQuerySpec,
): Promise<{ data: Record<string, unknown>[]; total?: number }> {
  const limitRaw = c.req.query('limit')
  const offsetRaw = c.req.query('offset')
  const q = (c.req.query('q') ?? '').trim()
  const paged = limitRaw != null || offsetRaw != null || q !== ''

  const where: string[] = []
  const params: unknown[] = [...(spec.baseParams ?? [])]
  if (spec.baseWhere) where.push(spec.baseWhere)
  if (q && spec.searchCols && spec.searchCols.length > 0) {
    params.push(`%${q}%`)
    const p = params.length
    where.push(`(${spec.searchCols.map(col => `${col} ILIKE $${p}`).join(' OR ')})`)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  if (!paged) {
    const { rows } = await pool.query(
      `SELECT ${spec.cols} FROM ${spec.table} ${whereSql} ORDER BY ${spec.orderBy} LIMIT ${spec.maxLimit}`,
      params,
    )
    return { data: rows }
  }

  const limit = clampInt(limitRaw, spec.defaultLimit ?? 50, 1, spec.limitCap ?? 500)
  const offset = clampInt(offsetRaw, 0, 0, Number.MAX_SAFE_INTEGER)

  const countRes = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${spec.table} ${whereSql}`, params)
  const total = countRes.rows[0]?.n ?? 0

  params.push(limit, offset)
  const { rows } = await pool.query(
    `SELECT ${spec.cols} FROM ${spec.table} ${whereSql}
     ORDER BY ${spec.orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return { data: rows, total }
}
