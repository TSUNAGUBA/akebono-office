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
import { err } from '../lib/errors'
import { newId } from '../lib/ids'

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

  // 日報一覧（自分: month 指定 / チーム: scope=team は管理者のみ・date or 期間指定）
  app.get('/daily', async (c) => {
    const user = c.get('user')
    const scope = c.req.query('scope') ?? 'mine'
    const month = c.req.query('month') ?? ''
    const date = c.req.query('date') ?? ''
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw err('AKO-GEN-001', 'month は YYYY-MM 形式で指定してください', 400)
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err('AKO-GEN-001', 'date は YYYY-MM-DD 形式で指定してください', 400)
    if (scope === 'team') {
      requireAdmin(c)
      const { rows } = await pool.query(
        `SELECT ${DAILY_COLS} FROM daily_reports
         WHERE ($1 = '' OR date = NULLIF($1, '')::date) AND ($2 = '' OR to_char(date, 'YYYY-MM') = $2)
         ORDER BY date DESC, submitted_at DESC NULLS LAST`,
        [date, month])
      return c.json({ data: rows })
    }
    const { rows } = await pool.query(
      `SELECT ${DAILY_COLS} FROM daily_reports
       WHERE author_kind = 'human' AND member_id = $1
         AND ($2 = '' OR date = NULLIF($2, '')::date) AND ($3 = '' OR to_char(date, 'YYYY-MM') = $3)
       ORDER BY date DESC`,
      [user.id, date, month])
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
    return c.json({ data: { id, status, hoursGapMinutes: gap } })
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
    const report = await pool.query('SELECT id, status FROM daily_reports WHERE id = $1', [reportId])
    if (!report.rows[0]) throw err('AKO-GEN-002', '対象の日報が見つかりません', 404)
    const id = newId('rc')
    await pool.query(
      `INSERT INTO report_comments (id, report_id, member_id, body, at) VALUES ($1, $2, $3, $4, $5)`,
      [id, reportId, user.id, text, nowJstIso()])
    return c.json({ data: { id } }, 201)
  })

  return app
}
