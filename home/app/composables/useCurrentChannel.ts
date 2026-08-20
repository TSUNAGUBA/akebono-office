/**
 * 現在のメディアチャンネルコンテキスト（メディア分析の対象チャンネル）。
 *
 * メディア分析は独立したメディアチャンネル（任意で業態と連携）を単位に動く（2026-08-03）。
 * 「今どのチャンネルを見ているか」をユーザー単位で保持する（useCurrentSegment と同型）。
 *
 * 永続化（デュアルモード）:
 *  - API モード: SoT はサーバー（/v1/me の prefs.currentChannelId = user_preferences。0039）。
 *    どの端末からログインしても同じチャンネルで開ける。
 *  - モックモード: 端末ローカル（useState + localStorage・SSR 安全・原則3）。
 * 保存済み id が無効化・削除されても先頭チャンネルへフォールバックする（情報損失なし = 原則2。両モード共通）。
 */
import type { MediaChannel } from '~/types/media'
import { resolveDefaultSegmentId } from '~/utils/akebono'

/** モックモードの端末ローカル保存キー（API モードでは使わない） */
const STORAGE_KEY = 'ako.currentChannel.v1'
/** API モードの user_preferences キー（/v1/me の prefs 配下） */
const PREF_KEY = 'currentChannelId'

export function useCurrentChannel() {
  const isApi = useApiMode()
  const me = useApiMe()
  const toast = useToast()
  const { channels } = useMediaChannels()

  /** 有効なチャンネル（表示順 = 連携済みを先・名前順） */
  const activeChannels = computed<MediaChannel[]>(() =>
    (channels.value as MediaChannel[])
      .filter(c => c.active !== false)
      .sort((a, b) => {
        // 連携済み（segmentId あり）を先に、その後は名前順（決定的）
        const la = a.segmentId ? 0 : 1
        const lb = b.segmentId ? 0 : 1
        return la !== lb ? la - lb : a.name.localeCompare(b.name, 'ja')
      }))

  /** モックモードの選択状態（端末ローカル）。API モードでは参照しない */
  const mockChannelId = useState<string>('ako-current-channel', () => {
    if (!isApi && import.meta.client) {
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved) return saved
      } catch { /* noop */ }
    }
    return ''
  })

  /** 選択中のチャンネル id（未選択 = '' のときは先頭チャンネルに解決される） */
  const currentChannelId = computed<string>(() =>
    isApi
      ? String((me.value?.prefs as Record<string, unknown> | undefined)?.[PREF_KEY] ?? '')
      : mockChannelId.value)

  /** 実効チャンネル id（常に有効な id を返す。無ければ ''）。無効 id は先頭チャンネルへフォールバック */
  const effectiveChannelId = computed(() =>
    resolveDefaultSegmentId(currentChannelId.value, activeChannels.value))

  /** 現在のチャンネルレコード（無ければ null） */
  const currentChannel = computed<MediaChannel | null>(() =>
    activeChannels.value.find(c => c.id === effectiveChannelId.value) ?? null)

  /** チャンネルを切り替える（有効なチャンネルのみ。API は非ブロッキング保管 = 原則4） */
  function switchChannel(id: string): void {
    if (!activeChannels.value.some(c => c.id === id)) return
    if (isApi) {
      void saveMePreference(PREF_KEY, id).then((res) => {
        if (!res.ok) toast.show('チャンネルの保存に失敗しました。この端末では切り替え済みです', 'warn')
      })
      return
    }
    mockChannelId.value = id
    if (import.meta.client) {
      try { localStorage.setItem(STORAGE_KEY, id) } catch { /* noop */ }
    }
  }

  /** チャンネルを id で解決（無効化済みも含めて全件から） */
  function channelById(id: string | null | undefined): MediaChannel | null {
    return (channels.value as MediaChannel[]).find(c => c.id === id) ?? null
  }

  return {
    activeChannels,
    currentChannelId,
    effectiveChannelId,
    currentChannel,
    switchChannel,
    channelById,
  }
}
