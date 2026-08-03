/**
 * ダッシュボード（F-01）のレイアウト（表示・配置）解決と保存（オペレーター指示 2026-08-03）。
 *
 * 2 階層（ユーザー設定 > テナント設定 > デフォルト）を解決し、テンプレート適用・解除を提供する。
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
import type { DashboardLayout, DashboardScope, DashboardTemplate } from '~/utils/dashboard-layout'
import {
  buildCustomLayout, DASHBOARD_TEMPLATES, layoutFromLegacyCategories, materializeLayout,
  parseDashboardLayout, resolveDashboardLayout,
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

  /** ユーザー層の生値（API=me.prefs / mock=端末ローカル） */
  const userRaw = computed<unknown>(() =>
    isApi
      ? (me.value?.prefs as Record<string, unknown> | undefined)?.[USER_PREF_KEY]
      : mockUserLayout.value)

  const tenantRaw = computed(() => getConfig(TENANT_CONFIG_KEY, ''))
  const legacyRaw = computed(() => getConfig(LEGACY_TENANT_CONFIG_KEY, ''))

  const resolved = computed(() => resolveDashboardLayout({
    userRaw: userRaw.value,
    tenantRaw: tenantRaw.value,
    legacyCategoriesRaw: legacyRaw.value,
  }))

  /** 有効レイアウト（ユーザー > テナント > デフォルトの解決結果） */
  const effectiveLayout = computed<DashboardLayout>(() => resolved.value.layout)
  /** どの階層が効いているか（表示用） */
  const resolvedScope = computed<DashboardScope>(() => resolved.value.scope)
  /** 有効レイアウトの由来テンプレート id */
  const activeTemplateId = computed(() => effectiveLayout.value.templateId)

  /** テンプレート一覧（選択 UI 用） */
  const templates: DashboardTemplate[] = DASHBOARD_TEMPLATES

  /** 各層に設定されているレイアウト（無ければ null。UI のハイライト・解除可否に使用） */
  const userLayout = computed<DashboardLayout | null>(() => parseDashboardLayout(userRaw.value))
  const tenantLayout = computed<DashboardLayout | null>(() =>
    parseDashboardLayout(tenantRaw.value) ?? layoutFromLegacyCategories(legacyRaw.value))
  const hasUserLayout = computed(() => userLayout.value !== null)
  const hasTenantLayout = computed(() => tenantLayout.value !== null)

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

  /** テンプレートを materialize して該当層へ保存する。 */
  async function applyTemplate(templateId: string, scope: ApplyScope): Promise<{ ok: boolean }> {
    return persistLayout(materializeLayout(templateId), scope)
  }

  /**
   * セクション構成（どのメニューをどのセクションに置くか）を該当層へ保存する（2026-08-03 #25）。
   * 現行の有効レイアウトの options（通知位置・AKEBONO 表示・密度）を維持したまま sections だけ差し替える。
   * templateId は 'custom'（テンプレート由来ではない手動編集）。保存経路は applyTemplate と同一（原則3）。
   * user>tenant>default の解決は effectiveLayout（resolveDashboardLayout）が引き続き担う（土台は既存）。
   */
  async function saveSections(sections: MenuCategoryDef[], scope: ApplyScope): Promise<{ ok: boolean }> {
    return persistLayout(buildCustomLayout(sections, effectiveLayout.value.options), scope)
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
    activeTemplateId,
    templates,
    userLayout,
    tenantLayout,
    hasUserLayout,
    hasTenantLayout,
    isAdmin,
    applyTemplate,
    saveSections,
    resetLayout,
  }
}
