/**
 * 勤怠 API（打刻・日次/月次集計・タイムカード・36 協定・修正申請）。
 * 集計はすべてサーバーサイドで実行する（Phase 7 方針: 重い処理はサーバーサイド）。
 * エラーコード: AKO-ATT-001（状態機械違反）/ 002（理由未入力）/ 003（処理済み申請）/ 004（権限）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { effectivePunches } from '../../../shared/domain/attendance-calc'
import { addDays, nowJstIso, todayJst } from '../../../shared/domain/jst'
import type { AttendanceRule, Member, PunchKind, PunchRecord } from '../../../shared/domain/types'
import { requireAdmin, requireHrOrAdmin } from '../auth'
import {
  article36Alerts, daySummary, monthSummary, PUNCH_ALLOWED, punchState, resolveRule,
} from '../domain/attendance'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { notifyAdmins } from '../lib/notify'

const PUNCH_KINDS: PunchKind[] = ['in', 'out', 'break_start', 'break_end']
const PUNCH_KIND_LABELS: Record<PunchKind, string> = {
  in: '出勤', out: '退勤', break_start: '休憩開始', break_end: '休憩終了',
}
/** タイムカードの照会期間上限（日）。モック画面と同じ 62 日 */
const TIMECARD_RANGE_MAX_DAYS = 62

const PUNCH_COLS = `id, member_id AS "memberId", date, kind, at, source,
  fixed_from AS "fixedFrom", fix_reason AS "fixReason", approved_by AS "approvedBy"`

async function punchesOf(pool: pg.Pool, memberId: string, date: string): Promise<PunchRecord[]> {
  const { rows } = await pool.query<PunchRecord>(
    `SELECT ${PUNCH_COLS} FROM punch_records WHERE member_id = $1 AND date = $2 ORDER BY at`,
    [memberId, date],
  )
  return rows
}

async function ruleOf(pool: pg.Pool, memberId: string): Promise<AttendanceRule | undefined> {
  const member = await pool.query<Pick<Member, 'attendanceRuleId' | 'employmentType'>>(
    'SELECT attendance_rule_id AS "attendanceRuleId", employment_type AS "employmentType" FROM members WHERE id = $1',
    [memberId],
  )
  const rules = await pool.query(
    `SELECT id, name, applies_to AS "appliesTo", default_for AS "defaultFor",
            work_start AS "workStart", work_end AS "workEnd", break_minutes AS "breakMinutes",
            flex, closing_day AS "closingDay", legal_holiday_weekday AS "legalHolidayWeekday", active
     FROM attendance_rules ORDER BY id`)
  return resolveRule(member.rows[0], rules.rows as AttendanceRule[])
}

function groupByDate(rows: PunchRecord[]): Map<string, PunchRecord[]> {
  const map = new Map<string, PunchRecord[]>()
  for (const r of rows) {
    const list = map.get(r.date) ?? []
    list.push(r)
    map.set(r.date, list)
  }
  return map
}

/** 本人以外の勤怠参照は管理者/人事のみ（C3 データ保護） */
function guardTargetMember(c: Parameters<typeof requireHrOrAdmin>[0], memberId: string): void {
  const user = c.get('user')
  if (memberId !== user.id) requireHrOrAdmin(c)
}

export function attendanceRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 打刻（状態機械ガード。本人のみ）
  app.post('/punches', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { kind?: PunchKind; source?: 'web' | 'mobile' }
    if (!body.kind || !PUNCH_KINDS.includes(body.kind)) {
      throw err('AKO-GEN-001', '打刻種別（kind）を指定してください', 400)
    }
    const date = todayJst()
    // 直列化: 同一メンバーの同時打刻をトランザクション + 行ロックで防ぐ
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`punch:${user.id}`])
      const { rows } = await client.query<PunchRecord>(
        `SELECT ${PUNCH_COLS} FROM punch_records WHERE member_id = $1 AND date = $2 ORDER BY at`,
        [user.id, date],
      )
      const state = punchState(rows)
      if (!PUNCH_ALLOWED[state].includes(body.kind)) {
        throw err('AKO-ATT-001', `現在の状態では「${PUNCH_KIND_LABELS[body.kind]}」はできません`, 409)
      }
      const id = newId('pch')
      await client.query(
        `INSERT INTO punch_records (id, member_id, date, kind, at, source)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, user.id, date, body.kind, nowJstIso(), body.source === 'mobile' ? 'mobile' : 'web'],
      )
      await client.query('COMMIT')
      return c.json({ data: { id, state: body.kind } }, 201)
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })

  // 打刻状態（打刻ウィジェット用）
  app.get('/state', async (c) => {
    const user = c.get('user')
    const rows = await punchesOf(pool, user.id, todayJst())
    return c.json({ data: { state: punchState(rows), punches: rows } })
  })

  // 日次サマリ（?raw=1 で修正前の生打刻も返す）
  app.get('/day', async (c) => {
    const memberId = c.req.query('memberId') ?? c.get('user').id
    const date = c.req.query('date') ?? todayJst()
    guardTargetMember(c, memberId)
    const rows = await punchesOf(pool, memberId, date)
    const rule = await ruleOf(pool, memberId)
    const summary = daySummary(rows, rule, date)
    return c.json({ data: c.req.query('raw') === '1' ? { ...summary, rawPunches: rows } : summary })
  })

  // 月次サマリ（サーバーサイド集計）
  app.get('/month', async (c) => {
    const memberId = c.req.query('memberId') ?? c.get('user').id
    const month = c.req.query('month') ?? todayJst().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month)) throw err('AKO-GEN-001', 'month は YYYY-MM 形式で指定してください', 400)
    guardTargetMember(c, memberId)
    const { rows } = await pool.query<PunchRecord>(
      `SELECT ${PUNCH_COLS} FROM punch_records
       WHERE member_id = $1 AND date >= $2::date AND date < $2::date + interval '1 month'
       ORDER BY at`,
      [memberId, `${month}-01`],
    )
    const rule = await ruleOf(pool, memberId)
    return c.json({ data: monthSummary(groupByDate(rows), rule, month) })
  })

  // 36 協定アラート（直近 6 ヶ月）
  app.get('/alerts', async (c) => {
    const memberId = c.req.query('memberId') ?? c.get('user').id
    const endMonth = c.req.query('endMonth') ?? todayJst().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(endMonth)) throw err('AKO-GEN-001', 'endMonth は YYYY-MM 形式で指定してください', 400)
    guardTargetMember(c, memberId)
    const from = `${endMonth}-01`
    const { rows } = await pool.query<PunchRecord>(
      `SELECT ${PUNCH_COLS} FROM punch_records
       WHERE member_id = $1 AND date >= ($2::date - interval '5 months') AND date < ($2::date + interval '1 month')
       ORDER BY at`,
      [memberId, from],
    )
    const rule = await ruleOf(pool, memberId)
    return c.json({ data: article36Alerts(groupByDate(rows), rule, endMonth) })
  })

  // タイムカード（管理者/人事。期間 × 部署 × 氏名でフィルタし日別の出退勤を返す）
  app.get('/timecard', async (c) => {
    requireHrOrAdmin(c)
    const from = c.req.query('from') ?? todayJst().slice(0, 8) + '01'
    const to = c.req.query('to') ?? todayJst()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      throw err('AKO-GEN-001', '期間（from/to）を YYYY-MM-DD で正しく指定してください', 400)
    }
    if (addDays(from, TIMECARD_RANGE_MAX_DAYS) < to) {
      throw err('AKO-GEN-001', `期間は最大 ${TIMECARD_RANGE_MAX_DAYS} 日までです`, 400)
    }
    const departmentId = c.req.query('departmentId') ?? ''
    const q = (c.req.query('q') ?? '').trim()

    const members = await pool.query<Pick<Member, 'id' | 'name' | 'departmentId' | 'attendanceRuleId' | 'employmentType'>>(
      `SELECT id, name, department_id AS "departmentId",
              attendance_rule_id AS "attendanceRuleId", employment_type AS "employmentType"
       FROM members
       WHERE active = true
         AND ($1 = '' OR department_id = $1)
         AND ($2 = '' OR name ILIKE '%' || $2 || '%')
       ORDER BY id`,
      [departmentId, q],
    )
    if (members.rows.length === 0) return c.json({ data: [] })

    const memberIds = members.rows.map(m => m.id)
    const punches = await pool.query<PunchRecord>(
      `SELECT ${PUNCH_COLS} FROM punch_records
       WHERE member_id = ANY($1) AND date BETWEEN $2 AND $3
       ORDER BY at`,
      [memberIds, from, to],
    )
    const rules = await pool.query(
      `SELECT id, name, applies_to AS "appliesTo", default_for AS "defaultFor",
              work_start AS "workStart", work_end AS "workEnd", break_minutes AS "breakMinutes",
              flex, closing_day AS "closingDay", legal_holiday_weekday AS "legalHolidayWeekday", active
       FROM attendance_rules ORDER BY id`)

    const byMember = new Map<string, PunchRecord[]>()
    for (const p of punches.rows) {
      const list = byMember.get(p.memberId) ?? []
      list.push(p)
      byMember.set(p.memberId, list)
    }
    const result: {
      memberId: string
      name: string
      departmentId: string
      date: string
      inAt: string | null
      outAt: string | null
      workMinutes: number
      breakMinutes: number
    }[] = []
    for (const m of members.rows) {
      const rule = resolveRule(m, rules.rows as AttendanceRule[])
      for (const [date, rows] of groupByDate(byMember.get(m.id) ?? [])) {
        const s = daySummary(rows, rule, date)
        if (s.punches.length === 0) continue
        result.push({
          memberId: m.id,
          name: m.name,
          departmentId: m.departmentId,
          date,
          inAt: s.punches.find(p => p.kind === 'in')?.at ?? null,
          outAt: [...s.punches].reverse().find(p => p.kind === 'out')?.at ?? null,
          workMinutes: s.workMinutes,
          breakMinutes: s.breakMinutes,
        })
      }
    }
    result.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, 'ja'))
    return c.json({ data: result })
  })

  // 打刻修正申請（理由必須）
  app.post('/fix-requests', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as {
      date?: string; kind?: PunchKind; requestedAt?: string; reason?: string
    }
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      throw err('AKO-GEN-001', '対象日（date）を指定してください', 400)
    }
    if (!body.kind || !PUNCH_KINDS.includes(body.kind)) {
      throw err('AKO-GEN-001', '打刻種別（kind）を指定してください', 400)
    }
    if (!body.requestedAt) throw err('AKO-GEN-001', '修正後の時刻（requestedAt）を指定してください', 400)
    if (!body.reason?.trim()) {
      throw err('AKO-ATT-002', '修正理由を入力してください（客観的記録の担保）', 400)
    }
    const id = newId('fix')
    await pool.query(
      `INSERT INTO attendance_fix_requests (id, member_id, date, kind, requested_at, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, user.id, body.date, body.kind, body.requestedAt, body.reason.trim()],
    )
    // 管理者への通知は補助処理（mockup と同一挙動）
    await notifyAdmins(pool, 'approval', '打刻修正申請',
      `${user.name} さんから ${body.date} の修正申請`, '/attendance')
    return c.json({ data: { id } }, 201)
  })

  // 修正申請一覧（本人 = 自分の申請 / 管理者 = 全件（status 指定可））
  app.get('/fix-requests', async (c) => {
    const user = c.get('user')
    const status = c.req.query('status') ?? ''
    const all = c.req.query('scope') === 'all'
    if (all) requireAdmin(c)
    const { rows } = await pool.query(
      `SELECT id, member_id AS "memberId", date, kind, requested_at AS "requestedAt",
              reason, status, decided_by AS "decidedBy"
       FROM attendance_fix_requests
       WHERE ($1 = '' OR status = $1) AND ($2 OR member_id = $3)
       ORDER BY created_at DESC`,
      [status, all, user.id],
    )
    return c.json({ data: rows })
  })

  // 修正申請の承認/却下（管理者）。承認時は修正打刻を追記（元打刻は削除しない = 記録系保護）
  app.post('/fix-requests/:id/decision', async (c) => {
    const user = c.get('user')
    if (user.role !== 'admin') {
      throw err('AKO-ATT-004', 'この操作には管理者権限が必要です', 403)
    }
    const fixId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { action?: 'approved' | 'rejected' }
    if (body.action !== 'approved' && body.action !== 'rejected') {
      throw err('AKO-GEN-001', 'action は approved / rejected を指定してください', 400)
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const req = await client.query(
        `SELECT id, member_id AS "memberId", date, kind, requested_at AS "requestedAt", reason, status
         FROM attendance_fix_requests WHERE id = $1 FOR UPDATE`,
        [fixId],
      )
      const fix = req.rows[0] as {
        memberId: string; date: string; kind: PunchKind; requestedAt: string; reason: string; status: string
      } | undefined
      if (!fix || fix.status !== 'pending') {
        throw err('AKO-ATT-003', 'この申請は処理済みです', 409)
      }
      if (body.action === 'approved') {
        const { rows } = await client.query<PunchRecord>(
          `SELECT ${PUNCH_COLS} FROM punch_records WHERE member_id = $1 AND date = $2 ORDER BY at`,
          [fix.memberId, fix.date],
        )
        // 置換対象 = 現在有効な同種打刻（fix の連鎖でも effectivePunches が最新のみ返す）
        const existing = effectivePunches(rows).find(p => p.kind === fix.kind)
        await client.query(
          `INSERT INTO punch_records (id, member_id, date, kind, at, source, fixed_from, fix_reason, approved_by)
           VALUES ($1, $2, $3, $4, $5, 'fix', $6, $7, $8)`,
          [newId('pch'), fix.memberId, fix.date, fix.kind, fix.requestedAt, existing?.at ?? null, fix.reason, user.id],
        )
      }
      await client.query(
        `UPDATE attendance_fix_requests SET status = $2, decided_by = $3, updated_at = now() WHERE id = $1`,
        [fixId, body.action, user.id],
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    await audit(pool, { actorId: user.id, action: body.action, entity: 'attendance_fix_requests', entityId: fixId })
    return c.json({ data: { id: fixId } })
  })

  return app
}
