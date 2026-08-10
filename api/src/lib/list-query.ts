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

/** 構造化フィルタの種別（項目カスタマイズ ITEM_CATALOG の filterKind と対応） */
export type FilterKind = 'text' | 'eq' | 'enum' | 'date' | 'number'

/** フィルタ対象カラムの定義（キー = フィルタパラメータ名 = 項目キー） */
export interface FilterColSpec {
  /** SQL カラム式（col または col::text 等） */
  col: string
  /** 種別。text = 正規化部分一致 / eq・enum = 完全一致 / date・number = 範囲 */
  kind: FilterKind
}

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
  /**
   * 構造化フィルタの対象カラム（キー = フィルタパラメータ名 = 項目キー）。
   * クエリは `f.<key>`（text/eq/enum）・`f.<key>.from` / `.to`（date）・`f.<key>.min` / `.max`（number）で受ける。
   * text は akebono_norm（NFKC + 小文字）で大文字小文字・全角半角を吸収した部分一致（0056）。
   */
  filterCols?: Record<string, FilterColSpec>
  /** ページ取得時の既定 limit（未指定 limit のとき使用。既定 50） */
  defaultLimit?: number
  /** ページ取得時の limit 上限（既定 500） */
  limitCap?: number
  /** 常時適用する静的 WHERE（"WHERE" は付けない）。両モードに適用 */
  baseWhere?: string
  /** baseWhere のバインド値 */
  baseParams?: unknown[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** 実在する暦日か（YYYY-MM-DD・閏年考慮）。正規表現は通るが暦上あり得ない日（2026-13-45 等）で
 *  `col::date` キャストが 22008 → 500 になるのを防ぐ（不正値は黙って無視 = 原則4）。 */
function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const y = Number(s.slice(0, 4)); const m = Number(s.slice(5, 7)); const d = Number(s.slice(8, 10))
  if (m < 1 || m > 12 || d < 1) return false
  const days = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!
  return d <= days
}

/**
 * 構造化フィルタ句を組み立てる（副作用: where / params へ push）。適用したフィルタが 1 件でもあれば true。
 * text = strpos(akebono_norm(col), akebono_norm($v)) > 0（NULL 列は非マッチ）/ eq・enum = 完全一致 /
 * date = col::date の範囲 / number = 数値範囲。値が空・不正なものは黙って無視する（原則4）。
 */
function applyFilters(
  c: Context, filterCols: Record<string, FilterColSpec>, where: string[], params: unknown[],
): boolean {
  let applied = false
  const push = (clause: string, value: unknown): void => {
    params.push(value)
    where.push(clause.replace('$P', `$${params.length}`))
    applied = true
  }
  for (const [key, spec] of Object.entries(filterCols)) {
    if (spec.kind === 'date') {
      const from = (c.req.query(`f.${key}.from`) ?? '').trim()
      const to = (c.req.query(`f.${key}.to`) ?? '').trim()
      if (isRealDate(from)) push(`${spec.col}::date >= $P`, from)
      if (isRealDate(to)) push(`${spec.col}::date <= $P`, to)
    } else if (spec.kind === 'number') {
      const min = Number(c.req.query(`f.${key}.min`))
      const max = Number(c.req.query(`f.${key}.max`))
      if (Number.isFinite(min) && (c.req.query(`f.${key}.min`) ?? '') !== '') push(`${spec.col} >= $P`, min)
      if (Number.isFinite(max) && (c.req.query(`f.${key}.max`) ?? '') !== '') push(`${spec.col} <= $P`, max)
    } else {
      const v = (c.req.query(`f.${key}`) ?? '').trim()
      if (!v) continue
      if (spec.kind === 'text') push(`strpos(app_office.akebono_norm(${spec.col}), app_office.akebono_norm($P)) > 0`, v)
      else push(`${spec.col} = $P`, v) // eq / enum
    }
  }
  return applied
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

  const where: string[] = []
  const params: unknown[] = [...(spec.baseParams ?? [])]
  if (spec.baseWhere) where.push(spec.baseWhere)
  if (q && spec.searchCols && spec.searchCols.length > 0) {
    params.push(`%${q}%`)
    const p = params.length
    where.push(`(${spec.searchCols.map(col => `${col} ILIKE $${p}`).join(' OR ')})`)
  }
  // 構造化フィルタ（f.<key> 系）。1 件でも適用されればページ取得へ切り替える
  const filtered = spec.filterCols ? applyFilters(c, spec.filterCols, where, params) : false
  const paged = limitRaw != null || offsetRaw != null || q !== '' || filtered
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
