/**
 * 個人別マルチチャネル通知連携（Slack / Google Chat。改修依頼 2026-08-20）の純ロジック。
 * 実体は shared/domain/notification-channels.ts（API と共有。原則3・6: 純ロジックの SoT は shared 側）。
 * `~/utils/...` import パスのための再エクスポート（notify-recipients と同じ流儀）。
 */
export {
  CHANNEL_META, channelDefault, channelEnabled, CHAT_SERVICES, enabledExternalServices,
  NOTIFICATION_CHANNEL_TYPES, NOTIFICATION_CHANNELS_PREF_KEY, NOTIFICATION_MATRIX_KINDS,
  parseNotificationMatrix, serializeNotificationMatrix, setMatrixCell,
} from '../../../shared/domain/notification-channels'
export type {
  ChatLinkStatus, ChatService, NotificationChannelType, NotificationMatrix,
} from '../../../shared/domain/notification-channels'
