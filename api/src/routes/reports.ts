/**
 * 日報・週報 API。mockup useReports の API 版。
 * - 提出済み日報は本人が編集可（提出状態・初回提出時刻は維持・監査ログ記録。下書きへは戻せない = AKO-REP-001）
 * - 提出済み週報は編集不可（AKO-REP-002 = 記録系の状態保護）
 * - 工数乖離チェック（勤怠実労働との差 60 分超で hoursGapMinutes を返す = 画面が警告表示）
 * - チーム参照（scope=team）: 管理者 = 下書き含む全件 / 一般 = 提出済みのみ（バッチ7h で全員へ公開）。
 *   scope=team / scope=all は日報参照権限（F-16-6 = reports + field 'member:<id>' の deny）で対象者を絞り込む。
 *   コメントは提出済み日報に対して全員可
 * 注: 提出時のエスカレーション起票・通知はバッチ2（通知ドメイン）で API 化する（実装状況マトリクス参照）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { DEFAULT_WORKING_DAY_RULE, isWorkingDay } from '../../../shared/domain/business-day'
import { addDays, nowJstIso, todayJst } from '../../../shared/domain/jst'
import { canUseFeature, canViewMemberReports, type PermissionSubject } from '../../../shared/domain/permissions'
import { TOMORROW_PLANS_MAX } from '../../../shared/domain/types'
import type { PermissionRule, PunchRecord, ReportEntry, TomorrowPlan } from '../../../shared/domain/types'
import {
  heuristicPersonalInsight, heuristicWeeklyInsight,
  type PersonalWeeklyInsight, type PersonalWeeklyMetrics, type WeeklyInsight, type WeeklyMetrics,
} from '../../../shared/domain/weekly-insight'
import { requireAdmin, type AuthUser } from '../auth'
import { daySummary } from '../domain/attendance'
import { audit } from '../lib/audit'
import { raiseEscalation } from '../lib/escalate'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { notify } from '../lib/notify'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import type { Env } from '../env'
import { capCp } from '../lib/text'

const DAILY_COLS = `id, author_kind AS "authorKind", member_id AS "memberId",
  ai_employee_id AS "aiEmployeeId", date, entries, reflection, issues, tomorrow,
  tomorrow_plans AS "tomorrowPlans", status, submitted_at AS "submittedAt"`
const WEEKLY_COLS = `id, member_id AS "memberId", week_start AS "weekStart",
  goal_review AS "goalReview", main_work AS "mainWork", issues, next_week AS "nextWeek",
  status, submitted_at AS "submittedAt"`

/** エントリの正規化（mockup cleanEntries と同一: 0.25h 刻み・progress 0-100。theme = 業務テーマ自由入力・projectId は旧形式互換） */
function cleanEntries(entries: unknown): ReportEntry[] {
  if (!Array.isArray(entries)) return []
  return entries
    .map(e => e as Partial<ReportEntry>)
    .filter(e => String(e.theme ?? '').trim() || (e.projectId ?? '') || String(e.task ?? '').trim())
    .map(e => ({
      theme: [...String(e.theme ?? '').trim()].slice(0, 100).join(''),
      projectId: String(e.projectId ?? ''),
      task: String(e.task ?? '').trim(),
      hours: Math.max(0, Math.round((Number.isFinite(Number(e.hours)) ? Number(e.hours) : 0) * 4) / 4),
      progress: Math.min(100, Math.max(0, Math.round(Number.isFinite(Number(e.progress)) ? Number(e.progress) : 0))),
    }))
}

/** 明日の予定の正規化（mockup cleanTomorrowPlans と同一: 空行除去・0.25h 刻み・最大 TOMORROW_PLANS_MAX 件） */
function cleanTomorrowPlans(plans: unknown): TomorrowPlan[] {
  if (!Array.isArray(plans)) return []
  return plans
    .map(p => p as Partial<TomorrowPlan>)
    .filter(p => String(p.theme ?? '').trim() || String(p.purpose ?? '').trim() || String(p.task ?? '').trim())
    .slice(0, TOMORROW_PLANS_MAX)
    .map(p => ({
      theme: [...String(p.theme ?? '').trim()].slice(0, 100).join(''),
      purpose: String(p.purpose ?? '').trim(),
      task: String(p.task ?? '').trim(),
      hours: Math.max(0, Math.round((Number.isFinite(Number(p.hours)) ? Number(p.hours) : 0) * 4) / 4),
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
       FROM punch_records WHERE member_id = $1 AND date = $2 ORDER BY at, created_at`,
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

/** 週次インサイトの洞察生成（Vertex AI 構造化出力。失敗・無効環境は null → heuristicWeeklyInsight へ） */
async function llmWeeklyInsight(env: Env | undefined, metrics: WeeklyMetrics): Promise<WeeklyInsight | null> {
  if (!env?.vertexProjectId) return null
  const res = await generateJson<WeeklyInsight>(env, {
    system: 'あなたは中小コンサルティング会社の経営参謀 AI です。週次の業務データ集計から、'
      + '経営・営業活動・チームやメンバーの状況の視点で会社運営に有効なインサイトを日本語で出力します。'
      + '集計値にある事実のみを根拠にし、推測で数値・事実を作らないこと。'
      + '日報は前日分までしか存在しないのが正常な運用のため、集計基準日（asOf）より後の未提出を'
      + '悲観的に評価しないこと（提出率は経過営業日 businessDaysElapsed 基準で判断する）。'
      + 'これは全メンバーが閲覧する全体レポートのため、本文に個人名を出さず集計・傾向で語ること'
      + '（個人への言及は個別インサイトが担う）。'
      + 'executiveSummary は 3〜5 文。swot の各項目・risks・actions は具体的かつ簡潔に（各 40 字以内・最大 5 件）。'
      + 'risks の severity は high / mid / low。',
    prompt: `# 週次集計（${metrics.weekStart}〜${metrics.weekEnd}）
${JSON.stringify(metrics, null, 1)}`,
    schema: {
      type: 'object',
      properties: {
        executiveSummary: { type: 'string' },
        swot: {
          type: 'object',
          properties: {
            strengths: { type: 'array', items: { type: 'string' } },
            weaknesses: { type: 'array', items: { type: 'string' } },
            opportunities: { type: 'array', items: { type: 'string' } },
            threats: { type: 'array', items: { type: 'string' } },
          },
          required: ['strengths', 'weaknesses', 'opportunities', 'threats'],
        },
        risks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              severity: { type: 'string' },
              mitigation: { type: 'string' },
            },
            required: ['title', 'severity', 'mitigation'],
          },
        },
        actions: { type: 'array', items: { type: 'string' } },
      },
      required: ['executiveSummary', 'swot', 'risks', 'actions'],
    },
    maxTokens: 3000,
  })
  if (!res || !res.executiveSummary || !res.swot) return null
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, 5).map(x => capCp(String(x), 80)) : [])
  return {
    executiveSummary: capCp(String(res.executiveSummary), 1000),
    swot: {
      strengths: arr(res.swot.strengths),
      weaknesses: arr(res.swot.weaknesses),
      opportunities: arr(res.swot.opportunities),
      threats: arr(res.swot.threats),
    },
    risks: (Array.isArray(res.risks) ? res.risks : [])
      .filter((r): r is NonNullable<typeof r> => !!r && typeof r === 'object').slice(0, 5).map(r => ({
      title: capCp(String(r.title ?? ''), 60),
      severity: r.severity === 'high' || r.severity === 'low' ? r.severity : 'mid',
      mitigation: capCp(String(r.mitigation ?? ''), 100),
    })),
    actions: arr(res.actions),
  }
}

/** 個別インサイトの洞察生成（Vertex AI 構造化出力。失敗・無効環境は null → heuristicPersonalInsight へ） */
async function llmPersonalInsight(
  env: Env | undefined,
  personal: PersonalWeeklyMetrics,
  company: WeeklyMetrics,
): Promise<PersonalWeeklyInsight | null> {
  if (!env?.vertexProjectId) return null
  const res = await generateJson<PersonalWeeklyInsight>(env, {
    system: 'あなたは社員一人ひとりに寄り添う業務アドバイザー AI です。本人の週次実績と全体集計から、'
      + '本人のロール（admin = 経営/管理・hr = 人事・member = 一般）・役職・所属部署に最適化した'
      + '個人向けインサイトを日本語で出力します。集計値にある事実のみを根拠にし、推測で数値・事実を作らないこと。'
      + '日報は前日分までが正常な運用のため、集計基準日（asOf）より後の未提出を指摘しないこと。'
      + 'summary は 2〜3 文（本人に語りかける文体）。focus・actions は具体的かつ簡潔に（各 50 字以内・最大 5 件）。',
    prompt: `# 本人の週次実績・属性\n${JSON.stringify(personal, null, 1)}\n\n# 全体集計（参考）\n${JSON.stringify(company, null, 1)}`,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        focus: { type: 'array', items: { type: 'string' } },
        actions: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'focus', 'actions'],
    },
    maxTokens: 1536,
  })
  if (!res || !res.summary) return null
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, 5).map(x => capCp(String(x), 100)) : [])
  return { summary: capCp(String(res.summary), 600), focus: arr(res.focus), actions: arr(res.actions) }
}

export function reportsRoutes(pool: pg.Pool, env?: Env): Hono {
  const app = new Hono()

  // 日報一覧（自分: month or from/to / チーム: scope=team は全員可・期間必須（管理者 = 下書き含む / 一般 = 提出済みのみ）/
  // 全員: scope=all は提出済みのみ全メンバー可。scope=all/team は F-16-6 の参照 deny で絞り込む）
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
    // 日報参照権限（F-16-6・バッチ7h）: deny された対象者の日報を応答から除外する共通フィルタ。
    // 自分の日報・AI 社員の日次報告は常に参照可（shared canViewMemberReports の規約どおり）
    const filterViewable = async (rows: { authorKind: string; memberId: string | null }[]) => {
      const rules = await activePermissionRules(pool)
      if (rules.length === 0) return rows
      const subject = subjectOf(user)
      return rows.filter(r => r.authorKind !== 'human' || !r.memberId
        || canViewMemberReports(rules, subject, r.memberId))
    }
    if (scope === 'team') {
      // バッチ7h: チームタブは全員へ公開。管理者は下書き含む全件・一般メンバーは提出済みのみ
      //（他人の下書きの内容・存在を一般メンバーへ見せない）。
      // scope=all と同じく期間なしの全履歴ダンプは許容しない（R1 M-2。フロントは常に期間指定）
      if (!date && !month && !(from && to)) {
        throw err('AKO-GEN-001', 'scope=team では date / month / from+to のいずれかを指定してください', 400)
      }
      const isAdminUser = user.role === 'admin'
      const { rows } = await pool.query<{ authorKind: string; memberId: string | null }>(
        `SELECT ${DAILY_COLS} FROM daily_reports
         WHERE ${rangeWhere}${isAdminUser ? '' : ` AND status = 'submitted'`}
         ORDER BY date DESC, submitted_at DESC NULLS LAST`,
        [date, month, from, to])
      return c.json({ data: await filterViewable(rows) })
    }
    // 全員の日報（バッチ5e: 相互参照による情報共有）。提出済みのみ = 下書きは本人以外に見せない。
    // month 必須: 期間なしの全履歴ダンプを許容しない（フロントは常に月単位でロードする）
    if (scope === 'all') {
      if (!month) throw err('AKO-GEN-001', 'scope=all では month（YYYY-MM）を指定してください', 400)
      const { rows } = await pool.query<{ authorKind: string; memberId: string | null }>(
        `SELECT ${DAILY_COLS} FROM daily_reports
         WHERE status = 'submitted' AND ${rangeWhere}
         ORDER BY date DESC, submitted_at DESC NULLS LAST`,
        [date, month, from, to])
      return c.json({ data: await filterViewable(rows) })
    }
    const { rows } = await pool.query(
      `SELECT ${DAILY_COLS} FROM daily_reports
       WHERE author_kind = 'human' AND member_id = $5 AND ${rangeWhere}
       ORDER BY date DESC`,
      [date, month, from, to, user.id])
    return c.json({ data: rows })
  })

  // 日報の保存（下書き / 提出 / 提出済みの本人編集）
  app.put('/daily', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as {
      date?: string; entries?: unknown; reflection?: string; issues?: string
      tomorrow?: string; tomorrowPlans?: unknown; status?: 'draft' | 'submitted'
    }
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      throw err('AKO-GEN-001', '対象日（date）を指定してください', 400)
    }
    const status = body.status === 'submitted' ? 'submitted' : 'draft'
    const entries = cleanEntries(body.entries)
    const tomorrowPlans = cleanTomorrowPlans(body.tomorrowPlans)
    if (status === 'submitted') {
      if (entries.length === 0) throw err('AKO-GEN-001', '作業エントリを 1 行以上入力してください', 400)
      // theme（テーマ）が正。旧クライアント・旧データ編集の projectId のみも許容する（原則7）
      if (entries.some(e => !(e.theme || e.projectId) || !e.task)) {
        throw err('AKO-GEN-001', '各エントリのテーマと内容を入力してください', 400)
      }
    }
    const submittedAt = status === 'submitted' ? nowJstIso() : null
    const client = await pool.connect()
    let id: string
    let editedAfterSubmit = false
    try {
      await client.query('BEGIN')
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM daily_reports
         WHERE author_kind = 'human' AND member_id = $1 AND date = $2 FOR UPDATE`,
        [user.id, body.date])
      const row = existing.rows[0]
      // 提出済みは本人の編集を許可（オペレーター指示 2026-07-17。提出状態・初回提出時刻は維持し、
      // 編集は監査ログへ記録する）。下書きへ戻す操作のみ不可（提出済み = 確定の意味を保つ）
      if (row?.status === 'submitted' && status !== 'submitted') {
        throw err('AKO-REP-001', '提出済みの日報は下書きへ戻せません（提出済みのまま編集してください）', 409)
      }
      editedAfterSubmit = row?.status === 'submitted'
      if (row) {
        id = row.id
        await client.query(
          `UPDATE daily_reports SET entries = $2, reflection = $3, issues = $4, tomorrow = $5,
             tomorrow_plans = $6, status = $7, submitted_at = COALESCE(submitted_at, $8), updated_at = now()
           WHERE id = $1`,
          [id, JSON.stringify(entries), body.reflection ?? '', body.issues ?? '', body.tomorrow ?? '',
            JSON.stringify(tomorrowPlans), status, submittedAt])
      } else {
        id = newId('dr')
        await client.query(
          `INSERT INTO daily_reports (id, author_kind, member_id, date, entries, reflection, issues, tomorrow, tomorrow_plans, status, submitted_at)
           VALUES ($1, 'human', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, user.id, body.date, JSON.stringify(entries), body.reflection ?? '', body.issues ?? '', body.tomorrow ?? '',
            JSON.stringify(tomorrowPlans), status, submittedAt])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    if (editedAfterSubmit) {
      await audit(pool, {
        actorId: user.id, action: 'update', entity: 'daily_reports', entityId: id,
        detail: `提出済み日報（${body.date}）を本人が編集`,
      })
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
  // scope=all: 全メンバーの提出済み週報（オペレーター指示 2026-07-22: 全員の週報タブ）。
  // 参照権限は日報と同じ「日報・週報の参照対象」（F-16-6 canViewMemberReports）で絞り込む
  app.get('/weekly', async (c) => {
    const user = c.get('user')
    if (c.req.query('scope') === 'all') {
      const rules = await activePermissionRules(pool)
      const subject = subjectOf(user)
      const { rows } = await pool.query<{ memberId: string }>(
        `SELECT ${WEEKLY_COLS} FROM weekly_reports WHERE status = 'submitted' ORDER BY week_start DESC`)
      return c.json({ data: rows.filter(r => canViewMemberReports(rules, subject, r.memberId)) })
    }
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

  /**
   * コメントスレッドの対象日報ガード（PR #57 R1 M-3）。
   * 他人の人間日報は「提出済み かつ 日報参照権限（F-16-6）で参照可」のときのみ許可。
   * 自分の日報・AI 社員の日報は従来どおり。違反は 404（存在を秘匿 = 下書き秘匿と同じ基準）
   */
  async function guardCommentTarget(
    c: { get: (k: 'user') => AuthUser },
    reportId: string,
  ): Promise<{ id: string; authorKind: string; memberId: string | null; status: string; date: string }> {
    const user = c.get('user')
    const { rows } = await pool.query<{ id: string; authorKind: string; memberId: string | null; status: string; date: string }>(
      `SELECT id, author_kind AS "authorKind", member_id AS "memberId", status, date::text AS date
       FROM daily_reports WHERE id = $1`, [reportId])
    const target = rows[0]
    if (!target) throw err('AKO-GEN-002', '対象の日報が見つかりません', 404)
    if (target.authorKind === 'human' && target.memberId && target.memberId !== user.id) {
      // 他人の下書きは管理者のみ（scope=team の下書き参照と同じ基準）
      if (target.status !== 'submitted' && user.role !== 'admin') {
        throw err('AKO-GEN-002', '対象の日報が見つかりません', 404)
      }
      // F-16-6 の参照 deny は一覧フィルタ（filterViewable）と同じく管理者にも適用される
      const rules = await activePermissionRules(pool)
      if (rules.length > 0 && !canViewMemberReports(rules, subjectOf(user), target.memberId)) {
        throw err('AKO-GEN-002', '対象の日報が見つかりません', 404)
      }
    }
    return target
  }

  // コメント（提出済み日報に対して。参照ガード = guardCommentTarget）
  app.get('/:reportId/comments', async (c) => {
    const reportId = c.req.param('reportId')
    await guardCommentTarget(c, reportId)
    const { rows } = await pool.query(
      `SELECT id, report_id AS "reportId", member_id AS "memberId", body, reactions, at
       FROM report_comments WHERE report_id = $1 ORDER BY at, created_at`,
      [reportId])
    return c.json({ data: rows })
  })

  app.post('/:reportId/comments', async (c) => {
    const user = c.get('user')
    const reportId = c.req.param('reportId')
    const body = await c.req.json().catch(() => ({})) as { body?: string }
    const text = (body.body ?? '').trim()
    if (!text) throw err('AKO-GEN-001', 'コメントを入力してください', 400)
    const target = await guardCommentTarget(c, reportId)
    const id = newId('rc')
    await pool.query(
      `INSERT INTO report_comments (id, report_id, member_id, body, at) VALUES ($1, $2, $3, $4, $5)`,
      [id, reportId, user.id, text, nowJstIso()])
    // 補助処理: 日報作成者へ通知（自分の日報・AI 日報は除く。mockup と同一挙動）
    if (target.authorKind === 'human' && target.memberId && target.memberId !== user.id) {
      await notify(pool, target.memberId, 'comment',
        `日報（${target.date}）にコメント`, `${user.name}: ${[...text].slice(0, 60).join('')}`, '/reports')
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

  // ---------- 週次 AI インサイト（バッチ7g → バッチ7j: 永続化・前日まで前提・全体/個別分離） ----------

  /** weekStart の検証（YYYY-MM-DD・実在日・月曜）。不正は AKO-GEN-001 400 */
  function validWeekStart(weekStart: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw err('AKO-GEN-001', 'weekStart（YYYY-MM-DD）を指定してください', 400)
    const wsDate = new Date(`${weekStart}T00:00:00Z`)
    if (Number.isNaN(wsDate.getTime()) || wsDate.toISOString().slice(0, 10) !== weekStart || wsDate.getUTCDay() !== 1) {
      throw err('AKO-GEN-001', 'weekStart には実在する週初め（月曜）の日付を指定してください', 400)
    }
    return addDays(weekStart, 6)
  }

  /**
   * 集計基準（バッチ7j）: 日報は前日分までが正常な運用のため、asOf = min(weekEnd, 前日)。
   * businessDaysElapsed = weekStart〜asOf の営業日数（祝日 = public_holidays・月〜金の既定ルール）
   */
  async function weekWindow(weekStart: string, weekEnd: string): Promise<{ asOf: string; businessDaysElapsed: number }> {
    const yesterday = addDays(todayJst(), -1)
    const asOf = yesterday < weekEnd ? yesterday : weekEnd
    const { rows } = await pool.query<{ date: string }>(
      `SELECT date::text AS date FROM public_holidays WHERE date BETWEEN $1::date AND $2::date`, [weekStart, weekEnd])
    const holidays = new Set(rows.map(r => r.date))
    let businessDaysElapsed = 0
    for (let d = weekStart; d <= asOf; d = addDays(d, 1)) {
      if (isWorkingDay(d, DEFAULT_WORKING_DAY_RULE, holidays)) businessDaysElapsed++
    }
    return { asOf, businessDaysElapsed }
  }

  /**
   * 全体共通の週次集計（バッチ7j: 保管して全員が共有するため、閲覧者に依存しない全量で集計する。
   * 売上・メンバー名（F-16-6）の閲覧者ごとのマスクは配信時 = maskCompanyForViewer が行う）
   */
  async function computeCompanyMetrics(weekStart: string, weekEnd: string): Promise<WeeklyMetrics> {
    const { asOf, businessDaysElapsed } = await weekWindow(weekStart, weekEnd)
    const [membersQ, dailyQ, weeklyQ, plansQ, wfQ, escQ, aiQ, notesQ, salesQ] = await Promise.all([
      pool.query<{ id: string; name: string }>(`SELECT id, name FROM members WHERE active = true`),
      pool.query<{ memberId: string | null; date: string; entries: ReportEntry[]; issues: string }>(
        `SELECT member_id AS "memberId", date::text AS date, entries, issues
         FROM daily_reports WHERE author_kind = 'human' AND status = 'submitted'
           AND date BETWEEN $1::date AND $2::date`, [weekStart, weekEnd]),
      pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM weekly_reports WHERE week_start = $1::date AND status = 'submitted'`,
        [weekStart]),
      pool.query<{ total: string; done: string }>(
        `SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'done')::text AS done
         FROM task_plans WHERE date BETWEEN $1::date AND $2::date`, [weekStart, weekEnd]),
      pool.query<{ submitted: string; approved: string }>(
        `SELECT count(*) FILTER (WHERE status <> 'draft')::text AS submitted,
                count(*) FILTER (WHERE status = 'approved')::text AS approved
         FROM workflow_requests WHERE substr(created_at, 1, 10) BETWEEN $1 AND $2`, [weekStart, weekEnd]),
      pool.query<{ raised: string; resolved: string }>(
        `SELECT count(*)::text AS raised, count(*) FILTER (WHERE status = 'resolved')::text AS resolved
         FROM escalations WHERE substr(raised_at, 1, 10) BETWEEN $1 AND $2`, [weekStart, weekEnd]),
      pool.query<{ done: string; active: string }>(
        `SELECT count(*) FILTER (WHERE status = 'done'
                  AND (updated_at AT TIME ZONE 'Asia/Tokyo')::date BETWEEN $1::date AND $2::date)::text AS done,
                count(*) FILTER (WHERE status IN ('proposed', 'in_progress', 'blocked'))::text AS active
         FROM ai_tasks`, [weekStart, weekEnd]),
      pool.query<{ kind: string; n: string }>(
        `SELECT kind, count(*)::text AS n FROM notes
         WHERE active = true AND (created_at AT TIME ZONE 'Asia/Tokyo')::date BETWEEN $1::date AND $2::date
         GROUP BY kind`, [weekStart, weekEnd]),
      pool.query<{ total: string | null }>(
        `SELECT sum(amount)::text AS total FROM sales_monthly WHERE month = $1`, [weekStart.slice(0, 7)]),
    ])

    const nameOf = new Map(membersQ.rows.map(m => [m.id, m.name]))
    const memberHours = new Map<string, { name: string; hours: number }>()
    const themeHours = new Map<string, number>()
    const daily = new Map<string, number>()
    const reporters = new Set<string>()
    const issues: { memberId?: string; member: string; issue: string }[] = []
    let totalHours = 0
    let submittedUpToAsOf = 0
    for (const r of dailyQ.rows) {
      const name = (r.memberId && nameOf.get(r.memberId)) || '不明'
      // 提出数・提出者は前日（asOf）まで基準（当日・未来日を未提出として扱わない = バッチ7j）
      if (r.date <= asOf) {
        submittedUpToAsOf++
        reporters.add(r.memberId ?? name)
      }
      daily.set(r.date, (daily.get(r.date) ?? 0) + 1)
      for (const e of (Array.isArray(r.entries) ? r.entries : [])) {
        const h = Number.isFinite(Number(e.hours)) ? Number(e.hours) : 0
        totalHours += h
        const key = r.memberId ?? name
        const cur = memberHours.get(key) ?? { name, hours: 0 }
        memberHours.set(key, { name, hours: cur.hours + h })
        const theme = String(e.theme ?? '').trim() || 'その他'
        themeHours.set(theme, (themeHours.get(theme) ?? 0) + h)
      }
      if (r.issues?.trim()) {
        issues.push({ memberId: r.memberId ?? undefined, member: name, issue: capCp(r.issues.trim(), 120) })
      }
    }
    const notesByKind = new Map(notesQ.rows.map(r => [r.kind, Number(r.n)]))
    return {
      weekStart,
      weekEnd,
      asOf,
      businessDaysElapsed,
      reportSubmitted: submittedUpToAsOf,
      reporters: reporters.size,
      membersActive: membersQ.rows.length,
      totalHours: Math.round(totalHours * 4) / 4,
      memberHours: [...memberHours.entries()]
        .map(([memberId, v]) => ({ memberId, name: v.name, hours: Math.round(v.hours * 4) / 4 }))
        .sort((a, b) => b.hours - a.hours).slice(0, 10),
      themeHours: [...themeHours.entries()].map(([theme, hours]) => ({ theme, hours: Math.round(hours * 4) / 4 }))
        .sort((a, b) => b.hours - a.hours).slice(0, 8),
      dailySubmissions: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(weekStart, i)
        return { date, count: daily.get(date) ?? 0 }
      }),
      issues: issues.slice(0, 10),
      weeklyCount: Number(weeklyQ.rows[0]?.n ?? 0),
      planDone: Number(plansQ.rows[0]?.done ?? 0),
      planTotal: Number(plansQ.rows[0]?.total ?? 0),
      workflowSubmitted: Number(wfQ.rows[0]?.submitted ?? 0),
      workflowApproved: Number(wfQ.rows[0]?.approved ?? 0),
      escalationRaised: Number(escQ.rows[0]?.raised ?? 0),
      escalationResolved: Number(escQ.rows[0]?.resolved ?? 0),
      aiTasksDone: Number(aiQ.rows[0]?.done ?? 0),
      aiTasksActive: Number(aiQ.rows[0]?.active ?? 0),
      minutesCount: notesByKind.get('minutes') ?? 0,
      poipoiCount: notesByKind.get('poipoi') ?? 0,
      salesMonthAmount: Number(salesQ.rows[0]?.total ?? 0),
    }
  }

  /** 個別インサイトの材料（ログインユーザーの週次実績 + 属性） */
  async function computePersonalMetrics(
    weekStart: string,
    weekEnd: string,
    user: AuthUser,
    window: { asOf: string; businessDaysElapsed: number },
  ): Promise<PersonalWeeklyMetrics> {
    const [memberQ, dailyQ, plansQ, weeklyQ] = await Promise.all([
      pool.query<{ name: string; role: string; title: string; departmentName: string | null }>(
        `SELECT m.name, m.role, m.title, d.name AS "departmentName"
         FROM members m LEFT JOIN departments d ON d.id = m.department_id WHERE m.id = $1`, [user.id]),
      pool.query<{ date: string; entries: ReportEntry[]; issues: string }>(
        `SELECT date::text AS date, entries, issues FROM daily_reports
         WHERE author_kind = 'human' AND member_id = $1 AND status = 'submitted'
           AND date BETWEEN $2::date AND $3::date`, [user.id, weekStart, weekEnd]),
      pool.query<{ total: string; done: string }>(
        `SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'done')::text AS done
         FROM task_plans WHERE member_id = $1 AND date BETWEEN $2::date AND $3::date`,
        [user.id, weekStart, weekEnd]),
      pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM weekly_reports
         WHERE member_id = $1 AND week_start = $2::date AND status = 'submitted'`, [user.id, weekStart]),
    ])
    const m = memberQ.rows[0]
    const themeHours = new Map<string, number>()
    const issues: string[] = []
    let totalHours = 0
    let submitted = 0
    for (const r of dailyQ.rows) {
      if (r.date <= window.asOf) submitted++
      for (const e of (Array.isArray(r.entries) ? r.entries : [])) {
        const h = Number.isFinite(Number(e.hours)) ? Number(e.hours) : 0
        totalHours += h
        const theme = String(e.theme ?? '').trim() || 'その他'
        themeHours.set(theme, (themeHours.get(theme) ?? 0) + h)
      }
      if (r.issues?.trim()) issues.push(capCp(r.issues.trim(), 120))
    }
    return {
      memberId: user.id,
      memberName: m?.name ?? user.name,
      role: (m?.role === 'admin' || m?.role === 'hr' ? m.role : 'member'),
      title: m?.title ?? '',
      department: m?.departmentName ?? '',
      reportSubmitted: submitted,
      businessDaysElapsed: window.businessDaysElapsed,
      totalHours: Math.round(totalHours * 4) / 4,
      themeHours: [...themeHours.entries()].map(([theme, hours]) => ({ theme, hours: Math.round(hours * 4) / 4 }))
        .sort((a, b) => b.hours - a.hours).slice(0, 5),
      issues: issues.slice(0, 5),
      planDone: Number(plansQ.rows[0]?.done ?? 0),
      planTotal: Number(plansQ.rows[0]?.total ?? 0),
      weeklySubmitted: Number(weeklyQ.rows[0]?.n ?? 0) > 0,
    }
  }

  /**
   * 保管された全体集計を閲覧者ごとにマスクして返す（F-16 準拠の配信時フィルタ）。
   * - 売上: sales 機能権限がなければ null
   * - メンバー別工数・課題: 日報参照権限（F-16-6）で deny された対象者の行を除外
   */
  function maskCompanyForViewer(
    metrics: WeeklyMetrics,
    rules: PermissionRule[],
    subject: PermissionSubject,
  ): WeeklyMetrics {
    const canSales = rules.length === 0 || canUseFeature(rules, subject, 'sales')
    const visible = (memberId?: string): boolean =>
      rules.length === 0 || !memberId || canViewMemberReports(rules, subject, memberId)
    return {
      ...metrics,
      salesMonthAmount: canSales ? metrics.salesMonthAmount : null,
      memberHours: metrics.memberHours.filter(x => visible(x.memberId)),
      issues: metrics.issues.filter(x => visible(x.memberId)),
    }
  }

  interface StoredInsight {
    metrics: unknown
    insight: unknown
    llm: boolean
    generatedAt: string
    generatedByName: string | null
  }

  async function storedInsight(weekStart: string, audience: string): Promise<StoredInsight | null> {
    const { rows } = await pool.query<StoredInsight>(
      `SELECT wi.metrics, wi.insight, wi.llm,
              to_char(wi.generated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "generatedAt",
              m.name AS "generatedByName"
       FROM weekly_insights wi LEFT JOIN members m ON m.id = wi.generated_by
       WHERE wi.week_start = $1::date AND wi.audience = $2`, [weekStart, audience])
    return rows[0] ?? null
  }

  async function upsertInsight(
    weekStart: string,
    audience: string,
    metrics: unknown,
    insight: unknown,
    llm: boolean,
    generatedBy: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO weekly_insights (id, week_start, audience, metrics, insight, llm, generated_by)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7)
       ON CONFLICT (week_start, audience) DO UPDATE SET
         metrics = EXCLUDED.metrics, insight = EXCLUDED.insight, llm = EXCLUDED.llm,
         generated_by = EXCLUDED.generated_by, generated_at = now()`,
      [newId('wi'), weekStart, audience, JSON.stringify(metrics), JSON.stringify(insight), llm, generatedBy])
  }

  // 保管済みインサイトの取得（バッチ7j: 生成しない = 再生成されるまで保存済みの結果を表示する）。
  // company = 全体共通（閲覧者ごとに売上・F-16-6 をマスク）/ personal = ログインユーザー向け。
  // reports 機能の deny は app.ts の featureGuard（/v1/reports）が 403 を返す（重複ガードは持たない = R1 M-5）
  app.get('/weekly-insight', async (c) => {
    const user = c.get('user')
    const weekStart = String(c.req.query('weekStart') ?? '')
    validWeekStart(weekStart)
    const rules = await activePermissionRules(pool)
    const subject = subjectOf(user)
    const [company, personal] = await Promise.all([
      storedInsight(weekStart, 'company'),
      storedInsight(weekStart, `member:${user.id}`),
    ])
    return c.json({
      data: {
        company: company
          ? { ...company, metrics: maskCompanyForViewer(company.metrics as WeeklyMetrics, rules, subject) }
          : null,
        personal,
      },
    })
  })

  // 生成・再生成（バッチ7j: 全体共通 + ログインユーザーの個別を集計 → 洞察生成 → 保管（upsert = 導出キャッシュ））。
  // 全体の洞察本文は「個人名なし・売上言及なし」で生成する（全員が共有する保管物のため。
  // 売上 KPI 値は保管し、配信時に権限マスク。個人向けの言及は個別インサイトが担う）
  app.post('/weekly-insight', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { weekStart?: string }
    const weekStart = String(body.weekStart ?? '')
    const weekEnd = validWeekStart(weekStart)
    const rules = await activePermissionRules(pool)
    const subject = subjectOf(user)

    const metrics = await computeCompanyMetrics(weekStart, weekEnd)
    // 全体の洞察は売上・個人名を剥がした集計から生成（売上権限のない閲覧者にも配信され、
    // 本文はマスク不能なテキストのため。個人名の抑止をプロンプト指示だけに頼らない = PR #59 R1 M-2）
    const narrativeSource: WeeklyMetrics = {
      ...metrics,
      salesMonthAmount: null,
      memberHours: metrics.memberHours.map((x, i) => ({ name: `メンバー${i + 1}`, hours: x.hours })),
      issues: metrics.issues.map(x => ({ member: '匿名', issue: x.issue })),
    }
    const companyLlm = await llmWeeklyInsight(env, narrativeSource)
    const companyInsight = companyLlm ?? heuristicWeeklyInsight(narrativeSource)
    await upsertInsight(weekStart, 'company', metrics, companyInsight, !!companyLlm, user.id)

    // 個別（ログインユーザー向け）: 本人の実績 + 閲覧者マスク済みの全体集計から生成
    const window = { asOf: metrics.asOf, businessDaysElapsed: metrics.businessDaysElapsed }
    const personalMetrics = await computePersonalMetrics(weekStart, weekEnd, user, window)
    const maskedCompany = maskCompanyForViewer(metrics, rules, subject)
    const personalLlm = await llmPersonalInsight(env, personalMetrics, maskedCompany)
    const personalInsight = personalLlm ?? heuristicPersonalInsight(personalMetrics, maskedCompany)
    await upsertInsight(weekStart, `member:${user.id}`, personalMetrics, personalInsight, !!personalLlm, user.id)

    const [company, personal] = await Promise.all([
      storedInsight(weekStart, 'company'),
      storedInsight(weekStart, `member:${user.id}`),
    ])
    return c.json({
      data: {
        company: company
          ? { ...company, metrics: maskCompanyForViewer(company.metrics as WeeklyMetrics, rules, subject) }
          : null,
        personal,
      },
    })
  })

  return app
}
