/**
 * 通知タブ（何を表示するか）の設定。純ロジック（カタログ・パース・解決）の SoT。
 *
 * ダッシュボードの通知欄（DashboardNotifications）と通知センター（/inbox）で共用する（原則3）。
 * 「すべて（all）」は常に先頭に固定表示し、それ以外のカテゴリタブ（エスカレーション・承認依頼・稟議・
 * 日報・顧客ログ・議事録）を表示するかどうかをユーザー / 全社（テナント）で設定できる。
 *
 * 解決順 = ユーザー設定 > 組織（テナント）設定 > 既定。ユーザー個人設定が優先（ヘッダーのクイックアクセスと同じ流儀）。
 * 永続化はデュアルモード（useNotificationTabs）: ユーザー層 = /v1/me pref（mock=localStorage）/
 * テナント層 = configs `notification-tabs`。新 API ルート/マイグレーションは不要（既存の汎用 key/value を利用）。
 */
import type { NotificationCategory } from '~/utils/notification-category'

/** 設定可能なカテゴリタブ（'all' は常時表示のため含めない）。表示順もこの順に固定する */
export interface NotificationTabDef {
  /** NotificationCategory と一致する id（カテゴリ絞り込みキー） */
  id: Exclude<NotificationCategory, 'other'>
  label: string
}

export const NOTIFICATION_TAB_CATALOG: NotificationTabDef[] = [
  { id: 'escalation', label: 'エスカレーション' },
  { id: 'approval', label: '承認依頼' },
  { id: 'workflow', label: '稟議' },
  { id: 'report', label: '日報' },
  { id: 'customer-log', label: '顧客ログ' },
  { id: 'minutes', label: '議事録' },
]

/**
 * 既定の表示タブ（ユーザー/組織が未設定のときの表示）。
 * 従来の既存 3 種（エスカレーション・承認依頼・稟議）に加え、今回追加の 3 種（日報・顧客ログ・議事録）も
 * 既定で表示する（= 追加要望に応え、多すぎる場合は設定で間引ける）。
 */
export const DEFAULT_NOTIFICATION_TAB_IDS: string[] =
  NOTIFICATION_TAB_CATALOG.map(t => t.id)

const CATALOG_IDS = new Set<string>(NOTIFICATION_TAB_CATALOG.map(t => t.id))

/** id → カタログ項目 */
export function notificationTabOf(id: string): NotificationTabDef | undefined {
  return NOTIFICATION_TAB_CATALOG.find(t => t.id === id)
}

export type NotificationTabsScope = 'user' | 'tenant' | 'default'

/**
 * 保存値をパース。カタログに存在する id のみ・重複除去し、カタログ順に整列して返す。
 * 未設定・不正値は null（= 設定なし）。空配列は「カテゴリタブを出さない（= すべて のみ）」として尊重する。
 *
 * 保存経路の二態を両方受理する（parseQuickAccessIds と同じ流儀）:
 *  - mock / localStorage: JSON 文字列（例 '["report"]'）
 *  - API モード: /v1/me の prefs は JSONB のためデシリアライズ済みの配列がそのまま渡る
 */
export function parseNotificationTabIds(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null
  let arr: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return null
    try { arr = JSON.parse(raw) } catch { return null }
  }
  if (!Array.isArray(arr)) return null
  const chosen = new Set<string>()
  for (const x of arr) {
    if (typeof x === 'string' && CATALOG_IDS.has(x)) chosen.add(x)
  }
  // カタログ順に整列（保存時の並びに依存せず、表示順を安定させる）
  return NOTIFICATION_TAB_CATALOG.filter(t => chosen.has(t.id)).map(t => t.id)
}

/** 解決: ユーザー > テナント > 既定 */
export function resolveNotificationTabIds(
  userRaw: unknown,
  tenantRaw: unknown,
): { ids: string[]; scope: NotificationTabsScope } {
  const u = parseNotificationTabIds(userRaw)
  if (u) return { ids: u, scope: 'user' }
  const t = parseNotificationTabIds(tenantRaw)
  if (t) return { ids: t, scope: 'tenant' }
  return { ids: [...DEFAULT_NOTIFICATION_TAB_IDS], scope: 'default' }
}
