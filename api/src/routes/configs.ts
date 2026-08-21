/**
 * 設定 API（app_configs の参照/更新 + 監査ログ参照）。設定系は upsert 更新可（SoT は本アプリ）。
 * 機能トグル・エスカレーションルール・日報入力方式（F-13-7）等のアプリ設定を key-value（jsonb）で保持する。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { AUDIT_PAGE_OTHER, auditEntitiesForPage, auditEntitiesWithPage } from '../../../shared/domain/audit-log'
import { isRealDateKey } from '../../../shared/domain/jst'
import { requireAdmin } from '../auth'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'

export function configsRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 参照は全員（機能トグルは画面表示の制御に必要）
  app.get('/', async (c) => {
    const { rows } = await pool.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM app_configs ORDER BY key')
    return c.json({ data: Object.fromEntries(rows.map(r => [r.key, r.value])) })
  })

  // 更新（管理者のみ。upsert = 冪等）
  app.put('/:key', async (c) => {
    const user = requireAdmin(c)
    const key = c.req.param('key')
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) {
      throw err('AKO-GEN-001', '設定キーの形式が不正です', 400)
    }
    const body = await c.req.json().catch(() => undefined) as { value?: unknown } | undefined
    if (body === undefined || !('value' in body)) {
      throw err('AKO-GEN-001', '設定値（value）を指定してください', 400)
    }
    await pool.query(
      `INSERT INTO app_configs (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(body.value)])
    await audit(pool, { actorId: user.id, action: 'update', entity: 'app_configs', entityId: key })
    return c.json({ data: { key } })
  })

  // 監査ログ（管理者のみ・新しい順 = ORDER BY id DESC）。at は JST ウォールクロック文字列で返す（表示規約と一致）。
  // 設定画面の監査ログタブ用にサーバーページング + フィルタへ拡張（改修 2026-08-21）:
  //   limit（既定 20・上限 500）/ offset / q（actor_id・entity・entity_id・detail の ILIKE）/
  //   f.actor / f.action / f.entity（完全一致）/ f.page（shared カタログで entity IN (...) へ展開）/
  //   f.at.from・f.at.to（JST の日付キー範囲）。
  // レスポンスは常に { data, total }（total は兄弟キー）。既存呼び出し（limit のみ = useApi の
  // 全件ハイドレーション）は apiFetch が data だけ読むため互換（原則7）。
  // クエリ命名・clamp・不正値は黙って無視（原則4）の流儀は lib/list-query.ts に合わせる
  // （f.page の entity 展開があるため runListQuery は使わず専用実装）
  app.get('/audit-logs', async (c) => {
    requireAdmin(c)
    const clampInt = (raw: string | undefined, fallback: number, min: number, max: number): number => {
      const n = Number.parseInt(raw ?? '', 10)
      if (!Number.isFinite(n)) return fallback
      return Math.min(Math.max(n, min), max)
    }
    const limit = clampInt(c.req.query('limit'), 20, 1, 500)
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER)

    const where: string[] = []
    const params: unknown[] = []
    // $P は同一バインド値の再利用可（q の OR 4 列など）のため全置換
    const push = (clause: string, value: unknown): void => {
      params.push(value)
      where.push(clause.replaceAll('$P', `$${params.length}`))
    }
    const q = (c.req.query('q') ?? '').trim()
    if (q) push('(actor_id ILIKE $P OR entity ILIKE $P OR entity_id ILIKE $P OR detail ILIKE $P)', `%${q}%`)
    const actor = (c.req.query('f.actor') ?? '').trim()
    if (actor) push('actor_id = $P', actor)
    const action = (c.req.query('f.action') ?? '').trim()
    if (action) push('action = $P', action)
    const entity = (c.req.query('f.entity') ?? '').trim()
    if (entity) push('entity = $P', entity)
    // f.page はカタログ（shared/domain/audit-log = 両モード共通の SoT）で entity 集合へ展開する。
    // 「その他」= ページが特定できる entity の否定（カタログ外の未知 entity も拾う）
    const page = (c.req.query('f.page') ?? '').trim()
    if (page === AUDIT_PAGE_OTHER) {
      push('NOT (entity = ANY($P))', auditEntitiesWithPage())
    } else if (page) {
      const entities = auditEntitiesForPage(page)
      // 未知ページ（カタログ外の値）は黙って無視（原則4 = list-query の不正値と同じ扱い）
      if (entities.length > 0) push('entity = ANY($P)', entities)
    }
    // 期間は JST の日付キー（YYYY-MM-DD）。不正・非実在日は黙って無視（isRealDateKey = 22008 の 500 化を防ぐ）
    const atFrom = (c.req.query('f.at.from') ?? '').trim()
    if (isRealDateKey(atFrom)) push(`(at AT TIME ZONE 'Asia/Tokyo')::date >= $P`, atFrom)
    const atTo = (c.req.query('f.at.to') ?? '').trim()
    if (isRealDateKey(atTo)) push(`(at AT TIME ZONE 'Asia/Tokyo')::date <= $P`, atTo)

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const countRes = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_logs ${whereSql}`, params)
    const total = countRes.rows[0]?.n ?? 0

    params.push(limit, offset)
    const { rows } = await pool.query(
      `SELECT id, actor_id AS "actorId", action, entity, entity_id AS "entityId", detail,
              to_char(at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS at
       FROM audit_logs ${whereSql}
       ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params)
    return c.json({ data: rows, total })
  })

  return app
}
