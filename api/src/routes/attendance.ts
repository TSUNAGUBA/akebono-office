/**
 * 勤怠 API（打刻・日次/月次集計・タイムカード・36 協定・修正申請）。
 * 集計はすべてサーバーサイドで実行する（Phase 7 方針: 重い処理はサーバーサイド）。
 * エラーコード: AKO-ATT-001（状態機械違反）/ 002（理由未入力）/ 003（処理済み申請）/ 004（承認/取下げ権限）
 *              / 005（直行/直帰が未承認で打刻修正できない）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { effectivePunches } from '../../../shared/domain/attendance-calc'
import { directKindsOf, resolveAttendanceRoute } from '../../../shared/domain/attendance-route'
import { pickApprover } from '../../../shared/domain/approver'
import { addDays, nowJstIso, todayJst } from '../../../shared/domain/jst'
import { canViewAllTimecards } from '../../../shared/domain/permissions'
import type {
  AttendanceRoute, AttendanceRouteStep, DirectType, Member, PunchKind, PunchRecord,
  AttendanceRule,
} from '../../../shared/domain/types'
import { requireHrOrAdmin } from '../auth'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import {
  article36Alerts, daySummary, monthSummary, PUNCH_ALLOWED, punchState, resolveRule,
} from '../domain/attendance'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { notify, notifyAdmins } from '../lib/notify'

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
    `SELECT ${PUNCH_COLS} FROM punch_records WHERE member_id = $1 AND date = $2 ORDER BY at, created_at`,
    [memberId, date],
  )
  return rows
}

/**
 * 勤怠ルールの SELECT 列（AttendanceRule 型と 1:1。参照箇所で共通利用 = 列追加時の更新漏れ防止）。
 * PR #43 レビュー指摘: 列リストの重複で workingWeekdays 等の追加が一部にしか反映されない事故を防ぐ
 */
export const ATTENDANCE_RULE_COLS = `id, name, applies_to AS "appliesTo", default_for AS "defaultFor",
  work_start AS "workStart", work_end AS "workEnd", break_minutes AS "breakMinutes",
  flex, closing_day AS "closingDay", legal_holiday_weekday AS "legalHolidayWeekday",
  working_weekdays AS "workingWeekdays", holiday_aware AS "holidayAware", active`

/** メンバーへ適用する勤怠ルールの解決（assist の翌営業日計算でも再利用するため export） */
export async function ruleOf(pool: pg.Pool, memberId: string): Promise<AttendanceRule | undefined> {
  const member = await pool.query<Pick<Member, 'attendanceRuleId' | 'employmentType'>>(
    'SELECT attendance_rule_id AS "attendanceRuleId", employment_type AS "employmentType" FROM members WHERE id = $1',
    [memberId],
  )
  const rules = await pool.query(
    `SELECT ${ATTENDANCE_RULE_COLS} FROM attendance_rules ORDER BY id`)
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

// ---------- 勤怠承認ワークフロー（直行/直帰・打刻修正の多段承認。0040） ----------

const DIRECT_TYPES: DirectType[] = ['chokkou', 'chokki', 'both']
const DIRECT_TYPE_LABELS: Record<DirectType, string> = { chokkou: '直行', chokki: '直帰', both: '直行直帰' }

interface ApproverCandidate {
  id: string; name: string; role: string; title: string
}

/** 承認者解決の候補（在籍者のみ・id 順）。解決は共有 pickApprover（役職/ロール/個人）に委譲する */
async function approverCandidates(pool: pg.Pool): Promise<ApproverCandidate[]> {
  const { rows } = await pool.query<ApproverCandidate>(
    `SELECT id, name, role, title FROM members WHERE active = true ORDER BY id`)
  return rows
}

/**
 * 区分の有効な経路ステップを凍結用に解決する（該当なし = [] = 管理者単段フォールバック）。
 * ORDER BY id + 実 id を保持して resolveAttendanceRoute のタイブレーク（id.localeCompare）をモックと一致させる。
 */
async function freezeRouteSteps(pool: pg.Pool, category: 'direct' | 'fix'): Promise<AttendanceRouteStep[]> {
  const { rows } = await pool.query<{ id: string; steps: AttendanceRouteStep[] }>(
    `SELECT id, steps FROM attendance_routes WHERE active = true AND category = $1 ORDER BY id`, [category])
  const routes = rows.map(r => ({ id: r.id, category, steps: r.steps, active: true })) as AttendanceRoute[]
  return resolveAttendanceRoute(routes, category) ?? []
}

/**
 * 現ステップの承認者 id を返す（フォールバック単段 = snapshot 空なら null）。
 * currentStep は 1 始まり。範囲外は null。
 */
async function currentApproverId(
  pool: pg.Pool, snapshot: AttendanceRouteStep[], currentStep: number,
): Promise<string | null> {
  if (snapshot.length === 0) return null
  const step = [...snapshot].sort((a, b) => a.order - b.order)[currentStep - 1]
  if (!step) return null
  const cands = await approverCandidates(pool)
  return pickApprover(cands, step)?.id ?? null
}
// pickApprover は共有（shared/domain/approver.ts）。役職/ロール/個人 + 旧形式フォールバックを一元化。

/**
 * 承認アクションの実行権限を判定する。
 * - 経路なし（snapshot 空）: 管理者のみ（従来どおり）。
 * - 経路あり: 現ステップの承認者本人 または 管理者（管理者は経路承認をオーバーライド可 = 従来の管理者中心運用を維持）。
 */
async function canDecide(
  pool: pg.Pool, user: { id: string; role: string }, snapshot: AttendanceRouteStep[], currentStep: number,
): Promise<boolean> {
  if (user.role === 'admin') return true
  if (snapshot.length === 0) return false
  return (await currentApproverId(pool, snapshot, currentStep)) === user.id
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
        `SELECT ${PUNCH_COLS} FROM punch_records WHERE member_id = $1 AND date = $2 ORDER BY at, created_at`,
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
       ORDER BY at, created_at`,
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
       ORDER BY at, created_at`,
      [memberId, from],
    )
    const rule = await ruleOf(pool, memberId)
    return c.json({ data: article36Alerts(groupByDate(rows), rule, endMonth) })
  })

  // 全員のタイムカード（期間 × 部署 × 氏名でフィルタし日別の出退勤を返す）。
  // 参照可否は権限表（attendance / timecard-all。既定 = 管理者/人事のみ = 従来ガードと同値）で制御する
  app.get('/timecard', async (c) => {
    const user = c.get('user')
    if (!canViewAllTimecards(await activePermissionRules(pool), subjectOf(user))) {
      throw err('AKO-ATT-004', '全員のタイムカードを参照する権限がありません', 403)
    }
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
       ORDER BY at, created_at`,
      [memberIds, from, to],
    )
    const rules = await pool.query(
      `SELECT ${ATTENDANCE_RULE_COLS} FROM attendance_rules ORDER BY id`)

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

  // 打刻修正申請（理由必須）。directRequestId 指定時は「承認済みの直行/直帰」を前提に解禁される修正
  app.post('/fix-requests', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as {
      date?: string; kind?: PunchKind; requestedAt?: string; reason?: string; directRequestId?: string
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
    // 直行/直帰起因の修正は「本人の承認済み直行/直帰申請（同日・対象打刻種別）」が前提（AKO-ATT-005）
    const directRequestId = body.directRequestId ?? null
    if (directRequestId) {
      const dr = await pool.query<{ type: DirectType; status: string; date: string }>(
        `SELECT type, status, to_char(date,'YYYY-MM-DD') AS date FROM direct_requests
         WHERE id = $1 AND member_id = $2`, [directRequestId, user.id])
      const d = dr.rows[0]
      if (!d || d.status !== 'approved' || d.date !== body.date || !directKindsOf(d.type).includes(body.kind)) {
        throw err('AKO-ATT-005', 'この日は直行/直帰が承認されていないため、打刻修正を申請できません', 409)
      }
    }
    const snapshot = await freezeRouteSteps(pool, 'fix')
    const status = snapshot.length > 0 ? 'in_review' : 'pending'
    const id = newId('fix')
    await pool.query(
      `INSERT INTO attendance_fix_requests
         (id, member_id, date, kind, requested_at, reason, status, current_step, route_snapshot, direct_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`,
      [id, user.id, body.date, body.kind, body.requestedAt, body.reason.trim(),
        status, JSON.stringify(snapshot), directRequestId],
    )
    // 通知は補助処理（原則4）。経路ありは現ステップ承認者へ / なしは管理者一斉（従来挙動）
    const approverId = await currentApproverId(pool, snapshot, 1)
    if (approverId && approverId !== user.id) {
      await notify(pool, approverId, 'approval', '打刻修正申請',
        `${user.name} さんから ${body.date} の修正申請`, '/attendance')
    } else if (!approverId) {
      await notifyAdmins(pool, 'approval', '打刻修正申請',
        `${user.name} さんから ${body.date} の修正申請`, '/attendance')
    }
    return c.json({ data: { id } }, 201)
  })

  // 修正申請一覧（本人 = 自分の申請 / 管理者・人事 = 全件（status 指定可）。承認は経路の現ステップ承認者 or 管理者）
  app.get('/fix-requests', async (c) => {
    const user = c.get('user')
    const status = c.req.query('status') ?? ''
    const all = c.req.query('scope') === 'all'
    if (all) requireHrOrAdmin(c)
    const { rows } = await pool.query(
      `SELECT id, member_id AS "memberId", to_char(date,'YYYY-MM-DD') AS date, kind,
              requested_at AS "requestedAt", reason, status, decided_by AS "decidedBy",
              current_step AS "currentStep", route_snapshot AS "routeSnapshot",
              direct_request_id AS "directRequestId", created_at AS "createdAt"
       FROM attendance_fix_requests
       WHERE ($1 = '' OR status = $1) AND ($2 OR member_id = $3)
       ORDER BY created_at DESC`,
      [status, all, user.id],
    )
    return c.json({ data: rows })
  })

  // 修正申請の承認/却下（経路の現ステップ承認者 or 管理者）。多段経路は最終ステップ承認時のみ打刻を追記。
  // 承認時は修正打刻を追記（元打刻は削除しない = 記録系保護）
  app.post('/fix-requests/:id/decision', async (c) => {
    const user = c.get('user')
    const fixId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { action?: 'approved' | 'rejected' }
    if (body.action !== 'approved' && body.action !== 'rejected') {
      throw err('AKO-GEN-001', 'action は approved / rejected を指定してください', 400)
    }
    let advanced: { finalized: boolean; nextApproverId: string | null; memberId: string; date: string } | null = null
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const req = await client.query(
        `SELECT id, member_id AS "memberId", to_char(date,'YYYY-MM-DD') AS date, kind,
                requested_at AS "requestedAt", reason, status,
                current_step AS "currentStep", route_snapshot AS "routeSnapshot"
         FROM attendance_fix_requests WHERE id = $1 FOR UPDATE`,
        [fixId],
      )
      const fix = req.rows[0] as {
        memberId: string; date: string; kind: PunchKind; requestedAt: string; reason: string
        status: string; currentStep: number; routeSnapshot: AttendanceRouteStep[]
      } | undefined
      if (!fix || (fix.status !== 'pending' && fix.status !== 'in_review')) {
        throw err('AKO-ATT-003', 'この申請は処理済みです', 409)
      }
      if (!await canDecide(pool, user, fix.routeSnapshot, fix.currentStep)) {
        throw err('AKO-ATT-004', 'この申請を承認する権限がありません', 403)
      }
      if (body.action === 'rejected') {
        await client.query(
          `UPDATE attendance_fix_requests SET status = 'rejected', decided_by = $2, updated_at = now() WHERE id = $1`,
          [fixId, user.id])
      } else {
        const isLast = fix.currentStep >= Math.max(1, fix.routeSnapshot.length)
        if (!isLast) {
          await client.query(
            `UPDATE attendance_fix_requests SET current_step = current_step + 1, status = 'in_review', updated_at = now() WHERE id = $1`,
            [fixId])
          advanced = {
            finalized: false,
            nextApproverId: await currentApproverId(pool, fix.routeSnapshot, fix.currentStep + 1),
            memberId: fix.memberId, date: fix.date,
          }
        } else {
          const { rows } = await client.query<PunchRecord>(
            `SELECT ${PUNCH_COLS} FROM punch_records WHERE member_id = $1 AND date = $2 ORDER BY at, created_at`,
            [fix.memberId, fix.date])
          // 置換対象 = 現在有効な同種打刻（fix の連鎖でも effectivePunches が最新のみ返す）
          const existing = effectivePunches(rows).find(p => p.kind === fix.kind)
          await client.query(
            `INSERT INTO punch_records (id, member_id, date, kind, at, source, fixed_from, fix_reason, approved_by)
             VALUES ($1, $2, $3, $4, $5, 'fix', $6, $7, $8)`,
            [newId('pch'), fix.memberId, fix.date, fix.kind, fix.requestedAt, existing?.at ?? null, fix.reason, user.id])
          await client.query(
            `UPDATE attendance_fix_requests SET status = 'approved', decided_by = $2, updated_at = now() WHERE id = $1`,
            [fixId, user.id])
          advanced = { finalized: true, nextApproverId: null, memberId: fix.memberId, date: fix.date }
        }
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    await audit(pool, { actorId: user.id, action: body.action, entity: 'attendance_fix_requests', entityId: fixId })
    // 次ステップ承認者への通知（補助処理・非ブロッキング）
    if (advanced && !advanced.finalized && advanced.nextApproverId && advanced.nextApproverId !== user.id) {
      await notify(pool, advanced.nextApproverId, 'approval', '打刻修正申請',
        `${advanced.date} の修正申請が次の承認へ進みました`, '/attendance')
    }
    return c.json({ data: { id: fixId } })
  })

  // ---------- 直行/直帰 申請（承認系・多段。承認後に当日の打刻修正が申請可能になる） ----------

  // 直行/直帰 申請（本人）
  app.post('/direct-requests', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { date?: string; type?: DirectType; reason?: string }
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      throw err('AKO-GEN-001', '対象日（date）を指定してください', 400)
    }
    if (!body.type || !DIRECT_TYPES.includes(body.type)) {
      throw err('AKO-GEN-001', '種別（直行/直帰/直行直帰）を指定してください', 400)
    }
    if (!body.reason?.trim()) throw err('AKO-ATT-002', '理由を入力してください', 400)
    const snapshot = await freezeRouteSteps(pool, 'direct')
    const status = snapshot.length > 0 ? 'in_review' : 'pending'
    const id = newId('dr')
    await pool.query(
      `INSERT INTO direct_requests (id, member_id, date, type, reason, status, current_step, route_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7)`,
      [id, user.id, body.date, body.type, body.reason.trim(), status, JSON.stringify(snapshot)])
    const approverId = await currentApproverId(pool, snapshot, 1)
    if (approverId && approverId !== user.id) {
      await notify(pool, approverId, 'approval', '直行/直帰申請',
        `${user.name} さんから ${body.date} の${DIRECT_TYPE_LABELS[body.type]}申請`, '/attendance')
    } else if (!approverId) {
      await notifyAdmins(pool, 'approval', '直行/直帰申請',
        `${user.name} さんから ${body.date} の${DIRECT_TYPE_LABELS[body.type]}申請`, '/attendance')
    }
    return c.json({ data: { id } }, 201)
  })

  // 直行/直帰 申請一覧（本人 = 自分 / 管理者・人事 = 全件）
  app.get('/direct-requests', async (c) => {
    const user = c.get('user')
    const statusQ = c.req.query('status') ?? ''
    const all = c.req.query('scope') === 'all'
    if (all) requireHrOrAdmin(c)
    const { rows } = await pool.query(
      `SELECT id, member_id AS "memberId", to_char(date,'YYYY-MM-DD') AS date, type, reason, status,
              current_step AS "currentStep", route_snapshot AS "routeSnapshot", decided_by AS "decidedBy",
              created_at AS "createdAt"
       FROM direct_requests
       WHERE ($1 = '' OR status = $1) AND ($2 OR member_id = $3)
       ORDER BY created_at DESC`,
      [statusQ, all, user.id])
    return c.json({ data: rows })
  })

  // 直行/直帰 申請の承認/却下/取下げ（多段。最終承認で approved = 当日の打刻修正が解禁される）
  app.post('/direct-requests/:id/actions', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { action?: 'approved' | 'rejected' | 'withdrawn' }
    if (!['approved', 'rejected', 'withdrawn'].includes(body.action ?? '')) {
      throw err('AKO-GEN-001', 'action は approved / rejected / withdrawn を指定してください', 400)
    }
    let next: { approverId: string | null; date: string } | null = null
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const r = await client.query(
        `SELECT id, member_id AS "memberId", to_char(date,'YYYY-MM-DD') AS date, status,
                current_step AS "currentStep", route_snapshot AS "routeSnapshot"
         FROM direct_requests WHERE id = $1 FOR UPDATE`, [id])
      const dr = r.rows[0] as {
        memberId: string; date: string; status: string; currentStep: number; routeSnapshot: AttendanceRouteStep[]
      } | undefined
      if (!dr || (dr.status !== 'pending' && dr.status !== 'in_review')) {
        throw err('AKO-ATT-003', 'この申請は処理済みです', 409)
      }
      if (body.action === 'withdrawn') {
        // 取下げは申請者本人のみ（原則9.5 の取消フロー）
        if (dr.memberId !== user.id) throw err('AKO-ATT-004', '取下げは申請者本人のみ可能です', 403)
        await client.query(`UPDATE direct_requests SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [id])
      } else {
        if (!await canDecide(pool, user, dr.routeSnapshot, dr.currentStep)) {
          throw err('AKO-ATT-004', 'この申請を承認する権限がありません', 403)
        }
        if (body.action === 'rejected') {
          await client.query(
            `UPDATE direct_requests SET status = 'rejected', decided_by = $2, updated_at = now() WHERE id = $1`,
            [id, user.id])
        } else {
          const isLast = dr.currentStep >= Math.max(1, dr.routeSnapshot.length)
          if (!isLast) {
            await client.query(
              `UPDATE direct_requests SET current_step = current_step + 1, status = 'in_review', updated_at = now() WHERE id = $1`,
              [id])
            next = { approverId: await currentApproverId(pool, dr.routeSnapshot, dr.currentStep + 1), date: dr.date }
          } else {
            await client.query(
              `UPDATE direct_requests SET status = 'approved', decided_by = $2, updated_at = now() WHERE id = $1`,
              [id, user.id])
          }
        }
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    await audit(pool, { actorId: user.id, action: body.action!, entity: 'direct_requests', entityId: id })
    if (next && next.approverId && next.approverId !== user.id) {
      await notify(pool, next.approverId, 'approval', '直行/直帰申請',
        `${next.date} の直行/直帰申請が次の承認へ進みました`, '/attendance')
    }
    return c.json({ data: { id } })
  })

  return app
}
