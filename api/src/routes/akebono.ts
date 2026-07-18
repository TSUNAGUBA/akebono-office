/**
 * AKEBONO API（F-03）。mockup akebono.vue の要望ボックスの API 版。
 * - akebono_wishes は記録系（追記のみ）。編集・削除は設けない
 * - 参照・投稿は認証済み全員（モックと同一の可視性 = 社内 C2。機能ガード 'akebono' = F-16 が前段）
 * - プレースホルダページ本体（要件定義中バナー・構想ロードマップ）は静的表示のためフロントの責務
 * エラー: AKO-AKB-001（要望未入力）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { nowJstIso } from '../../../shared/domain/jst'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { capCp } from '../lib/text'

const WISH_COLS = `id, member_id AS "memberId", body, at`
/** 要望本文の上限（コードポイント） */
const WISH_BODY_CAP = 2000

export function akebonoRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 要望一覧（新しい順。表示名はフロントが members マスタキャッシュから解決）
  app.get('/wishes', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${WISH_COLS} FROM akebono_wishes ORDER BY at DESC, id LIMIT 500`)
    return c.json({ data: rows })
  })

  // 要望の投稿（追記のみ = 記録系）
  app.post('/wishes', async (c) => {
    const user = c.get('user')
    const reqBody = await c.req.json().catch(() => ({})) as { body?: unknown }
    const body = capCp(String(reqBody.body ?? '').trim(), WISH_BODY_CAP)
    if (!body) throw err('AKO-AKB-001', '要望を入力してください', 400)
    const id = newId('aw')
    await pool.query(
      `INSERT INTO akebono_wishes (id, member_id, body, at) VALUES ($1, $2, $3, $4)`,
      [id, user.id, body, nowJstIso()])
    return c.json({ data: { id } }, 201)
  })

  return app
}
