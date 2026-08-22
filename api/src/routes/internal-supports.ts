/**
 * 社内サポート活動 API（改善要望 2026-08-22・F-57）。
 * - 社内メンバーどうしのフォローアップ（業務支援・技術支援・教育等）を時系列で記録する。
 * - チーム共有（全員が閲覧・登録・編集可 = 活動記録 3 種・営業アプローチと同じ所有モデル。訂正履歴は監査ログ）。
 * - 取消 = 論理削除（active=false）+ 復元（原則9.5）。
 * - 記録は AKEBONO Intelligence の AI 分析（ナレッジカテゴリ「社内サポート」）の材料になる。
 * - 検証は shared/domain/internal-support（モックと同一関数・同一順 = パリティ）。
 * エラー: AKO-ISP-001 入力不正 / 002 不在。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { capCodePoints } from '../../../shared/domain/customer-log'
import {
  INTERNAL_SUPPORT_TEXT_CAP, internalSupportError, type InternalSupportInput,
} from '../../../shared/domain/internal-support'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'

const COLS = `s.id, s.member_id AS "memberId", s.activity_date::text AS "activityDate",
  s.activity_time AS "activityTime", s.performer_member_id AS "performerMemberId",
  s.target_member_id AS "targetMemberId", s.task_description AS "taskDescription",
  s.method, s.feedback, s.active,
  to_char(s.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt",
  to_char(s.updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt"`

function longText(v: unknown): string {
  return capCodePoints(String(v ?? '').trim(), INTERNAL_SUPPORT_TEXT_CAP)
}

function timeOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim()
  return s || null
}

function inputOf(b: Record<string, unknown>, userId: string): InternalSupportInput {
  return {
    activityDate: String(b.activityDate ?? '').trim(),
    activityTime: timeOrNull(b.activityTime),
    performerMemberId: String(b.performerMemberId ?? '').trim() || userId,
    targetMemberId: String(b.targetMemberId ?? '').trim(),
    taskDescription: longText(b.taskDescription),
    method: String(b.method ?? '').trim(),
    feedback: longText(b.feedback),
  }
}

function assertValid(message: string | null): void {
  if (message) throw err('AKO-ISP-001', message, 400)
}

/** FK 違反（23503）= 紐付け先メンバー不在（400） */
function writeError(e: unknown): never {
  if ((e as { code?: string }).code === '23503') {
    throw err('AKO-ISP-001', '紐付け先（実施者・対象者のメンバー）が見つかりません', 400)
  }
  throw e
}

async function findRow(pool: pg.Pool, id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(`SELECT ${COLS} FROM internal_supports s WHERE id = $1`, [id])
  if (!rows[0]) throw err('AKO-ISP-002', '社内サポート活動が見つかりません', 404)
  return rows[0]
}

export function internalSupportsRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 一覧（取消済み込みの全量ハイドレーション = sales-approaches と同じ設計判断:
  // 社内フォローアップの件数増加は緩やか。並びは活動日降順 → 作成降順で安定返却）
  app.get('/', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM internal_supports s
       ORDER BY s.activity_date DESC, s.created_at DESC, s.id DESC`)
    return c.json({ data: rows })
  })

  // 登録（全員可）
  app.post('/', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = inputOf(b, user.id)
    assertValid(internalSupportError(input))
    const id = newId('isp')
    try {
      await pool.query(
        `INSERT INTO internal_supports
           (id, member_id, activity_date, activity_time, performer_member_id, target_member_id,
            task_description, method, feedback)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)`,
        [id, user.id, input.activityDate, input.activityTime, input.performerMemberId,
          input.targetMemberId, input.taskDescription, input.method, input.feedback])
    } catch (e) {
      writeError(e)
    }
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'internal_supports', entityId: id,
      detail: '社内サポート活動を登録',
    })
    return c.json({ data: await findRow(pool, id) }, 201)
  })

  // 編集（全員可 = チーム共有。送られたキーのみ更新 = 部分更新の安全側 → マージ後に shared 宣言順で全体検証）
  app.patch('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await findRow(pool, id) as unknown as InternalSupportInput
    const has = (k: string): boolean => Object.hasOwn(b, k)
    const merged: InternalSupportInput = {
      activityDate: has('activityDate') ? String(b.activityDate ?? '').trim() : cur.activityDate,
      activityTime: has('activityTime') ? timeOrNull(b.activityTime) : cur.activityTime,
      performerMemberId: has('performerMemberId')
        ? (String(b.performerMemberId ?? '').trim() || user.id) : cur.performerMemberId,
      targetMemberId: has('targetMemberId') ? String(b.targetMemberId ?? '').trim() : cur.targetMemberId,
      taskDescription: has('taskDescription') ? longText(b.taskDescription) : cur.taskDescription,
      method: has('method') ? String(b.method ?? '').trim() : cur.method,
      feedback: has('feedback') ? longText(b.feedback) : cur.feedback,
    }
    assertValid(internalSupportError(merged))
    try {
      await pool.query(
        `UPDATE internal_supports
         SET activity_date = $2::date, activity_time = $3, performer_member_id = $4,
             target_member_id = $5, task_description = $6, method = $7, feedback = $8, updated_at = now()
         WHERE id = $1`,
        [id, merged.activityDate, merged.activityTime, merged.performerMemberId,
          merged.targetMemberId, merged.taskDescription, merged.method, merged.feedback])
    } catch (e) {
      writeError(e)
    }
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'internal_supports', entityId: id,
      detail: '社内サポート活動を編集',
    })
    return c.json({ data: await findRow(pool, id) })
  })

  // 取消/復元（論理削除。全員可・冪等: 条件付き UPDATE で同時実行でも監査ログは 1 回だけ = activities と同型）
  app.post('/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findRow(pool, id)
    const upd = await pool.query(
      `UPDATE internal_supports SET active = false, updated_at = now() WHERE id = $1 AND active = true`, [id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: 'すでに取消済みです' } })
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'internal_supports', entityId: id, detail: '社内サポート活動を取消' })
    return c.json({ data: { id } })
  })

  app.post('/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findRow(pool, id)
    const upd = await pool.query(
      `UPDATE internal_supports SET active = true, updated_at = now() WHERE id = $1 AND active = false`, [id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: '取消されていません' } })
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'internal_supports', entityId: id, detail: '社内サポート活動を復元' })
    return c.json({ data: { id } })
  })

  return app
}
