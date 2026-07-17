/**
 * 設定 API（app_configs の参照/更新 + 監査ログ参照）。設定系は upsert 更新可（SoT は本アプリ）。
 * 機能トグル・エスカレーションルール・日報入力方式（F-13-7）等のアプリ設定を key-value（jsonb）で保持する。
 */
import { Hono } from 'hono'
import type pg from 'pg'
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

  // 監査ログ（管理者のみ・新しい順）。at は JST ウォールクロック文字列で返す（表示規約と一致）
  app.get('/audit-logs', async (c) => {
    requireAdmin(c)
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100)))
    const { rows } = await pool.query(
      `SELECT id, actor_id AS "actorId", action, entity, entity_id AS "entityId", detail,
              to_char(at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS at
       FROM audit_logs ORDER BY id DESC LIMIT $1`,
      [limit])
    return c.json({ data: rows })
  })

  return app
}
