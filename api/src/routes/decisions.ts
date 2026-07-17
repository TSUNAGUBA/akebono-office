/**
 * 意思決定支援 API（F-02）。mockup useDecision の API 版。
 * - 判断テーマは汎用マスタ（/v1/masters/decision-themes）。本ルートは判断ログのみを担う
 * - 判断ログは追記のみ（記録系保護 = 原則2）。参照は認証済み全員（社内 C2・mockup と同一の可視性）
 * - シナリオ予測（決定的線形モデル）は表示射影としてクライアント側に維持（設計判断）
 * エラー: AKO-DEC-001（テーマなし）/ 002（選択肢なし）/ 003（理由未入力）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { nowJstIso } from '../../../shared/domain/jst'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'

const LOG_COLS = `id, theme_id AS "themeId", chosen_slot AS "chosenSlot", reason,
  decided_by AS "decidedBy", at`

export function decisionsRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 判断ログ一覧（新しい順）
  app.get('/logs', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${LOG_COLS} FROM decision_logs ORDER BY at DESC LIMIT 500`)
    return c.json({ data: rows })
  })

  // 判断の記録（追記のみ。テーマ・選択肢の存在をサーバー側で強制）
  app.post('/logs', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const themeId = String(body.themeId ?? '')
    const slot = String(body.slot ?? '')
    const reason = String(body.reason ?? '').trim()
    if (!reason) throw err('AKO-DEC-003', '判断理由を入力してください', 400)
    const { rows } = await pool.query<{ options: { slot: string }[] }>(
      `SELECT options FROM decision_themes WHERE id = $1 AND active = true`, [themeId])
    const theme = rows[0]
    if (!theme) throw err('AKO-DEC-001', '判断テーマが見つかりません', 404)
    if (!theme.options.some(o => o.slot === slot)) {
      throw err('AKO-DEC-002', '選択肢が見つかりません', 400)
    }
    const id = newId('dl')
    await pool.query(
      `INSERT INTO decision_logs (id, theme_id, chosen_slot, reason, decided_by, at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, themeId, slot, reason, user.id, nowJstIso()])
    return c.json({ data: { id } }, 201)
  })

  return app
}
