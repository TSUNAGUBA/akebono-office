/**
 * 顧客ログ API（オペレーター指示 2026-07-30）。
 * 「いつ（何月何日・時刻は任意）どの顧客（会社/人）とどんな会話をしたか」を本人が記録する。
 * - 記録系 = 追記 + 本人編集（監査ログ）+ 取消(archive)/復元(restore)（原則2/9.5）。本人のみ操作可（AKO-CLG-002）。
 * - 他メンバー参照（F-16）: GET は ?memberId= で readonly 参照可（canViewMemberCustomerLog で enforcement。
 *   既定 = 参照不可の許可制。未許可は AKO-PRM-002 403）。自分のログは常に参照可。
 * - AI 参照: 書込後に検索インデックスを再生成（owner スコープ付き = 本人のログのみ AI 文脈へ = search-index 側）。
 * - 機能ガード: customer-log（F-16。既定 allow = 誰でも自分のログは記録・参照できる）。
 * エラー: AKO-CLG-001 入力不正 / 002 対象なし・権限なし（本人以外の操作）/ 003 会社と担当者の不整合。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { canViewMemberCustomerLog } from '../../../shared/domain/permissions'
import type { CustomerLog } from '../../../shared/domain/types'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { scheduleSearchRebuild } from '../lib/search-index'
import { capCp } from '../lib/text'

const BODY_CAP = 20_000
const TITLE_CAP = 200
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// createdAt/updatedAt は JST ウォールクロック文字列で返す（notes/task-plans/chatbot と同一規約。
// フロントは文字列を直接パースするため UTC の "Z" ISO を返すと日付キー比較・表示が最大 9 時間ずれる）。
// log_date は date 型（tz なし）のため ::text で 'YYYY-MM-DD' をそのまま返す
const CLOG_COLS = `id, member_id AS "memberId", log_date::text AS "logDate", log_time AS "logTime",
  company_id AS "companyId", contact_id AS "contactId", title, body, active,
  to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt"`

/** 任意の紐付け id（空文字は null 化。存在チェックは FK が担い 400 で報告） */
function refOrNull(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || null
}

/** 日付（YYYY-MM-DD・実在日）。不正・存在しない日（2026-13-40 等）は 400 で弾く（DB の 22007 を出さない） */
function parseDate(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!DATE_RE.test(s)) throw err('AKO-CLG-001', '日付（何月何日）を選択してください', 400)
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw err('AKO-CLG-001', '日付が正しくありません', 400)
  }
  return s
}

/** 時刻（HH:MM・任意）。空は null。書式不正は 400 */
function parseTime(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (!TIME_RE.test(s)) throw err('AKO-CLG-001', '時刻は HH:MM 形式で入力してください', 400)
  return s
}

/** 会話内容（必須・上限 cap） */
function parseBody(v: unknown): string {
  const s = capCp(String(v ?? '').trim(), BODY_CAP)
  if (!s) throw err('AKO-CLG-001', '会話内容を入力してください', 400)
  return s
}

/** 顧客(会社)（必須） */
function parseCompanyId(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) throw err('AKO-CLG-001', '顧客(会社)を選択してください', 400)
  return s
}

/** 担当者(人)が選択した会社に属するか検証（FK では表現できない整合を API 層で担保） */
async function assertContact(pool: pg.Pool, contactId: string, companyId: string): Promise<void> {
  const { rows } = await pool.query<{ companyId: string }>(
    `SELECT company_id AS "companyId" FROM contacts WHERE id = $1`, [contactId])
  const row = rows[0]
  if (!row) throw err('AKO-CLG-003', '指定した顧客担当者が見つかりません', 400)
  if (row.companyId !== companyId) {
    throw err('AKO-CLG-003', '顧客担当者は選択した会社に所属している必要があります', 400)
  }
}

/** 本人のログを取得（本人以外・不在は 403 = 存在を秘匿。task-plans ownPlan と同型） */
async function ownLog(pool: pg.Pool, logId: string, memberId: string, message: string): Promise<CustomerLog> {
  const { rows } = await pool.query<CustomerLog>(`SELECT ${CLOG_COLS} FROM customer_logs WHERE id = $1`, [logId])
  const row = rows[0]
  if (!row || row.memberId !== memberId) throw err('AKO-CLG-002', message, 403)
  return row
}

export function customerLogsRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // 一覧（既定 = 本人。memberId 指定 = 他メンバーの readonly 参照 = 権限で許可された対象者のみ）。
  // 期間 from/to・会社/担当者フィルタは任意。includeArchived=1 は本人のみ（復元 UI 用。他人の取消済みは晒さない）
  app.get('/', async (c) => {
    const user = c.get('user')
    const target = c.req.query('memberId')?.trim() || user.id
    if (target !== user.id) {
      const rules = await activePermissionRules(pool)
      if (!canViewMemberCustomerLog(rules, subjectOf(user), target)) {
        throw err('AKO-PRM-002', '指定メンバーの顧客ログを参照する権限がありません', 403)
      }
    }
    const includeArchived = c.req.query('includeArchived') === '1' && target === user.id
    const params: unknown[] = [target]
    const conds = ['member_id = $1']
    if (!includeArchived) conds.push('active = true')
    const from = c.req.query('from')?.trim()
    if (from && DATE_RE.test(from)) { params.push(from); conds.push(`log_date >= $${params.length}::date`) }
    const to = c.req.query('to')?.trim()
    if (to && DATE_RE.test(to)) { params.push(to); conds.push(`log_date <= $${params.length}::date`) }
    const companyId = c.req.query('companyId')?.trim()
    if (companyId) { params.push(companyId); conds.push(`company_id = $${params.length}`) }
    const contactId = c.req.query('contactId')?.trim()
    if (contactId) { params.push(contactId); conds.push(`contact_id = $${params.length}`) }
    const { rows } = await pool.query(
      `SELECT ${CLOG_COLS} FROM customer_logs WHERE ${conds.join(' AND ')}
       ORDER BY log_date DESC, log_time DESC NULLS LAST, created_at DESC, id DESC LIMIT 1000`, params)
    return c.json({ data: rows })
  })

  // 登録（本人）
  app.post('/', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const logDate = parseDate(b.logDate)
    const logTime = parseTime(b.logTime)
    const companyId = parseCompanyId(b.companyId)
    const contactId = refOrNull(b.contactId)
    const title = capCp(String(b.title ?? '').trim(), TITLE_CAP)
    const body = parseBody(b.body)
    if (contactId) await assertContact(pool, contactId, companyId)
    const id = newId('clog')
    try {
      await pool.query(
        `INSERT INTO customer_logs (id, member_id, log_date, log_time, company_id, contact_id, title, body)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)`,
        [id, user.id, logDate, logTime, companyId, contactId, title, body])
    } catch (e) {
      if ((e as { code?: string }).code === '23503') {
        throw err('AKO-CLG-001', '紐付け先（顧客・担当者）が見つかりません', 400)
      }
      throw e
    }
    await audit(pool, { actorId: user.id, action: 'create', entity: 'customer_logs', entityId: id, detail: '顧客ログを登録' })
    scheduleSearchRebuild(pool, env, 'customer-log:create')
    const { rows } = await pool.query(`SELECT ${CLOG_COLS} FROM customer_logs WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  // 編集（本人のみ）。送られたキーのみ更新し未指定は現状維持する（部分更新の安全側 = CLAUDE.md 部分更新原則。
  // Zod を使わない手動バリデーションのため既定値注入の問題は無いが、明示的に「現状マージ → 全体検証 → 書込」）
  app.patch('/:id', async (c) => {
    const user = c.get('user')
    const logId = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await ownLog(pool, logId, user.id, '自分の顧客ログのみ編集できます')
    const next = {
      logDate: Object.hasOwn(b, 'logDate') ? parseDate(b.logDate) : cur.logDate,
      logTime: Object.hasOwn(b, 'logTime') ? parseTime(b.logTime) : cur.logTime,
      companyId: Object.hasOwn(b, 'companyId') ? parseCompanyId(b.companyId) : cur.companyId,
      contactId: Object.hasOwn(b, 'contactId') ? refOrNull(b.contactId) : cur.contactId,
      title: Object.hasOwn(b, 'title') ? capCp(String(b.title ?? '').trim(), TITLE_CAP) : cur.title,
      body: Object.hasOwn(b, 'body') ? parseBody(b.body) : cur.body,
    }
    if (next.contactId) await assertContact(pool, next.contactId, next.companyId)
    try {
      await pool.query(
        `UPDATE customer_logs
         SET log_date = $2::date, log_time = $3, company_id = $4, contact_id = $5,
             title = $6, body = $7, updated_at = now()
         WHERE id = $1`,
        [logId, next.logDate, next.logTime, next.companyId, next.contactId, next.title, next.body])
    } catch (e) {
      if ((e as { code?: string }).code === '23503') {
        throw err('AKO-CLG-001', '紐付け先（顧客・担当者）が見つかりません', 400)
      }
      throw e
    }
    await audit(pool, { actorId: user.id, action: 'update', entity: 'customer_logs', entityId: logId, detail: '顧客ログを編集' })
    scheduleSearchRebuild(pool, env, 'customer-log:update')
    const { rows } = await pool.query(`SELECT ${CLOG_COLS} FROM customer_logs WHERE id = $1`, [logId])
    return c.json({ data: rows[0] })
  })

  // 取消（論理削除。本人のみ）。冪等: active = true 条件で更新し、同時実行でも監査ログは 1 回だけ
  app.post('/:id/archive', async (c) => {
    const user = c.get('user')
    const logId = c.req.param('id')
    await ownLog(pool, logId, user.id, '自分の顧客ログのみ取り消せます')
    const upd = await pool.query(
      `UPDATE customer_logs SET active = false, updated_at = now() WHERE id = $1 AND active = true`, [logId])
    if (upd.rowCount === 0) return c.json({ data: { id: logId, warning: 'すでに取消済みです' } })
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'customer_logs', entityId: logId, detail: '顧客ログを取消' })
    scheduleSearchRebuild(pool, env, 'customer-log:archive')
    return c.json({ data: { id: logId } })
  })

  // 復元（取消の取消。本人のみ = 原則9.5 の対称性）
  app.post('/:id/restore', async (c) => {
    const user = c.get('user')
    const logId = c.req.param('id')
    await ownLog(pool, logId, user.id, '自分の顧客ログのみ復元できます')
    const upd = await pool.query(
      `UPDATE customer_logs SET active = true, updated_at = now() WHERE id = $1 AND active = false`, [logId])
    if (upd.rowCount === 0) return c.json({ data: { id: logId, warning: '取消されていません' } })
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'customer_logs', entityId: logId, detail: '顧客ログを復元' })
    scheduleSearchRebuild(pool, env, 'customer-log:restore')
    return c.json({ data: { id: logId } })
  })

  return app
}
