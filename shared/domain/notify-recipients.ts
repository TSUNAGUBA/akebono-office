/**
 * 通知の宛先解決（純粋関数・Vue/DB 非依存。オペレーター指示 2026-08-03）。
 * 「ロール / 役職 / 個人」の指定（承認者 ApproverType と同じ 3 種 = 原則3）から、実際に通知する
 * 在籍メンバー id の集合を決定的に導く。ぽいぽいポストの通知先設定などで利用する。
 *
 * 保存形式は app_configs（テナント設定）の JSON 文字列（NotifyRecipientTarget[]）。
 * 壊れた JSON・不正要素は parseNotifyRecipients が捨てる（表示・配信を壊さない = 原則4）。
 */
import type { ApproverType, MemberRole } from './types'

/** 通知宛先の 1 指定（承認者と同じ 3 種: title=役職 / role=ロール / member=個人）。 */
export interface NotifyRecipientTarget {
  type: ApproverType
  /** type='role' のとき有効（admin/hr/member） */
  role?: MemberRole | null
  /** type='title' のとき有効（CodeMaster 'title' のラベル） */
  title?: string | null
  /** type='member' のとき有効（メンバー id） */
  memberId?: string | null
}

/** 宛先解決の入力に使うメンバー候補（在籍者・役職・ロール） */
export interface RecipientCandidate {
  id: string
  role: string
  title: string
  active?: boolean
}

const ROLES: readonly string[] = ['admin', 'hr', 'member']

/**
 * 宛先指定（JSON 文字列 / オブジェクト配列の両対応）を正規化する。
 * type と対応フィールドが揃った要素だけを残す（不正・欠落は捨てる）。
 */
export function parseNotifyRecipients(raw: unknown): NotifyRecipientTarget[] {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return []
    try { value = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(value)) return []
  const out: NotifyRecipientTarget[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    if (t.type === 'member' && typeof t.memberId === 'string' && t.memberId) {
      out.push({ type: 'member', memberId: t.memberId })
    } else if (t.type === 'title' && typeof t.title === 'string' && t.title) {
      out.push({ type: 'title', title: t.title })
    } else if (t.type === 'role' && typeof t.role === 'string' && ROLES.includes(t.role)) {
      out.push({ type: 'role', role: t.role as MemberRole })
    }
  }
  return out
}

/**
 * 宛先指定の配列 → 実際に通知する在籍メンバー id（重複排除・id 昇順で決定的）。
 * - member: 指定 id が在籍していれば追加
 * - title:  役職ラベル一致の在籍者すべて
 * - role:   ロール一致の在籍者すべて
 * excludeMemberId（任意）は結果から除外する（例: 投稿者本人へは通知しない）。
 */
export function resolveNotifyRecipientIds<M extends RecipientCandidate>(
  targets: NotifyRecipientTarget[],
  members: M[],
  excludeMemberId?: string | null,
): string[] {
  const actives = members.filter(m => m.active !== false)
  const ids = new Set<string>()
  for (const t of targets ?? []) {
    if (t.type === 'member') {
      if (t.memberId && actives.some(m => m.id === t.memberId)) ids.add(t.memberId)
    } else if (t.type === 'title') {
      if (t.title) for (const m of actives) if (m.title === t.title) ids.add(m.id)
    } else if (t.type === 'role') {
      if (t.role) for (const m of actives) if (m.role === t.role) ids.add(m.id)
    }
  }
  if (excludeMemberId) ids.delete(excludeMemberId)
  return [...ids].sort((a, b) => a.localeCompare(b))
}
