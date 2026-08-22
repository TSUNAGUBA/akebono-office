/**
 * データ基盤（改善要望 2026-08-22: 自社コンテキスト / ナレッジ / ログの 3 カテゴリ）の読み取り層。
 * useIntelligenceData（分析入力の 8 ソース）を補完し、ナレッジ・ログ系の追加ソース
 * （議事録・メディアレポート・ECレポート・委託販売レポート・社内サポート）を読む。
 * - モックモード: useMockDb のシード（決定的デモデータ）
 * - API モード: 共通 API から読み取り専用で取得。権限（F-16）によるサーバー側フィルタ・403 は
 *   空データとして扱う（原則4 = 見えるデータで表示する）
 * SPA（ssr:false）専用: キャッシュはモジュールスコープ単一。
 */
import type { Ref } from 'vue'
import type { InternalSupport, Note } from '~/types/domain'
import type { MediaWeeklyReport } from '../../../shared/domain/media-weekly-report'
import type { ConsignmentReport, EcReport } from '~/types/foundation'

// ---------- API モードのキャッシュ ----------

const apiMinutes = ref<Note[]>([])
const apiMediaReports = ref<MediaWeeklyReport[]>([])
const apiEcReports = ref<EcReport[]>([])
const apiConsignmentReports = ref<ConsignmentReport[]>([])
const apiInternalSupports = ref<InternalSupport[]>([])
const apiMediaChannels = ref<{ id: string; name: string }[]>([])
const loadingCount = ref(0)

async function tracked(fn: () => Promise<void>): Promise<void> {
  loadingCount.value++
  try {
    await fn()
  } finally {
    loadingCount.value--
  }
}

function loadFoundation(force = false): Promise<void> {
  return apiLoadOnce('intel:foundation', () => tracked(async () => {
    const [minutes, mediaReports, ecReports, consignment, internalSupports, channels] = await Promise.all([
      apiFetch<Note[]>('/v1/notes', { query: { kind: 'minutes' } }).catch(() => []),
      apiFetch<MediaWeeklyReport[]>('/v1/media/weekly-reports').catch(() => []),
      apiFetch<EcReport[]>('/v1/akebono/dashboard-insights/list').catch(() => []),
      apiFetch<ConsignmentReport[]>('/v1/akebono/payment-notices').catch(() => []),
      apiFetch<InternalSupport[]>('/v1/internal-supports').catch(() => []),
      apiFetch<{ id: string; name: string }[]>('/v1/media/channels').catch(() => []),
    ])
    apiMinutes.value = minutes
    apiMediaReports.value = mediaReports
    apiEcReports.value = ecReports
    apiConsignmentReports.value = consignment
    apiInternalSupports.value = internalSupports
    apiMediaChannels.value = channels
  }), force)
}

onApiReset(() => {
  apiMinutes.value = []
  apiMediaReports.value = []
  apiEcReports.value = []
  apiConsignmentReports.value = []
  apiInternalSupports.value = []
  apiMediaChannels.value = []
  if (useApiMe().value) void loadFoundation(true)
})

export function useFoundationData() {
  const { tbl } = useMockDb()
  const isApi = useApiMode()
  if (isApi) void loadFoundation()

  // モック側 tbl() の型はシードの相対パス解決で別モジュール扱いになりうるため、統一型へ寄せる
  const minutes = (isApi ? apiMinutes : tbl('minutes')) as Ref<Note[]>
  const mediaReports = (isApi ? apiMediaReports : tbl('mediaReports')) as Ref<MediaWeeklyReport[]>
  const ecReports = (isApi ? apiEcReports : tbl('ecReports')) as Ref<EcReport[]>
  const consignmentReports = (isApi ? apiConsignmentReports : tbl('consignmentReports')) as Ref<ConsignmentReport[]>
  const internalSupports = (isApi ? apiInternalSupports : tbl('internalSupports')) as Ref<InternalSupport[]>

  /** メディアチャンネル名（API モードのみ取得。モックはシードの単一チャンネル名で解決） */
  function mediaChannelName(id: string): string {
    if (!isApi) return id === 'mch-01' ? 'オウンドメディア' : id
    return apiMediaChannels.value.find(ch => ch.id === id)?.name ?? id
  }

  const loading = computed(() => loadingCount.value > 0)

  /** 再読込（データソース画面の更新ボタン。モックモードは no-op） */
  async function refresh(): Promise<void> {
    if (isApi) await loadFoundation(true)
  }

  return {
    minutes, mediaReports, ecReports, consignmentReports, internalSupports,
    mediaChannelName, loading, refresh,
  }
}
