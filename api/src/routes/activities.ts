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
  normalizeActivityLinks,
  partnerActivityError, type PartnerActivityInput,
  salesActivityError, type SalesActivityInput,
  supportActivityError, type SupportActivityInput,
} from '../../../shared/domain/activity'
import { capCodePoints } from '../../../shared/domain/customer-log'
import type { AuthUser } from '../auth'
import { audit } from '../lib/audit'
import { auditCreatedCompany, resolveCompany } from '../lib/company-resolve'
import { auditCreatedContact, resolveContact } from '../lib/contact-resolve'
import { auditCreatedVillage, resolveVillage } from '../lib/village-resolve'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { runListQuery } from '../lib/list-query'

// created_at/updated_at は JST ウォールクロック文字列で返す（customer-logs と同一規約）。
// 射影は xxxColsFor(alias) が唯一の定義（JOIN 用のエイリアス前置と単表取得で同一関数を使い、
// 列追加時に一覧 GET と単件 SELECT のレスポンス形が乖離しないようにする = 監査 m-5）
function jstStampsFor(t: string): string {
  return `to_char(${t}.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt",
  to_char(${t}.updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt"`
}

function supportColsFor(t: string): string {
  return `${t}.id, ${t}.member_id AS "memberId", ${t}.village_id AS "villageId", ${t}.received_date::text AS "receivedDate",
  ${t}.received_time AS "receivedTime", ${t}.first_contact_method AS "firstContactMethod",
  ${t}.company_id AS "companyId", ${t}.inquirer_name AS "inquirerName",
  ${t}.target_system AS "targetSystem", ${t}.target_location AS "targetLocation", ${t}.category, ${t}.title, ${t}.body, ${t}.priority, ${t}.status,
  ${t}.staff_member_id AS "staffMemberId", ${t}.response, ${t}.cause, ${t}.resolution,
  ${t}.completed_date::text AS "completedDate", ${t}.completed_time AS "completedTime",
  ${t}.knowledge_note AS "knowledgeNote", ${t}.links, ${t}.active, ${jstStampsFor(t)}`
}

function salesColsFor(t: string): string {
  return `${t}.id, ${t}.member_id AS "memberId", ${t}.village_id AS "villageId", ${t}.company_id AS "companyId",
  ${t}.contact_id AS "contactId", ${t}.approach_group AS "approachGroup", ${t}.title,
  ${t}.deal_type AS "dealType", ${t}.staff_member_id AS "staffMemberId", ${t}.phase,
  ${t}.amount::float8 AS "amount", ${t}.probability, ${t}.expected_close_date::text AS "expectedCloseDate",
  ${t}.customer_issue AS "customerIssue", ${t}.proposal, ${t}.next_action AS "nextAction",
  ${t}.next_action_date::text AS "nextActionDate", ${t}.links, ${t}.active, ${jstStampsFor(t)}`
}

function partnerColsFor(t: string): string {
  return `${t}.id, ${t}.member_id AS "memberId", ${t}.village_id AS "villageId", ${t}.partner_name AS "partnerName",
  ${t}.partner_company_id AS "partnerCompanyId", ${t}.partner_contact_id AS "partnerContactId",
  ${t}.approach_company_id AS "approachCompanyId", ${t}.approach_group AS "approachGroup", ${t}.theme,
  ${t}.related_company AS "relatedCompany", ${t}.activity_type AS "activityType", ${t}.status, ${t}.summary,
  ${t}.current_state AS "currentState", ${t}.next_action AS "nextAction",
  ${t}.next_action_date::text AS "nextActionDate", ${t}.staff_member_id AS "staffMemberId",
  ${t}.related_meeting AS "relatedMeeting", ${t}.related_sales_activity_id AS "relatedSalesActivityId",
  ${t}.memo, ${t}.links, ${t}.active, ${jstStampsFor(t)}`
}

// 単表取得用（FROM に同じ別名を付けて使う）
const SUPPORT_COLS = supportColsFor('sa')
const SALES_COLS = salesColsFor('sa')
const PARTNER_COLS = partnerColsFor('pa')

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

/** 任意の数値（null/'' = null。number/string 以外（配列等）と数値でない文字列は NaN として
 *  shared 検証で 400 にする = `Number([])` が 0 に化ける寛容さを許さない。R1 レビュー NIT-4） */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'number' && typeof v !== 'string') return Number.NaN
  return Number(v)
}

/** 対象 1 件の取得（不在・型は 404。取消済みも返す = 復元/編集 UI 用）。from は cols の別名付き FROM 句 */
async function findRow<T extends pg.QueryResultRow>(pool: pg.Pool, code: ErrCode, cols: string, from: string, id: string, label: string): Promise<T> {
  const { rows } = await pool.query<T>(`SELECT ${cols} FROM ${from} WHERE id = $1`, [id])
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

/** 取消/復元（論理削除。全員可・冪等: 条件付き UPDATE で同時実行でも監査ログは 1 回だけ）。
 * selectFrom = cols の別名付き FROM 句（例 'support_activities sa'）/ table = UPDATE 用の素のテーブル名 */
function archiveRestoreRoutes(
  app: Hono, pool: pg.Pool, table: string, selectFrom: string, entity: string, label: string,
  code: ErrCode, cols: string,
): void {
  app.post('/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findRow(pool, code, cols, selectFrom, id, label)
    const upd = await pool.query(
      `UPDATE ${table} SET active = false, updated_at = now() WHERE id = $1 AND active = true`, [id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: 'すでに取消済みです' } })
    await audit(pool, { actorId: user.id, action: 'archive', entity, entityId: id, detail: `${label}を取消` })
    return c.json({ data: { id } })
  })

  app.post('/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findRow(pool, code, cols, selectFrom, id, label)
    const upd = await pool.query(
      `UPDATE ${table} SET active = true, updated_at = now() WHERE id = $1 AND active = false`, [id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: '取消されていません' } })
    await audit(pool, { actorId: user.id, action: 'restore', entity, entityId: id, detail: `${label}を復元` })
    return c.json({ data: { id } })
  })
}

/** 参考リンク（jsonb）を JSON 文字列で返す（trim・空/重複除去は shared 正規化 = 検証は各 xxxActivityError が担う） */
function linksJson(links: string[]): string {
  return JSON.stringify(normalizeActivityLinks(links))
}

/** 任意の会社解決（id も新規名も空なら未設定 = null。空名で空会社を作らない）。改修依頼 2026-08-19 第4弾 */
async function resolveOptionalCompany(
  db: pg.PoolClient, companyId: string | null, newName: string,
): Promise<{ id: string | null; created: { id: string; name: string } | null }> {
  if (!companyId && !newName.trim()) return { id: null, created: null }
  return resolveCompany(db, companyId, newName)
}

/** 会社名のスナップショット取得（表示・検索用に partner_name/related_company へ載せる）。id 未設定は空 */
async function companyNameOf(db: pg.PoolClient, id: string | null): Promise<string> {
  if (!id) return ''
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1`, [id])
  return rows[0]?.name ?? ''
}

/**
 * 活動記録の書込トランザクション（改修依頼 2026-08-19 第4弾で共通化 = 原則3）。
 * run 内でマスタ解決（会社/担当/事業区分）+ INSERT/UPDATE を行い、返した「コミット後に実行する監査」を
 * commit 成功後に順に呼ぶ（customer-logs と同じ「SoT 先行の原子性」= 検証失敗時に孤児マスタを残さない）。
 * FK 違反（23503）は refError で -001（400）へ変換する。
 */
async function runInTx(
  pool: pg.Pool,
  code: ErrCode,
  refsLabel: string,
  run: (db: pg.PoolClient) => Promise<Array<() => Promise<void>>>,
): Promise<void> {
  const client = await pool.connect()
  let postCommit: Array<() => Promise<void>> = []
  try {
    await client.query('BEGIN')
    postCommit = await run(client)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    refError(code, e, refsLabel)
  } finally {
    client.release()
  }
  for (const audit of postCommit) await audit()
}

// ---------- サポート活動（F-43） ----------

/** リクエスト body → 入力（cap 適用。companyId 未指定は newCompanyName で解決） */
function supportInputOf(b: Record<string, unknown>, userId: string): SupportActivityInput {
  return {
    villageId: String(b.villageId ?? '').trim(),
    newVillageName: String(b.newVillageName ?? ''),
    receivedDate: String(b.receivedDate ?? '').trim(),
    receivedTime: strOrNull(b.receivedTime),
    firstContactMethod: String(b.firstContactMethod ?? '').trim(),
    companyId: String(b.companyId ?? '').trim(),
    newCompanyName: String(b.newCompanyName ?? ''),
    inquirerName: str(b.inquirerName, NAME_CAP),
    targetSystem: str(b.targetSystem, NAME_CAP),
    targetLocation: str(b.targetLocation, NAME_CAP),
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
    links: normalizeActivityLinks(b.links),
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
    await runInTx(pool, 'AKO-SUP', REFS, async (db) => {
      const village = await resolveVillage(db, input.villageId || null, input.newVillageName)
      const company = await resolveCompany(db, input.companyId || null, input.newCompanyName)
      await db.query(
        `INSERT INTO support_activities
           (id, member_id, village_id, received_date, received_time, first_contact_method, company_id,
            inquirer_name, target_system, target_location, category, title, body, priority, status,
            staff_member_id, response, cause, resolution, completed_date, completed_time, knowledge_note, links)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::date, $21, $22, $23)`,
        [id, user.id, village.id, input.receivedDate, input.receivedTime, input.firstContactMethod, company.id,
          input.inquirerName, input.targetSystem, input.targetLocation, input.category, input.title, input.body,
          input.priority, input.status, input.staffMemberId, input.response, input.cause, input.resolution,
          input.completedDate, input.completedTime, input.knowledgeNote, linksJson(input.links)])
      return [
        () => auditCreatedVillage(pool, user, village.created, 'サポート活動'),
        () => auditCreatedCompany(pool, user, company.created, 'サポート活動'),
      ]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'support_activities', entityId: id, detail: 'サポート活動を登録' })
    const { rows } = await pool.query(`SELECT ${SUPPORT_COLS} FROM support_activities sa WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  // 編集（全員可 = チーム共有の記録。訂正履歴は監査ログ。フォームは全項目送信 = 実質全置換）
  app.patch('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await findRow<SupportActivityInput & { companyId: string; villageId: string | null }>(
      pool, 'AKO-SUP', SUPPORT_COLS, 'support_activities sa', id, 'サポート活動')
    // 送られたキーのみ更新（部分更新の安全側 = CLAUDE.md 部分更新原則）→ マージ後に shared 宣言順で全体検証
    const has = (k: string): boolean => Object.hasOwn(b, k)
    const touchesCompany = has('companyId') || has('newCompanyName')
    const touchesVillage = has('villageId') || has('newVillageName')
    const merged: SupportActivityInput = {
      // 事業区分（任意）: 未タッチは現行 id を保持（resolveVillage が id 指定はそのまま返す）
      villageId: touchesVillage ? String(b.villageId ?? '').trim() : (cur.villageId ?? ''),
      newVillageName: touchesVillage ? String(b.newVillageName ?? '') : '',
      receivedDate: has('receivedDate') ? String(b.receivedDate ?? '').trim() : cur.receivedDate,
      receivedTime: has('receivedTime') ? strOrNull(b.receivedTime) : cur.receivedTime,
      firstContactMethod: has('firstContactMethod') ? String(b.firstContactMethod ?? '').trim() : cur.firstContactMethod,
      companyId: touchesCompany ? String(b.companyId ?? '').trim() : cur.companyId,
      newCompanyName: touchesCompany ? String(b.newCompanyName ?? '') : '',
      inquirerName: has('inquirerName') ? str(b.inquirerName, NAME_CAP) : cur.inquirerName,
      targetSystem: has('targetSystem') ? str(b.targetSystem, NAME_CAP) : cur.targetSystem,
      targetLocation: has('targetLocation') ? str(b.targetLocation, NAME_CAP) : cur.targetLocation,
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
      links: has('links') ? normalizeActivityLinks(b.links) : (cur.links ?? []),
    }
    assertValid('AKO-SUP', supportActivityError(merged))
    await runInTx(pool, 'AKO-SUP', REFS, async (db) => {
      const village = await resolveVillage(db, merged.villageId || null, merged.newVillageName)
      const company = await resolveCompany(db, merged.companyId || null, merged.newCompanyName)
      await db.query(
        `UPDATE support_activities
         SET village_id = $2, received_date = $3::date, received_time = $4, first_contact_method = $5,
             company_id = $6, inquirer_name = $7, target_system = $8, target_location = $9, category = $10,
             title = $11, body = $12, priority = $13, status = $14, staff_member_id = $15, response = $16,
             cause = $17, resolution = $18, completed_date = $19::date, completed_time = $20,
             knowledge_note = $21, links = $22, updated_at = now()
         WHERE id = $1`,
        [id, village.id, merged.receivedDate, merged.receivedTime, merged.firstContactMethod, company.id,
          merged.inquirerName, merged.targetSystem, merged.targetLocation, merged.category, merged.title,
          merged.body, merged.priority, merged.status, merged.staffMemberId, merged.response, merged.cause,
          merged.resolution, merged.completedDate, merged.completedTime, merged.knowledgeNote, linksJson(merged.links)])
      return [
        () => auditCreatedVillage(pool, user, village.created, 'サポート活動'),
        () => auditCreatedCompany(pool, user, company.created, 'サポート活動'),
      ]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'support_activities', entityId: id, detail: 'サポート活動を編集' })
    const { rows } = await pool.query(`SELECT ${SUPPORT_COLS} FROM support_activities sa WHERE id = $1`, [id])
    return c.json({ data: rows[0] })
  })

  archiveRestoreRoutes(app, pool, 'support_activities', 'support_activities sa', 'support_activities', 'サポート活動', 'AKO-SUP', SUPPORT_COLS)
  return app
}

// ---------- 営業活動（F-44） ----------

function salesInputOf(b: Record<string, unknown>, userId: string): SalesActivityInput {
  return {
    villageId: String(b.villageId ?? '').trim(),
    newVillageName: String(b.newVillageName ?? ''),
    companyId: String(b.companyId ?? '').trim(),
    newCompanyName: String(b.newCompanyName ?? ''),
    contactId: String(b.contactId ?? '').trim(),
    newContactName: String(b.newContactName ?? ''),
    approachGroup: str(b.approachGroup, NAME_CAP),
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
    links: normalizeActivityLinks(b.links),
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
    await runInTx(pool, 'AKO-SAL', REFS, async (db) => {
      const village = await resolveVillage(db, input.villageId || null, input.newVillageName)
      const company = await resolveCompany(db, input.companyId || null, input.newCompanyName)
      const contact = await resolveContact(db, company.id, input.contactId || null, input.newContactName, { errCode: 'AKO-SAL', lockPrefix: 'sales-contact' })
      await db.query(
        `INSERT INTO sales_activities
           (id, member_id, village_id, company_id, contact_id, approach_group, title, deal_type,
            staff_member_id, phase, amount, probability, expected_close_date, customer_issue, proposal,
            next_action, next_action_date, links)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::date, $14, $15, $16, $17::date, $18)`,
        [id, user.id, village.id, company.id, contact.id, input.approachGroup, input.title, input.dealType,
          input.staffMemberId, input.phase, input.amount, input.probability, input.expectedCloseDate,
          input.customerIssue, input.proposal, input.nextAction, input.nextActionDate, linksJson(input.links)])
      return [
        () => auditCreatedVillage(pool, user, village.created, '営業活動'),
        () => auditCreatedCompany(pool, user, company.created, '営業活動'),
        () => auditCreatedContact(pool, user, contact.created, '営業活動'),
      ]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'sales_activities', entityId: id, detail: '営業活動を登録' })
    const { rows } = await pool.query(`SELECT ${SALES_COLS} FROM sales_activities sa WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  app.patch('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await findRow<SalesActivityInput & { villageId: string | null; contactId: string | null }>(
      pool, 'AKO-SAL', SALES_COLS, 'sales_activities sa', id, '営業活動')
    const has = (k: string): boolean => Object.hasOwn(b, k)
    const touchesCompany = has('companyId') || has('newCompanyName')
    const touchesVillage = has('villageId') || has('newVillageName')
    const touchesContact = has('contactId') || has('newContactName')
    const merged: SalesActivityInput = {
      villageId: touchesVillage ? String(b.villageId ?? '').trim() : (cur.villageId ?? ''),
      newVillageName: touchesVillage ? String(b.newVillageName ?? '') : '',
      companyId: touchesCompany ? String(b.companyId ?? '').trim() : cur.companyId,
      newCompanyName: touchesCompany ? String(b.newCompanyName ?? '') : '',
      // 会社を変更した編集で担当を触っていない場合は担当をクリア（旧担当が新会社に属さず所属エラーになるのを防ぐ）
      contactId: touchesContact ? String(b.contactId ?? '').trim() : (touchesCompany ? '' : (cur.contactId ?? '')),
      newContactName: touchesContact ? String(b.newContactName ?? '') : '',
      approachGroup: has('approachGroup') ? str(b.approachGroup, NAME_CAP) : cur.approachGroup,
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
      links: has('links') ? normalizeActivityLinks(b.links) : (cur.links ?? []),
    }
    assertValid('AKO-SAL', salesActivityError(merged))
    await runInTx(pool, 'AKO-SAL', REFS, async (db) => {
      const village = await resolveVillage(db, merged.villageId || null, merged.newVillageName)
      const company = await resolveCompany(db, merged.companyId || null, merged.newCompanyName)
      const contact = await resolveContact(db, company.id, merged.contactId || null, merged.newContactName, { errCode: 'AKO-SAL', lockPrefix: 'sales-contact' })
      await db.query(
        `UPDATE sales_activities
         SET village_id = $2, company_id = $3, contact_id = $4, approach_group = $5, title = $6,
             deal_type = $7, staff_member_id = $8, phase = $9, amount = $10, probability = $11,
             expected_close_date = $12::date, customer_issue = $13, proposal = $14, next_action = $15,
             next_action_date = $16::date, links = $17, updated_at = now()
         WHERE id = $1`,
        [id, village.id, company.id, contact.id, merged.approachGroup, merged.title, merged.dealType,
          merged.staffMemberId, merged.phase, merged.amount, merged.probability, merged.expectedCloseDate,
          merged.customerIssue, merged.proposal, merged.nextAction, merged.nextActionDate, linksJson(merged.links)])
      return [
        () => auditCreatedVillage(pool, user, village.created, '営業活動'),
        () => auditCreatedCompany(pool, user, company.created, '営業活動'),
        () => auditCreatedContact(pool, user, contact.created, '営業活動'),
      ]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'sales_activities', entityId: id, detail: '営業活動を編集' })
    const { rows } = await pool.query(`SELECT ${SALES_COLS} FROM sales_activities sa WHERE id = $1`, [id])
    return c.json({ data: rows[0] })
  })

  archiveRestoreRoutes(app, pool, 'sales_activities', 'sales_activities sa', 'sales_activities', '営業活動', 'AKO-SAL', SALES_COLS)
  return app
}

// ---------- ビジネスパートナー活動（F-45） ----------

function partnerInputOf(b: Record<string, unknown>, userId: string): PartnerActivityInput {
  return {
    villageId: String(b.villageId ?? '').trim(),
    newVillageName: String(b.newVillageName ?? ''),
    partnerCompanyId: String(b.partnerCompanyId ?? '').trim(),
    newPartnerCompanyName: String(b.newPartnerCompanyName ?? ''),
    partnerContactId: String(b.partnerContactId ?? '').trim(),
    newPartnerContactName: String(b.newPartnerContactName ?? ''),
    approachCompanyId: String(b.approachCompanyId ?? '').trim(),
    newApproachCompanyName: String(b.newApproachCompanyName ?? ''),
    approachGroup: str(b.approachGroup, NAME_CAP),
    theme: str(b.theme, TITLE_CAP),
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
    links: normalizeActivityLinks(b.links),
  }
}

/** パートナー活動の書込（village + パートナー会社/担当 + アプローチ企業を解決し INSERT/UPDATE 用の値を返す）。
 *  partner_name/related_company には会社名スナップショットを載せる（表示・検索の下位互換 = 旧行と同じ列で見える） */
async function resolvePartnerRefs(
  db: pg.PoolClient, pool: pg.Pool, user: AuthUser, input: PartnerActivityInput,
): Promise<{
  villageId: string | null; partnerCompanyId: string; partnerContactId: string | null
  approachCompanyId: string | null; partnerName: string; relatedCompany: string
  audits: Array<() => Promise<void>>
}> {
  const village = await resolveVillage(db, input.villageId || null, input.newVillageName)
  const partnerCompany = await resolveCompany(db, input.partnerCompanyId || null, input.newPartnerCompanyName)
  const partnerContact = await resolveContact(db, partnerCompany.id, input.partnerContactId || null, input.newPartnerContactName, { errCode: 'AKO-PTN', lockPrefix: 'partner-contact' })
  const approachCompany = await resolveOptionalCompany(db, input.approachCompanyId || null, input.newApproachCompanyName)
  return {
    villageId: village.id, partnerCompanyId: partnerCompany.id, partnerContactId: partnerContact.id,
    approachCompanyId: approachCompany.id,
    partnerName: await companyNameOf(db, partnerCompany.id),
    relatedCompany: await companyNameOf(db, approachCompany.id),
    audits: [
      () => auditCreatedVillage(pool, user, village.created, 'ビジネスパートナー活動'),
      () => auditCreatedCompany(pool, user, partnerCompany.created, 'ビジネスパートナー活動'),
      () => auditCreatedContact(pool, user, partnerContact.created, 'ビジネスパートナー活動'),
      () => auditCreatedCompany(pool, user, approachCompany.created, 'ビジネスパートナー活動'),
    ],
  }
}

export function partnerActivitiesRoutes(pool: pg.Pool): Hono {
  const app = new Hono()
  const REFS = '自社担当者・関連商談'

  app.get('/', async (c) => {
    const res = await runListQuery(pool, c, {
      table: 'partner_activities pa',
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
    await runInTx(pool, 'AKO-PTN', REFS, async (db) => {
      const refs = await resolvePartnerRefs(db, pool, user, input)
      await db.query(
        `INSERT INTO partner_activities
           (id, member_id, village_id, partner_company_id, partner_contact_id, approach_company_id,
            approach_group, partner_name, theme, related_company, activity_type, status, summary,
            current_state, next_action, next_action_date, staff_member_id, related_meeting,
            related_sales_activity_id, memo, links)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::date, $17, $18, $19, $20, $21)`,
        [id, user.id, refs.villageId, refs.partnerCompanyId, refs.partnerContactId, refs.approachCompanyId,
          input.approachGroup, refs.partnerName, input.theme, refs.relatedCompany, input.activityType,
          input.status, input.summary, input.currentState, input.nextAction, input.nextActionDate,
          input.staffMemberId, input.relatedMeeting, input.relatedSalesActivityId, input.memo, linksJson(input.links)])
      return refs.audits
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'partner_activities', entityId: id, detail: 'ビジネスパートナー活動を登録' })
    const { rows } = await pool.query(`SELECT ${PARTNER_COLS} FROM partner_activities pa WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  app.patch('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await findRow<PartnerActivityInput & {
      villageId: string | null; partnerCompanyId: string | null; partnerContactId: string | null; approachCompanyId: string | null
    }>(pool, 'AKO-PTN', PARTNER_COLS, 'partner_activities pa', id, 'ビジネスパートナー活動')
    const has = (k: string): boolean => Object.hasOwn(b, k)
    const touchesPartnerCompany = has('partnerCompanyId') || has('newPartnerCompanyName')
    const touchesPartnerContact = has('partnerContactId') || has('newPartnerContactName')
    const merged: PartnerActivityInput = {
      villageId: (has('villageId') || has('newVillageName')) ? String(b.villageId ?? '').trim() : (cur.villageId ?? ''),
      newVillageName: (has('villageId') || has('newVillageName')) ? String(b.newVillageName ?? '') : '',
      partnerCompanyId: touchesPartnerCompany ? String(b.partnerCompanyId ?? '').trim() : (cur.partnerCompanyId ?? ''),
      newPartnerCompanyName: touchesPartnerCompany ? String(b.newPartnerCompanyName ?? '') : '',
      // パートナー会社を変更した編集で担当を触っていない場合は担当をクリア（旧担当が別会社所属で所属エラーになるのを防ぐ）
      partnerContactId: touchesPartnerContact ? String(b.partnerContactId ?? '').trim() : (touchesPartnerCompany ? '' : (cur.partnerContactId ?? '')),
      newPartnerContactName: touchesPartnerContact ? String(b.newPartnerContactName ?? '') : '',
      approachCompanyId: (has('approachCompanyId') || has('newApproachCompanyName')) ? String(b.approachCompanyId ?? '').trim() : (cur.approachCompanyId ?? ''),
      newApproachCompanyName: (has('approachCompanyId') || has('newApproachCompanyName')) ? String(b.newApproachCompanyName ?? '') : '',
      approachGroup: has('approachGroup') ? str(b.approachGroup, NAME_CAP) : cur.approachGroup,
      theme: has('theme') ? str(b.theme, TITLE_CAP) : cur.theme,
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
      links: has('links') ? normalizeActivityLinks(b.links) : (cur.links ?? []),
    }
    assertValid('AKO-PTN', partnerActivityError(merged))
    await runInTx(pool, 'AKO-PTN', REFS, async (db) => {
      const refs = await resolvePartnerRefs(db, pool, user, merged)
      await db.query(
        `UPDATE partner_activities
         SET village_id = $2, partner_company_id = $3, partner_contact_id = $4, approach_company_id = $5,
             approach_group = $6, partner_name = $7, theme = $8, related_company = $9, activity_type = $10,
             status = $11, summary = $12, current_state = $13, next_action = $14, next_action_date = $15::date,
             staff_member_id = $16, related_meeting = $17, related_sales_activity_id = $18, memo = $19,
             links = $20, updated_at = now()
         WHERE id = $1`,
        [id, refs.villageId, refs.partnerCompanyId, refs.partnerContactId, refs.approachCompanyId,
          merged.approachGroup, refs.partnerName, merged.theme, refs.relatedCompany, merged.activityType,
          merged.status, merged.summary, merged.currentState, merged.nextAction, merged.nextActionDate,
          merged.staffMemberId, merged.relatedMeeting, merged.relatedSalesActivityId, merged.memo, linksJson(merged.links)])
      return refs.audits
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'partner_activities', entityId: id, detail: 'ビジネスパートナー活動を編集' })
    const { rows } = await pool.query(`SELECT ${PARTNER_COLS} FROM partner_activities pa WHERE id = $1`, [id])
    return c.json({ data: rows[0] })
  })

  archiveRestoreRoutes(app, pool, 'partner_activities', 'partner_activities pa', 'partner_activities', 'ビジネスパートナー活動', 'AKO-PTN', PARTNER_COLS)
  return app
}
