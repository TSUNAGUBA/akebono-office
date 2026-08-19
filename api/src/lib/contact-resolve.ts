/**
 * コンボボックス自由入力からの顧客担当者(人)解決（customer-logs から抽出した共通実装 = 原則3。
 * 顧客活動 / 営業活動 / パートナー活動で共用。改修依頼 2026-08-19 第4弾）。
 * newContactName があれば同一会社内の氏名（空白除去・大小無視）完全一致で照合し、なければ新規登録する。
 * contactId 指定時は所属整合を検証する。エラーコードの名前空間・ロック接頭辞は呼び出し側で指定する
 * （顧客活動 = AKO-CLG / clog-contact、活動記録 = 各エラーコード / act-contact 等）。
 */
import type pg from 'pg'
import type { AuthUser } from '../auth'
import { lockResolveKey } from './company-resolve'
import { audit } from './audit'
import { err } from './errors'
import { newId } from './ids'
import { capCp } from './text'

/** 顧客担当者(人)の氏名上限（customer-log NAME_CAP と同値） */
const CONTACT_NAME_CAP = 120

function normContactName(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

/** contactId 指定時の所属検証（不在 / 別会社所属は {code}-003 = 400） */
export async function assertContactBelongs(
  db: pg.Pool | pg.PoolClient, contactId: string, companyId: string, errCode: string,
): Promise<void> {
  const { rows } = await db.query<{ companyId: string }>(
    `SELECT company_id AS "companyId" FROM contacts WHERE id = $1`, [contactId])
  const row = rows[0]
  if (!row) throw err(`${errCode}-003`, '指定した顧客担当者が見つかりません', 400)
  if (row.companyId !== companyId) {
    throw err(`${errCode}-003`, '顧客担当者は選択した会社に所属している必要があります', 400)
  }
}

/**
 * 顧客担当者(人)の解決。contactId 指定は所属検証してそのまま。空 = 未設定（null）。
 * 自由入力名は同一会社内の氏名一致 → なければ新規登録。呼び出し側はトランザクション内で使い、
 * created が非 null ならコミット後に auditCreatedContact を呼ぶ。
 */
export async function resolveContact(
  db: pg.PoolClient,
  companyId: string,
  contactId: string | null,
  newContactName: string,
  opts: { errCode: string; lockPrefix: string },
): Promise<{ id: string | null; created: { id: string; name: string } | null }> {
  if (contactId) {
    await assertContactBelongs(db, contactId, companyId, opts.errCode)
    return { id: contactId, created: null }
  }
  const name = capCp(newContactName.trim(), CONTACT_NAME_CAP)
  if (!name) return { id: null, created: null }
  await lockResolveKey(db, `${opts.lockPrefix}:${companyId}:${normContactName(name)}`)
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM contacts WHERE company_id = $1 AND active = true ORDER BY id`, [companyId])
  const hit = rows.find(r => normContactName(r.name) === normContactName(name))
  if (hit) return { id: hit.id, created: null }
  const id = newId('p')
  await db.query(`INSERT INTO contacts (id, company_id, name) VALUES ($1, $2, $3)`, [id, companyId, name])
  return { id, created: { id, name } }
}

/** コンボボックス新規登録の監査ログ（コミット後に呼ぶ。補助処理 = 主フロー成立後） */
export async function auditCreatedContact(
  pool: pg.Pool, user: AuthUser, created: { id: string; name: string } | null, fromLabel: string,
): Promise<void> {
  if (!created) return
  await audit(pool, {
    actorId: user.id, action: 'create', entity: 'contacts', entityId: created.id,
    detail: `${fromLabel}から顧客担当者「${created.name}」を新規登録`,
  })
}
