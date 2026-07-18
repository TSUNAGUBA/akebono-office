/**
 * 日報 AI アシスト API（F-06-7）。mockup useReportAssist の API 版。
 * - ヒアリング回答・ぽいぽいメモは assist_logs へ追記のみ（記録系。答え直しは新しい回答が優先）
 * - ドラフト生成: Vertex AI（構造化出力）→ 失敗時は shared/domain/report-draft の
 *   決定的ヒューリスティックへフォールバック（原則4。モックと同一ロジック）。
 *   生成結果は保存しない（フォームへ流し込み → 既存 PUT /v1/reports/daily で提出）
 * - カレンダー予定はカレンダー連携（OAuth）バッチまで空 = wrap 3 問とタスク計画のみで生成
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { nextWorkingDay, workingDayRuleOf } from '../../../shared/domain/business-day'
import { nowJstIso, todayJst } from '../../../shared/domain/jst'
import type { DraftContext, ReportDraft } from '../../../shared/domain/report-draft'
import { heuristicReportDraft, toQuarterHours } from '../../../shared/domain/report-draft'
import type { HearingLog, TaskPlan } from '../../../shared/domain/types'
import type { Env } from '../env'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { ruleOf } from './attendance'
import { holidaySetAfter } from './holidays'

const LOG_COLS = `id, member_id AS "memberId", date::text AS date, kind,
  calendar_event_id AS "calendarEventId", question, answer, at`
const PLAN_COLS = `id, member_id AS "memberId", date::text AS date, calendar_event_id AS "calendarEventId",
  title, purpose, done_criteria AS "doneCriteria", approach, ai_comment AS "aiComment",
  ai_comment_at AS "aiCommentAt", status, outcome, reflection, result_at AS "resultAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`

function dateOrToday(v: unknown): string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : todayJst()
}

export function assistRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // 当日のヒアリングログ（本人のみ。設問生成はフロントの射影）
  app.get('/logs', async (c) => {
    const user = c.get('user')
    const date = dateOrToday(c.req.query('date'))
    const { rows } = await pool.query(
      `SELECT ${LOG_COLS} FROM assist_logs WHERE member_id = $1 AND date = $2::date ORDER BY at, id LIMIT 500`,
      [user.id, date])
    return c.json({ data: rows })
  })

  // ヒアリング回答の記録（本人・追記のみ）
  app.post('/answers', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const answer = String(body.answer ?? '').trim()
    if (!answer) throw err('AKO-RAS-001', '回答を入力してください', 400)
    const id = newId('hl')
    await pool.query(
      `INSERT INTO assist_logs (id, member_id, date, kind, calendar_event_id, question, answer, at)
       VALUES ($1, $2, $3, 'qa', $4, $5, $6, $7)`,
      [id, user.id, dateOrToday(body.date),
        typeof body.calendarEventId === 'string' && body.calendarEventId ? body.calendarEventId : null,
        String(body.question ?? ''), answer, nowJstIso()])
    return c.json({ data: { id } }, 201)
  })

  // ぽいぽいメモ（本人・追記のみ・2000 字まで）
  app.post('/memos', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    // 2000 字上限（コードポイント単位 = サロゲートペアを境界で壊さない）
    const text = [...String(body.text ?? '').trim()].slice(0, 2000).join('')
    if (!text) throw err('AKO-RAS-002', 'メモを入力してください', 400)
    const id = newId('hl')
    await pool.query(
      `INSERT INTO assist_logs (id, member_id, date, kind, calendar_event_id, question, answer, at)
       VALUES ($1, $2, $3, 'memo', NULL, '', $4, $5)`,
      [id, user.id, dateOrToday(body.date), text, nowJstIso()])
    return c.json({ data: { id } }, 201)
  })

  // 日報ドラフト生成（本人。保存しない = 何度でも再生成可）
  app.post('/report-draft', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const date = dateOrToday(body.date)
    // 翌営業日はメンバーの勤怠ルール（営業曜日・祝日考慮）+ 祝日マスタで解決
    // （オペレーター報告 2026-07-18 #4: 外注等の週末稼働・祝日をマスタで制御）
    const [rule, holidays] = await Promise.all([ruleOf(pool, user.id), holidaySetAfter(pool, date)])
    const nextDate = nextWorkingDay(date, workingDayRuleOf(rule), holidays)

    // 材料の収集（カレンダー予定は同期済みキャッシュ = calendar_events）
    const [logsQ, plansQ, nextPlansQ, projectsQ, companiesQ, eventsQ] = await Promise.all([
      pool.query<HearingLog>(
        `SELECT ${LOG_COLS} FROM assist_logs WHERE member_id = $1 AND date = $2::date ORDER BY at, id`,
        [user.id, date]),
      pool.query<TaskPlan>(
        `SELECT ${PLAN_COLS} FROM task_plans WHERE member_id = $1 AND date = $2::date ORDER BY created_at, id`,
        [user.id, date]),
      pool.query<TaskPlan>(
        `SELECT ${PLAN_COLS} FROM task_plans WHERE member_id = $1 AND date = $2::date ORDER BY created_at, id`,
        [user.id, nextDate]),
      pool.query<{ id: string; name: string; companyId: string }>(
        `SELECT id, name, company_id AS "companyId" FROM projects WHERE active = true ORDER BY id`),
      pool.query<{ id: string; name: string; aliases: string[] }>(
        `SELECT id, name, aliases FROM companies WHERE active = true ORDER BY id`),
      pool.query(
        `SELECT id, member_id AS "memberId", date::text AS date, from_time AS "from", to_time AS "to",
                title, source, synced_to_google AS "syncedToGoogle", project_id AS "projectId"
         FROM calendar_events WHERE member_id = $1 AND date = $2::date ORDER BY from_time LIMIT 200`,
        [user.id, date]),
    ])
    const ctx: DraftContext = {
      events: eventsQ.rows,
      logs: logsQ.rows,
      dayPlans: plansQ.rows,
      nextDayPlans: nextPlansQ.rows,
      projects: projectsQ.rows,
      companies: companiesQ.rows,
    }

    const draft = (await llmDraft(env, ctx, date)) ?? heuristicReportDraft(ctx, date)
    return c.json({ data: draft })
  })

  return app
}

/** LLM によるドラフト生成（失敗・無効環境は null → ヒューリスティックへ） */
async function llmDraft(env: Env, ctx: DraftContext, date: string): Promise<ReportDraft | null> {
  if (!env.vertexProjectId) return null
  if (ctx.logs.length === 0 && ctx.dayPlans.length === 0) return null // 材料ゼロは定型出力で十分
  const material = [
    `対象日: ${date}`,
    '## タスク計画（AI業務アシスタント）',
    ...ctx.dayPlans.map(p => `- [${p.status === 'done' ? '完了' : '計画'}] ${p.title}`
      + (p.outcome ? ` / 結果: ${p.outcome}` : '') + (p.reflection ? ` / 所感: ${p.reflection}` : '')),
    '## ヒアリング回答・メモ',
    ...ctx.logs.map(l => l.kind === 'memo' ? `- メモ: ${l.answer}` : `- Q: ${l.question} / A: ${l.answer}`),
    '## 翌営業日の計画',
    ...ctx.nextDayPlans.map(p => `- ${p.title}`),
    '## 参考: 有効なプロジェクト名（業務テーマの候補）',
    ...ctx.projects.map(p => `- ${p.name}`),
  ].join('\n')
  const res = await generateJson<ReportDraft>(env, {
    system: 'あなたは業務日報の下書きを作るアシスタントです。与えられた材料（タスク計画の結果・ヒアリング回答・メモ）'
      + 'だけを根拠に、日本語の日報ドラフトを JSON で返します。推測で事実を作らないこと。'
      + 'entries は作業単位（theme は業務テーマ = 短い名詞句 20 字以内・材料のプロジェクト名や業務分類を使う、'
      + 'task は 60 字以内、hours は 0.25 刻みの見積り、progress は 0-100）。reflection は所感（丁寧語 2〜4 文）、'
      + 'issues は課題（なければ空文字）、tomorrow は明日の予定の一言、basis は生成根拠の短い箇条書き。',
    prompt: material,
    schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              theme: { type: 'string' },
              task: { type: 'string' },
              hours: { type: 'number' },
              progress: { type: 'number' },
            },
            required: ['theme', 'task', 'hours', 'progress'],
          },
        },
        reflection: { type: 'string' },
        issues: { type: 'string' },
        tomorrow: { type: 'string' },
        basis: { type: 'array', items: { type: 'string' } },
      },
      required: ['entries', 'reflection', 'issues', 'tomorrow', 'basis'],
    },
  })
  if (!res || !Array.isArray(res.entries) || res.entries.length === 0) return null
  // LLM 出力の正規化: theme/task は文字数キャップ・hours 0.25 刻み・progress 0-100
  return {
    entries: res.entries.slice(0, 20).map(e => ({
      theme: [...String(e.theme ?? '').trim()].slice(0, 20).join(''),
      task: [...String(e.task ?? '')].slice(0, 120).join(''),
      hours: toQuarterHours(Math.min(24, Math.max(0, Number(e.hours) || 0)) * 60),
      progress: Math.min(100, Math.max(0, Math.round(Number(e.progress) || 0))),
    })),
    reflection: String(res.reflection ?? ''),
    issues: String(res.issues ?? ''),
    tomorrow: String(res.tomorrow ?? ''),
    basis: [...(Array.isArray(res.basis) ? res.basis.map(String) : []), 'AI（Vertex AI）が材料から生成'],
  }
}
