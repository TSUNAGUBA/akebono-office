/**
 * アプリ設定（外部リンク・機能トグル・エスカレーションルール・汎用設定・デモリセット）
 * - モックモード: 従来どおり useMockDb（同期）
 * - API モード: SoT は /v1/configs（app_configs）。機能トグル・エスカレーションルールは
 *   シード既定値に設定値（configs の 'featureToggles' / 'escalationRules' 配列）を上書きして解決する。
 *   書込は非同期（サーバー反映 → キャッシュ更新）だが、呼び出し側の使い方（戻り値を見ない）は
 *   従来と互換。失敗はトーストで通知する（非ブロッキング）。
 */
import type { Ref } from 'vue'
import type { EscalationRule, FeatureToggle, Result } from '~/types/domain'
import { seedEscalationRules, seedFeatureToggles } from '~/data/seed/core'

// API モードの設定キャッシュ（SPA・モジュールスコープ単一）
const apiConfigs = ref<Record<string, unknown>>({})
let configsLoaded = false
let configsInflight: Promise<void> | null = null

async function loadConfigs(force = false): Promise<void> {
  if (!force && (configsLoaded || configsInflight)) return configsInflight ?? undefined
  configsInflight = apiFetch<Record<string, unknown>>('/v1/configs')
    .then((data) => {
      apiConfigs.value = data
      configsLoaded = true
    })
    .catch(() => { /* 未認証等は既定値のまま（ログイン後の再取得は画面遷移で発火） */ })
    .finally(() => { configsInflight = null })
  return configsInflight
}

function mergeByKey<T extends { key: string }>(defaults: T[], override: unknown): T[] {
  if (!Array.isArray(override)) return defaults
  const map = new Map((override as T[]).filter(o => o && typeof o === 'object' && 'key' in o).map(o => [o.key, o]))
  return defaults.map(d => ({ ...d, ...(map.get(d.key) ?? {}) }))
}

export function useAppSettings() {
  const { tbl, commit, resetDemo } = useMockDb()

  // ---------- API モード ----------
  if (useApiMode()) {
    void loadConfigs()
    const toast = useToast()

    const featureToggles = computed(() =>
      mergeByKey(seedFeatureToggles, apiConfigs.value.featureToggles)) as Ref<FeatureToggle[]>
    const escalationRules = computed(() =>
      mergeByKey(seedEscalationRules, apiConfigs.value.escalationRules)) as Ref<EscalationRule[]>

    function getConfig(key: string, fallback = ''): string {
      const v = apiConfigs.value[key]
      return typeof v === 'string' ? v : fallback
    }

    async function putConfig(key: string, value: unknown): Promise<Result> {
      const res = await apiResult(() => apiFetch(`/v1/configs/${key}`, { method: 'PUT', body: { value } }))
      if (res.ok) {
        apiConfigs.value = { ...apiConfigs.value, [key]: value }
      } else {
        toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
      }
      return res
    }

    return {
      featureToggles,
      escalationRules,
      isEnabled: (key: string) => featureToggles.value.find(t => t.key === key)?.enabled ?? true,
      setToggle: (key: string, enabled: boolean) =>
        putConfig('featureToggles', featureToggles.value.map(t => t.key === key ? { ...t, enabled } : t)),
      updateEscalationRule: (key: string, patch: { enabled?: boolean; threshold?: number | null; cooldownDays?: number }) =>
        putConfig('escalationRules', escalationRules.value.map(r => r.key === key ? { ...r, ...patch } : r)),
      getConfig,
      setConfig: (key: string, value: string) => putConfig(key, value),
      resetDemo, // モックコレクション（未移行分）のみ初期化。API データには影響しない
      reloadConfigs: () => loadConfigs(true),
    }
  }

  // ---------- モックモード（従来どおり同期） ----------
  const featureToggles = tbl('featureToggles')
  const escalationRules = tbl('escalationRules')
  const appConfigs = tbl('appConfigs')

  /** 汎用設定の取得（例: reportInputMode） */
  function getConfig(key: string, fallback = ''): string {
    return appConfigs.value.find(c => c.key === key)?.value ?? fallback
  }

  /** 汎用設定の upsert */
  function setConfig(key: string, value: string): Result {
    if (appConfigs.value.some(c => c.key === key)) {
      appConfigs.value = appConfigs.value.map(c => c.key === key ? { ...c, value } : c)
    } else {
      appConfigs.value = [...appConfigs.value, { key, value }]
    }
    commit()
    return { ok: true }
  }

  function isEnabled(key: string): boolean {
    return featureToggles.value.find(t => t.key === key)?.enabled ?? true
  }

  function setToggle(key: string, enabled: boolean): Result {
    featureToggles.value = featureToggles.value.map(t => t.key === key ? { ...t, enabled } : t)
    commit()
    return { ok: true }
  }

  function updateEscalationRule(key: string, patch: { enabled?: boolean; threshold?: number | null; cooldownDays?: number }): Result {
    escalationRules.value = escalationRules.value.map(r => r.key === key ? { ...r, ...patch } : r)
    commit()
    return { ok: true }
  }

  return {
    featureToggles, escalationRules, isEnabled, setToggle, updateEscalationRule, getConfig, setConfig, resetDemo,
    reloadConfigs: async () => { /* モックモードでは不要 */ },
  }
}
