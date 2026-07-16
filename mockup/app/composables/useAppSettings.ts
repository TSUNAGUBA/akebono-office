/** アプリ設定（外部リンク・機能トグル・エスカレーションルール・汎用設定・デモリセット） */
import type { Result } from '~/types/domain'

export function useAppSettings() {
  const { tbl, commit, resetDemo } = useMockDb()
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

  return { featureToggles, escalationRules, isEnabled, setToggle, updateEscalationRule, getConfig, setConfig, resetDemo }
}
