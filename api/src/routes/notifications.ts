/**
 * 通知 API（本人の通知のみ参照・既読化できる）。発行はサーバー内部（lib/notify）のみ。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { err } from '../lib/errors'

const COLS = `id, member_id AS "memberId", kind, title, body, link, read, at`

export function notificationsRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 自分の通知（新しい順。?unread=1 で未読のみ）
  app.get('/', async (c) => {
    const user = c.get('user')
    const unreadOnly = c.req.query('unread') === '1'
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM notifications
       WHERE member_id = $1 AND ($2 = false OR read = false)
       ORDER BY at DESC LIMIT 200`,
      [user.id, unreadOnly])
    return c.json({ data: rows })
  })

  // 既読化（本人の通知のみ）
  app.post('/:id/read', async (c) => {
    const user = c.get('user')
    const result = await pool.query(
      'UPDATE notifications SET read = true WHERE id = $1 AND member_id = $2',
      [c.req.param('id'), user.id])
    if (result.rowCount === 0) throw err('AKO-GEN-002', '対象の通知が見つかりません', 404)
    return c.json({ data: { id: c.req.param('id') } })
  })

  // 全件既読化（冪等）
  app.post('/read-all', async (c) => {
    const user = c.get('user')
    await pool.query('UPDATE notifications SET read = true WHERE member_id = $1 AND read = false', [user.id])
    return c.json({ data: { ok: true } })
  })

  return app
}
