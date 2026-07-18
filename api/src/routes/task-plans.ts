/**
 * タスク計画 API（F-14 AI業務アシスタント）。mockup useTaskPlans の API 版。
 * - 計画は本人のみ操作可（AKO-TPL-003）。結果記録済み（done）は編集・削除不可（AKO-TPL-004 = 記録系保護）
 * - AI コメント: Vertex AI（lib/llm.generateJson）→ 失敗時は shared/domain/task-plan-review の
 *   決定的ヒューリスティックへフォールバック（原則4。モックと同一文言）
 * - インサイト: 管理者のみ。メンバー別の計画数・完了率・振り返り記入率をサーバー集計
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { addDays, nowJstIso, todayJst } from '../../../shared/domain/jst'
import { heuristicPlanReview } from '../../../shared/domain/task-plan-review'
import type { TaskPlan } from '../../../shared/domain/types'
import { requireAdmin } from '../auth'
import type { Env } from '../env'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'

const COLS = `id, member_id AS "memberId", date::text AS date, calendar_event_id AS "calendarEventId",
  title, purpose, done_criteria AS "doneCriteria", approach, ai_comment AS "aiComment",
  ai_comment_at AS "aiCommentAt", status, outcome, reflection, result_at AS "resultAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`

/** 本人の計画をクレーム付きで取得（403/404 はモックのエラー区分と同一） */
async function ownPlan(
  db: pg.Pool | pg.PoolClient,
  planId: string,
  memberId: string,
  message: string,
): Promise<TaskPlan> {
  const { rows } = await db.query<TaskPlan>(`SELECT ${COLS} FROM task_plans WHERE id = $1`, [planId])
  const p = rows[0]
  if (!p || p.memberId !== memberId) throw err('AKO-TPL-003', message, 403)
  return p
}

export function taskPlansRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // 一覧（本人のみ。期間指定 from/to。インサイトは /insights = 管理者のサーバー集計）
  app.get('/', async (c) => {
    const user = c.get('user')
    const from = c.req.query('from') ?? addDays(todayJst(), -31)
    const to = c.req.query('to') ?? addDays(todayJst(), 31)
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM task_plans
       WHERE member_id = $1 AND date >= $2::date AND date <= $3::date
       ORDER BY date, created_at, id LIMIT 2000`,
      [user.id, from, to])
    return c.json({ data: rows })
  })

  // 計画の作成・更新（本人のみ。done は編集不可。更新時は AI コメントを保持）
  app.put('/', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const title = String(body.title ?? '').trim()
    if (!title) throw err('AKO-TPL-001', 'タスク名を入力してください', 400)
    const date = String(body.date ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err('AKO-TPL-002', '実施予定日を選択してください', 400)
    const purpose = String(body.purpose ?? '').trim()
    const doneCriteria = String(body.doneCriteria ?? '').trim()
    const approach = String(body.approach ?? '').trim()
    const calendarEventId = typeof body.calendarEventId === 'string' && body.calendarEventId
      ? body.calendarEventId
      : null
    const now = nowJstIso()
    const planId = typeof body.id === 'string' && body.id ? body.id : null

    if (planId) {
      const existing = await ownPlan(pool, planId, user.id, '自分の計画のみ編集できます')
      if (existing.status === 'done') throw err('AKO-TPL-004', '結果記録済みの計画は編集できません', 409)
      await pool.query(
        `UPDATE task_plans
         SET date = $2, calendar_event_id = $3, title = $4, purpose = $5,
             done_criteria = $6, approach = $7, updated_at = $8
         WHERE id = $1`,
        [planId, date, calendarEventId, title, purpose, doneCriteria, approach, now])
      return c.json({ data: { id: planId } })
    }
    const id = newId('tp')
    await pool.query(
      `INSERT INTO task_plans (id, member_id, date, calendar_event_id, title, purpose,
         done_criteria, approach, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [id, user.id, date, calendarEventId, title, purpose, doneCriteria, approach, now])
    return c.json({ data: { id } }, 201)
  })

  // 計画の削除（本人・planned のみ。done は記録のため削除不可）
  app.post('/:id/remove', async (c) => {
    const user = c.get('user')
    const planId = c.req.param('id')
    const p = await ownPlan(pool, planId, user.id, '自分の計画のみ削除できます')
    if (p.status === 'done') throw err('AKO-TPL-004', '結果記録済みの計画は削除できません', 409)
    await pool.query(`DELETE FROM task_plans WHERE id = $1`, [planId])
    return c.json({ data: { id: planId } })
  })

  // AI レビューコメント（本人・planned のみ。LLM → 失敗時ヒューリスティック。何度でも再取得可 = 上書きのみ）
  app.post('/:id/ai-review', async (c) => {
    const user = c.get('user')
    const planId = c.req.param('id')
    const p = await ownPlan(pool, planId, user.id, '自分の計画のみレビューを受けられます')
    if (p.status === 'done') throw err('AKO-TPL-004', '結果記録済みの計画はレビュー対象外です', 409)

    let comment: string | null = null
    const llm = await generateJson<{ good: string[]; advice: string[] }>(env, {
      system: 'あなたは業務タスク計画のレビュアーです。目的の具体性・達成条件の検証可能性（第三者が判定できるか）・'
        + '段取りのステップ分解の 3 観点で計画を批評し、良い点（good）と改善提案（advice）を日本語で返します。'
        + '各項目は 1〜2 文の丁寧語。advice が空になる場合は、リスクへの備え（撤退ライン等）を 1 件入れてください。',
      prompt: `タスク名: ${p.title}\n目的: ${p.purpose || '（未記入）'}\n達成条件: ${p.doneCriteria || '（未記入）'}\n`
        + `段取り: ${p.approach || '（未記入）'}`,
      schema: {
        type: 'object',
        properties: {
          good: { type: 'array', items: { type: 'string' } },
          advice: { type: 'array', items: { type: 'string' } },
        },
        required: ['good', 'advice'],
      },
    })
    if (llm && (llm.good.length > 0 || llm.advice.length > 0)) {
      comment = [...llm.good, ...llm.advice].map(s => String(s).trim()).filter(Boolean).join('\n')
    }
    // フォールバック（LLM 無効・失敗・空応答）: モックと同一の決定的ヒューリスティック
    if (!comment) {
      comment = heuristicPlanReview({ purpose: p.purpose, doneCriteria: p.doneCriteria, approach: p.approach })
    }
    await pool.query(
      `UPDATE task_plans SET ai_comment = $2, ai_comment_at = $3, updated_at = $3 WHERE id = $1`,
      [planId, comment, nowJstIso()])
    return c.json({ data: { id: planId, aiComment: comment } })
  })

  // 結果・所感の記録（本人のみ・1 回で確定。以後は編集不可 = 記録系）
  app.post('/:id/result', async (c) => {
    const user = c.get('user')
    const planId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { outcome?: string; reflection?: string }
    const outcome = String(body.outcome ?? '').trim()
    if (!outcome) throw err('AKO-TPL-005', '結果を入力してください', 400)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // クレームファースト: 二重記録を FOR UPDATE で防ぐ（記録系は 1 回で確定）
      const { rows } = await client.query<{ memberId: string; status: string }>(
        `SELECT member_id AS "memberId", status FROM task_plans WHERE id = $1 FOR UPDATE`, [planId])
      const p = rows[0]
      if (!p || p.memberId !== user.id) throw err('AKO-TPL-003', '自分の計画のみ記録できます', 403)
      if (p.status === 'done') throw err('AKO-TPL-004', 'この計画は記録済みです', 409)
      const now = nowJstIso()
      await client.query(
        `UPDATE task_plans
         SET status = 'done', outcome = $2, reflection = $3, result_at = $4, updated_at = $4
         WHERE id = $1`,
        [planId, outcome, String(body.reflection ?? '').trim(), now])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    return c.json({ data: { id: planId } })
  })

  // 管理者インサイト（直近 days 日）: 計画数・完了率（分母 = 対象日が今日以前）・振り返り記入率
  app.get('/insights', async (c) => {
    requireAdmin(c)
    const days = Math.min(62, Math.max(1, Number(c.req.query('days') ?? 7)))
    const today = todayJst()
    const from = addDays(today, -(days - 1))
    const { rows } = await pool.query<{
      memberId: string
      name: string
      planned: number
      due: number
      done: number
      reflected: number
    }>(
      `SELECT m.id AS "memberId", m.name,
              count(p.id)::int AS planned,
              count(p.id) FILTER (WHERE p.date <= $2::date)::int AS due,
              count(p.id) FILTER (WHERE p.date <= $2::date AND p.status = 'done')::int AS done,
              count(p.id) FILTER (WHERE p.date <= $2::date AND p.status = 'done'
                AND btrim(p.reflection) <> '')::int AS reflected
       FROM members m
       JOIN task_plans p ON p.member_id = m.id AND p.date >= $1::date AND p.date <= $2::date
       WHERE m.active = true AND m.employment_type <> 'outsource'
       GROUP BY m.id, m.name
       HAVING count(p.id) > 0
       ORDER BY count(p.id) DESC`,
      [from, today])
    return c.json({
      data: rows.map(r => ({
        memberId: r.memberId,
        name: r.name,
        planned: r.planned,
        done: r.done,
        doneRate: r.due > 0 ? r.done / r.due : null,
        reflectionRate: r.done > 0 ? r.reflected / r.done : null,
      })),
    })
  })

  return app
}
