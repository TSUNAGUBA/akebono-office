/**
 * 活動記録 API（サポート活動 / 営業活動 / ビジネスパートナー活動。改修依頼 2026-08-18・F-43/F-44/F-45）。
 * - 記録系（チーム共有）: 認証済み全員が閲覧・登録・編集できる（顧客活動の本人所有と異なり、対応状況を
 *   チームで引き継ぐ運用のため編集も全員可 = 訂正履歴は監査ログで残す）。取消 = 論理削除 + 復元（原則9.5）。
 * - 一覧 GET は lib/list-query の共通実装（サーバーページング + 検索 + 構造化フィルタ。
 *   パラメータ無しは maxLimit までの全件 = useApi.loadApiCollection の全件ハイドレーションと互換）。
 * - 入力検証は shared/domain/activity の純関数を宣言順で適用（モックとパリティ = SoT）。
 * - 顧客(会社)のコンボボックス新規登録（サポート/営業）は lib/company-resolve（customer-logs と共通 = 原則3）。
 * - AI 検索インデックスへは供給しない（AI 参照範囲の拡大は別途の設計判断とする = 安全側）。
 * - 機能ガード: support-activity / sales-activity / partner-activity（F-16。既定 allow）。
 * エラー: AKO-SUP/SAL/PTN-001 入力不正（400）/ -002 対象なし（404）。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import {
  ACTIVITY_BODY_CAP as BODY_CAP, ACTIVITY_NAME_CAP as NAME_CAP, ACTIVITY_TITLE_CAP as TITLE_CAP,
  partnerActivityError, type PartnerActivityInput,
  salesActivityError, type SalesActivityInput,
  supportActivityError, type SupportActivityInput,
} from '../../../shared/domain/activity'
import { capCodePoints } from '../../../shared/domain/customer-log'
import type { AuthUser } from '../auth'
import { audit } from '../lib/audit'
import { auditCreatedCompany, resolveCompany } from '../lib/company-resolve'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { runListQuery } from '../lib/list-query'

// created_at/updated_at は JST ウォールクロック文字列で返す（customer-logs と同一規約）
const JST_STAMPS = `to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt"`

const SUPPORT_COLS = `id, member_id AS "memberId", received_date::text AS "receivedDate",
  received_time AS "receivedTime", company_id AS "companyId", inquirer_name AS "inquirerName",
  target_system AS "targetSystem", category, title, body, priority, status,
  staff_member_id AS "staffMemberId", response, cause, resolution,
  completed_date::text AS "completedDate", completed_time AS "completedTime",
  knowledge_note AS "knowledgeNote", active, ${JST_STAMPS}`

const SALES_COLS = `id, member_id AS "memberId", company_id AS "companyId", title,
  deal_type AS "dealType", staff_member_id AS "staffMemberId", phase,
  amount::float8 AS "amount", probability, expected_close_date::text AS "expectedCloseDate",
  customer_issue AS "customerIssue", proposal, next_action AS "nextAction",
  next_action_date::text AS "nextActionDate", active, ${JST_STAMPS}`

const PARTNER_COLS = `id, member_id AS "memberId", partner_name AS "partnerName", theme,
  related_company AS "relatedCompany", activity_type AS "activityType", status, summary,
  current_state AS "currentState", next_action AS "nextAction",
  next_action_date::text AS "nextActionDate", staff_member_id AS "staffMemberId",
  related_meeting AS "relatedMeeting", related_sales_activity_id AS "relatedSalesActivityId",
  memo, active, ${JST_STAMPS}`

// ---------- 共通ヘルパー ----------

type ErrCode = 'AKO-SUP' | 'AKO-SAL' | 'AKO-PTN'

/** shared 検証（メッセージ | null）を -001（400）へ変換する */
function assertValid(code: ErrCode, message: string | null): void {
  if (message) throw err(`${code}-001`, message, 400)
}

/** 文字列（trim + コードポイント cap） */
function str(v: unknown, cap: number): string {
  return capCodePoints(String(v ?? '').trim(), cap)
}

/** 任意の日付/時刻（空は null。実在検証は shared 側の xxxActivityError が担う） */
function strOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim()
  return s || null
}

/** 任意の数値（null/'' = null。数値でない持込は NaN のまま渡し shared 検証で 400 にする） */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  return Number(v)
}

/** 対象 1 件の取得（不在・型は 404。取消済みも返す = 復元/編集 UI 用） */
async function findRow<T extends pg.QueryResultRow>(pool: pg.Pool, code: ErrCode, cols: string, table: string, id: string, label: string): Promise<T> {
  const { rows } = await pool.query<T>(`SELECT ${cols} FROM ${table} WHERE id = $1`, [id])
  if (!rows[0]) throw err(`${code}-002`, `${label}が見つかりません`, 404)
  return rows[0]
}

/** FK 違反（23503）を入力エラーへ変換（紐付け先の不在 = 400） */
function refError(code: ErrCode, e: unknown, refsLabel: string): never {
  if ((e as { code?: string }).code === '23503') {
    throw err(`${code}-001`, `紐付け先（${refsLabel}）が見つかりません`, 400)
  }
  throw e
}

/** 取消/復元（論理削除。全員可・冪等: 条件付き UPDATE で同時実行でも監査ログは 1 回だけ） */
function archiveRestoreRoutes(
  app: Hono, pool: pg.Pool, table: string, entity: string, label: string,
  code: ErrCode, cols: string,
): void {
  app.post('/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findRow(pool, code, cols, table, id, label)
    const upd = await pool.query(
      `UPDATE ${table} SET active = false, updated_at = now() WHERE id = $1 AND active = true`, [id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: 'すでに取消済みです' } })
    await audit(pool, { actorId: user.id, action: 'archive', entity, entityId: id, detail: `${label}を取消` })
    return c.json({ data: { id } })
  })

  app.post('/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findRow(pool, code, cols, table, id, label)
    const upd = await pool.query(
      `UPDATE ${table} SET active = true, updated_at = now() WHERE id = $1 AND active = false`, [id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: '取消されていません' } })
    await audit(pool, { actorId: user.id, action: 'restore', entity, entityId: id, detail: `${label}を復元` })
    return c.json({ data: { id } })
  })
}

/**
 * 会社解決付きの書込（サポート/営業。トランザクションで resolveCompany → 書込 → コミット後に監査。
 * customer-logs と同じ「SoT 先行の原子性」= 検証失敗時に孤児マスタを残さない）
 */
async function writeWithCompany(
  pool: pg.Pool,
  user: AuthUser,
  code: ErrCode,
  refsLabel: string,
  fromLabel: string,
  companyId: string | null,
  newCompanyName: string,
  run: (db: pg.PoolClient, companyId: string) => Promise<void>,
): Promise<void> {
  const client = await pool.connect()
  let created: { id: string; name: string } | null = null
  try {
    await client.query('BEGIN')
    const company = await resolveCompany(client, companyId, newCompanyName)
    created = company.created
    await run(client, company.id)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    refError(code, e, refsLabel)
  } finally {
    client.release()
  }
  await auditCreatedCompany(pool, user, created, fromLabel)
}

// ---------- サポート活動（F-43） ----------

/** リクエスト body → 入力（cap 適用。companyId 未指定は newCompanyName で解決） */
function supportInputOf(b: Record<string, unknown>, userId: string): SupportActivityInput {
  return {
    receivedDate: String(b.receivedDate ?? '').trim(),
    receivedTime: strOrNull(b.receivedTime),
    companyId: String(b.companyId ?? '').trim(),
    newCompanyName: String(b.newCompanyName ?? ''),
    inquirerName: str(b.inquirerName, NAME_CAP),
    targetSystem: str(b.targetSystem, NAME_CAP),
    category: String(b.category ?? '').trim(),
    title: str(b.title, TITLE_CAP),
    body: str(b.body, BODY_CAP),
    priority: String(b.priority ?? '').trim(),
    status: String(b.status ?? '').trim(),
    staffMemberId: String(b.staffMemberId ?? '').trim() || userId,
    response: str(b.response, BODY_CAP),
    cause: str(b.cause, BODY_CAP),
    resolution: str(b.resolution, BODY_CAP),
    completedDate: strOrNull(b.completedDate),
    completedTime: strOrNull(b.completedTime),
    knowledgeNote: str(b.knowledgeNote, BODY_CAP),
  }
}

export function supportActivitiesRoutes(pool: pg.Pool): Hono {
  const app = new Hono()
  const REFS = '顧客・自社担当者'

  // 一覧（サーバーページング + 検索 + フィルタ。q は件名/内容/顧客名/問い合わせ者/対象システムを横断。
  // 顧客名検索のため companies を JOIN = 射影列はテーブル別名付き supportColsFor で曖昧列名を避ける）
  app.get('/', async (c) => {
    const res = await runListQuery(pool, c, {
      table: 'support_activities sa LEFT JOIN companies c ON c.id = sa.company_id',
      cols: supportColsFor('sa'),
      orderBy: 'sa.received_date DESC, sa.created_at DESC, sa.id DESC',
      maxLimit: 1000,
      defaultLimit: 20,
      searchCols: ['sa.title', 'sa.body', 'c.name', 'sa.inquirer_name', 'sa.target_system'],
      filterCols: {
        status: { col: 'sa.status', kind: 'enum' },
        category: { col: 'sa.category', kind: 'enum' },
        priority: { col: 'sa.priority', kind: 'enum' },
        companyId: { col: 'sa.company_id', kind: 'eq' },
        active: { col: 'sa.active::text', kind: 'eq' },
      },
    })
    return c.json(res)
  })

  // 登録（全員可）
  app.post('/', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = supportInputOf(b, user.id)
    assertValid('AKO-SUP', supportActivityError(input))
    const id = newId('sup')
    await writeWithCompany(pool, user, 'AKO-SUP', REFS, 'サポート活動', input.companyId || null, input.newCompanyName,
      async (db, companyId) => {
        await db.query(
          `INSERT INTO support_activities
             (id, member_id, received_date, received_time, company_id, inquirer_name, target_system,
              category, title, body, priority, status, staff_member_id, response, cause, resolution,
              completed_date, completed_time, knowledge_note)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::date, $18, $19)`,
          [id, user.id, input.receivedDate, input.receivedTime, companyId, input.inquirerName,
            input.targetSystem, input.category, input.title, input.body, input.priority, input.status,
            input.staffMemberId, input.response, input.cause, input.resolution,
            input.completedDate, input.completedTime, input.knowledgeNote])
      })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'support_activities', entityId: id, detail: 'サポート活動を登録' })
    const { rows } = await pool.query(`SELECT ${SUPPORT_COLS} FROM support_activities WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  // 編集（全員可 = チーム共有の記録。訂正履歴は監査ログ。フォームは全項目送信 = 実質全置換）
  app.patch('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await findRow<SupportActivityInput & { companyId: string }>(
      pool, 'AKO-SUP', SUPPORT_COLS, 'support_activities', id, 'サポート活動')
    // 送られたキーのみ更新（部分更新の安全側 = CLAUDE.md 部分更新原則）→ マージ後に shared 宣言順で全体検証
    const has = (k: string): boolean => Object.hasOwn(b, k)
    const touchesCompany = has('companyId') || has('newCompanyName')
    const merged: SupportActivityInput = {
      receivedDate: has('receivedDate') ? String(b.receivedDate ?? '').trim() : cur.receivedDate,
      receivedTime: has('receivedTime') ? strOrNull(b.receivedTime) : cur.receivedTime,
      companyId: touchesCompany ? String(b.companyId ?? '').trim() : cur.companyId,
      newCompanyName: touchesCompany ? String(b.newCompanyName ?? '') : '',
      inquirerName: has('inquirerName') ? str(b.inquirerName, NAME_CAP) : cur.inquirerName,
      targetSystem: has('targetSystem') ? str(b.targetSystem, NAME_CAP) : cur.targetSystem,
      category: has('category') ? String(b.category ?? '').trim() : cur.category,
      title: has('title') ? str(b.title, TITLE_CAP) : cur.title,
      body: has('body') ? str(b.body, BODY_CAP) : cur.body,
      priority: has('priority') ? String(b.priority ?? '').trim() : cur.priority,
      status: has('status') ? String(b.status ?? '').trim() : cur.status,
      staffMemberId: has('staffMemberId') ? (String(b.staffMemberId ?? '').trim() || user.id) : cur.staffMemberId,
      response: has('response') ? str(b.response, BODY_CAP) : cur.response,
      cause: has('cause') ? str(b.cause, BODY_CAP) : cur.cause,
      resolution: has('resolution') ? str(b.resolution, BODY_CAP) : cur.resolution,
      completedDate: has('completedDate') ? strOrNull(b.completedDate) : cur.completedDate,
      completedTime: has('completedTime') ? strOrNull(b.completedTime) : cur.completedTime,
      knowledgeNote: has('knowledgeNote') ? str(b.knowledgeNote, BODY_CAP) : cur.knowledgeNote,
    }
    assertValid('AKO-SUP', supportActivityError(merged))
    await writeWithCompany(pool, user, 'AKO-SUP', REFS, 'サポート活動', merged.companyId || null, merged.newCompanyName,
      async (db, companyId) => {
        await db.query(
          `UPDATE support_activities
           SET received_date = $2::date, received_time = $3, company_id = $4, inquirer_name = $5,
               target_system = $6, category = $7, title = $8, body = $9, priority = $10, status = $11,
               staff_member_id = $12, response = $13, cause = $14, resolution = $15,
               completed_date = $16::date, completed_time = $17, knowledge_note = $18, updated_at = now()
           WHERE id = $1`,
          [id, merged.receivedDate, merged.receivedTime, companyId, merged.inquirerName,
            merged.targetSystem, merged.category, merged.title, merged.body, merged.priority,
            merged.status, merged.staffMemberId, merged.response, merged.cause, merged.resolution,
            merged.completedDate, merged.completedTime, merged.knowledgeNote])
      })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'support_activities', entityId: id, detail: 'サポート活動を編集' })
    const { rows } = await pool.query(`SELECT ${SUPPORT_COLS} FROM support_activities WHERE id = $1`, [id])
    return c.json({ data: rows[0] })
  })

  archiveRestoreRoutes(app, pool, 'support_activities', 'support_activities', 'サポート活動', 'AKO-SUP', SUPPORT_COLS)
  return app
}

// ---------- 営業活動（F-44） ----------

function salesInputOf(b: Record<string, unknown>, userId: string): SalesActivityInput {
  return {
    companyId: String(b.companyId ?? '').trim(),
    newCompanyName: String(b.newCompanyName ?? ''),
    title: str(b.title, TITLE_CAP),
    dealType: String(b.dealType ?? '').trim(),
    staffMemberId: String(b.staffMemberId ?? '').trim() || userId,
    phase: String(b.phase ?? '').trim(),
    amount: numOrNull(b.amount),
    probability: numOrNull(b.probability),
    expectedCloseDate: strOrNull(b.expectedCloseDate),
    customerIssue: str(b.customerIssue, BODY_CAP),
    proposal: str(b.proposal, BODY_CAP),
    nextAction: str(b.nextAction, BODY_CAP),
    nextActionDate: strOrNull(b.nextActionDate),
  }
}

export function salesActivitiesRoutes(pool: pg.Pool): Hono {
  const app = new Hono()
  const REFS = '顧客・担当者'

  app.get('/', async (c) => {
    const res = await runListQuery(pool, c, {
      table: 'sales_activities sa LEFT JOIN companies c ON c.id = sa.company_id',
      cols: salesColsFor('sa'),
      orderBy: 'sa.created_at DESC, sa.id DESC',
      maxLimit: 1000,
      defaultLimit: 20,
      searchCols: ['sa.title', 'c.name', 'sa.customer_issue', 'sa.proposal', 'sa.next_action'],
      filterCols: {
        phase: { col: 'sa.phase', kind: 'enum' },
        dealType: { col: 'sa.deal_type', kind: 'enum' },
        companyId: { col: 'sa.company_id', kind: 'eq' },
        active: { col: 'sa.active::text', kind: 'eq' },
      },
    })
    return c.json(res)
  })

  app.post('/', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = salesInputOf(b, user.id)
    assertValid('AKO-SAL', salesActivityError(input))
    const id = newId('deal')
    await writeWithCompany(pool, user, 'AKO-SAL', REFS, '営業活動', input.companyId || null, input.newCompanyName,
      async (db, companyId) => {
        await db.query(
          `INSERT INTO sales_activities
             (id, member_id, company_id, title, deal_type, staff_member_id, phase, amount, probability,
              expected_close_date, customer_issue, proposal, next_action, next_action_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13, $14::date)`,
          [id, user.id, companyId, input.title, input.dealType, input.staffMemberId, input.phase,
            input.amount, input.probability, input.expectedCloseDate, input.customerIssue,
            input.proposal, input.nextAction, input.nextActionDate])
      })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'sales_activities', entityId: id, detail: '営業活動を登録' })
    const { rows } = await pool.query(`SELECT ${SALES_COLS} FROM sales_activities WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  app.patch('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await findRow<SalesActivityInput>(pool, 'AKO-SAL', SALES_COLS, 'sales_activities', id, '営業活動')
    const has = (k: string): boolean => Object.hasOwn(b, k)
    const touchesCompany = has('companyId') || has('newCompanyName')
    const merged: SalesActivityInput = {
      companyId: touchesCompany ? String(b.companyId ?? '').trim() : cur.companyId,
      newCompanyName: touchesCompany ? String(b.newCompanyName ?? '') : '',
      title: has('title') ? str(b.title, TITLE_CAP) : cur.title,
      dealType: has('dealType') ? String(b.dealType ?? '').trim() : cur.dealType,
      staffMemberId: has('staffMemberId') ? (String(b.staffMemberId ?? '').trim() || user.id) : cur.staffMemberId,
      phase: has('phase') ? String(b.phase ?? '').trim() : cur.phase,
      amount: has('amount') ? numOrNull(b.amount) : cur.amount,
      probability: has('probability') ? numOrNull(b.probability) : cur.probability,
      expectedCloseDate: has('expectedCloseDate') ? strOrNull(b.expectedCloseDate) : cur.expectedCloseDate,
      customerIssue: has('customerIssue') ? str(b.customerIssue, BODY_CAP) : cur.customerIssue,
      proposal: has('proposal') ? str(b.proposal, BODY_CAP) : cur.proposal,
      nextAction: has('nextAction') ? str(b.nextAction, BODY_CAP) : cur.nextAction,
      nextActionDate: has('nextActionDate') ? strOrNull(b.nextActionDate) : cur.nextActionDate,
    }
    assertValid('AKO-SAL', salesActivityError(merged))
    await writeWithCompany(pool, user, 'AKO-SAL', REFS, '営業活動', merged.companyId || null, merged.newCompanyName,
      async (db, companyId) => {
        await db.query(
          `UPDATE sales_activities
           SET company_id = $2, title = $3, deal_type = $4, staff_member_id = $5, phase = $6,
               amount = $7, probability = $8, expected_close_date = $9::date, customer_issue = $10,
               proposal = $11, next_action = $12, next_action_date = $13::date, updated_at = now()
           WHERE id = $1`,
          [id, companyId, merged.title, merged.dealType, merged.staffMemberId, merged.phase,
            merged.amount, merged.probability, merged.expectedCloseDate, merged.customerIssue,
            merged.proposal, merged.nextAction, merged.nextActionDate])
      })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'sales_activities', entityId: id, detail: '営業活動を編集' })
    const { rows } = await pool.query(`SELECT ${SALES_COLS} FROM sales_activities WHERE id = $1`, [id])
    return c.json({ data: rows[0] })
  })

  archiveRestoreRoutes(app, pool, 'sales_activities', 'sales_activities', '営業活動', 'AKO-SAL', SALES_COLS)
  return app
}

// ---------- ビジネスパートナー活動（F-45） ----------

function partnerInputOf(b: Record<string, unknown>, userId: string): PartnerActivityInput {
  return {
    partnerName: str(b.partnerName, NAME_CAP),
    theme: str(b.theme, TITLE_CAP),
    relatedCompany: str(b.relatedCompany, NAME_CAP),
    activityType: String(b.activityType ?? '').trim(),
    status: String(b.status ?? '').trim(),
    summary: str(b.summary, BODY_CAP),
    currentState: str(b.currentState, BODY_CAP),
    nextAction: str(b.nextAction, BODY_CAP),
    nextActionDate: strOrNull(b.nextActionDate),
    staffMemberId: String(b.staffMemberId ?? '').trim() || userId,
    relatedMeeting: str(b.relatedMeeting, NAME_CAP),
    relatedSalesActivityId: strOrNull(b.relatedSalesActivityId),
    memo: str(b.memo, BODY_CAP),
  }
}

export function partnerActivitiesRoutes(pool: pg.Pool): Hono {
  const app = new Hono()
  const REFS = '自社担当者・関連商談'

  app.get('/', async (c) => {
    const res = await runListQuery(pool, c, {
      table: 'partner_activities',
      cols: PARTNER_COLS,
      orderBy: 'created_at DESC, id DESC',
      maxLimit: 1000,
      defaultLimit: 20,
      searchCols: ['partner_name', 'theme', 'related_company', 'summary', 'current_state', 'next_action', 'memo'],
      filterCols: {
        status: { col: 'status', kind: 'enum' },
        activityType: { col: 'activity_type', kind: 'enum' },
        active: { col: 'active::text', kind: 'eq' },
      },
    })
    return c.json(res)
  })

  app.post('/', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = partnerInputOf(b, user.id)
    assertValid('AKO-PTN', partnerActivityError(input))
    const id = newId('pact')
    try {
      await pool.query(
        `INSERT INTO partner_activities
           (id, member_id, partner_name, theme, related_company, activity_type, status, summary,
            current_state, next_action, next_action_date, staff_member_id, related_meeting,
            related_sales_activity_id, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14, $15)`,
        [id, user.id, input.partnerName, input.theme, input.relatedCompany, input.activityType,
          input.status, input.summary, input.currentState, input.nextAction, input.nextActionDate,
          input.staffMemberId, input.relatedMeeting, input.relatedSalesActivityId, input.memo])
    } catch (e) {
      refError('AKO-PTN', e, REFS)
    }
    await audit(pool, { actorId: user.id, action: 'create', entity: 'partner_activities', entityId: id, detail: 'ビジネスパートナー活動を登録' })
    const { rows } = await pool.query(`SELECT ${PARTNER_COLS} FROM partner_activities WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  app.patch('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await findRow<PartnerActivityInput>(pool, 'AKO-PTN', PARTNER_COLS, 'partner_activities', id, 'ビジネスパートナー活動')
    const has = (k: string): boolean => Object.hasOwn(b, k)
    const merged: PartnerActivityInput = {
      partnerName: has('partnerName') ? str(b.partnerName, NAME_CAP) : cur.partnerName,
      theme: has('theme') ? str(b.theme, TITLE_CAP) : cur.theme,
      relatedCompany: has('relatedCompany') ? str(b.relatedCompany, NAME_CAP) : cur.relatedCompany,
      activityType: has('activityType') ? String(b.activityType ?? '').trim() : cur.activityType,
      status: has('status') ? String(b.status ?? '').trim() : cur.status,
      summary: has('summary') ? str(b.summary, BODY_CAP) : cur.summary,
      currentState: has('currentState') ? str(b.currentState, BODY_CAP) : cur.currentState,
      nextAction: has('nextAction') ? str(b.nextAction, BODY_CAP) : cur.nextAction,
      nextActionDate: has('nextActionDate') ? strOrNull(b.nextActionDate) : cur.nextActionDate,
      staffMemberId: has('staffMemberId') ? (String(b.staffMemberId ?? '').trim() || user.id) : cur.staffMemberId,
      relatedMeeting: has('relatedMeeting') ? str(b.relatedMeeting, NAME_CAP) : cur.relatedMeeting,
      relatedSalesActivityId: has('relatedSalesActivityId') ? strOrNull(b.relatedSalesActivityId) : cur.relatedSalesActivityId,
      memo: has('memo') ? str(b.memo, BODY_CAP) : cur.memo,
    }
    assertValid('AKO-PTN', partnerActivityError(merged))
    try {
      await pool.query(
        `UPDATE partner_activities
         SET partner_name = $2, theme = $3, related_company = $4, activity_type = $5, status = $6,
             summary = $7, current_state = $8, next_action = $9, next_action_date = $10::date,
             staff_member_id = $11, related_meeting = $12, related_sales_activity_id = $13,
             memo = $14, updated_at = now()
         WHERE id = $1`,
        [id, merged.partnerName, merged.theme, merged.relatedCompany, merged.activityType,
          merged.status, merged.summary, merged.currentState, merged.nextAction, merged.nextActionDate,
          merged.staffMemberId, merged.relatedMeeting, merged.relatedSalesActivityId, merged.memo])
    } catch (e) {
      refError('AKO-PTN', e, REFS)
    }
    await audit(pool, { actorId: user.id, action: 'update', entity: 'partner_activities', entityId: id, detail: 'ビジネスパートナー活動を編集' })
    const { rows } = await pool.query(`SELECT ${PARTNER_COLS} FROM partner_activities WHERE id = $1`, [id])
    return c.json({ data: rows[0] })
  })

  archiveRestoreRoutes(app, pool, 'partner_activities', 'partner_activities', 'ビジネスパートナー活動', 'AKO-PTN', PARTNER_COLS)
  return app
}

// ---------- JOIN 用の列前置（単表用 *_COLS の各列へテーブル別名を付ける） ----------

/** SUPPORT_COLS を sa. 前置で組み立て直す（JOIN 時の曖昧列名を避ける） */
function supportColsFor(t: string): string {
  return `${t}.id, ${t}.member_id AS "memberId", ${t}.received_date::text AS "receivedDate",
  ${t}.received_time AS "receivedTime", ${t}.company_id AS "companyId", ${t}.inquirer_name AS "inquirerName",
  ${t}.target_system AS "targetSystem", ${t}.category, ${t}.title, ${t}.body, ${t}.priority, ${t}.status,
  ${t}.staff_member_id AS "staffMemberId", ${t}.response, ${t}.cause, ${t}.resolution,
  ${t}.completed_date::text AS "completedDate", ${t}.completed_time AS "completedTime",
  ${t}.knowledge_note AS "knowledgeNote", ${t}.active,
  to_char(${t}.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt",
  to_char(${t}.updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt"`
}

/** SALES_COLS を前置で組み立て直す（JOIN 時の曖昧列名を避ける） */
function salesColsFor(t: string): string {
  return `${t}.id, ${t}.member_id AS "memberId", ${t}.company_id AS "companyId", ${t}.title,
  ${t}.deal_type AS "dealType", ${t}.staff_member_id AS "staffMemberId", ${t}.phase,
  ${t}.amount::float8 AS "amount", ${t}.probability, ${t}.expected_close_date::text AS "expectedCloseDate",
  ${t}.customer_issue AS "customerIssue", ${t}.proposal, ${t}.next_action AS "nextAction",
  ${t}.next_action_date::text AS "nextActionDate", ${t}.active,
  to_char(${t}.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt",
  to_char(${t}.updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt"`
}
