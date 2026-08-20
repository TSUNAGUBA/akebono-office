/**
 * 通知の宛先解決（純粋関数）。実体は shared/domain/notify-recipients.ts（API と共有）。
 * 既存 import パス互換のための再エクスポート。
 */
export { parseNotifyRecipients, resolveNotifyRecipientIds } from '../../../shared/domain/notify-recipients'
export type { NotifyRecipientTarget, RecipientCandidate } from '../../../shared/domain/notify-recipients'
