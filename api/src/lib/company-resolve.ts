/**
 * コンボボックス自由入力からの顧客(会社)解決（customer-logs から抽出した共通実装 = 原則3。
 * 顧客活動 / サポート活動 / 営業活動で共用。改修依頼 2026-08-18）。
 * newCompanyName があれば正規化名（法人格・空白ゆらぎ除去 = shared name-match）の完全一致で
 * 既存の顧客(会社)を照合し、なければマスタへ新規登録する（重複マスタを作らない）。
 */
import type pg from 'pg'
import { CUSTOMER_LOG_NAME_CAP as NAME_CAP } from '../../../shared/domain/customer-log'
import { normalizeCompanyName } from '../../../shared/domain/name-match'
import type { AuthUser } from '../auth'
import { audit } from './audit'
import { newId } from './ids'
import { capCp } from './text'

/**
 * 「照合 → なければ INSERT」の同名同時登録ガード。
 * READ COMMITTED では 2 リクエストが同時に照合へ失敗して重複マスタが生まれるため、
 * 正規化名単位のトランザクションスコープのアドバイザリロックで直列化する
 * （後着はロック待ち → 先着のコミット後に照合し直して既存へ名寄せされる。
 *  ロックはコミット/ロールバックで自動解放 = pg_advisory_xact_lock。ハッシュは他ロック箇所
 *  （akebono-trade / akebono-billing 等）と同じ 64bit hashtextextended = 衝突確率を最小化。
 *  万一衝突しても無関係な名前が直列化されるだけで無害）。
 */
export async function lockResolveKey(db: pg.PoolClient, key: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key])
}

/**
 * 顧客(会社)の解決。companyId 指定はそのまま。自由入力名は既存照合 → なければ新規登録。
 * 呼び出し側はトランザクション内で使い、created が非 null ならコミット後に auditCreatedCompany を呼ぶ。
 */
export async function resolveCompany(
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

/** コンボボックス新規登録の監査ログ（コミット後に呼ぶ。補助処理 = 主フロー成立後） */
export async function auditCreatedCompany(
  pool: pg.Pool,
  user: AuthUser,
  created: { id: string; name: string } | null,
  fromLabel: string,
): Promise<void> {
  if (!created) return
  await audit(pool, {
    actorId: user.id, action: 'create', entity: 'companies', entityId: created.id,
    detail: `${fromLabel}から顧客(会社)「${created.name}」を新規登録`,
  })
}
