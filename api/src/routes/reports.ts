/**
 * 日報・週報 API。mockup useReports の API 版。
 * - 提出済みは編集不可（AKO-REP-001/002 = 記録系の状態保護）
 * - 工数乖離チェック（勤怠実労働との差 60 分超で hoursGapMinutes を返す = 画面が警告表示）
 * - チーム参照（scope=team）は管理者のみ。コメントは提出済み日報に対して全員可
 * 注: 提出時のエスカレーション起票・通知はバッチ2（通知ドメイン）で API 化する（実装状況マトリクス参照）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { nowJstIso, todayJst } from '../../../shared/domain/jst'
import type { PunchRecord, ReportEntry } from '../../../shared/domain/types'
import { requireAdmin } from '../auth'
import { daySummary } from '../domain/attendance'
import { raiseEscalation } from '../lib/escalate'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { notify } from '../lib/notify'

const DAILY_COLS = `id, author_kind AS "authorKind", member_id AS "memberId",
  ai_employee_id AS "aiEmployeeId", date, entries, reflection, issues, tomorrow,
  status, submitted_at AS "submittedAt"`
const WEEKLY_COLS = `id, member_id AS "memberId", week_start AS "weekStart",
  goal_review AS "goalReview", main_work AS "mainWork", issues, next_week AS "nextWeek",
  status, submitted_at AS "submittedAt"`

/** エントリの正規化（mockup cleanEntries と同一: 0.25h 刻み・progress 0-100） */
function cleanEntries(entries: unknown): ReportEntry[] {
  if (!Array.isArray(entries)) return []
  return entries
    .map(e => e as Partial<ReportEntry>)
    .filter(e => (e.projectId ?? '') || String(e.task ?? '').trim())
    .map(e => ({
      projectId: String(e.projectId ?? ''),
      task: String(e.task ?? '').trim(),
      hours: Math.max(0, Math.round((Number.isFinite(Number(e.hours)) ? Number(e.hours) : 0) * 4) / 4),
      progress: Math.min(100, Math.max(0, Math.round(Number.isFinite(Number(e.progress)) ? Number(e.progress) : 0))),
    }))
}

/** 工数合計と勤怠実労働の乖離（60 分超のみ符号付きで返す。打刻がない日は null） */
async function hoursGapMinutes(
  pool: pg.Pool,
  memberId: string,
  date: string,
  entries: ReportEntry[],
): Promise<number | null> {
  try {
    const { rows } = await pool.query<PunchRecord>(
      `SELECT id, member_id AS "memberId", date, kind, at, source,
              fixed_from AS "fixedFrom", fix_reason AS "fixReason", approved_by AS "approvedBy"
       FROM punch_records WHERE member_id = $1 AND date = $2 ORDER BY at`,
      [memberId, date],
    )
    const work = daySummary(rows, undefined, date).workMinutes
    if (work <= 0) return null
    const reported = Math.round(entries.reduce((s, e) => s + (Number.isFinite(e.hours) ? e.hours : 0), 0) * 60)
    const gap = reported - work
    return Math.abs(gap) > 60 ? gap : null
  } catch {
    return null
  }
}

export function reportsRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 日報一覧（自分: month or from/to / チーム: scope=team は管理者のみ・date / month / from/to）
  app.get('/daily', async (c) => {
    const user = c.get('user')
    const scope = c.req.query('scope') ?? 'mine'
    const month = c.req.query('month') ?? ''
    const date = c.req.query('date') ?? ''
    const from = c.req.query('from') ?? ''
    const to = c.req.query('to') ?? ''
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw err('AKO-GEN-001', 'month は YYYY-MM 形式で指定してください', 400)
    for (const [key, v] of [['date', date], ['from', from], ['to', to]] as const) {
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw err('AKO-GEN-001', `${key} は YYYY-MM-DD 形式で指定してください`, 400)
    }
    const rangeWhere = `($1 = '' OR date = NULLIF($1, '')::date)
         AND ($2 = '' OR to_char(date, 'YYYY-MM') = $2)
         AND ($3 = '' OR date >= NULLIF($3, '')::date) AND ($4 = '' OR date <= NULLIF($4, '')::date)`
    if (scope === 'team') {
      requireAdmin(c)
      const { rows } = await pool.query(
        `SELECT ${DAILY_COLS} FROM daily_reports
         WHERE ${rangeWhere}
         ORDER BY date DESC, submitted_at DESC NULLS LAST`,
        [date, month, from, to])
      return c.json({ data: rows })
    }
    const { rows } = await pool.query(
      `SELECT ${DAILY_COLS} FROM daily_reports
       WHERE author_kind = 'human' AND member_id = $5 AND ${rangeWhere}
       ORDER BY date DESC`,
      [date, month, from, to, user.id])
    return c.json({ data: rows })
  })

  // 日報の保存（下書き / 提出。提出済みは編集不可）
  app.put('/daily', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as {
      date?: string; entries?: unknown; reflection?: string; issues?: string
      tomorrow?: string; status?: 'draft' | 'submitted'
    }
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      throw err('AKO-GEN-001', '対象日（date）を指定してください', 400)
    }
    const status = body.status === 'submitted' ? 'submitted' : 'draft'
    const entries = cleanEntries(body.entries)
    if (status === 'submitted') {
      if (entries.length === 0) throw err('AKO-GEN-001', '作業エントリを 1 行以上入力してください', 400)
      if (entries.some(e => !e.projectId || !e.task)) {
        throw err('AKO-GEN-001', '各エントリのプロジェクトと作業内容を入力してください', 400)
      }
    }
    const submittedAt = status === 'submitted' ? nowJstIso() : null
    const client = await pool.connect()
    let id: string
    try {
      await client.query('BEGIN')
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM daily_reports
         WHERE author_kind = 'human' AND member_id = $1 AND date = $2 FOR UPDATE`,
        [user.id, body.date])
      const row = existing.rows[0]
      if (row?.status === 'submitted') {
        throw err('AKO-REP-001', '提出済みの日報は編集できません', 409)
      }
      if (row) {
        id = row.id
        await client.query(
          `UPDATE daily_reports SET entries = $2, reflection = $3, issues = $4, tomorrow = $5,
             status = $6, submitted_at = $7, updated_at = now()
           WHERE id = $1`,
          [id, JSON.stringify(entries), body.reflection ?? '', body.issues ?? '', body.tomorrow ?? '', status, submittedAt])
      } else {
        id = newId('dr')
        await client.query(
          `INSERT INTO daily_reports (id, author_kind, member_id, date, entries, reflection, issues, tomorrow, status, submitted_at)
           VALUES ($1, 'human', $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, user.id, body.date, JSON.stringify(entries), body.reflection ?? '', body.issues ?? '', body.tomorrow ?? '', status, submittedAt])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    const gap = status === 'submitted' ? await hoursGapMinutes(pool, user.id, body.date, entries) : null
    // 提出成立後の補助処理: 課題記入あり → エスカレーション起票（mockup submit と同一挙動）。
    // クールダウン（AKO-ESC-001）は既に管理者へ共有済みとして escalated = true を返す
    let escalated = false
    if (status === 'submitted' && (body.issues ?? '').trim()) {
      const raised = await raiseEscalation(pool, {
        reason: 'issue_reported',
        targetMemberId: user.id,
        context: `日報（${body.date}）で課題の記入: 「${(body.issues ?? '').trim()}」`,
        dedupeKey: `issue:${user.id}:${body.date}`,
      })
      escalated = raised.raised || raised.code === 'AKO-ESC-001'
    }
    return c.json({ data: { id, status, hoursGapMinutes: gap, escalated } })
  })

  // 週報一覧 / 保存（提出済みは編集不可）
  app.get('/weekly', async (c) => {
    const user = c.get('user')
    const memberId = c.req.query('memberId') ?? user.id
    if (memberId !== user.id) requireAdmin(c)
    const { rows } = await pool.query(
      `SELECT ${WEEKLY_COLS} FROM weekly_reports WHERE member_id = $1 ORDER BY week_start DESC`,
      [memberId])
    return c.json({ data: rows })
  })

  app.put('/weekly', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as {
      weekStart?: string; goalReview?: string; mainWork?: string; issues?: string
      nextWeek?: string; status?: 'draft' | 'submitted'
    }
    if (!body.weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(body.weekStart)) {
      throw err('AKO-GEN-001', '週の開始日（weekStart）を指定してください', 400)
    }
    const status = body.status === 'submitted' ? 'submitted' : 'draft'
    if (status === 'submitted' && !String(body.mainWork ?? '').trim()) {
      throw err('AKO-GEN-001', '主要業務を入力してください', 400)
    }
    const submittedAt = status === 'submitted' ? nowJstIso() : null
    const client = await pool.connect()
    let id: string
    try {
      await client.query('BEGIN')
      const existing = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM weekly_reports WHERE member_id = $1 AND week_start = $2 FOR UPDATE',
        [user.id, body.weekStart])
      const row = existing.rows[0]
      if (row?.status === 'submitted') {
        throw err('AKO-REP-002', '提出済みの週報は編集できません', 409)
      }
      if (row) {
        id = row.id
        await client.query(
          `UPDATE weekly_reports SET goal_review = $2, main_work = $3, issues = $4, next_week = $5,
             status = $6, submitted_at = $7, updated_at = now() WHERE id = $1`,
          [id, body.goalReview ?? '', body.mainWork ?? '', body.issues ?? '', body.nextWeek ?? '', status, submittedAt])
      } else {
        id = newId('wr')
        await client.query(
          `INSERT INTO weekly_reports (id, member_id, week_start, goal_review, main_work, issues, next_week, status, submitted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, user.id, body.weekStart, body.goalReview ?? '', body.mainWork ?? '', body.issues ?? '', body.nextWeek ?? '', status, submittedAt])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    return c.json({ data: { id, status } })
  })

  // 日報リマインド（管理者 → 未提出メンバーへ通知。mockup useReports.remind と同一挙動）
  app.post('/remind', async (c) => {
    requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as { memberId?: string; date?: string }
    if (!body.memberId) throw err('AKO-GEN-001', '対象メンバーを指定してください', 400)
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      throw err('AKO-GEN-001', '対象日（date）を指定してください', 400)
    }
    const member = await pool.query('SELECT id FROM members WHERE id = $1 AND active = true', [body.memberId])
    if (!member.rows[0]) throw err('AKO-GEN-002', '対象メンバーが見つかりません', 404)
    await notify(pool, body.memberId, 'reminder', '日報リマインド',
      `${body.date} の日報が未提出です。提出をお願いします`, '/reports')
    return c.json({ data: { ok: true } })
  })

  // コメント（提出済み日報に対して）
  app.get('/:reportId/comments', async (c) => {
    const { rows } = await pool.query(
      `SELECT id, report_id AS "reportId", member_id AS "memberId", body, reactions, at
       FROM report_comments WHERE report_id = $1 ORDER BY at`,
      [c.req.param('reportId')])
    return c.json({ data: rows })
  })

  app.post('/:reportId/comments', async (c) => {
    const user = c.get('user')
    const reportId = c.req.param('reportId')
    const body = await c.req.json().catch(() => ({})) as { body?: string }
    const text = (body.body ?? '').trim()
    if (!text) throw err('AKO-GEN-001', 'コメントを入力してください', 400)
    const report = await pool.query<{ id: string; authorKind: string; memberId: string | null; date: string }>(
      `SELECT id, author_kind AS "authorKind", member_id AS "memberId", date FROM daily_reports WHERE id = $1`,
      [reportId])
    const target = report.rows[0]
    if (!target) throw err('AKO-GEN-002', '対象の日報が見つかりません', 404)
    const id = newId('rc')
    await pool.query(
      `INSERT INTO report_comments (id, report_id, member_id, body, at) VALUES ($1, $2, $3, $4, $5)`,
      [id, reportId, user.id, text, nowJstIso()])
    // 補助処理: 日報作成者へ通知（自分の日報・AI 日報は除く。mockup と同一挙動）
    if (target.authorKind === 'human' && target.memberId && target.memberId !== user.id) {
      await notify(pool, target.memberId, 'comment',
        `日報（${target.date}）にコメント`, `${user.name}: ${text.slice(0, 60)}`, '/reports')
    }
    return c.json({ data: { id } }, 201)
  })

  // リアクションのトグル（コメントに対して 1 人 1 絵文字 1 個。mockup toggleReaction と同一挙動）
  app.post('/comments/:commentId/reactions', async (c) => {
    const user = c.get('user')
    const commentId = c.req.param('commentId')
    const body = await c.req.json().catch(() => ({})) as { emoji?: string }
    const emoji = (body.emoji ?? '').trim()
    if (!emoji || emoji.length > 8) throw err('AKO-GEN-001', 'リアクション（emoji）を指定してください', 400)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ reactions: { memberId: string; emoji: string }[] }>(
        'SELECT reactions FROM report_comments WHERE id = $1 FOR UPDATE', [commentId])
      const row = rows[0]
      if (!row) throw err('AKO-GEN-002', '対象のコメントが見つかりません', 404)
      const has = row.reactions.some(r => r.memberId === user.id && r.emoji === emoji)
      const reactions = has
        ? row.reactions.filter(r => !(r.memberId === user.id && r.emoji === emoji))
        : [...row.reactions, { memberId: user.id, emoji }]
      await client.query('UPDATE report_comments SET reactions = $2 WHERE id = $1',
        [commentId, JSON.stringify(reactions)])
      await client.query('COMMIT')
      return c.json({ data: { id: commentId, reactions } })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })

  return app
}
