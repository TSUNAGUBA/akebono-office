/**
 * 通知のカテゴリ判定（SoT）。ダッシュボードの通知欄と通知・エスカレーションセンター（/inbox）で共用する（原則3）。
 * - escalation = kind='escalation'（エスカレーション起票の通知）
 * - workflow（稟議）= リンク先が /workflow の通知（承認依頼・決裁・却下・差戻し）
 * - report（日報）= リンク先が /reports の通知（日報・週報のコメント・リマインド）
 * - customer-log（顧客ログ）= リンク先が /customer-log の通知
 * - minutes（議事録）= リンク先が /minutes の通知
 * - approval（承認依頼）= それ以外の approval 通知（打刻修正・休暇など）
 * - other = 上記以外（AI 報告・システム・ぽいぽい等）
 *
 * リンク基準のカテゴリ（workflow / report / customer-log / minutes）は kind='approval' 判定より先に評価する
 * = 「どの機能の通知か」を種別より優先して分類する（日報の承認通知は approval ではなく report に入れる）。
 */
import type { AppNotification } from '~/types/domain'

export type NotificationCategory =
  | 'escalation' | 'approval' | 'workflow' | 'report' | 'customer-log' | 'minutes' | 'other'

/** リンク先パス（先頭一致）→ カテゴリ。判定順を安定させるため配列で持つ */
const LINK_CATEGORY_RULES: { prefix: string; category: NotificationCategory }[] = [
  { prefix: '/workflow', category: 'workflow' },
  { prefix: '/reports', category: 'report' },
  { prefix: '/customer-log', category: 'customer-log' },
  { prefix: '/minutes', category: 'minutes' },
]

export function notificationCategoryOf(n: AppNotification): NotificationCategory {
  if (n.kind === 'escalation') return 'escalation'
  const bare = (n.link || '').split('?')[0] ?? ''
  for (const rule of LINK_CATEGORY_RULES) {
    if (bare === rule.prefix || bare.startsWith(`${rule.prefix}/`)) return rule.category
  }
  if (n.kind === 'approval') return 'approval'
  return 'other'
}
