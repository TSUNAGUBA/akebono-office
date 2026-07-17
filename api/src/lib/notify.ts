/**
 * 通知の発行（補助処理・非ブロッキング: 失敗しても主フローを止めない。開発原則4）
 * mockup useNotifications.notify / notifyAdmins の API 版。
 */
import type pg from 'pg'
import { nowJstIso } from '../../../shared/domain/jst'
import type { NotificationKind } from '../../../shared/domain/types'
import { newId } from './ids'

export async function notify(
  db: pg.Pool | pg.PoolClient,
  memberId: string,
  kind: NotificationKind,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO notifications (id, member_id, kind, title, body, link, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId('nt'), memberId, kind, title, body, link, nowJstIso()],
    )
  } catch (e) {
    console.warn('notify failed (non-blocking):', (e as Error).message)
  }
}

/** 管理者全員へ通知する（mockup と同一: role='admin' の在籍者） */
export async function notifyAdmins(
  db: pg.Pool | pg.PoolClient,
  kind: NotificationKind,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM members WHERE active = true AND role = 'admin'`)
    for (const m of rows) {
      await notify(db, m.id, kind, title, body, link)
    }
  } catch (e) {
    console.warn('notifyAdmins failed (non-blocking):', (e as Error).message)
  }
}
