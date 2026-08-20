/**
 * 個人別マルチチャネル通知連携（Slack / Google Chat。改修依頼 2026-08-20）。
 * 連携状態（連携/解除/要再認証）と通知マトリクス（通知種別 × チャネルの ON/OFF）を扱う。
 * 純ロジック（カタログ・パース・既定値）は utils/notification-channels.ts（= shared/domain）が SoT。
 *
 * デュアルモード（useCalendar / useNotificationTabs の流儀 = 原則3):
 * - mock: 連携状態 = localStorage 'ako.chat-links.v1'（擬似同意モーダルは profile.vue が表示し、
 *   許可で connect() を呼ぶ）/ マトリクス = localStorage 'ako.notification-matrix.v1'。
 *   テスト送信はトーストのみのデモ（実送信なし）
 * - API: GET /v1/notification-channels（連携状態 + マトリクス）・PUT /matrix（保存）・
 *   POST /:service/oauth/url → OAuth 同意画面へフルリダイレクト（復帰は /#/profile?chat=connected|error
 *   クエリ。profile.vue の onMounted が refresh + トースト + クエリ除去を行う）・
 *   POST /:service/disconnect・POST /:service/test（自分宛に実送信）
 *
 * リアルタイム受信はスコープ外: アプリ内通知は既存の 60 秒ポーリング（useNotifications）を維持し、
 * 即時性は外部チャネル（Slack / Google Chat の DM）が担う設計。
 */
import type { NotificationKind, Result } from '~/types/domain'
import {
  CHANNEL_META, channelEnabled, CHAT_SERVICES, type ChatLinkStatus, type ChatService,
  type NotificationChannelType, type NotificationMatrix,
  parseNotificationMatrix, serializeNotificationMatrix, setMatrixCell,
} from '~/utils/notification-channels'
import { NOTIFICATION_KIND_LABELS } from '~/utils/labels'

/** mock モードの端末ローカル保存キー */
const MOCK_LINKS_KEY = 'ako.chat-links.v1'
const MOCK_MATRIX_KEY = 'ako.notification-matrix.v1'

/** サービスごとの連携状態（UI 表示用。トークンはクライアントへ来ない） */
export interface ChatLinkView {
  service: ChatService
  label: string
  /** 連携機能が利用可能か（API モードで OAuth 未設定なら false = 連携導線を「未設定」表示に） */
  enabled: boolean
  connected: boolean
  status: ChatLinkStatus | null
  displayName: string
}

interface ServiceState {
  enabled: boolean
  connected: boolean
  status: ChatLinkStatus | null
  displayName: string
}

type MockLinks = Partial<Record<ChatService, { connected: boolean; displayName: string; status: ChatLinkStatus }>>

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一 = useCalendar と同型） ----------

function emptyServices(): Record<ChatService, ServiceState> {
  return {
    slack: { enabled: false, connected: false, status: null, displayName: '' },
    google_chat: { enabled: false, connected: false, status: null, displayName: '' },
  }
}

const apiChannels = ref<{ loaded: boolean; services: Record<ChatService, ServiceState>; matrix: NotificationMatrix }>(
  { loaded: false, services: emptyServices(), matrix: {} })

function loadChannels(force = false): Promise<void> {
  return apiLoadOnce('notification-channels', async () => {
    const d = await apiFetch<{ services: Record<ChatService, ServiceState>; matrix: unknown }>(
      '/v1/notification-channels')
    apiChannels.value = { loaded: true, services: d.services, matrix: parseNotificationMatrix(d.matrix) }
  }, force)
}

// ログイン確立・切替時に取り直す
onApiReset(() => {
  apiChannels.value = { loaded: false, services: emptyServices(), matrix: {} }
})

// ---------- mock モードの localStorage 読み書き ----------

function readMockLinks(): MockLinks {
  if (!import.meta.client) return {}
  try {
    const v = JSON.parse(localStorage.getItem(MOCK_LINKS_KEY) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as MockLinks : {}
  } catch {
    return {}
  }
}

function readMockMatrix(): NotificationMatrix {
  if (!import.meta.client) return {}
  try {
    return parseNotificationMatrix(localStorage.getItem(MOCK_MATRIX_KEY) ?? '')
  } catch {
    return {}
  }
}

export function useNotificationChannels() {
  const isApi = useApiMode()
  const { currentUser } = useCurrentUser()
  const { show } = useToast()

  const mockLinks = useState<MockLinks>('ako-chat-links', () => readMockLinks())
  const mockMatrix = useState<NotificationMatrix>('ako-notification-matrix', () => readMockMatrix())

  if (isApi) void loadChannels()

  /** 連携状態の取得が完了しているか（未取得の間は「未設定」表示を出さない） */
  const isLoaded = computed(() => (isApi ? apiChannels.value.loaded : true))

  /** サービスごとの連携状態（カタログ順で常に 2 件） */
  const links = computed<ChatLinkView[]>(() => CHAT_SERVICES.map((service) => {
    const label = CHANNEL_META[service].label
    if (isApi) {
      const s = apiChannels.value.services[service]
      return { service, label, enabled: s.enabled, connected: s.connected, status: s.status, displayName: s.displayName }
    }
    const m = mockLinks.value[service]
    return {
      service,
      label,
      enabled: true,
      connected: m?.connected ?? false,
      status: m?.connected ? (m.status ?? 'connected') : null,
      displayName: m?.displayName ?? '',
    }
  }))

  /** 通知マトリクス（未設定セルは既定値: アプリ内 ON / 外部 OFF。cellOn で実効値を参照） */
  const matrix = computed<NotificationMatrix>(() => (isApi ? apiChannels.value.matrix : mockMatrix.value))

  function cellOn(kind: NotificationKind, channel: NotificationChannelType): boolean {
    return channelEnabled(matrix.value, kind, channel)
  }

  /**
   * セルのトグル保存。楽観反映 → 保存し、失敗時は巻き戻してエラートースト
   * （成功/失敗を必ずトーストで報告 = 主要操作のフィードバック）。
   */
  async function setCell(
    kind: NotificationKind,
    channel: NotificationChannelType,
    enabled: boolean,
  ): Promise<void> {
    const next = setMatrixCell(matrix.value, kind, channel, enabled)
    if (isApi) {
      const prev = apiChannels.value.matrix
      apiChannels.value = { ...apiChannels.value, matrix: next } // 楽観反映（クリック順に確定）
      const res = await apiResult(() =>
        apiFetch('/v1/notification-channels/matrix', { method: 'PUT', body: { matrix: next } }))
      if (!res.ok) {
        apiChannels.value = { ...apiChannels.value, matrix: prev } // 失敗は巻き戻し
        show(`${res.error.code}: ${res.error.message}`, 'crit')
        return
      }
    } else {
      mockMatrix.value = next
      if (import.meta.client) {
        try {
          localStorage.setItem(MOCK_MATRIX_KEY, JSON.stringify(serializeNotificationMatrix(next)))
        } catch { /* プライベートモード等は保存不可でも画面上の反映は成立 */ }
      }
    }
    show(`「${NOTIFICATION_KIND_LABELS[kind]}」の ${CHANNEL_META[channel].label} 通知を ${enabled ? 'ON' : 'OFF'} にしました`)
  }

  /**
   * 連携を開始する。API モードは OAuth 同意画面へフルリダイレクト（このページから離れる。
   * 復帰後の状態反映は profile.vue の ?chat= クエリ処理 + refresh が行う）。
   * mock は擬似同意モーダルの「許可」後に呼ばれ、即時に連携済みへ（再連携 = 上書きで status 回復）。
   */
  async function connect(service: ChatService): Promise<Result> {
    if (isApi) {
      try {
        const { url } = await apiFetch<{ url: string }>(
          `/v1/notification-channels/${service}/oauth/url`, { method: 'POST' })
        window.location.href = url // 成功時はページ遷移するためここへは戻らない
        return { ok: true }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const displayName = service === 'slack'
      ? `AKEBONO ワークスペース / ${currentUser.value.name}`
      : currentUser.value.email || currentUser.value.name
    mockLinks.value = {
      ...mockLinks.value,
      [service]: { connected: true, displayName, status: 'connected' as ChatLinkStatus },
    }
    writeMockLinks(mockLinks.value)
    return { ok: true }
  }

  /** 連携を解除する（取消フロー = 原則9.5。再連携でいつでも復元できる） */
  async function disconnect(service: ChatService): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() =>
        apiFetch(`/v1/notification-channels/${service}/disconnect`, { method: 'POST' }))
      if (res.ok) await loadChannels(true)
      return res
    }
    const next = { ...mockLinks.value }
    delete next[service]
    mockLinks.value = next
    writeMockLinks(next)
    return { ok: true }
  }

  /** テスト送信（API = 自分宛に実送信 / mock = デモ。トーストは呼び出し側で表示） */
  async function sendTest(service: ChatService): Promise<Result> {
    if (isApi) {
      return apiResult(() => apiFetch(`/v1/notification-channels/${service}/test`, { method: 'POST' }))
    }
    const m = mockLinks.value[service]
    if (!m?.connected) {
      return {
        ok: false,
        error: { code: 'AKO-NCH-003', message: `${CHANNEL_META[service].label} が未連携です。連携してからテスト送信してください` },
      }
    }
    return { ok: true }
  }

  /** OAuth 復帰後などの状態の取り直し */
  async function refresh(): Promise<void> {
    if (!isApi) return
    await loadChannels(true)
  }

  function writeMockLinks(value: MockLinks): void {
    if (!import.meta.client) return
    try {
      localStorage.setItem(MOCK_LINKS_KEY, JSON.stringify(value))
    } catch { /* 保存不可でも画面上の反映は成立（次回リロードで既定に戻る） */ }
  }

  return { isLoaded, links, matrix, cellOn, setCell, connect, disconnect, sendTest, refresh }
}
