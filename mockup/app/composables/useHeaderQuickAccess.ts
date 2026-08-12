/**
 * ヘッダーのクイックアクセス（ヘッダーカスタマイズ）の解決と保存。
 *
 * 3 階層（ユーザー設定 > 組織〔テナント〕設定 > 既定）を解決する。ユーザー個人設定が優先（オペレーター指示）。
 * 純ロジック（カタログ・パース・解決）は utils/header-quick-access.ts が SoT。
 *
 * 永続化（デュアルモード。useDashboardLayout の流儀を踏襲 = 原則3）:
 *  - ユーザー層: API=/v1/me の prefs.headerQuickAccess（saveMePreference・端末間同期）
 *    / mock=端末ローカル（useState + localStorage 'ako.header-quick-access.v1'・SSR 安全）
 *  - テナント層: configs `header-quick-access`（getConfig/setConfig）
 *
 * 保存値は id 配列（JSON）。新 API ルート/マイグレーションの追加は不要（既存の汎用 key/value を利用）。
 */
import {
  parseQuickAccessIds, resolveQuickAccessIds, type QuickAccessScope,
} from '~/utils/header-quick-access'

/** mock モードの端末ローカル保存キー */
const USER_STORAGE_KEY = 'ako.header-quick-access.v1'
/** API モードの user_preferences キー（/v1/me の prefs 配下） */
const USER_PREF_KEY = 'headerQuickAccess'
/** テナント層の configs キー */
const TENANT_CONFIG_KEY = 'header-quick-access'

export type QuickAccessApplyScope = 'user' | 'tenant'

export function useHeaderQuickAccess() {
  const isApi = useApiMode()
  const me = useApiMe()
  const toast = useToast()
  const { getConfig, setConfig } = useAppSettings()
  const { isAdmin } = useCurrentUser()

  /** mock モードのユーザー層（端末ローカル）。API モードでは参照しない */
  const mockUserRaw = useState<string>('ako-header-quick-access', () => {
    if (!isApi && import.meta.client) {
      try { return localStorage.getItem(USER_STORAGE_KEY) ?? '' } catch { return '' }
    }
    return ''
  })

  const userRaw = computed<unknown>(() =>
    isApi
      ? (me.value?.prefs as Record<string, unknown> | undefined)?.[USER_PREF_KEY]
      : mockUserRaw.value)
  const tenantRaw = computed(() => getConfig(TENANT_CONFIG_KEY, ''))

  const resolved = computed(() => resolveQuickAccessIds(userRaw.value, tenantRaw.value))

  /** 有効なクイックアクセス id 群（ユーザー > テナント > 既定の解決結果） */
  const effectiveIds = computed<string[]>(() => resolved.value.ids)
  /** どの階層が効いているか（表示用） */
  const resolvedScope = computed<QuickAccessScope>(() => resolved.value.scope)
  /** 各層の設定（無ければ null。UI のハイライト・解除可否に使用） */
  const userIds = computed<string[] | null>(() => parseQuickAccessIds(userRaw.value))
  const tenantIds = computed<string[] | null>(() => parseQuickAccessIds(tenantRaw.value))

  /**
   * 指定スコープへ保存する。
   *  - user: 全ユーザーが自分向けに設定可能
   *  - tenant: 管理者のみ（非管理者は警告して no-op = 非ブロッキング）
   */
  async function persist(ids: string[], scope: QuickAccessApplyScope): Promise<{ ok: boolean }> {
    if (scope === 'tenant') {
      if (!isAdmin.value) {
        toast.show('全社設定（組織のクイックアクセス）の変更は管理者のみ可能です', 'warn')
        return { ok: false }
      }
      const res = await setConfig(TENANT_CONFIG_KEY, JSON.stringify(ids))
      return { ok: res?.ok !== false }
    }
    if (isApi) {
      const res = await saveMePreference(USER_PREF_KEY, ids)
      return { ok: res.ok }
    }
    const json = JSON.stringify(ids)
    mockUserRaw.value = json
    if (import.meta.client) {
      try { localStorage.setItem(USER_STORAGE_KEY, json) } catch { /* noop */ }
    }
    return { ok: true }
  }

  /** 該当層の設定を解除する（既定・上位層へ戻す取消フロー = 原則9.5） */
  async function reset(scope: QuickAccessApplyScope): Promise<{ ok: boolean }> {
    if (scope === 'tenant') {
      if (!isAdmin.value) {
        toast.show('全社設定（組織のクイックアクセス）の変更は管理者のみ可能です', 'warn')
        return { ok: false }
      }
      const res = await setConfig(TENANT_CONFIG_KEY, '')
      return { ok: res?.ok !== false }
    }
    if (isApi) {
      const res = await saveMePreference(USER_PREF_KEY, '')
      return { ok: res.ok }
    }
    mockUserRaw.value = ''
    if (import.meta.client) {
      try { localStorage.removeItem(USER_STORAGE_KEY) } catch { /* noop */ }
    }
    return { ok: true }
  }

  return { effectiveIds, resolvedScope, userIds, tenantIds, isAdmin, persist, reset }
}
