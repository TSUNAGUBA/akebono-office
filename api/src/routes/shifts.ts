/**
 * シフト API（F-05）。mockup useShifts の API 版。
 * - 期間状態は draft→open→closed→adjusting→published の正順のみ（FOR UPDATE クレームで直列化）
 * - 希望は open かつ締切内・本人のみ（設定系 = UNIQUE upsert で上書き）。割当は adjusting 中のみ変更可
 * - 確定・公開は transition(published) が割当 confirmed 化 + スタッフ通知まで担う
 * - 確定後変更は requestChange（管理者）→ 本人 consent の 2 段階（労基法上の本人合意）
 * - 割当バリデーション（労基法34/61条・週40h・希望NG）は shared/domain/shift.validateShiftAssign を共有
 * エラー: AKO-SFT-001（年少者深夜 = 割当不可）/ 002（状態遷移違反）/ 003（受付外の希望操作）/
 *         004（調整中以外の割当変更）/ 005（対象なし）/ 006（確定後変更・合意の状態不正）/
 *         007（期間・日付・時刻入力の不正）/ 008（管理者権限なし）
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import type pg from 'pg'
import { addDays, nowJstIso, todayJst, weekdayOf } from '../../../shared/domain/jst'
import { shiftSpan, SHIFT_STATUS_FLOW, validateShiftAssign } from '../../../shared/domain/shift'
import type { ShiftPeriod, ShiftPeriodStatus, ShiftWishKind } from '../../../shared/domain/types'
import type { AuthUser } from '../auth'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { notify, notifyAdmins } from '../lib/notify'

/** シフト管理操作の権限ガード（mockup と同一のドメイン固有コード AKO-SFT-008） */
function requireShiftAdmin(c: Context): AuthUser {
  const user = c.get('user')
  if (user.role !== 'admin') throw err('AKO-SFT-008', 'この操作には管理者権限が必要です', 403)
  return user
}

const WISH_KINDS: ShiftWishKind[] = ['want', 'ng', 'either']
const STATUS_LABELS: Record<ShiftPeriodStatus, string> = {
  draft: '準備中', open: '希望受付中', closed: '締切', adjusting: '調整中', published: '確定公開',
}

const PERIOD_COLS = `id, label, start_date AS "startDate", end_date AS "endDate",
  wish_deadline AS "wishDeadline", status`
const WISH_COLS = `id, period_id AS "periodId", member_id AS "memberId", date::text AS date,
  wish, from_time AS "from", to_time AS "to"`
const ASSIGN_COLS = `id, period_id AS "periodId", member_id AS "memberId", date::text AS date,
  from_time AS "from", to_time AS "to", status, consent_at AS "consentAt"`
const DEMAND_COLS = `id, period_id AS "periodId", date::text AS date,
  from_time AS "from", to_time AS "to", required`

function isHhmm(v: unknown): v is string {
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)
}

const WEEKDAYS_JP = ['日', '月', '火', '水', '木', '金', '土'] as const

/** YYYY-MM-DD → YYYY/M/D(曜)。mockup の fmtDateLong と同一表示（メッセージのモード間整合） */
function jpDateLong(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return `${y}/${m}/${d}(${WEEKDAYS_JP[weekdayOf(dateKey)]})`
}

/** YYYY-MM-DD → M/D。mockup の fmtDate と同一表示 */
function jpDate(dateKey: string): string {
  return `${Number(dateKey.slice(5, 7))}/${Number(dateKey.slice(8, 10))}`
}

function isDateKey(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

async function periodById(db: pg.Pool | pg.PoolClient, id: string, forUpdate = false): Promise<ShiftPeriod> {
  const { rows } = await db.query<ShiftPeriod>(
    `SELECT ${PERIOD_COLS} FROM shift_periods WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id])
  const p = rows[0]
  if (!p) throw err('AKO-SFT-005', '対象の募集期間が見つかりません', 404)
  return p
}

/** 希望の提出・変更ガード（open 中・締切内・期間内の日付） */
function wishGuard(p: ShiftPeriod, date?: string): void {
  if (p.status !== 'open') {
    throw err('AKO-SFT-003', '希望の提出・変更は「希望受付中」の期間のみ可能です', 409)
  }
  if (todayJst() > p.wishDeadline) {
    throw err('AKO-SFT-003', `希望締切（${jpDateLong(p.wishDeadline)}）を過ぎているため提出できません`, 409)
  }
  if (date && (date < p.startDate || date > p.endDate)) {
    throw err('AKO-SFT-007', '期間外の日付には提出できません', 400)
  }
}

/**
 * 割当バリデーション（shared 共有ロジック + DB から文脈収集）
 * error 級（年少者深夜・時刻不正）が 1 件でもあれば例外。warn は返して呼び出し側が応答へ含める
 */
async function validateAssignOrThrow(
  db: pg.Pool | pg.PoolClient,
  input: { periodId: string; memberId: string; date: string; from: string; to: string; excludeAssignmentId?: string },
): Promise<{ code: string; level: 'error' | 'warn'; message: string }[]> {
  const { rows: memberRows } = await db.query<{ name: string; birthDate: string | null }>(
    `SELECT name, birth_date AS "birthDate" FROM members WHERE id = $1 AND active = true`, [input.memberId])
  const member = memberRows[0]
  if (!member) throw err('AKO-SFT-005', '対象のメンバーが見つかりません', 404)

  const weekStart = addDays(input.date, -weekdayOf(input.date))
  const weekEnd = addDays(weekStart, 6)
  const { rows: weekRows } = await db.query<{ from: string; to: string }>(
    `SELECT from_time AS "from", to_time AS "to" FROM shift_assignments
     WHERE member_id = $1 AND date >= $2::date AND date <= $3::date AND id <> $4`,
    [input.memberId, weekStart, weekEnd, input.excludeAssignmentId ?? ''])
  const weekAssignedMinutes = weekRows.reduce((sum, a) => sum + shiftSpan(a.from, a.to).minutes, 0)

  const { rows: wishRows } = await db.query<{ wish: ShiftWishKind }>(
    `SELECT wish FROM shift_wishes WHERE period_id = $1 AND member_id = $2 AND date = $3::date`,
    [input.periodId, input.memberId, input.date])

  const warnings = validateShiftAssign({
    memberName: member.name,
    birthDate: member.birthDate,
    date: input.date,
    from: input.from,
    to: input.to,
    weekAssignedMinutes,
    weekStartDate: weekStart,
    hasNgWish: wishRows[0]?.wish === 'ng',
  })
  const fatal = warnings.find(w => w.level === 'error')
  if (fatal) throw err(fatal.code, fatal.message, 409)
  return warnings.filter(w => w.level === 'warn')
}

export function shiftsRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 一括ハイドレーション（期間・必要人数は全員 / 希望・割当は管理者 = 全件、本人 = 自分のみ）
  app.get('/', async (c) => {
    const user = c.get('user')
    const scopeAll = user.role === 'admin'
    const [periods, wishes, assignments, demands] = await Promise.all([
      pool.query(`SELECT ${PERIOD_COLS} FROM shift_periods ORDER BY start_date DESC LIMIT 200`),
      pool.query(
        `SELECT ${WISH_COLS} FROM shift_wishes WHERE ($1 OR member_id = $2) ORDER BY date LIMIT 5000`,
        [scopeAll, user.id]),
      pool.query(
        `SELECT ${ASSIGN_COLS} FROM shift_assignments WHERE ($1 OR member_id = $2) ORDER BY date LIMIT 5000`,
        [scopeAll, user.id]),
      pool.query(`SELECT ${DEMAND_COLS} FROM shift_demands ORDER BY date LIMIT 5000`),
    ])
    return c.json({
      data: {
        periods: periods.rows,
        wishes: wishes.rows,
        assignments: assignments.rows,
        demands: demands.rows,
      },
    })
  })

  // 募集期間の作成（管理者・状態は draft 固定）
  app.post('/periods', async (c) => {
    const user = requireShiftAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const label = String(body.label ?? '').trim()
    if (!label) throw err('AKO-SFT-007', '期間名を入力してください', 400)
    if (!isDateKey(body.startDate) || !isDateKey(body.endDate) || !isDateKey(body.wishDeadline)) {
      throw err('AKO-SFT-007', '開始日・終了日・希望締切をすべて入力してください', 400)
    }
    if (body.endDate < body.startDate) {
      throw err('AKO-SFT-007', '終了日は開始日以降の日付にしてください', 400)
    }
    if (body.wishDeadline > body.startDate) {
      throw err('AKO-SFT-007', '希望締切は開始日以前の日付にしてください（調整期間の確保）', 400)
    }
    const id = newId('sp')
    await pool.query(
      `INSERT INTO shift_periods (id, label, start_date, end_date, wish_deadline, status)
       VALUES ($1, $2, $3, $4, $5, 'draft')`,
      [id, label, body.startDate, body.endDate, body.wishDeadline])
    void user
    return c.json({ data: { id } }, 201)
  })

  // 状態遷移（管理者・正順のみ）。published への遷移は割当 confirmed 化 + スタッフ通知を伴う
  app.post('/periods/:id/transition', async (c) => {
    requireShiftAdmin(c)
    const periodId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { next?: string }
    const next = body.next as ShiftPeriodStatus
    if (!SHIFT_STATUS_FLOW.includes(next)) {
      throw err('AKO-GEN-001', '遷移先（next）を指定してください', 400)
    }
    const client = await pool.connect()
    let notifyTargets: string[] = []
    let period: ShiftPeriod
    try {
      await client.query('BEGIN')
      period = await periodById(client, periodId, true) // クレームファースト
      if (SHIFT_STATUS_FLOW.indexOf(next) !== SHIFT_STATUS_FLOW.indexOf(period.status) + 1) {
        const flow = SHIFT_STATUS_FLOW.map(s => STATUS_LABELS[s]).join('→')
        throw err('AKO-SFT-002',
          `「${STATUS_LABELS[period.status]}」から「${STATUS_LABELS[next]}」へは遷移できません（${flow} の順のみ）`, 409)
      }
      await client.query(
        `UPDATE shift_periods SET status = $2, updated_at = now() WHERE id = $1`, [periodId, next])
      if (next === 'published') {
        const { rows } = await client.query<{ memberId: string }>(
          `UPDATE shift_assignments SET status = 'confirmed', updated_at = now()
           WHERE period_id = $1 RETURNING member_id AS "memberId"`, [periodId])
        notifyTargets = [...new Set(rows.map(r => r.memberId))]
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    // 補助処理: 通知（コミット後・非ブロッキング）
    for (const memberId of notifyTargets) {
      await notify(pool, memberId, 'system', 'シフトが確定しました',
        `${period.label}（${jpDate(period.startDate)}〜${jpDate(period.endDate)}）のシフトが公開されました`, '/shift')
    }
    return c.json({ data: { id: periodId, status: next } })
  })

  // 希望の提出・変更（本人のみ。同一日への再提出は上書き = 設定系）
  app.put('/wishes', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const periodId = String(body.periodId ?? '')
    const wish = body.wish as ShiftWishKind
    if (!periodId || !isDateKey(body.date) || !WISH_KINDS.includes(wish)) {
      throw err('AKO-GEN-001', 'periodId / date / wish を指定してください', 400)
    }
    const p = await periodById(pool, periodId)
    wishGuard(p, body.date)
    const from = wish === 'want' ? (isHhmm(body.from) ? body.from : '10:00') : null
    const to = wish === 'want' ? (isHhmm(body.to) ? body.to : '17:00') : null
    const id = newId('sw')
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO shift_wishes (id, period_id, member_id, date, wish, from_time, to_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (period_id, member_id, date)
       DO UPDATE SET wish = EXCLUDED.wish, from_time = EXCLUDED.from_time,
                     to_time = EXCLUDED.to_time, updated_at = now()
       RETURNING id`,
      [id, periodId, user.id, body.date, wish, from, to])
    return c.json({ data: { id: rows[0]!.id } })
  })

  // 希望の取消（本人のみ・締切内のみ）
  app.post('/wishes/clear', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const periodId = String(body.periodId ?? '')
    if (!periodId || !isDateKey(body.date)) {
      throw err('AKO-GEN-001', 'periodId / date を指定してください', 400)
    }
    const p = await periodById(pool, periodId)
    wishGuard(p, body.date)
    const { rows } = await pool.query<{ id: string }>(
      `DELETE FROM shift_wishes WHERE period_id = $1 AND member_id = $2 AND date = $3::date RETURNING id`,
      [periodId, user.id, body.date])
    if (!rows[0]) throw err('AKO-SFT-005', 'この日の希望は未提出です', 404)
    return c.json({ data: { id: rows[0].id } })
  })

  // 割当の作成・更新（管理者・調整中のみ。更新時は tentative へ戻し合意記録をクリア）
  // 期間行を FOR UPDATE でクレームし、並行する transition(published) と直列化する
  // （非ロックだと published 期間に tentative 割当が残る競合窓ができる）
  app.post('/assignments', async (c) => {
    requireShiftAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const periodId = String(body.periodId ?? '')
    const memberId = String(body.memberId ?? '')
    if (!periodId || !memberId || !isDateKey(body.date)) {
      throw err('AKO-GEN-001', 'periodId / memberId / date を指定してください', 400)
    }
    if (!isHhmm(body.from) || !isHhmm(body.to)) {
      throw err('AKO-SFT-007', '開始・終了時刻を正しく入力してください', 400)
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const p = await periodById(client, periodId, true)
      if (p.status !== 'adjusting') {
        throw err('AKO-SFT-004', '割当の変更は期間が「調整中」のときのみ可能です', 409)
      }
      if (body.date < p.startDate || body.date > p.endDate) {
        throw err('AKO-SFT-007', '期間外の日付には割当できません', 400)
      }
      const { rows: existingRows } = await client.query<{ id: string }>(
        `SELECT id FROM shift_assignments WHERE period_id = $1 AND member_id = $2 AND date = $3::date`,
        [periodId, memberId, body.date])
      const warnings = await validateAssignOrThrow(client, {
        periodId, memberId, date: body.date, from: body.from, to: body.to,
        excludeAssignmentId: existingRows[0]?.id,
      })
      const id = newId('sa')
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO shift_assignments (id, period_id, member_id, date, from_time, to_time, status, consent_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'tentative', NULL)
         ON CONFLICT (period_id, member_id, date)
         DO UPDATE SET from_time = EXCLUDED.from_time, to_time = EXCLUDED.to_time,
                       status = 'tentative', consent_at = NULL, updated_at = now()
         RETURNING id`,
        [id, periodId, memberId, body.date, body.from, body.to])
      await client.query('COMMIT')
      return c.json({ data: { id: rows[0]!.id, warnings } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  })

  // 割当の解除（管理者・調整中のみ。期間行の FOR UPDATE で transition と直列化）
  app.post('/assignments/:id/unassign', async (c) => {
    requireShiftAdmin(c)
    const assignmentId = c.req.param('id')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ id: string; periodId: string }>(
        `SELECT id, period_id AS "periodId" FROM shift_assignments WHERE id = $1`, [assignmentId])
      const a = rows[0]
      if (!a) throw err('AKO-SFT-005', '対象の割当が見つかりません', 404)
      const p = await periodById(client, a.periodId, true)
      if (p.status !== 'adjusting') {
        throw err('AKO-SFT-004', '割当の解除は期間が「調整中」のときのみ可能です', 409)
      }
      await client.query(`DELETE FROM shift_assignments WHERE id = $1`, [assignmentId])
      await client.query('COMMIT')
      return c.json({ data: { id: assignmentId } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  })

  // 確定後変更の申請（管理者・published + confirmed のみ → change_requested。本人へ合意依頼通知）
  app.post('/assignments/:id/request-change', async (c) => {
    requireShiftAdmin(c)
    const assignmentId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    if (!isHhmm(body.from) || !isHhmm(body.to)) {
      throw err('AKO-SFT-007', '開始・終了時刻を正しく入力してください', 400)
    }
    const client = await pool.connect()
    let target: { memberId: string; date: string } | null = null
    try {
      await client.query('BEGIN')
      // クレームファースト: confirmed のみ変更申請へ進める
      const { rows } = await client.query<{ memberId: string; date: string; periodId: string; status: string }>(
        `SELECT member_id AS "memberId", date::text AS date, period_id AS "periodId", status
         FROM shift_assignments WHERE id = $1 FOR UPDATE`, [assignmentId])
      const a = rows[0]
      if (!a) throw err('AKO-SFT-005', '対象の割当が見つかりません', 404)
      const p = await periodById(client, a.periodId)
      if (p.status !== 'published') {
        throw err('AKO-SFT-006', '確定後変更は公開済みの期間のみ対象です', 409)
      }
      if (a.status !== 'confirmed') {
        throw err('AKO-SFT-006', 'この割当は確定状態ではないため変更申請できません', 409)
      }
      await validateAssignOrThrow(client, {
        periodId: a.periodId, memberId: a.memberId, date: a.date,
        from: body.from, to: body.to, excludeAssignmentId: assignmentId,
      })
      await client.query(
        `UPDATE shift_assignments
         SET from_time = $2, to_time = $3, status = 'change_requested', consent_at = NULL, updated_at = now()
         WHERE id = $1`,
        [assignmentId, body.from, body.to])
      await client.query('COMMIT')
      target = { memberId: a.memberId, date: a.date }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    await notify(pool, target.memberId, 'system', 'シフト変更の合意依頼',
      `${jpDateLong(target.date)} のシフトを ${body.from}〜${body.to} へ変更する申請があります。確認して合意してください`, '/shift')
    return c.json({ data: { id: assignmentId } })
  })

  // 変更への本人合意（change_requested のみ・本人のみ。consent_at を記録して confirmed へ）
  app.post('/assignments/:id/consent', async (c) => {
    const user = c.get('user')
    const assignmentId = c.req.param('id')
    const client = await pool.connect()
    let consented: { from: string; to: string; date: string } | null = null
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ memberId: string; date: string; from: string; to: string; status: string }>(
        `SELECT member_id AS "memberId", date::text AS date, from_time AS "from", to_time AS "to", status
         FROM shift_assignments WHERE id = $1 FOR UPDATE`, [assignmentId])
      const a = rows[0]
      if (!a) throw err('AKO-SFT-005', '対象の割当が見つかりません', 404)
      if (a.status !== 'change_requested') {
        throw err('AKO-SFT-006', '合意待ちの変更はありません', 409)
      }
      if (a.memberId !== user.id) {
        throw err('AKO-SFT-006', 'シフト変更への合意は本人のみ行えます（労務上の本人合意）', 403)
      }
      await client.query(
        `UPDATE shift_assignments SET status = 'confirmed', consent_at = $2, updated_at = now() WHERE id = $1`,
        [assignmentId, nowJstIso()])
      await client.query('COMMIT')
      consented = { from: a.from, to: a.to, date: a.date }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    await notifyAdmins(pool, 'system', 'シフト変更に本人が合意',
      `${user.name} さんが ${jpDateLong(consented.date)} のシフト変更（${consented.from}〜${consented.to}）に合意しました`, '/shift')
    return c.json({ data: { id: assignmentId } })
  })

  // 必要人数の設定（管理者。日別 1 スロット upsert・0 人で削除 = 設定系）
  app.put('/demands', async (c) => {
    requireShiftAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const periodId = String(body.periodId ?? '')
    // 小数は切り捨ててから 0 判定する（0.5 が CHECK (required > 0) 違反で 500 になるのを防ぐ）
    const required = Math.floor(Number(body.required))
    if (!periodId || !isDateKey(body.date) || !Number.isFinite(required)) {
      throw err('AKO-GEN-001', 'periodId / date / required を指定してください', 400)
    }
    await periodById(pool, periodId)
    if (required <= 0) {
      const { rows } = await pool.query<{ id: string }>(
        `DELETE FROM shift_demands WHERE period_id = $1 AND date = $2::date RETURNING id`,
        [periodId, body.date])
      return c.json({ data: { id: rows[0]?.id ?? null } })
    }
    if (!isHhmm(body.from) || !isHhmm(body.to)) {
      throw err('AKO-SFT-007', '開始・終了時刻を正しく入力してください', 400)
    }
    const id = newId('sd')
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO shift_demands (id, period_id, date, from_time, to_time, required)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (period_id, date)
       DO UPDATE SET from_time = EXCLUDED.from_time, to_time = EXCLUDED.to_time,
                     required = EXCLUDED.required, updated_at = now()
       RETURNING id`,
      [id, periodId, body.date, body.from, body.to, required])
    return c.json({ data: { id: rows[0]!.id } })
  })

  return app
}
