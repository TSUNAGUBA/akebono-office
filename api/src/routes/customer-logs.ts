/**
 * 顧客ログ API（オペレーター指示 2026-07-30 → 項目拡張 2026-07-31）。
 * 「いつ（何月何日・開始/終了時刻は任意）どの顧客（会社/人）と誰（自社担当者）が
 * どんな会話（担当者メモ・属性タグ）をしたか」を本人が記録する（議事録メモは 2026-08-03 に廃止）。
 * - 記録系 = 追記 + 本人編集（監査ログ）+ 取消(archive)/復元(restore)（原則2/9.5）。本人のみ操作可（AKO-CLG-002）。
 * - 他メンバー参照（F-16）: GET は ?memberId= で readonly 参照可（canViewMemberCustomerLog で enforcement。
 *   既定 = 参照不可の許可制。未許可は AKO-PRM-002 403）。自分のログは常に参照可。
 * - コンボボックス新規登録: newCompanyName / newContactName を受け取り、未登録なら顧客(会社)・担当者(人)を
 *   マスタへ新規登録したうえでログに反映する（同一トランザクション = SoT 先行の原子性。原則6）。
 *   既存名との照合は正規化名（shared name-match）の完全一致で行い、重複マスタを作らない。
 * - AI 参照: 書込後に検索インデックスを再生成（owner スコープ付き = 本人のログのみ AI 文脈へ = search-index 側）。
 * - 機能ガード: customer-log（F-16。既定 allow = 誰でも自分のログは記録・参照できる）。
 * エラー: AKO-CLG-001 入力不正 / 002 対象なし・権限なし（本人以外の操作）/ 003 会社と担当者の不整合。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import {
  CUSTOMER_LOG_BODY_CAP as BODY_CAP, CUSTOMER_LOG_NAME_CAP as NAME_CAP, CUSTOMER_LOG_TITLE_CAP as TITLE_CAP,
  cleanCustomerLogTags, customerLogCompanyError, customerLogDateError, customerLogMemoError,
  customerLogTagsError, customerLogTimeError, customerLogTimeRangeError, isRealDateKey,
} from '../../../shared/domain/customer-log'
import { normalizeCompanyName } from '../../../shared/domain/name-match'
import { canViewMemberCustomerLog } from '../../../shared/domain/permissions'
import type { CustomerLog } from '../../../shared/domain/types'
import type { AuthUser } from '../auth'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { scheduleSearchRebuild } from '../lib/search-index'
import { capCp } from '../lib/text'

// createdAt/updatedAt は JST ウォールクロック文字列で返す（notes/task-plans/chatbot と同一規約。
// フロントは文字列を直接パースするため UTC の "Z" ISO を返すと日付キー比較・表示が最大 9 時間ずれる）。
// log_date は date 型（tz なし）のため ::text で 'YYYY-MM-DD' をそのまま返す
const CLOG_COLS = `id, member_id AS "memberId", log_date::text AS "logDate", log_time AS "logTime",
  end_time AS "endTime", company_id AS "companyId", contact_id AS "contactId",
  staff_member_id AS "staffMemberId", tags, title, body, active,
  to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt"`

/** 任意の紐付け id（空文字は null 化。存在チェックは FK が担い 400 で報告） */
function refOrNull(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || null
}

/** shared 検証（メッセージ | null）を AKO-CLG-001（400）へ変換する（検証ロジックの SoT = shared/domain/customer-log） */
function assertClg(message: string | null): void {
  if (message) throw err('AKO-CLG-001', message, 400)
}

/** 日付（YYYY-MM-DD・実在日）。不正・存在しない日（2026-13-40 等）は 400 で弾く（DB の 22007 を出さない） */
function parseDate(v: unknown): string {
  const s = String(v ?? '').trim()
  assertClg(customerLogDateError(s))
  return s
}

/** 時刻（HH:MM・任意）。空は null。書式不正は 400。分の 15 分単位は UI の選択肢制約（既存データ互換のため API は HH:MM を許容） */
function parseTime(v: unknown, label: '開始' | '終了'): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  assertClg(customerLogTimeError(s, label))
  return s
}

/** 属性タグ（任意・重複除去・件数/文字数上限）。文字列配列以外は 400 */
function parseTags(v: unknown): string[] {
  assertClg(customerLogTagsError(v))
  return Array.isArray(v) ? cleanCustomerLogTags(v) : []
}

/** 担当者(人)が選択した会社に属するか検証（FK では表現できない整合を API 層で担保） */
async function assertContact(db: pg.Pool | pg.PoolClient, contactId: string, companyId: string): Promise<void> {
  const { rows } = await db.query<{ companyId: string }>(
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

/** コンボボックス新規登録の結果（audit はコミット後に記録するため作成分を持ち帰る） */
interface ResolvedRefs {
  companyId: string
  contactId: string | null
  createdCompany: { id: string; name: string } | null
  createdContact: { id: string; name: string } | null
}

/**
 * 「照合 → なければ INSERT」の同名同時登録ガード（レビュー指摘 m-1）。
 * READ COMMITTED では 2 リクエストが同時に照合へ失敗して重複マスタが生まれるため、
 * 正規化名単位のトランザクションスコープのアドバイザリロックで直列化する
 * （後着はロック待ち → 先着のコミット後に照合し直して既存へ名寄せされる。
 *  ロックはコミット/ロールバックで自動解放 = pg_advisory_xact_lock。ハッシュは他ロック箇所
 *  （akebono-trade / akebono-billing 等）と同じ 64bit hashtextextended = 衝突確率を最小化。
 *  万一衝突しても無関係な名前が直列化されるだけで無害）。
 */
async function lockResolveKey(db: pg.PoolClient, key: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key])
}

/**
 * 顧客(会社)の解決。newCompanyName があれば正規化名（法人格・空白ゆらぎ除去 = shared name-match）の
 * 完全一致で既存の顧客(会社)を照合し、なければマスタへ新規登録する（重複マスタを作らない）。
 */
async function resolveCompany(
  db: pg.PoolClient,
  companyId: string | null,
  newCompanyName: string,
): Promise<{ id: string; created: { id: string; name: string } | null }> {
  if (companyId) return { id: companyId, created: null }
  const name = capCp(newCompanyName.trim(), NAME_CAP)
  const norm = normalizeCompanyName(name)
  await lockResolveKey(db, `clog-company:${norm}`)
  const { rows } = await db.query<{ id: string; name: string; aliases: string[] | null }>(
    `SELECT id, name, aliases FROM companies WHERE kind = 'customer' AND active = true ORDER BY id`)
  for (const r of rows) {
    if ([r.name, ...(r.aliases ?? [])].some(n => n && normalizeCompanyName(String(n)) === norm)) {
      return { id: r.id, created: null }
    }
  }
  const id = newId('c')
  await db.query(`INSERT INTO companies (id, kind, name) VALUES ($1, 'customer', $2)`, [id, name])
  return { id, created: { id, name } }
}

/**
 * 顧客担当者(人)の解決。newContactName があれば同一会社内の氏名（空白除去・大小無視）完全一致で照合し、
 * なければマスタへ新規登録する。contactId 指定時は所属整合を検証（AKO-CLG-003）。
 */
async function resolveContact(
  db: pg.PoolClient,
  companyId: string,
  contactId: string | null,
  newContactName: string,
): Promise<{ id: string | null; created: { id: string; name: string } | null }> {
  if (contactId) {
    await assertContact(db, contactId, companyId)
    return { id: contactId, created: null }
  }
  const name = capCp(newContactName.trim(), NAME_CAP)
  if (!name) return { id: null, created: null }
  const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
  await lockResolveKey(db, `clog-contact:${companyId}:${norm(name)}`)
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM contacts WHERE company_id = $1 AND active = true ORDER BY id`, [companyId])
  const hit = rows.find(r => norm(r.name) === norm(name))
  if (hit) return { id: hit.id, created: null }
  const id = newId('p')
  await db.query(`INSERT INTO contacts (id, company_id, name) VALUES ($1, $2, $3)`, [id, companyId, name])
  return { id, created: { id, name } }
}

/** 会社 + 担当者の一括解決（登録・編集で共用）。会社指定の検証は shared customerLogCompanyError（パリティの SoT） */
async function resolveRefs(
  db: pg.PoolClient,
  input: { companyId: string | null; newCompanyName: string; contactId: string | null; newContactName: string },
): Promise<ResolvedRefs> {
  assertClg(customerLogCompanyError(input.companyId ?? '', input.newCompanyName))
  const company = await resolveCompany(db, input.companyId, input.newCompanyName)
  const contact = await resolveContact(db, company.id, input.contactId, input.newContactName)
  return {
    companyId: company.id,
    contactId: contact.id,
    createdCompany: company.created,
    createdContact: contact.created,
  }
}

/** コンボボックス新規登録の監査ログ（コミット後。補助処理 = 主フロー成立後） */
async function auditCreatedRefs(pool: pg.Pool, user: AuthUser, refs: ResolvedRefs): Promise<void> {
  if (refs.createdCompany) {
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'companies', entityId: refs.createdCompany.id,
      detail: `顧客ログから顧客(会社)「${refs.createdCompany.name}」を新規登録`,
    })
  }
  if (refs.createdContact) {
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'contacts', entityId: refs.createdContact.id,
      detail: `顧客ログから顧客担当者「${refs.createdContact.name}」を新規登録`,
    })
  }
}

/** FK 違反（23503）を入力エラーへ変換（紐付け先の不在 = 400） */
function refError(e: unknown): never {
  if ((e as { code?: string }).code === '23503') {
    throw err('AKO-CLG-001', '紐付け先（顧客・担当者・自社担当者）が見つかりません', 400)
  }
  throw e
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
    // 実在日のみフィルタに使う（2026-02-30 等の不正日は無視 = ::date キャストの 22007→500 を出さない）
    const from = c.req.query('from')?.trim()
    if (from && isRealDateKey(from)) { params.push(from); conds.push(`log_date >= $${params.length}::date`) }
    const to = c.req.query('to')?.trim()
    if (to && isRealDateKey(to)) { params.push(to); conds.push(`log_date <= $${params.length}::date`) }
    const companyId = c.req.query('companyId')?.trim()
    if (companyId) { params.push(companyId); conds.push(`company_id = $${params.length}`) }
    const contactId = c.req.query('contactId')?.trim()
    if (contactId) { params.push(contactId); conds.push(`contact_id = $${params.length}`) }
    const { rows } = await pool.query(
      `SELECT ${CLOG_COLS} FROM customer_logs WHERE ${conds.join(' AND ')}
       ORDER BY log_date DESC, log_time DESC NULLS LAST, created_at DESC, id DESC LIMIT 1000`, params)
    return c.json({ data: rows })
  })

  // 登録（本人）。companyId/contactId の代わりに newCompanyName/newContactName で新規マスタ登録 + 反映
  app.post('/', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const logDate = parseDate(b.logDate)
    const logTime = parseTime(b.logTime, '開始')
    const endTime = parseTime(b.endTime, '終了')
    assertClg(customerLogTimeRangeError(logTime, endTime))
    const tags = parseTags(b.tags)
    // 自社の担当者（未指定はログインユーザー = 記録者。仕様の既定値）
    const staffMemberId = String(b.staffMemberId ?? '').trim() || user.id
    const title = capCp(String(b.title ?? '').trim(), TITLE_CAP)
    const body = capCp(String(b.body ?? '').trim(), BODY_CAP)
    assertClg(customerLogMemoError(body))
    const id = newId('clog')
    const client = await pool.connect()
    let refs: ResolvedRefs
    try {
      await client.query('BEGIN')
      refs = await resolveRefs(client, {
        companyId: refOrNull(b.companyId),
        newCompanyName: String(b.newCompanyName ?? ''),
        contactId: refOrNull(b.contactId),
        newContactName: String(b.newContactName ?? ''),
      })
      await client.query(
        `INSERT INTO customer_logs
           (id, member_id, log_date, log_time, end_time, company_id, contact_id, staff_member_id, tags, title, body)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, user.id, logDate, logTime, endTime, refs.companyId, refs.contactId, staffMemberId,
          JSON.stringify(tags), title, body])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      refError(e)
    } finally {
      client.release()
    }
    await auditCreatedRefs(pool, user, refs)
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
    // マージ後の全体検証は shared/domain/customer-log の宣言順（日付 → 開始 → 終了 → 範囲 → タグ → メモ）で
    // 適用する（POST・モックと同一順 = パリティ。レビュー 2 巡目 MINOR-1: オブジェクトリテラル一括構築だと
    // tags の parse が範囲検証より先に throw して順序が割れるため、フィールドごとに順に解決する）
    const logDate = Object.hasOwn(b, 'logDate') ? parseDate(b.logDate) : cur.logDate
    const logTime = Object.hasOwn(b, 'logTime') ? parseTime(b.logTime, '開始') : cur.logTime
    const endTime = Object.hasOwn(b, 'endTime') ? parseTime(b.endTime, '終了') : cur.endTime
    assertClg(customerLogTimeRangeError(logTime, endTime))
    const tags = Object.hasOwn(b, 'tags') ? parseTags(b.tags) : cur.tags
    const staffMemberId = Object.hasOwn(b, 'staffMemberId')
      ? (String(b.staffMemberId ?? '').trim() || user.id)
      : cur.staffMemberId
    const title = Object.hasOwn(b, 'title') ? capCp(String(b.title ?? '').trim(), TITLE_CAP) : cur.title
    const body = Object.hasOwn(b, 'body') ? capCp(String(b.body ?? '').trim(), BODY_CAP) : cur.body
    assertClg(customerLogMemoError(body))
    const next = { logDate, logTime, endTime, tags, staffMemberId, title, body }
    // 会社・担当者の解決（newCompanyName / newContactName 指定時は新規マスタ登録も行う）。
    // どのキーも送られていなければ現状維持
    const touchesCompany = Object.hasOwn(b, 'companyId') || Object.hasOwn(b, 'newCompanyName')
    const touchesContact = Object.hasOwn(b, 'contactId') || Object.hasOwn(b, 'newContactName')
    const client = await pool.connect()
    let refs: ResolvedRefs
    try {
      await client.query('BEGIN')
      if (touchesCompany || touchesContact) {
        refs = await resolveRefs(client, {
          companyId: touchesCompany ? refOrNull(b.companyId) : cur.companyId,
          newCompanyName: touchesCompany ? String(b.newCompanyName ?? '') : '',
          // 会社を変えた場合、担当者キー未送信でも旧担当者の所属整合を検証してから引き継ぐ
          contactId: touchesContact ? refOrNull(b.contactId) : cur.contactId,
          newContactName: touchesContact ? String(b.newContactName ?? '') : '',
        })
      } else {
        refs = { companyId: cur.companyId, contactId: cur.contactId, createdCompany: null, createdContact: null }
      }
      await client.query(
        `UPDATE customer_logs
         SET log_date = $2::date, log_time = $3, end_time = $4, company_id = $5, contact_id = $6,
             staff_member_id = $7, tags = $8, title = $9, body = $10, updated_at = now()
         WHERE id = $1`,
        [logId, next.logDate, next.logTime, next.endTime, refs.companyId, refs.contactId,
          next.staffMemberId, JSON.stringify(next.tags), next.title, next.body])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      refError(e)
    } finally {
      client.release()
    }
    await auditCreatedRefs(pool, user, refs)
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
