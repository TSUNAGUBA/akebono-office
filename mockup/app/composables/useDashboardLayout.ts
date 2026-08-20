/**
 * ダッシュボード（F-01）のレイアウト（表示・配置）解決と保存（オペレーター指示 2026-08-03）。
 *
 * 3 階層（ユーザー設定 > テナント設定 > アプリ既定（デフォルト表示））を解決し、テンプレート適用・解除を提供する。
 * 純ロジック（型・テンプレート・解決・categorize）は utils/dashboard-layout.ts が SoT。
 *
 * 永続化（デュアルモード。既存基盤を踏襲 = 原則3）:
 *  - ユーザー層: API=/v1/me の prefs.dashboardLayout（saveMePreference。user_preferences 0039・端末間同期）
 *    / mock=端末ローカル（useState + localStorage 'ako.dashboard-layout.v1'・SSR 安全。useCurrentSegment の流儀）
 *  - テナント層: configs `dashboard-layout`（getConfig/setConfig。app_configs・両モード対応済み）
 *    未設定時は従来の `menu-categories-dashboard` を下位互換として解釈（resolveDashboardLayout 内）
 *
 * 保存値は DashboardLayout（templateId + sections + options）を JSON で持つ（将来の微調整に耐える）。
 * API ルート/マイグレーションの新規追加は不要（既存の汎用 key/value を利用）。
 */
import type {
  DashboardLayout, DashboardLayoutOptions, DashboardScope, DashboardTemplate,
  NotificationPlacement, SectionFavorite,
} from '~/utils/dashboard-layout'
import {
  buildCustomLayout, DASHBOARD_TEMPLATES, DEFAULT_LAYOUT_OPTIONS, layoutFromLegacyCategories,
  materializeLayout, parseDashboardLayout, parseNotificationPlacement, parseSectionFavorites,
  pickBaseLayout, removeSectionFavorite, resolveDashboardLayout,
  resolveNotificationPlacement, upsertSectionFavorite, withNotificationPlacement,
} from '~/utils/dashboard-layout'
import type { MenuCategoryDef } from '~/utils/menu-registry'

/** mock モードの端末ローカル保存キー（API モードでは使わない） */
const USER_STORAGE_KEY = 'ako.dashboard-layout.v1'
/** API モードの user_preferences キー（/v1/me の prefs 配下） */
const USER_PREF_KEY = 'dashboardLayout'
/** テナント層の configs キー（新） */
const TENANT_CONFIG_KEY = 'dashboard-layout'
/** テナント層の下位互換キー（従来のメニューカテゴリ設定） */
const LEGACY_TENANT_CONFIG_KEY = 'menu-categories-dashboard'

// 通知配置の専用キー（レイアウト設定 = 通知の配置に特化。2026-08-18）。
// レイアウト本体（sections を含む JSON）と別キーにすることで、「配置だけ変えたのに
// セクション構成がその層に固定され、以後の全社セクション変更が届かなくなる」副作用を避ける（レビュー指摘）
/** mock モードの端末ローカル保存キー（通知配置） */
const PLACEMENT_STORAGE_KEY = 'ako.dashboard-notification-placement.v1'
/** API モードの user_preferences キー（通知配置） */
const PLACEMENT_PREF_KEY = 'dashboardNotificationPlacement'
/** テナント層の configs キー（通知配置） */
const PLACEMENT_CONFIG_KEY = 'dashboard-notification-placement'

export type ApplyScope = 'user' | 'tenant'

export function useDashboardLayout() {
  const isApi = useApiMode()
  const me = useApiMe()
  const toast = useToast()
  const { getConfig, setConfig } = useAppSettings()
  const { isAdmin } = useCurrentUser()

  /** mock モードのユーザー層（端末ローカル）。API モードでは参照しない */
  const mockUserLayout = useState<string>('ako-dashboard-layout', () => {
    if (!isApi && import.meta.client) {
      try { return localStorage.getItem(USER_STORAGE_KEY) ?? '' } catch { return '' }
    }
    return ''
  })

  /** mock モードのユーザー層（通知配置。端末ローカル）。API モードでは参照しない */
  const mockUserPlacement = useState<string>('ako-dashboard-notification-placement', () => {
    if (!isApi && import.meta.client) {
      try { return localStorage.getItem(PLACEMENT_STORAGE_KEY) ?? '' } catch { return '' }
    }
    return ''
  })

  /** ユーザー層の生値（API=me.prefs / mock=端末ローカル） */
  const userRaw = computed<unknown>(() =>
    isApi
      ? (me.value?.prefs as Record<string, unknown> | undefined)?.[USER_PREF_KEY]
      : mockUserLayout.value)

  const tenantRaw = computed(() => getConfig(TENANT_CONFIG_KEY, ''))
  const legacyRaw = computed(() => getConfig(LEGACY_TENANT_CONFIG_KEY, ''))

  /** 通知配置（専用キー）の生値。ユーザー層 = prefs / mock ローカル・テナント層 = configs */
  const userPlacementRaw = computed<unknown>(() =>
    isApi
      ? (me.value?.prefs as Record<string, unknown> | undefined)?.[PLACEMENT_PREF_KEY]
      : mockUserPlacement.value)
  const tenantPlacementRaw = computed(() => getConfig(PLACEMENT_CONFIG_KEY, ''))

  const resolved = computed(() => resolveDashboardLayout({
    userRaw: userRaw.value,
    tenantRaw: tenantRaw.value,
    legacyCategoriesRaw: legacyRaw.value,
  }))

  /**
   * 通知配置の解決（層整合 = ユーザー配置キー > ユーザー層レイアウト由来〔分離前の明示選択のみ〕>
   * テナント配置キー > テナント層レイアウト由来〔同〕> アプリ既定。
   * 専用キー導入前にユーザー層レイアウトで配置を選んでいた既存ユーザーを新しいテナントキーが上書きしない = 原則7。
   * 分離後の保存（inherit）はフォールバック値を層に固定しない = キー解除後の巻き戻り先が陳腐化しない〔R8〕）
   */
  const placementResolution = computed(() => resolveNotificationPlacement({
    userRaw: userPlacementRaw.value,
    tenantRaw: tenantPlacementRaw.value,
    userLayout: userLayout.value
      ? { placement: userLayout.value.options.notifications, inherit: userLayout.value.options.notificationsInherit }
      : null,
    tenantLayout: tenantLayout.value
      ? { placement: tenantLayout.value.options.notifications, inherit: tenantLayout.value.options.notificationsInherit }
      : null,
  }))

  /**
   * 有効レイアウト（ユーザー > テナント > デフォルトの解決結果）。
   * 通知配置は専用キーを含む層整合の解決結果を options.notifications へ適用する（2026-08-18 の分離）。
   */
  const effectiveLayout = computed<DashboardLayout>(() => {
    const layout = resolved.value.layout
    const placement = placementResolution.value.placement
    if (placement === layout.options.notifications) return layout
    return withNotificationPlacement(layout, placement)
  })
  /** どの階層が効いているか（レイアウト = セクション構成の解決層。表示用） */
  const resolvedScope = computed<DashboardScope>(() => resolved.value.scope)
  /** 通知配置がどこ由来か（専用キーの層 / 'layout' = レイアウト由来 / 'default' = アプリ既定。表示用） */
  const placementSource = computed<'user' | 'tenant' | 'layout' | 'default'>(() => placementResolution.value.source)
  /**
   * 現在の配置が「自分の分離前レイアウト（配置を明示保持）」由来か（表示用）。
   * このときだけ全社の配置キーより自分のレイアウトが優先される（原則7）ため、UI がその旨を案内する。
   * テナント層レイアウト由来の 'layout'（全社キーを設定すれば即座に上書きされる）とは区別する（レビュー R12）
   */
  const placementFromOwnLegacyLayout = computed(() =>
    placementResolution.value.source === 'layout'
    && !!userLayout.value
    && !userLayout.value.options.notificationsInherit)
  /** 有効レイアウトの由来テンプレート id */
  const activeTemplateId = computed(() => effectiveLayout.value.templateId)

  /** テンプレート一覧（選択 UI 用） */
  const templates: DashboardTemplate[] = DASHBOARD_TEMPLATES

  /** 各層に設定されているレイアウト（無ければ null。UI のハイライト・解除可否に使用） */
  const userLayout = computed<DashboardLayout | null>(() => parseDashboardLayout(userRaw.value))
  const tenantLayout = computed<DashboardLayout | null>(() =>
    parseDashboardLayout(tenantRaw.value) ?? layoutFromLegacyCategories(legacyRaw.value))
  /**
   * テナント層の「新キー（dashboard-layout）自身の」設定（下位互換の menu-categories-dashboard を含まない）。
   * resetLayout('tenant') は新キーのみをクリアする（従来キーは MenuCategoryEditor が管理するため触らない）ので、
   * 「解除」ボタンの活性判定・適用中テンプレートのハイライトはこちらを使う（レビュー MINOR）。
   */
  const tenantLayoutOwn = computed<DashboardLayout | null>(() => parseDashboardLayout(tenantRaw.value))
  const hasUserLayout = computed(() => userLayout.value !== null)
  const hasTenantLayout = computed(() => tenantLayout.value !== null)
  const hasTenantLayoutOwn = computed(() => tenantLayoutOwn.value !== null)

  /**
   * 指定スコープでの編集の「土台」となるレイアウト（ドラフト初期値・保存時に引き継ぐ options の取得元）。
   * 純ロジックは utils の pickBaseLayout が SoT（原則3）。effectiveLayout（解決結果）を土台にすると、
   * 管理者が全社（tenant）を編集する際に自分の user 設定がテナントへ紛れ込む（レビュー MAJOR）ため層で分ける。
   */
  function baseLayoutForScope(scope: ApplyScope): DashboardLayout {
    return pickBaseLayout(scope, { userLayout: userLayout.value, tenantLayout: tenantLayout.value })
  }

  /**
   * DashboardLayout を該当層へ保存する（applyTemplate / saveSections の共通保存経路 = 原則3）。
   *  - user: saveMePreference（API）/ localStorage（mock）。全ユーザーが自分向けに設定可能
   *  - tenant: setConfig（configs）。管理者のみ（非管理者は警告して no-op = 非ブロッキング）
   * 失敗はトースト通知済み（setConfig/saveMePreference）。結果は { ok } で返す。
   */
  async function persistLayout(layout: DashboardLayout, scope: ApplyScope): Promise<{ ok: boolean }> {
    if (scope === 'tenant') {
      if (!isAdmin.value) {
        toast.show('全社設定（テナント既定）の変更は管理者のみ可能です', 'warn')
        return { ok: false }
      }
      const res = await setConfig(TENANT_CONFIG_KEY, JSON.stringify(layout))
      return { ok: res?.ok !== false }
    }
    // user scope
    if (isApi) {
      const res = await saveMePreference(USER_PREF_KEY, layout)
      return { ok: res.ok }
    }
    const json = JSON.stringify(layout)
    mockUserLayout.value = json
    if (import.meta.client) {
      try { localStorage.setItem(USER_STORAGE_KEY, json) } catch { /* noop */ }
    }
    return { ok: true }
  }

  /**
   * レイアウト本体へ保存する際のフォールバック配置（保存先層の視点での現行有効配置）。
   * - user: 自分の解決結果（配置キー > 自分のレイアウト > テナントキー > レイアウト）をそのまま維持
   *   = テンプレート適用・セクション保存で**見えている配置が変わらない**（レビュー R3）
   * - tenant: テナント配置キー > テナント層レイアウト由来（**管理者個人の user 配置キーをテナントへ
   *   漏らさない** = §53 MAJOR と同じ層分離）
   * ※ レイアウト本体の options.notifications は配置キー未設定時のフォールバックとしてのみ効く
   */
  function placementForPersist(scope: ApplyScope): NotificationPlacement {
    if (scope === 'user') return placementResolution.value.placement
    return tenantEffectivePlacement.value
  }

  /**
   * レイアウト保存時の配置フォールバックの引き継ぎ。
   * - 保存先層に**分離前レイアウト**（配置を明示選択した保存値 = inherit なし）があるときは、
   *   その配置値をそのまま温存する（当時の配置意思を引き継ぐ = 原則7。inherit は立てない）
   * - それ以外は inherit = true で配置をキーへ委譲する（フォールバック値を層に固定せず、
   *   テナント配置変更・キー解除が以後も効き続ける = レビュー R5/R8）。placement は参考値
   *   （inherit 時の解決では使われない）として保存先層視点の現行有効値を書く
   */
  function persistedPlacementOf(scope: ApplyScope): { placement: NotificationPlacement; inherit: boolean } {
    const own = scope === 'user' ? userLayout.value : tenantLayoutOwn.value
    if (own && !own.options.notificationsInherit) {
      return { placement: own.options.notifications, inherit: false }
    }
    return { placement: placementForPersist(scope), inherit: true }
  }

  /**
   * テンプレートを materialize して該当層へ保存する。
   * レイアウト設定（通知の配置）とセクション設定の分離（改修依頼 2026-08-18）: テンプレートは
   * セクション構成 + 表示オプション（AKEBONO・密度）を適用し、**通知の配置は保存先層の現行有効値を維持する**
   * （通知の配置はレイアウト設定〔saveNotificationPlacement〕だけが変更する）。
   */
  async function applyTemplate(templateId: string, scope: ApplyScope): Promise<{ ok: boolean }> {
    const persisted = persistedPlacementOf(scope)
    const layout = withNotificationPlacement(materializeLayout(templateId), persisted.placement)
    if (persisted.inherit) layout.options.notificationsInherit = true
    // セクション「その他」の非表示は層の明示選択として温存する（通知配置と同じ規約 = テンプレートは
    // セクション構成の差し替えであって表示オプションの取消ではない。戻すのは解除 or トグル操作。レビュー R1）
    if (baseLayoutForScope(scope).options.showOther === false) layout.options.showOther = false
    return persistLayout(layout, scope)
  }

  /** 各層自身に設定されている通知配置（専用キーのみ。無ければ null。UI のハイライト・解除可否に使用） */
  const userPlacement = computed<NotificationPlacement | null>(() => parseNotificationPlacement(userPlacementRaw.value))
  const tenantPlacement = computed<NotificationPlacement | null>(() => parseNotificationPlacement(tenantPlacementRaw.value))

  /**
   * テナント層視点の現行有効配置（テナントキー > テナント層レイアウト〔分離前の明示値のみ〕> アプリ既定）。
   * 解決関数と同じ規則で inherit 付きフォールバック値を拾わない（拾うと、キー解除後の全社プレビュー・
   * 次回保存のフォールバックが陳腐化した値を復元してしまう = レビュー R13）。
   * 全社スコープのプレビュー・保存フォールバック（persistedPlacementOf）が共用する。
   */
  const tenantEffectivePlacement = computed<NotificationPlacement>(() => {
    if (tenantPlacement.value) return tenantPlacement.value
    const t = tenantLayout.value
    if (t && !t.options.notificationsInherit) return t.options.notifications
    return DEFAULT_LAYOUT_OPTIONS.notifications
  })

  /**
   * 通知の配置（上/右/下/非表示）だけを該当層へ保存する（レイアウト設定 = 通知配置に特化。2026-08-18）。
   * レイアウト本体とは**別の専用キー**に保存する = セクション構成には一切触れない
   * （レイアウト本体へ保存すると、配置だけ変えたのにフォールバック層のセクション構成がその層へ
   * 固定され、以後の全社セクション変更が届かなくなる = レビュー指摘）。
   */
  async function saveNotificationPlacement(
    placement: NotificationPlacement, scope: ApplyScope,
  ): Promise<{ ok: boolean }> {
    return persistPlacement(placement, scope)
  }

  /** 通知配置の該当層の設定を解除する（レイアウト由来の配置へ戻す。取消フロー = 原則 9.5） */
  async function resetNotificationPlacement(scope: ApplyScope): Promise<{ ok: boolean }> {
    return persistPlacement(null, scope)
  }

  /** 通知配置（専用キー）の保存・解除の共通経路（null = 解除） */
  async function persistPlacement(
    placement: NotificationPlacement | null, scope: ApplyScope,
  ): Promise<{ ok: boolean }> {
    if (scope === 'tenant') {
      if (!isAdmin.value) {
        toast.show('全社設定（テナント既定）の変更は管理者のみ可能です', 'warn')
        return { ok: false }
      }
      const res = await setConfig(PLACEMENT_CONFIG_KEY, placement ?? '')
      return { ok: res?.ok !== false }
    }
    // user scope
    if (isApi) {
      const res = await saveMePreference(PLACEMENT_PREF_KEY, placement ?? '')
      return { ok: res.ok }
    }
    mockUserPlacement.value = placement ?? ''
    if (import.meta.client) {
      try {
        if (placement) localStorage.setItem(PLACEMENT_STORAGE_KEY, placement)
        else localStorage.removeItem(PLACEMENT_STORAGE_KEY)
      } catch { /* noop */ }
    }
    return { ok: true }
  }

  /**
   * セクション構成（どのメニューをどのセクションに置くか）を該当層へ保存する（2026-08-03 #25）。
   * options（通知位置・AKEBONO 表示・密度）は「保存先スコープ自身」の設定を維持したまま sections だけ
   * 差し替える。effectiveLayout（解決結果）の options を使うと、管理者が全社を編集した際に自分の user 設定の
   * options がテナントへ漏れる（レビュー MAJOR）ため baseLayoutForScope で層ごとに土台を取る。
   * optionsPatch = セクションと同時に保存する表示オプションの部分更新（セクション設定の「その他」トグル等。
   * 改修依頼 2026-08-20）。土台 options の上へマージする。通知の配置は本パッチでは変更できない（notifications /
   * notificationsInherit は persistedPlacementOf の結果が常に上書きする = 配置は専用キーの担当のまま）。
   * templateId は 'custom'（テンプレート由来ではない手動編集）。保存経路は applyTemplate と同一（原則3）。
   */
  async function saveSections(
    sections: MenuCategoryDef[], scope: ApplyScope, optionsPatch?: Partial<DashboardLayoutOptions>,
  ): Promise<{ ok: boolean }> {
    // options は保存先層自身の土台から取りつつ、通知配置は保存先層の現行有効値を維持する
    // （baseLayoutForScope のフォールバック値をそのまま書くと、配置キーで変えた見た目が
    // セクション保存で巻き戻る = レビュー R3。placementForPersist が層分離も担保）。
    // notificationsInherit = 分離後の保存は原則、配置をキーへ委譲（フォールバック値を層に固定しない = レビュー R5/R8）
    const persisted = persistedPlacementOf(scope)
    const options: DashboardLayout['options'] = {
      ...baseLayoutForScope(scope).options,
      ...optionsPatch,
      notifications: persisted.placement,
    }
    if (persisted.inherit) options.notificationsInherit = true
    else delete options.notificationsInherit
    // showOther は「false のときだけ書く」永続形式（原則7 = normalizeOptions と同じ規約）。
    // パッチで true（表示 = 既定）へ戻したときはキー自体を消す = 既定値を層に凍結しない
    if (options.showOther !== false) delete options.showOther
    return persistLayout(buildCustomLayout(sections, options), scope)
  }

  /**
   * 該当層の設定を解除する（取消フロー = 原則 9.5）。
   *  - user 解除 → テナント/デフォルトへ戻る
   *  - tenant 解除 → 従来のメニューカテゴリ設定（あれば）/デフォルトへ戻る
   */
  async function resetLayout(scope: ApplyScope): Promise<{ ok: boolean }> {
    if (scope === 'tenant') {
      if (!isAdmin.value) {
        toast.show('全社設定（テナント既定）の変更は管理者のみ可能です', 'warn')
        return { ok: false }
      }
      const res = await setConfig(TENANT_CONFIG_KEY, '')
      return { ok: res?.ok !== false }
    }
    // user scope
    if (isApi) {
      const res = await saveMePreference(USER_PREF_KEY, '')
      return { ok: res.ok }
    }
    mockUserLayout.value = ''
    if (import.meta.client) {
      try { localStorage.removeItem(USER_STORAGE_KEY) } catch { /* noop */ }
    }
    return { ok: true }
  }

  return {
    effectiveLayout,
    resolvedScope,
    placementSource,
    activeTemplateId,
    templates,
    userLayout,
    tenantLayout,
    tenantLayoutOwn,
    hasUserLayout,
    hasTenantLayout,
    hasTenantLayoutOwn,
    userPlacement,
    tenantPlacement,
    tenantEffectivePlacement,
    placementFromOwnLegacyLayout,
    baseLayoutForScope,
    isAdmin,
    applyTemplate,
    saveNotificationPlacement,
    resetNotificationPlacement,
    saveSections,
    resetLayout,
  }
}

// ---------- セクション構成のお気に入り（自由設定の保存・呼び出し。改修依頼 2026-08-18） ----------

/** mock モードの端末ローカル保存キー（お気に入り。API モードでは使わない） */
const FAVORITES_STORAGE_KEY = 'ako.dashboard-section-favorites.v1'
/** API モードの user_preferences キー（お気に入り。/v1/me の prefs 配下） */
const FAVORITES_PREF_KEY = 'dashboardSectionFavorites'

/**
 * セクション構成のお気に入り（ユーザー個人・端末間同期）。
 * 自由設定（セクション設定の手動編集）に名前を付けて保存し、あとから呼び出せる。
 * 純ロジック（パース・upsert・削除）は utils/dashboard-layout.ts が SoT。
 * 永続化はデュアルモード（useDashboardLayout のユーザー層と同じ流儀 = 原則3）:
 *  - API: /v1/me の prefs.dashboardSectionFavorites（saveMePreference）
 *  - mock: useState + localStorage 'ako.dashboard-section-favorites.v1'
 */
export function useSectionFavorites() {
  const isApi = useApiMode()
  const me = useApiMe()

  const mockRaw = useState<string>('ako-dashboard-section-favorites', () => {
    if (!isApi && import.meta.client) {
      try { return localStorage.getItem(FAVORITES_STORAGE_KEY) ?? '' } catch { return '' }
    }
    return ''
  })

  const raw = computed<unknown>(() =>
    isApi
      ? (me.value?.prefs as Record<string, unknown> | undefined)?.[FAVORITES_PREF_KEY]
      : mockRaw.value)

  /** お気に入り一覧（保存順。未設定は空） */
  const favorites = computed<SectionFavorite[]>(() => parseSectionFavorites(raw.value) ?? [])

  async function persistFavorites(list: SectionFavorite[]): Promise<{ ok: boolean }> {
    if (isApi) {
      const res = await saveMePreference(FAVORITES_PREF_KEY, list)
      return { ok: res.ok }
    }
    const json = JSON.stringify(list)
    mockRaw.value = json
    if (import.meta.client) {
      try { localStorage.setItem(FAVORITES_STORAGE_KEY, json) } catch { /* noop */ }
    }
    return { ok: true }
  }

  /** 現在のセクション構成をお気に入りとして保存する（同名は上書き・上限超過はエラー） */
  async function saveFavorite(
    name: string, sections: MenuCategoryDef[],
  ): Promise<{ ok: true; overwritten: boolean } | { ok: false; error: string }> {
    const r = upsertSectionFavorite(favorites.value, { name, sections, savedAt: nowJstIso() })
    if (!r.ok) return r
    const persisted = await persistFavorites(r.list)
    if (!persisted.ok) return { ok: false, error: 'お気に入りの保存に失敗しました' }
    return { ok: true, overwritten: r.overwritten }
  }

  /** お気に入りを削除する（取消フロー = 原則 9.5 は確認ダイアログを呼び出し側で） */
  async function deleteFavorite(id: string): Promise<{ ok: boolean }> {
    return persistFavorites(removeSectionFavorite(favorites.value, id))
  }

  return { favorites, saveFavorite, deleteFavorite }
}
