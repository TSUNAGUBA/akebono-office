/**
 * メディアチャンネル（旧 useMediaSettings を置換・拡張）。独立チャンネルの CRUD + GA 連携 + AI 分析設定を
 * 画面操作で完結させる。任意で「連携する Akebono 業務アプリ（業態）」を設定できる（連携は必須でない）。
 *
 * デュアルモード（useCalendar / 旧 useMediaSettings の流儀）:
 * - モック: mediaChannels コレクションが SoT（擬似 OAuth = このレコードが接続状態を持つ）
 * - API: GA 接続状態の SoT はサーバー（media_ga_tokens → GET /v1/media/status。channelId キーの遅延ロード）。
 *   チャンネル/設定の SoT は media_channels（GET/PUT /v1/media/settings・POST/PATCH /v1/media/channels）。
 *   connect は Google OAuth 2.0 の同意画面フルリダイレクト（復帰は /media/settings?ga=&channel= クエリ）→
 *   GA4 プロパティ選択（/v1/media/properties → PUT /v1/media/property）で connected が完成する
 * - 取消可能性（原則9.5）: チャンネルは取消（論理削除）・復元でき、連携は解除でき、設定は再編集で上書きできる
 */
import type { Result } from '~/types/domain'
import type { MediaChannel } from '~/types/media'
import { defaultMediaChannel } from '~/utils/media'

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一。channelId キー） ----------

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

/** チャンネル一覧（GA 接続状態はサーバーが各行へ合成済み。includeInactive=1 で取消済みも含む） */
const apiChannels = ref<MediaChannel[]>([])
const apiGaStatus = ref<Record<string, GaStatus>>({})
/** media_channels 行（GET /settings。null = 未取得） */
const apiSettingRows = ref<Record<string, Partial<MediaChannel> | null>>({})

/** チャンネル一覧の遅延ロード（ハブ・チャンネルバー・現在チャンネル解決で共有） */
export function loadMediaChannels(force = false): Promise<void> {
  return apiLoadOnce('media:channels', async () => {
    const rows = await apiFetch<MediaChannel[]>('/v1/media/channels', { query: { includeInactive: '1' } })
    apiChannels.value = rows
  }, force)
}

/**
 * ある業態(segmentId)に連携する active チャンネルの id 群（API モードのキャッシュから解決）。
 * 統合キャッシュ無効化（invalidateIntegratedFor）が「業態 id ≠ チャンネル id」の連携チャンネル
 * （UI で新規作成し業態連携したもの = id が mc-xxxx）も対象にできるようにする（レビュー M-1・原則6）。
 * 下位互換チャンネル（channel.id === segmentId）は id 一致でも拾えるため、呼び出し側で segmentId 自身も併せて対象にする。
 */
export function channelIdsForSegment(segmentId: string): string[] {
  if (!segmentId) return []
  return apiChannels.value.filter(c => c.active !== false && c.segmentId === segmentId).map(c => c.id)
}

/** GA 接続状態の遅延ロード（useMediaAnalytics の統合集計も await するためモジュール公開） */
export function loadMediaGaStatus(channelId: string, force = false): Promise<void> {
  if (!channelId) return Promise.resolve()
  return apiLoadOnce(`media:ga:${channelId}`, async () => {
    const s = await apiFetch<Omit<GaStatus, 'loaded'>>('/v1/media/status', { query: { channelId } })
    apiGaStatus.value = { ...apiGaStatus.value, [channelId]: { ...s, loaded: true } }
  }, force)
}
const loadGaStatus = loadMediaGaStatus

function loadSettingRow(channelId: string, force = false): Promise<void> {
  if (!channelId) return Promise.resolve()
  return apiLoadOnce(`media:setting:${channelId}`, async () => {
    const row = await apiFetch<Partial<MediaChannel> | null>('/v1/media/settings', { query: { channelId } })
    apiSettingRows.value = { ...apiSettingRows.value, [channelId]: row }
  }, force)
}

// ログイン確立・切替時に取り直す
onApiReset(() => {
  apiChannels.value = []
  apiGaStatus.value = {}
  apiSettingRows.value = {}
})

export function useMediaChannels() {
  const { tbl, commit, nextId } = useMockDb()
  const channelsTbl = tbl('mediaChannels')
  const isApi = useApiMode()

  /** 全チャンネル（取消済み含む。表示側でフィルタ）。API は遅延ロードキャッシュ */
  const channels = computed<MediaChannel[]>(() => {
    if (isApi) {
      void loadMediaChannels()
      return apiChannels.value
    }
    return channelsTbl.value as MediaChannel[]
  })

  function rawFor(channelId: string): MediaChannel | undefined {
    return (channelsTbl.value as MediaChannel[]).find(ch => ch.id === channelId)
  }

  /** モック: 部分更新の内部実装（渡したキーのみ上書き = 未指定フィールドを保持） */
  function saveMock(channelId: string, patch: Partial<Omit<MediaChannel, 'id'>>): Result {
    const base = rawFor(channelId)
    if (!base) return { ok: false, error: { code: 'AKO-MEDIA-021', message: '対象のメディアチャンネルが見つかりません' } }
    const next: MediaChannel = { ...base, ...patch }
    channelsTbl.value = (channelsTbl.value as MediaChannel[]).map(ch => ch.id === channelId ? next : ch)
    commit()
    return { ok: true }
  }

  /**
   * チャンネル設定を取得する（読み取り専用・materialize しない。表示既定は defaultMediaChannel で補う）。
   * API モードは「サーバー設定行 + 一覧行 + GA 接続状態」を MediaChannel 形へ合成する
   * （既存の全消費側が channel.gaConnected 等をそのまま読める）。参照が遅延ロードを発火する。
   */
  function settingFor(channelId: string): MediaChannel | null {
    if (!channelId) return null
    if (isApi) {
      void loadMediaChannels()
      void loadGaStatus(channelId)
      void loadSettingRow(channelId)
      const listed = apiChannels.value.find(ch => ch.id === channelId) ?? null
      const row = apiSettingRows.value[channelId] ?? null
      const ga = apiGaStatus.value[channelId]
      const base = row ?? listed
      if (!base) return null
      return {
        ...defaultMediaChannel(channelId, base.name ?? 'メディア', base.segmentId ?? null),
        ...(listed ?? {}),
        ...(row ?? {}),
        // GA 接続状態の SoT はサーバー（media_ga_tokens）。status が来ていればそれ、無ければ一覧行の値
        gaConnected: ga ? ga.connected === true : (listed?.gaConnected ?? false),
        gaPropertyId: ga ? ga.propertyId : (listed?.gaPropertyId ?? null),
        gaPropertyName: ga ? ga.propertyName : (listed?.gaPropertyName ?? null),
        gaConnectedAt: ga ? ga.connectedAt : (listed?.gaConnectedAt ?? null),
      }
    }
    return rawFor(channelId) ?? null
  }

  /** GA 連携状態（API モードの needsProperty / enabled / loaded を含む。モックは設定から合成） */
  function gaStatusFor(channelId: string): GaStatus {
    if (isApi) {
      void loadGaStatus(channelId)
      return apiGaStatus.value[channelId] ?? GA_STATUS_EMPTY
    }
    const s = settingFor(channelId)
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

  /** OAuth 復帰後などの接続状態・設定・一覧の取り直し */
  async function refreshGa(channelId: string): Promise<void> {
    if (!isApi) return
    await Promise.all([loadGaStatus(channelId, true), loadSettingRow(channelId, true), loadMediaChannels(true)])
  }

  // ---------- チャンネル CRUD ----------

  /** チャンネルを新規作成する（name 必須・segmentId 任意 = 連携は必須でない） */
  async function createChannel(input: { name: string; segmentId?: string | null } & Partial<Omit<MediaChannel, 'id' | 'name' | 'segmentId'>>): Promise<{ ok: boolean; channel?: MediaChannel; error?: { code: string; message: string } }> {
    if (!input.name.trim()) return { ok: false, error: { code: 'AKO-MEDIA-020', message: 'チャンネル名を入力してください' } }
    if (isApi) {
      try {
        const channel = await apiFetch<MediaChannel>('/v1/media/channels', {
          method: 'POST',
          body: {
            name: input.name.trim(), segmentId: input.segmentId ?? null,
            siteName: input.siteName, siteUrl: input.siteUrl, analysisGoal: input.analysisGoal,
            targetAudience: input.targetAudience, defaultTone: input.defaultTone, keywords: input.keywords,
          },
        })
        await loadMediaChannels(true)
        return { ok: true, channel }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const created: MediaChannel = {
      ...defaultMediaChannel(nextId('mediaChannels', 'mc'), input.name.trim(), input.segmentId ?? null),
      siteName: input.siteName ?? '',
      siteUrl: input.siteUrl ?? '',
      analysisGoal: input.analysisGoal ?? 'awareness',
      targetAudience: input.targetAudience ?? '',
      defaultTone: input.defaultTone ?? 'formal',
      keywords: input.keywords ?? [],
    }
    channelsTbl.value = [...(channelsTbl.value as MediaChannel[]), created]
    commit()
    return { ok: true, channel: created }
  }

  /**
   * チャンネル設定の部分更新（渡したキーのみ上書き = 未指定フィールドを保持）。
   * API モードは AI 分析設定・サイト・連携先（name/segmentId）を送る（GA 接続状態はサーバー SoT のため除外）。
   * SoT 書込 → レスポンス行でキャッシュ更新の順序（原則6）
   */
  async function save(channelId: string, patch: Partial<Omit<MediaChannel, 'id'>>): Promise<Result> {
    if (isApi) {
      // GA 系フィールドはサーバー（media_ga_tokens）が SoT。送信自体を避ける
      const { gaConnected: _c, gaPropertyId: _p, gaPropertyName: _n, gaConnectedAt: _a, ...rest } = patch
      try {
        const row = await apiFetch<Partial<MediaChannel>>('/v1/media/settings', {
          method: 'PUT', body: { channelId, ...rest },
        })
        apiSettingRows.value = { ...apiSettingRows.value, [channelId]: row }
        await loadMediaChannels(true) // name/segmentId の変更を一覧へ反映
        return { ok: true }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    return saveMock(channelId, patch)
  }

  /** チャンネルを取消（論理削除）する（原則9.5。記事・設定は残す = 非破壊） */
  async function archiveChannel(channelId: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch(`/v1/media/channels/${channelId}/archive`, { method: 'POST' }))
      if (res.ok) await loadMediaChannels(true)
      return res
    }
    return saveMock(channelId, { active: false })
  }

  /** 取消したチャンネルを復元する */
  async function restoreChannel(channelId: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch(`/v1/media/channels/${channelId}/restore`, { method: 'POST' }))
      if (res.ok) await loadMediaChannels(true)
      return res
    }
    return saveMock(channelId, { active: true })
  }

  // ---------- GA 連携（モック擬似 OAuth / API はリダイレクト + プロパティ選択） ----------

  /** GA4 を連携する（モック専用: 擬似 OAuth 同意後に呼ぶ） */
  function connectGa(channelId: string, propertyId: string, propertyName: string): Result {
    if (!propertyId.trim()) return { ok: false, error: { code: 'AKO-MEDIA-002', message: 'GA4 プロパティ ID を入力してください' } }
    return saveMock(channelId, {
      gaConnected: true,
      gaPropertyId: propertyId.trim(),
      gaPropertyName: propertyName.trim() || propertyId.trim(),
      gaConnectedAt: nowJstIso(),
    })
  }

  /** API: Google の同意画面へフルリダイレクト（このページから離れる。復帰は ?ga= クエリ処理） */
  async function startGaConnect(channelId: string): Promise<Result> {
    try {
      const { url } = await apiFetch<{ url: string }>('/v1/media/oauth/url', { query: { channelId } })
      window.location.href = url
      return { ok: true }
    } catch (e) {
      return { ok: false, error: apiErrorOf(e) }
    }
  }

  /** API: OAuth 済みアカウントの GA4 プロパティ一覧（Admin API accountSummaries の平坦化） */
  async function listGaProperties(channelId: string): Promise<{ ok: boolean; properties?: { id: string; name: string; account: string }[]; error?: { code: string; message: string } }> {
    try {
      const properties = await apiFetch<{ id: string; name: string; account: string }[]>('/v1/media/properties', { query: { channelId } })
      return { ok: true, properties }
    } catch (e) {
      return { ok: false, error: apiErrorOf(e) }
    }
  }

  /** API: GA4 プロパティを確定する（ここで connected が完成）。SoT 書込 → 状態の取り直し（原則6）。 */
  async function selectGaProperty(channelId: string, propertyId: string, propertyName: string): Promise<Result> {
    const res = await apiResult(() => apiFetch('/v1/media/property', {
      method: 'PUT', body: { channelId, propertyId, propertyName },
    }))
    if (res.ok) {
      await refreshGa(channelId)
      invalidateMediaAnalytics(channelId)
    }
    return res
  }

  /** GA 連携を解除する（取消フロー。設定・記事は残す = 非破壊） */
  async function disconnectGa(channelId: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch('/v1/media/disconnect', { method: 'POST', body: { channelId } }))
      if (res.ok) {
        await refreshGa(channelId)
        invalidateMediaAnalytics(channelId)
      }
      return res
    }
    return saveMock(channelId, { gaConnected: false, gaPropertyId: null, gaPropertyName: null, gaConnectedAt: null })
  }

  /**
   * 業態(segmentId)に連携する active チャンネルを解決する（両モード）。
   * 下位互換チャンネル（id === segmentId）を優先し、無ければ segmentId 連携の先頭 active チャンネル。
   * F-41 ダッシュボードが業態基点でメディア指標を引くときに使う（UI 作成の mc- チャンネル連携にも追随。レビュー MINOR-1）。
   */
  function channelForSegment(segmentId: string): MediaChannel | null {
    if (!segmentId) return null
    const active = (channels.value as MediaChannel[]).filter(c => c.active !== false)
    return active.find(c => c.id === segmentId && c.segmentId === segmentId)
      ?? active.find(c => c.segmentId === segmentId)
      ?? null
  }

  return {
    channels,
    settingFor, save, createChannel, archiveChannel, restoreChannel, channelForSegment,
    connectGa, disconnectGa,
    gaStatusFor, refreshGa, startGaConnect, listGaProperties, selectGaProperty,
  }
}
