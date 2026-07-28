/**
 * メディア設定（セグメント 1:1）。GA 連携と AI 分析設定を画面操作で完結させる。
 *
 * デュアルモード（useCalendar の流儀）:
 * - モック: mediaSettings コレクションが SoT（擬似 OAuth = このレコードが接続状態を持つ）。従来挙動を維持
 * - API: GA 接続状態の SoT はサーバー（media_ga_tokens → GET /v1/media/status。segmentId キーの遅延ロード）。
 *   AI 分析設定の SoT は media_settings（GET/PUT /v1/media/settings）。connect は Google OAuth 2.0 の
 *   同意画面へのフルリダイレクト（復帰は /media/settings?ga=connected|error&segment= クエリ）→
 *   GA4 プロパティ選択（/v1/media/properties → PUT /v1/media/property）で connected が完成する
 * - 取消可能性（原則9.5）: 連携は解除でき、設定は再編集で上書きできる
 */
import type { MediaSetting } from '~/types/media'
import { defaultMediaSetting } from '~/utils/media'

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一。segmentId キー） ----------

export interface GaStatus {
  enabled: boolean
  connected: boolean
  /** トークンはあるが GA4 プロパティ未選択（選択モーダルへ誘導する中間状態） */
  needsProperty: boolean
  propertyId: string | null
  propertyName: string | null
  connectedAt: string | null
  /** 取得完了か（未取得の間は「未設定」バナー等を出さない） */
  loaded: boolean
}

const GA_STATUS_EMPTY: GaStatus = {
  enabled: false, connected: false, needsProperty: false,
  propertyId: null, propertyName: null, connectedAt: null, loaded: false,
}

const apiGaStatus = ref<Record<string, GaStatus>>({})
/** media_settings 行（null = サーバー未設定。表示は defaultMediaSetting で補う） */
const apiSettingRows = ref<Record<string, Partial<MediaSetting> | null>>({})

/** GA 接続状態の遅延ロード（useMediaAnalytics の統合集計も await するためモジュール公開） */
export function loadMediaGaStatus(segmentId: string, force = false): Promise<void> {
  if (!segmentId) return Promise.resolve()
  return apiLoadOnce(`media:ga:${segmentId}`, async () => {
    const s = await apiFetch<Omit<GaStatus, 'loaded'>>('/v1/media/status', { query: { segmentId } })
    apiGaStatus.value = { ...apiGaStatus.value, [segmentId]: { ...s, loaded: true } }
  }, force)
}
const loadGaStatus = loadMediaGaStatus

function loadSettingRow(segmentId: string, force = false): Promise<void> {
  if (!segmentId) return Promise.resolve()
  return apiLoadOnce(`media:setting:${segmentId}`, async () => {
    const row = await apiFetch<Partial<MediaSetting> | null>('/v1/media/settings', { query: { segmentId } })
    apiSettingRows.value = { ...apiSettingRows.value, [segmentId]: row }
  }, force)
}

// ログイン確立・切替時に取り直す
onApiReset(() => {
  apiGaStatus.value = {}
  apiSettingRows.value = {}
})

export function useMediaSettings() {
  const { tbl, commit, nextId } = useMockDb()
  const settings = tbl('mediaSettings')
  const { effectiveSegmentId, segmentById } = useCurrentSegment()
  const isApi = useApiMode()

  function rawFor(segmentId: string): MediaSetting | undefined {
    return (settings.value as MediaSetting[]).find(s => s.segmentId === segmentId)
  }

  /** モック: 部分更新の内部実装（渡したキーのみ上書き = 未指定フィールドを保持） */
  function saveMock(segmentId: string, patch: Partial<Omit<MediaSetting, 'id' | 'segmentId'>>): { ok: boolean; error?: { code: string; message: string } } {
    const base = ensureSetting(segmentId)
    if (!base) return { ok: false, error: { code: 'AKO-MEDIA-001', message: 'メディア設定の対象セグメントが見つかりません' } }
    const next: MediaSetting = { ...base, ...patch }
    settings.value = (settings.value as MediaSetting[]).map(s => s.segmentId === segmentId ? next : s)
    commit()
    return { ok: true }
  }

  /**
   * セグメントの設定を取得する（モック: 無ければ既定を materialize して保存 / API: settingFor と同義 —
   * materialize はサーバー側 upsert（初回 PUT）が担うため、参照だけでは行を作らない = 冪等）。
   * segmentId 無効時は null。
   */
  function ensureSetting(segmentId: string): MediaSetting | null {
    if (isApi) return settingFor(segmentId)
    const existing = rawFor(segmentId)
    if (existing) return existing
    const seg = segmentById(segmentId)
    if (!seg) return null
    const created = defaultMediaSetting(seg, nextId('mediaSettings', 'ms'))
    settings.value = [...settings.value, created]
    commit()
    return created
  }

  /**
   * 設定を取得する（読み取り専用・materialize しない。表示既定は defaultMediaSetting で補う）。
   * API モードは「サーバー設定行 + GA 接続状態」を MediaSetting 形へ合成する（既存の全消費側が
   * setting.gaConnected 等をそのまま読める = 画面の分岐を変えない）。参照が遅延ロードを発火する
   */
  function settingFor(segmentId: string): MediaSetting | null {
    const seg = segmentById(segmentId)
    if (!seg) return null
    if (isApi) {
      void loadGaStatus(segmentId)
      void loadSettingRow(segmentId)
      const base = defaultMediaSetting(seg, 'ms-preview')
      const row = apiSettingRows.value[segmentId]
      const ga = apiGaStatus.value[segmentId]
      return {
        ...base,
        ...(row ?? {}),
        // サーバー行の空サイト名は表示既定（業態名ベース）で補う（materialize 前の空表示を防ぐ）
        siteName: row?.siteName || base.siteName,
        // GA 接続状態の SoT はサーバー（media_ga_tokens）。設定行の値では上書きさせない
        gaConnected: ga?.connected === true,
        gaPropertyId: ga?.propertyId ?? null,
        gaPropertyName: ga?.propertyName ?? null,
        gaConnectedAt: ga?.connectedAt ?? null,
      }
    }
    const existing = rawFor(segmentId)
    if (existing) return existing
    return defaultMediaSetting(seg, 'ms-preview')
  }

  /** 現在の業態の設定（表示用。materialize しない） */
  const currentSetting = computed<MediaSetting | null>(() => settingFor(effectiveSegmentId.value))

  /** GA 連携状態（API モードの needsProperty / enabled / loaded を含む。モックは設定から合成） */
  function gaStatusFor(segmentId: string): GaStatus {
    if (isApi) {
      void loadGaStatus(segmentId)
      return apiGaStatus.value[segmentId] ?? GA_STATUS_EMPTY
    }
    const s = settingFor(segmentId)
    return {
      enabled: true,
      connected: s?.gaConnected === true,
      needsProperty: false,
      propertyId: s?.gaPropertyId ?? null,
      propertyName: s?.gaPropertyName ?? null,
      connectedAt: s?.gaConnectedAt ?? null,
      loaded: true,
    }
  }

  /** OAuth 復帰後などの接続状態・設定の取り直し */
  async function refreshGa(segmentId: string): Promise<void> {
    if (!isApi) return
    await Promise.all([loadGaStatus(segmentId, true), loadSettingRow(segmentId, true)])
  }

  /**
   * 部分更新（渡したキーのみ上書き = 未指定フィールドを保持）。
   * API モードは AI 分析設定のみ送る（GA 接続状態はサーバー SoT のため patch から除外）。
   * SoT 書込 → レスポンス行でキャッシュ更新の順序（原則6）
   */
  async function save(segmentId: string, patch: Partial<Omit<MediaSetting, 'id' | 'segmentId'>>): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    if (isApi) {
      // GA 系フィールドはサーバー（media_ga_tokens）が SoT。誤って送っても無視される設計だが送信自体を避ける
      const { gaConnected: _c, gaPropertyId: _p, gaPropertyName: _n, gaConnectedAt: _a, ...rest } = patch
      try {
        const row = await apiFetch<Partial<MediaSetting>>('/v1/media/settings', {
          method: 'PUT', body: { segmentId, ...rest },
        })
        apiSettingRows.value = { ...apiSettingRows.value, [segmentId]: row }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    return saveMock(segmentId, patch)
  }

  /**
   * GA4 を連携する（モック専用: 擬似 OAuth 同意後に呼ぶ）。
   * API モードの連携は startGaConnect（同意画面リダイレクト）→ selectGaProperty の 2 段
   */
  function connectGa(segmentId: string, propertyId: string, propertyName: string): { ok: boolean; error?: { code: string; message: string } } {
    if (!propertyId.trim()) return { ok: false, error: { code: 'AKO-MEDIA-002', message: 'GA4 プロパティ ID を入力してください' } }
    return saveMock(segmentId, {
      gaConnected: true,
      gaPropertyId: propertyId.trim(),
      gaPropertyName: propertyName.trim() || propertyId.trim(),
      gaConnectedAt: nowJstIso(),
    })
  }

  /** API: Google の同意画面へフルリダイレクト（このページから離れる。復帰は ?ga= クエリ処理） */
  async function startGaConnect(segmentId: string): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    try {
      const { url } = await apiFetch<{ url: string }>('/v1/media/oauth/url', { query: { segmentId } })
      window.location.href = url
      return { ok: true }
    } catch (e) {
      return { ok: false, error: apiErrorOf(e) }
    }
  }

  /** API: OAuth 済みアカウントの GA4 プロパティ一覧（Admin API accountSummaries の平坦化） */
  async function listGaProperties(segmentId: string): Promise<{ ok: boolean; properties?: { id: string; name: string; account: string }[]; error?: { code: string; message: string } }> {
    try {
      const properties = await apiFetch<{ id: string; name: string; account: string }[]>('/v1/media/properties', { query: { segmentId } })
      return { ok: true, properties }
    } catch (e) {
      return { ok: false, error: apiErrorOf(e) }
    }
  }

  /** API: GA4 プロパティを確定する（ここで connected が完成）。SoT 書込 → 状態の取り直し（原則6） */
  async function selectGaProperty(segmentId: string, propertyId: string, propertyName: string): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    const res = await apiResult(() => apiFetch('/v1/media/property', {
      method: 'PUT', body: { segmentId, propertyId, propertyName },
    }))
    if (res.ok) await refreshGa(segmentId)
    return res
  }

  /** GA 連携を解除する（取消フロー。設定・記事は残す = 非破壊） */
  async function disconnectGa(segmentId: string): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    if (isApi) {
      const res = await apiResult(() => apiFetch('/v1/media/disconnect', { method: 'POST', body: { segmentId } }))
      if (res.ok) await refreshGa(segmentId)
      return res
    }
    return saveMock(segmentId, { gaConnected: false, gaPropertyId: null, gaPropertyName: null, gaConnectedAt: null })
  }

  return {
    settings, currentSetting,
    settingFor, ensureSetting, save, connectGa, disconnectGa,
    gaStatusFor, refreshGa, startGaConnect, listGaProperties, selectGaProperty,
  }
}
