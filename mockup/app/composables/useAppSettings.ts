/** アプリ設定（外部リンク・機能トグル・エスカレーションルール・デモリセット） */
import type { Result } from '~/types/domain'

export function useAppSettings() {
  const { tbl, commit, resetDemo } = useMockDb()
  const featureToggles = tbl('featureToggles')
  const escalationRules = tbl('escalationRules')

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

  return { featureToggles, escalationRules, isEnabled, setToggle, updateEscalationRule, resetDemo }
}
