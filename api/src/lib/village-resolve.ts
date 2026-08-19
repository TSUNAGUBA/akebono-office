/**
 * コンボボックス自由入力からの事業区分（Village）解決（company-resolve と同型 = 原則3。
 * 改修依頼 2026-08-19 第4弾）。活動記録（サポート/営業/パートナー）の最上段の Village コンボで、
 * 未登録名が入力されたらマスタへ新規登録して反映する（照合 → なければ INSERT。重複を作らない）。
 * villages マスタは /v1/masters（admin 専用）だが、この解決は活動 route 自身の tx 内で走るため
 * 非 admin でも暗黙作成できる（company-resolve と同じ配慮）。
 */
import type pg from 'pg'
import type { AuthUser } from '../auth'
import { audit } from './audit'
import { newId } from './ids'
import { capCp } from './text'
import { lockResolveKey } from './company-resolve'

const VILLAGE_NAME_CAP = 120

/** 照合用の正規化（trim + 小文字化 + 連続空白の圧縮）。会社名ほど厳密な法人格除去は不要（社内区分名のため） */
function normalizeVillageName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * 事業区分（Village）の解決。villageId 指定はそのまま。空 = 未設定（null を返す）。
 * 自由入力名は既存照合（正規化名の完全一致）→ なければ新規登録。
 * 呼び出し側はトランザクション内で使い、created が非 null ならコミット後に auditCreatedVillage を呼ぶ。
 */
export async function resolveVillage(
  db: pg.PoolClient,
  villageId: string | null,
  newVillageName: string,
): Promise<{ id: string | null; created: { id: string; name: string } | null }> {
  if (villageId) return { id: villageId, created: null }
  const name = capCp(newVillageName.trim(), VILLAGE_NAME_CAP)
  if (!name) return { id: null, created: null } // 未入力 = 未設定（任意項目）
  const norm = normalizeVillageName(name)
  await lockResolveKey(db, `village:${norm}`)
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM villages WHERE active = true ORDER BY id`)
  for (const r of rows) {
    if (normalizeVillageName(r.name) === norm) return { id: r.id, created: null }
  }
  const id = newId('vil')
  await db.query(`INSERT INTO villages (id, name) VALUES ($1, $2)`, [id, name])
  return { id, created: { id, name } }
}

/** コンボボックス新規登録の監査ログ（コミット後に呼ぶ。補助処理 = 主フロー成立後） */
export async function auditCreatedVillage(
  pool: pg.Pool,
  user: AuthUser,
  created: { id: string; name: string } | null,
  fromLabel: string,
): Promise<void> {
  if (!created) return
  await audit(pool, {
    actorId: user.id, action: 'create', entity: 'villages', entityId: created.id,
    detail: `${fromLabel}から事業区分「${created.name}」を新規登録`,
  })
}
