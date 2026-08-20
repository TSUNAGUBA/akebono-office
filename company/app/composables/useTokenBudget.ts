/**
 * トークン管理（FC-06）: 消費の可視化・月末予測・予算・抑制/制限。
 * 集計・正規化の純粋ロジックは ~/utils/token-budget.ts（テスト対象）。
 *
 * 【モック境界の宣言】
 * - 消費実績の SoT は活動ログ（/v1/ai-company/logs または モック DB）の tokens/costUsd。
 *   現時点の値は決定的モック値（shared/domain/ai-tasks.mockActivityCost）であり、
 *   LLM 実測値の記録は共通 API の本実装対象（phase3/company-intelligence-requirements.md §5）。
 * - 予算・制限設定の SoT はフロントエンド（localStorage）。端末間同期されない。
 *   共通 API 本実装時にサーバー側の予算テーブル + 受付制御へ移行する。
 * - 超過時のブロックは UI 層のガード（依頼・承認の入口で判定）。API モードでも
 *   クライアント側の抑止であり、サーバー側の強制ではない（画面に明示）。
 *
 * 設定は編集で上書き・既定値へリセット可能（取消可能性 = 原則9.5）。
 */
import {
  DEFAULT_TOKEN_BUDGET, normalizeTokenBudget, summarizeTokenUsage,
  type TokenBudgetSettings, type TokenUsageSummary,
} from '~/utils/token-budget'

const STORAGE_KEY = 'akc.tokenBudget.v1'

function loadSettings(): TokenBudgetSettings {
  if (import.meta.client) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) return normalizeTokenBudget(JSON.parse(raw))
    } catch { /* 壊れた保存値は既定値で復旧（非ブロッキング） */ }
  }
  return { ...DEFAULT_TOKEN_BUDGET, perEmployeeMonthlyTokens: {} }
}

// SPA（ssr:false）専用: モジュールスコープ単一の設定状態
const settings = ref<TokenBudgetSettings>(loadSettings())

export type BudgetState = 'ok' | 'warn' | 'over'

export function useTokenBudget() {
  const { employeesAll, roleOf, logs } = useAiCompany()

  /** 設定を保存する（上書き = 取消可能。保存失敗時は false） */
  function saveSettings(next: TokenBudgetSettings): boolean {
    settings.value = normalizeTokenBudget(next)
    if (!import.meta.client) return true
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.value))
      return true
    } catch {
      return false
    }
  }

  /** 既定値へ戻す（原則9.5 の取消フロー） */
  function resetSettings(): void {
    settings.value = { ...DEFAULT_TOKEN_BUDGET, perEmployeeMonthlyTokens: {} }
    if (import.meta.client) {
      try { localStorage.removeItem(STORAGE_KEY) } catch { /* noop */ }
    }
  }

  /** 当月の消費集計（SoT = 活動ログ。ここは派生キャッシュ） */
  const usage = computed<TokenUsageSummary>(() => summarizeTokenUsage(
    logs.value,
    todayJst(),
    (empId) => {
      const emp = employeesAll.value.find(e => e.id === empId)
      return roleOf(emp)?.modelTier ?? 'standard'
    },
    empId => employeesAll.value.find(e => e.id === empId)?.name ?? empId,
  ))

  /** 予算の消化率（% 整数。予算未設定は null） */
  const tokenBudgetPct = computed<number | null>(() => {
    const budget = settings.value.monthlyTokenBudget
    if (!budget) return null
    return Math.round((usage.value.totalTokens / budget) * 100)
  })

  const costBudgetPct = computed<number | null>(() => {
    const budget = settings.value.monthlyCostBudgetUsd
    if (!budget) return null
    return Math.round((usage.value.totalCostUsd / budget) * 100)
  })

  /** 予算状態（トークン・コストのうち進んでいる方で判定） */
  const budgetState = computed<BudgetState>(() => {
    const pct = Math.max(tokenBudgetPct.value ?? 0, costBudgetPct.value ?? 0)
    if (pct >= 100) return 'over'
    if (pct >= settings.value.alertThresholdPct) return 'warn'
    return 'ok'
  })

  /** AI 社員別の当月消費と上限超過判定 */
  function employeeUsage(aiEmployeeId: string): { tokens: number; cap: number | null; over: boolean } {
    const tokens = usage.value.byEmployee.find(e => e.aiEmployeeId === aiEmployeeId)?.tokens ?? 0
    const cap = settings.value.perEmployeeMonthlyTokens[aiEmployeeId] ?? null
    return { tokens, cap, over: cap !== null && tokens >= cap }
  }

  /**
   * 新規依頼・承認の入口ガード（抑制・制限）。
   * - overBudgetAction='block' かつ 全体予算 100% 以上 → ブロック（AKC-TOK-001）
   * - overBudgetAction='block' かつ 対象 AI 社員の上限超過 → ブロック（AKC-TOK-002）
   * - それ以外は許可（warn 状態は呼び出し側がバナー・トーストで警告）
   * ※ UI 層の抑止（モック）。サーバー側の強制は共通 API 本実装時に移行する。
   */
  function guardSpend(aiEmployeeId?: string): { ok: true } | { ok: false; error: { code: string; message: string } } {
    if (settings.value.overBudgetAction !== 'block') return { ok: true }
    if (budgetState.value === 'over') {
      return {
        ok: false,
        error: { code: 'AKC-TOK-001', message: '月間予算を超過しているため新規の依頼・承認をブロックしています（トークン管理で予算・動作を変更できます）' },
      }
    }
    if (aiEmployeeId && employeeUsage(aiEmployeeId).over) {
      return {
        ok: false,
        error: { code: 'AKC-TOK-002', message: 'この AI 社員の月間トークン上限を超過しています（トークン管理で上限を変更できます）' },
      }
    }
    return { ok: true }
  }

  return {
    settings: computed(() => settings.value),
    saveSettings,
    resetSettings,
    usage,
    tokenBudgetPct,
    costBudgetPct,
    budgetState,
    employeeUsage,
    guardSpend,
  }
}
