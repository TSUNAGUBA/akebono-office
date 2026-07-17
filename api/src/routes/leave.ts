/**
 * 休暇 API（残数・年5日義務・申請/承認・付与）。mockup useLeave の API 版。
 * - 残数計算（FIFO 引当）はサーバーサイド（domain/leave.ts）
 * - 付与の冪等性は DB の UNIQUE 制約（member × 種別 × 付与日）+ ON CONFLICT DO NOTHING
 * - 付与・承認/却下は管理者/人事のみ
 * エラーコード: AKO-LEV-001〜008（台帳: api-design §4）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { todayJst } from '../../../shared/domain/jst'
import type { LeaveGrant, LeaveRequest, LeaveType } from '../../../shared/domain/types'
import { requireHrOrAdmin } from '../auth'
import { calcLeaveBalance, calcObligation, expireDateFor } from '../domain/leave'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'

export const PAID_LEAVE_TYPE_ID = 'lt-paid'
const GRANT_MAX_DAYS = 40

const GRANT_COLS = `id, member_id AS "memberId", leave_type_id AS "leaveTypeId",
  grant_date AS "grantDate", days, kind, expire_date AS "expireDate", granted_by AS "grantedBy"`
const REQUEST_COLS = `id, member_id AS "memberId", leave_type_id AS "leaveTypeId",
  date, unit, status, reason, decided_by AS "decidedBy"`

async function leaveTypeOf(db: pg.Pool | pg.PoolClient, id: string): Promise<LeaveType | undefined> {
  const { rows } = await db.query(
    `SELECT id, name, grant_method AS "grantMethod", expiry_months AS "expiryMonths",
            is_statutory AS "isStatutory", description, display_order AS "displayOrder", active
     FROM leave_types WHERE id = $1`, [id])
  return rows[0] as LeaveType | undefined
}

async function balanceOf(
  db: pg.Pool | pg.PoolClient,
  memberId: string,
  leaveTypeId: string,
): Promise<ReturnType<typeof calcLeaveBalance>> {
  const grants = await db.query<LeaveGrant>(
    `SELECT ${GRANT_COLS} FROM leave_grants WHERE member_id = $1 AND leave_type_id = $2`,
    [memberId, leaveTypeId])
  const requests = await db.query<LeaveRequest>(
    `SELECT ${REQUEST_COLS} FROM leave_requests
     WHERE member_id = $1 AND leave_type_id = $2 AND status = 'approved'`,
    [memberId, leaveTypeId])
  const type = await leaveTypeOf(db, leaveTypeId)
  return calcLeaveBalance(grants.rows, requests.rows, type, todayJst())
}

function guardTargetMember(c: Parameters<typeof requireHrOrAdmin>[0], memberId: string): void {
  const user = c.get('user')
  if (memberId !== user.id) requireHrOrAdmin(c)
}

/** 付与の権限ガード（モック互換のドメインコード AKO-LEV-004 を返す） */
function requireGrantPermission(c: Parameters<typeof requireHrOrAdmin>[0]) {
  const user = c.get('user')
  if (user.role !== 'admin' && user.role !== 'hr') {
    throw err('AKO-LEV-004', '休暇の付与には管理者または人事の権限が必要です', 403)
  }
  return user
}

export function leaveRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 残数（種別ごと。既定は法定有給）
  app.get('/balance', async (c) => {
    const memberId = c.req.query('memberId') ?? c.get('user').id
    const leaveTypeId = c.req.query('leaveTypeId') ?? PAID_LEAVE_TYPE_ID
    guardTargetMember(c, memberId)
    return c.json({ data: await balanceOf(pool, memberId, leaveTypeId) })
  })

  // 年 5 日取得義務
  app.get('/obligation', async (c) => {
    const memberId = c.req.query('memberId') ?? c.get('user').id
    guardTargetMember(c, memberId)
    const grants = await pool.query<LeaveGrant>(
      `SELECT ${GRANT_COLS} FROM leave_grants WHERE member_id = $1 AND leave_type_id = $2`,
      [memberId, PAID_LEAVE_TYPE_ID])
    const requests = await pool.query<LeaveRequest>(
      `SELECT ${REQUEST_COLS} FROM leave_requests
       WHERE member_id = $1 AND leave_type_id = $2 AND status = 'approved'`,
      [memberId, PAID_LEAVE_TYPE_ID])
    return c.json({ data: calcObligation(grants.rows, requests.rows, todayJst()) })
  })

  // 付与一覧（本人 or 管理者/人事）
  app.get('/grants', async (c) => {
    const memberId = c.req.query('memberId') ?? ''
    if (memberId) guardTargetMember(c, memberId)
    else requireHrOrAdmin(c)
    const { rows } = await pool.query(
      `SELECT ${GRANT_COLS} FROM leave_grants WHERE ($1 = '' OR member_id = $1) ORDER BY grant_date DESC, member_id`,
      [memberId])
    return c.json({ data: rows })
  })

  // 申請一覧（本人 = 自分 / scope=all は管理者/人事）
  app.get('/requests', async (c) => {
    const user = c.get('user')
    const all = c.req.query('scope') === 'all'
    if (all) requireHrOrAdmin(c)
    const status = c.req.query('status') ?? ''
    const { rows } = await pool.query(
      `SELECT ${REQUEST_COLS} FROM leave_requests
       WHERE ($1 OR member_id = $2) AND ($3 = '' OR status = $3)
       ORDER BY date DESC`,
      [all, user.id, status])
    return c.json({ data: rows })
  })

  // 休暇申請（種別別の残数チェック → pending 追記）
  app.post('/requests', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as {
      date?: string; unit?: 'full' | 'half'; reason?: string; leaveTypeId?: string
    }
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      throw err('AKO-GEN-001', '取得日を選択してください', 400)
    }
    const unit = body.unit === 'half' ? 'half' : 'full'
    const leaveTypeId = body.leaveTypeId ?? PAID_LEAVE_TYPE_ID
    const type = await leaveTypeOf(pool, leaveTypeId)
    if (!type || !type.active) throw err('AKO-LEV-005', '有効な休暇種別を選択してください', 400)
    const needed = unit === 'half' ? 0.5 : 1
    const bal = await balanceOf(pool, user.id, leaveTypeId)
    if (bal.remaining < needed) {
      throw err('AKO-LEV-001',
        `${type.name}の残数が不足しています（残 ${bal.remaining} 日 / 必要 ${needed} 日）。付与状況をご確認ください`, 409)
    }
    const id = newId('lv')
    await pool.query(
      `INSERT INTO leave_requests (id, member_id, leave_type_id, date, unit, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, user.id, leaveTypeId, body.date, unit, body.reason ?? ''],
    )
    return c.json({ data: { id } }, 201)
  })

  // 承認/却下（管理者/人事。pending ガード + 承認時の残数再チェック）
  app.post('/requests/:id/decision', async (c) => {
    const user = c.get('user')
    if (user.role !== 'admin' && user.role !== 'hr') {
      throw err('AKO-LEV-003', 'この操作には管理者または人事の権限が必要です', 403)
    }
    const requestId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { action?: 'approved' | 'rejected' }
    if (body.action !== 'approved' && body.action !== 'rejected') {
      throw err('AKO-GEN-001', 'action は approved / rejected を指定してください', 400)
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const req = await client.query(
        `SELECT ${REQUEST_COLS} FROM leave_requests WHERE id = $1 FOR UPDATE`, [requestId])
      const target = req.rows[0] as LeaveRequest | undefined
      if (!target || target.status !== 'pending') {
        throw err('AKO-LEV-002', 'この申請は処理済みです', 409)
      }
      if (body.action === 'approved') {
        const bal = await balanceOf(client, target.memberId, target.leaveTypeId)
        const needed = target.unit === 'half' ? 0.5 : 1
        if (bal.remaining < needed) {
          const type = await leaveTypeOf(client, target.leaveTypeId)
          throw err('AKO-LEV-001', `申請者の${type?.name ?? '休暇'}残数が不足しているため承認できません`, 409)
        }
      }
      await client.query(
        `UPDATE leave_requests SET status = $2, decided_by = $3, updated_at = now() WHERE id = $1`,
        [requestId, body.action, user.id],
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    await audit(pool, { actorId: user.id, action: body.action, entity: 'leave_requests', entityId: requestId })
    return c.json({ data: { id: requestId } })
  })

  // 個別付与（管理者/人事。冪等: 同一メンバー × 種別 × 付与日はスキップ）
  app.post('/grants', async (c) => {
    const user = requireGrantPermission(c)
    const body = await c.req.json().catch(() => ({})) as {
      memberId?: string; leaveTypeId?: string; days?: number; grantDate?: string
    }
    const result = await grantOne(pool, user.id, body)
    return c.json({ data: result }, result.skipped ? 200 : 201)
  })

  // 一括付与（管理者/人事。重複スキップで冪等・一部スキップでも続行）
  app.post('/grants/bulk', async (c) => {
    const user = requireGrantPermission(c)
    const body = await c.req.json().catch(() => ({})) as {
      memberIds?: string[]; leaveTypeId?: string; days?: number; grantDate?: string
    }
    if (!Array.isArray(body.memberIds) || body.memberIds.length === 0) {
      throw err('AKO-LEV-007', '付与対象のメンバーを選択してください', 400)
    }
    let granted = 0
    let skipped = 0
    for (const memberId of body.memberIds) {
      const r = await grantOne(pool, user.id, { ...body, memberId })
      if (r.skipped) skipped++
      else granted++
    }
    return c.json({ data: { granted, skipped } })
  })

  async function grantOne(
    db: pg.Pool,
    actorId: string,
    input: { memberId?: string; leaveTypeId?: string; days?: number; grantDate?: string },
  ): Promise<{ id?: string; skipped: boolean }> {
    if (!input.memberId) throw err('AKO-GEN-001', '対象メンバーを指定してください', 400)
    const type = input.leaveTypeId ? await leaveTypeOf(db, input.leaveTypeId) : undefined
    if (!type || !type.active) throw err('AKO-LEV-005', '有効な休暇種別を選択してください', 400)
    const days = Number(input.days)
    if (!(days > 0) || days > GRANT_MAX_DAYS) {
      throw err('AKO-LEV-006', `付与日数は 1〜${GRANT_MAX_DAYS} 日で入力してください`, 400)
    }
    const grantDate = input.grantDate || todayJst()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(grantDate)) {
      throw err('AKO-GEN-001', '付与日は YYYY-MM-DD 形式で指定してください', 400)
    }
    const id = newId('lg')
    // 冪等ガード: UNIQUE (member_id, leave_type_id, grant_date) + DO NOTHING（再実行で二重付与しない）
    const result = await db.query(
      `INSERT INTO leave_grants (id, member_id, leave_type_id, grant_date, days, kind, expire_date, granted_by)
       VALUES ($1, $2, $3, $4, $5, 'special', $6, $7)
       ON CONFLICT ON CONSTRAINT leave_grants_idempotent DO NOTHING`,
      [id, input.memberId, type.id, grantDate, days, expireDateFor(type.expiryMonths, grantDate), actorId],
    )
    if (result.rowCount === 0) return { skipped: true }
    await audit(db, {
      actorId, action: 'grant', entity: 'leave_grants', entityId: id,
      detail: `${input.memberId} へ ${type.name} ${days} 日を付与`,
    })
    return { id, skipped: false }
  }

  return app
}
