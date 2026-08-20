/**
 * 個人別マルチチャネル通知連携（Slack / Google Chat。改修依頼 2026-08-20）の純ロジック SoT（Vue/DB 非依存・mock/API 共有）。
 *
 * 通知マトリクス = 「通知種別（行）× 通知先チャネル（列）の ON/OFF」を表す個人設定。
 * - 既定値: アプリ内（in_app）= ON / Slack・Google Chat = OFF（連携しただけでは送らない = 誤送信防止）
 * - 永続形式: NotificationMatrix の JSON。API モードは user_preferences キー
 *   `NOTIFICATION_CHANNELS_PREF_KEY`（0039 の per-user 設定基盤 = 原則3）、mock は localStorage。
 *   serializeNotificationMatrix が既定値と同じセルを落として最小サイズに保つ
 *   （/v1/me/preferences 系の value 4KB 上限対策）。
 * - parseNotificationMatrix は JSON 文字列 / デシリアライズ済みオブジェクトの両対応
 *   （notification-tabs の parse と同じ流儀）。未知キー・非 boolean は無害に落とす =
 *   将来の種別/チャネル追加・旧クライアントの保存値でも壊れない（原則7）。
 */
import type { NotificationKind } from './types'

// ---------- チャネル・サービスのカタログ ----------

/** 通知先チャネル（列）。in_app = 既存のアプリ内通知（notifications テーブル / mockdb） */
export type NotificationChannelType = 'in_app' | 'slack' | 'google_chat'

export const NOTIFICATION_CHANNEL_TYPES: NotificationChannelType[] = ['in_app', 'slack', 'google_chat']

export const CHANNEL_META: Record<NotificationChannelType, { label: string }> = {
  in_app: { label: 'アプリ内' },
  slack: { label: 'Slack' },
  google_chat: { label: 'Google Chat' },
}

/** OAuth 連携対象の外部チャットサービス（= in_app 以外のチャネル） */
export type ChatService = 'slack' | 'google_chat'

export const CHAT_SERVICES: ChatService[] = ['slack', 'google_chat']

/** 連携トークンの状態。401 等の失効検知で reauth_required へ遷移（再連携で connected へ戻る） */
export type ChatLinkStatus = 'connected' | 'reauth_required'

/** API モードの user_preferences キー（/v1/me の prefs 配下。0039 基盤を再利用 = 新テーブル不要） */
export const NOTIFICATION_CHANNELS_PREF_KEY = 'notificationChannels'

// ---------- 通知マトリクス ----------

/** 行 = 通知種別 / 列 = チャネル / セル = ON/OFF（省略セルは既定値） */
export type NotificationMatrix = Partial<Record<NotificationKind, Partial<Record<NotificationChannelType, boolean>>>>

/** マトリクスの行カタログ（NotificationKind の全種別。表示順もこの順に固定する） */
export const NOTIFICATION_MATRIX_KINDS: NotificationKind[] = [
  'approval', 'comment', 'reminder', 'ai_report', 'system', 'escalation', 'poipoi',
]

const KIND_SET = new Set<string>(NOTIFICATION_MATRIX_KINDS)
const CHANNEL_SET = new Set<string>(NOTIFICATION_CHANNEL_TYPES)

/** チャネルの既定値: アプリ内 = ON（デフォルトON要件）/ 外部チャネル = OFF */
export function channelDefault(channel: NotificationChannelType): boolean {
  return channel === 'in_app'
}

/**
 * 保存値をパースする（JSON 文字列 / オブジェクトの両対応）。
 * 未知の種別・チャネル・非 boolean 値は無害に落とす（壊れた保存値でも表示・配信を壊さない = 原則4・7）。
 * 未設定・不正値は {}（= 全セル既定値）。
 */
export function parseNotificationMatrix(raw: unknown): NotificationMatrix {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: NotificationMatrix = {}
  for (const [kind, cells] of Object.entries(value as Record<string, unknown>)) {
    if (!KIND_SET.has(kind) || !cells || typeof cells !== 'object' || Array.isArray(cells)) continue
    const row: Partial<Record<NotificationChannelType, boolean>> = {}
    for (const [channel, v] of Object.entries(cells as Record<string, unknown>)) {
      if (CHANNEL_SET.has(channel) && typeof v === 'boolean') row[channel as NotificationChannelType] = v
    }
    if (Object.keys(row).length > 0) out[kind as NotificationKind] = row
  }
  return out
}

/** セルの実効値（未設定セルは既定値: in_app=ON / slack・google_chat=OFF） */
export function channelEnabled(
  matrix: NotificationMatrix,
  kind: NotificationKind,
  channel: NotificationChannelType,
): boolean {
  return matrix[kind]?.[channel] ?? channelDefault(channel)
}

/**
 * 保存用の最小形へ正規化する（既定値と同じセルは書かない = 最小サイズ・4KB 上限対策）。
 * parse との往復（parse(serialize(m))）で実効値（channelEnabled）は不変。
 */
export function serializeNotificationMatrix(matrix: NotificationMatrix): NotificationMatrix {
  const out: NotificationMatrix = {}
  for (const kind of NOTIFICATION_MATRIX_KINDS) {
    const cells = matrix[kind]
    if (!cells) continue
    const row: Partial<Record<NotificationChannelType, boolean>> = {}
    for (const channel of NOTIFICATION_CHANNEL_TYPES) {
      const v = cells[channel]
      if (typeof v === 'boolean' && v !== channelDefault(channel)) row[channel] = v
    }
    if (Object.keys(row).length > 0) out[kind] = row
  }
  return out
}

/** セルを 1 つ変更した新しいマトリクスを返す（最小形へ正規化済み。UI のトグル操作用） */
export function setMatrixCell(
  matrix: NotificationMatrix,
  kind: NotificationKind,
  channel: NotificationChannelType,
  enabled: boolean,
): NotificationMatrix {
  return serializeNotificationMatrix({
    ...matrix,
    [kind]: { ...(matrix[kind] ?? {}), [channel]: enabled },
  })
}

/** この種別で ON になっている外部チャットサービス（配信エンジンのチャネル判定用） */
export function enabledExternalServices(matrix: NotificationMatrix, kind: NotificationKind): ChatService[] {
  return CHAT_SERVICES.filter(s => channelEnabled(matrix, kind, s))
}
