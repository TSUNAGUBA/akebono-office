/** 監査ログ（補助処理・非ブロッキング: 失敗しても主フローを止めない。開発原則4） */
import type pg from 'pg'

export async function audit(
  db: pg.Pool | pg.PoolClient,
  input: { actorId: string; action: string; entity: string; entityId: string; detail?: string },
): Promise<void> {
  try {
    await db.query(
      'INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5)',
      [input.actorId, input.action, input.entity, input.entityId, input.detail ?? ''],
    )
  } catch (e) {
    console.warn('audit log failed (non-blocking):', (e as Error).message)
  }
}
