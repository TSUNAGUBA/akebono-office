/**
 * 通知のカテゴリ判定（SoT）。ダッシュボードの通知欄と通知・エスカレーションセンター（/inbox）で共用する（原則3）。
 * - escalation = kind='escalation'（エスカレーション起票の通知）
 * - workflow（稟議）= リンク先が /workflow の通知（承認依頼・決裁・却下・差戻し）
 * - approval（承認依頼）= それ以外の approval 通知（打刻修正・休暇など）
 * - other = 上記以外（コメント・AI 報告・リマインド・ぽいぽい等）
 */
import type { AppNotification } from '~/types/domain'

export type NotificationCategory = 'escalation' | 'approval' | 'workflow' | 'other'

export function notificationCategoryOf(n: AppNotification): NotificationCategory {
  if (n.kind === 'escalation') return 'escalation'
  const bare = (n.link || '').split('?')[0] ?? ''
  if (bare === '/workflow' || bare.startsWith('/workflow/')) return 'workflow'
  if (n.kind === 'approval') return 'approval'
  return 'other'
}
