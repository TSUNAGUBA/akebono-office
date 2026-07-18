/**
 * エスカレーション API（F-12）。mockup useEscalations の API 版。
 * - 起票（POST /）: dedupeKey + クールダウンで冪等（AKO-ESC-001）。ルール無効は AKO-ESC-002
 * - 解決（POST /:id/resolution）: 管理者のみ。open → resolved のクレームファースト（AKO-ESC-003）。
 *   裁定はナレッジ還流（補助処理・失敗しても解決は成立）。回答は本人へ通知
 * - 36 協定チェック（POST /overtime-check）: 本人の月次閲覧を契機にサーバー側で判定して起票
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { nowJstIso, todayJst } from '../../../shared/domain/jst'
import type {
  AttendanceRule, EscalationReason, EscalationResolutionType, KnowledgeDomain, Member, PunchRecord,
} from '../../../shared/domain/types'
import { requireAdmin } from '../auth'
import { article36Alerts, resolveRule } from '../domain/attendance'
import { ATTENDANCE_RULE_COLS } from './attendance'
import { raiseEscalation } from '../lib/escalate'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { notify } from '../lib/notify'

const REASONS: EscalationReason[] = ['issue_reported', 'stalled_task', 'overload', 'low_confidence', 'overtime_alert']
const RESOLUTION_TYPES: EscalationResolutionType[] = ['answer', 'ruling', 'no_action']
const KNOWLEDGE_DOMAINS: KnowledgeDomain[] = ['company', 'contact', 'relation', 'project', 'industry']

const COLS = `id, reason, target_member_id AS "targetMemberId", target_ai_employee_id AS "targetAiEmployeeId",
  context, status, resolution, knowledge_reflected AS "knowledgeReflected",
  dedupe_key AS "dedupeKey", raised_at AS "raisedAt"`

export function escalationsRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 一覧（管理者のみ。open / resolved の分割はフロントの射影）
  app.get('/', async (c) => {
    requireAdmin(c)
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM escalations ORDER BY raised_at DESC, created_at DESC LIMIT 500`)
    return c.json({ data: rows })
  })

  // 起票（認証済みなら誰でも。クールダウン中は 409 AKO-ESC-001 = 既に共有済みの意）
  app.post('/', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as {
      reason?: EscalationReason; targetMemberId?: string; context?: string; dedupeKey?: string
    }
    if (!body.reason || !REASONS.includes(body.reason)) {
      throw err('AKO-GEN-001', 'reason を指定してください', 400)
    }
    if (!body.context?.trim() || !body.dedupeKey?.trim()) {
      throw err('AKO-GEN-001', 'context / dedupeKey を指定してください', 400)
    }
    const result = await raiseEscalation(pool, {
      reason: body.reason,
      targetMemberId: body.targetMemberId ?? user.id,
      context: body.context.trim(),
      dedupeKey: body.dedupeKey.trim(),
    })
    if (!result.raised) {
      if (result.code === 'AKO-ESC-001') throw err('AKO-ESC-001', 'クールダウン期間中のため重複起票をスキップしました', 409)
      if (result.code === 'AKO-ESC-002') throw err('AKO-ESC-002', 'このシグナルは設定で無効化されています', 409)
      throw err('AKO-ESC-999', '起票に失敗しました', 500)
    }
    return c.json({ data: { id: result.id } }, 201)
  })

  // 解決（管理者のみ。open → resolved のアトミッククレーム）
  app.post('/:id/resolution', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as {
      type?: EscalationResolutionType
      body?: string
      reflectKnowledge?: boolean
      knowledgeTarget?: { domain?: KnowledgeDomain; targetId?: string }
    }
    if (!body.type || !RESOLUTION_TYPES.includes(body.type)) {
      throw err('AKO-GEN-001', 'type は answer / ruling / no_action を指定してください', 400)
    }
    const text = (body.body ?? '').trim()
    if ((body.type === 'answer' || body.type === 'ruling') && !text) {
      throw err('AKO-GEN-001', '内容を入力してください', 400)
    }
    const resolvedAt = nowJstIso()

    const client = await pool.connect()
    let target: { targetMemberId: string | null; context: string } | undefined
    let knowledgeReflected = false
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ targetMemberId: string | null; context: string; status: string }>(
        `SELECT target_member_id AS "targetMemberId", context, status FROM escalations WHERE id = $1 FOR UPDATE`,
        [id])
      target = rows[0]
      if (!target || (target as { status?: string }).status !== 'open') {
        throw err('AKO-ESC-003', 'このエスカレーションは既に解決済みです', 409)
      }

      // 裁定のナレッジ還流（失敗しても解決は成立させる）。
      // Postgres は文の失敗でトランザクション全体が abort 状態になるため、SAVEPOINT で還流のみ巻き戻す
      if (body.type === 'ruling' && body.reflectKnowledge) {
        const domain = body.knowledgeTarget?.domain
        const targetId = body.knowledgeTarget?.targetId ?? ''
        if (domain && KNOWLEDGE_DOMAINS.includes(domain) && targetId) {
          await client.query('SAVEPOINT knowledge_reflux')
          try {
            const ctx = [...target.context]
            const title = `裁定: ${ctx.slice(0, 24).join('')}${ctx.length > 24 ? '…' : ''}`
            await client.query(
              `INSERT INTO knowledge_articles (id, domain, target_id, title, body, tags, source, source_ref_id, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, 'escalation', $7, now())`,
              [newId('ka'), domain, targetId, title, text, JSON.stringify(['裁定']), id])
            knowledgeReflected = true
          } catch (e) {
            await client.query('ROLLBACK TO SAVEPOINT knowledge_reflux')
            console.warn('knowledge reflux failed (non-blocking):', (e as Error).message)
            knowledgeReflected = false
          }
        }
      }

      await client.query(
        `UPDATE escalations
         SET status = 'resolved', resolution = $2, knowledge_reflected = $3, updated_at = now()
         WHERE id = $1`,
        [id, JSON.stringify({ type: body.type, body: text, resolvedBy: user.id, at: resolvedAt }), knowledgeReflected])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    // 回答送信は本人へ届ける（補助処理）
    if (body.type === 'answer' && target?.targetMemberId) {
      await notify(pool, target.targetMemberId, 'escalation', '管理者からの回答', text, '/inbox')
    }
    return c.json({ data: { id, knowledgeReflected } })
  })

  // 36 協定チェック（本人の月次閲覧を契機にサーバー側で判定 → アラートがあれば起票。冪等）
  app.post('/overtime-check', async (c) => {
    const user = c.get('user')
    const endMonth = todayJst().slice(0, 7)
    const { rows } = await pool.query<PunchRecord>(
      `SELECT id, member_id AS "memberId", date, kind, at, source,
              fixed_from AS "fixedFrom", fix_reason AS "fixReason", approved_by AS "approvedBy"
       FROM punch_records
       WHERE member_id = $1 AND date >= ($2::date - interval '5 months') AND date < ($2::date + interval '1 month')
       ORDER BY at, created_at`,
      [user.id, `${endMonth}-01`])
    const member = await pool.query<Pick<Member, 'attendanceRuleId' | 'employmentType'>>(
      `SELECT attendance_rule_id AS "attendanceRuleId", employment_type AS "employmentType" FROM members WHERE id = $1`,
      [user.id])
    const rules = await pool.query(
      `SELECT ${ATTENDANCE_RULE_COLS} FROM attendance_rules ORDER BY id`)
    const byDate = new Map<string, PunchRecord[]>()
    for (const p of rows) {
      const list = byDate.get(p.date) ?? []
      list.push(p)
      byDate.set(p.date, list)
    }
    const alerts = article36Alerts(byDate, resolveRule(member.rows[0], rules.rows as AttendanceRule[]), endMonth)
    if (alerts.length === 0) return c.json({ data: { raised: false } })
    const result = await raiseEscalation(pool, {
      reason: 'overtime_alert',
      targetMemberId: user.id,
      context: `36協定アラート: ${alerts.map(a => a.message).join(' / ')}`,
      dedupeKey: `overtime:${user.id}:${endMonth}`,
    })
    return c.json({ data: { raised: result.raised } })
  })

  return app
}
