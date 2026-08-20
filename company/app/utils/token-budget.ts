/**
 * トークン管理の純粋ロジック（FC-06）。
 * composable（useTokenBudget）から分離してユニットテスト可能にする。
 * 消費実績の SoT は活動ログ。ここは集計・予測・正規化の純関数のみ（副作用なし）。
 */
import type { AiActivityLog, AiModelTier } from '~/types/domain'
import { daysInMonth } from '../../../shared/domain/jst'

export interface TokenBudgetSettings {
  /** 月間トークン予算（null = 制限なし） */
  monthlyTokenBudget: number | null
  /** 月間コスト予算 USD（null = 制限なし） */
  monthlyCostBudgetUsd: number | null
  /** アラート閾値（% = 50-100） */
  alertThresholdPct: number
  /** 予算超過時の動作: warn = 警告のみ / block = 新規依頼・承認をブロック */
  overBudgetAction: 'warn' | 'block'
  /** AI 社員別の月間トークン上限（未設定 = 全体予算のみ適用） */
  perEmployeeMonthlyTokens: Record<string, number>
}

export const DEFAULT_TOKEN_BUDGET: TokenBudgetSettings = {
  monthlyTokenBudget: 2_000_000,
  monthlyCostBudgetUsd: 20,
  alertThresholdPct: 80,
  overBudgetAction: 'warn',
  perEmployeeMonthlyTokens: {},
}

/**
 * 保存値を検証して正規化する（欠落キー・不正値があっても壊れない = 原則7）。
 * 予算値（monthlyTokenBudget / monthlyCostBudgetUsd / 社員別上限）の欠落・不正は
 * **既定値ではなく「未設定 = 制限なし」へ落とす**（ユーザーが明示的に空へ変更した状態を
 * 既定予算で勝手に上書きしないための挙動 = R1 #10 で明文化）。閾値・動作のみ既定値へフォールバックする。
 */
export function normalizeTokenBudget(raw: unknown): TokenBudgetSettings {
  const r = (raw ?? {}) as Partial<TokenBudgetSettings>
  const intOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null
  const per: Record<string, number> = {}
  if (r.perEmployeeMonthlyTokens && typeof r.perEmployeeMonthlyTokens === 'object') {
    for (const [k, v] of Object.entries(r.perEmployeeMonthlyTokens)) {
      const n = intOrNull(v)
      if (n !== null) per[k] = n
    }
  }
  return {
    monthlyTokenBudget: intOrNull(r.monthlyTokenBudget),
    monthlyCostBudgetUsd: typeof r.monthlyCostBudgetUsd === 'number' && Number.isFinite(r.monthlyCostBudgetUsd) && r.monthlyCostBudgetUsd > 0
      ? r.monthlyCostBudgetUsd
      : null,
    alertThresholdPct: typeof r.alertThresholdPct === 'number' && r.alertThresholdPct >= 50 && r.alertThresholdPct <= 100
      ? Math.round(r.alertThresholdPct)
      : DEFAULT_TOKEN_BUDGET.alertThresholdPct,
    overBudgetAction: r.overBudgetAction === 'block' ? 'block' : 'warn',
    perEmployeeMonthlyTokens: per,
  }
}

export interface TokenUsageSummary {
  month: string
  totalTokens: number
  totalCostUsd: number
  /** 日別消費（当月 1 日〜今日。ログのない日は 0） */
  byDay: { date: string; tokens: number; costUsd: number }[]
  /** AI 社員別消費（当月。消費降順） */
  byEmployee: { aiEmployeeId: string; name: string; tokens: number; costUsd: number }[]
  /** モデルティア別消費（当月。lite → standard → pro 順） */
  byTier: { tier: AiModelTier; tokens: number; costUsd: number }[]
  /** 月末予測（経過日の日平均 × 月日数の線形予測） */
  forecastTokens: number
  forecastCostUsd: number
}

/** 当月（today の属する月）の消費を集計する。today は 'YYYY-MM-DD'（JST 日付キー） */
export function summarizeTokenUsage(
  logs: AiActivityLog[],
  today: string,
  tierOf: (aiEmployeeId: string) => AiModelTier,
  nameOf: (aiEmployeeId: string) => string,
): TokenUsageSummary {
  const month = today.slice(0, 7)
  const monthLogs = logs.filter(l => l.at.slice(0, 7) === month)

  const dayMap = new Map<string, { tokens: number; costUsd: number }>()
  const empMap = new Map<string, { tokens: number; costUsd: number }>()
  const tierMap = new Map<AiModelTier, { tokens: number; costUsd: number }>()
  let totalTokens = 0
  let totalCostUsd = 0
  for (const l of monthLogs) {
    totalTokens += l.tokens
    totalCostUsd += l.costUsd
    const day = l.at.slice(0, 10)
    const d = dayMap.get(day) ?? { tokens: 0, costUsd: 0 }
    d.tokens += l.tokens
    d.costUsd += l.costUsd
    dayMap.set(day, d)
    const e = empMap.get(l.aiEmployeeId) ?? { tokens: 0, costUsd: 0 }
    e.tokens += l.tokens
    e.costUsd += l.costUsd
    empMap.set(l.aiEmployeeId, e)
    const tier = tierOf(l.aiEmployeeId)
    const t = tierMap.get(tier) ?? { tokens: 0, costUsd: 0 }
    t.tokens += l.tokens
    t.costUsd += l.costUsd
    tierMap.set(tier, t)
  }

  // 当月 1 日〜今日の日別系列（ログのない日は 0 で穴埋め）
  const byDay: TokenUsageSummary['byDay'] = []
  const dayOfMonth = Number(today.slice(8, 10))
  for (let i = 1; i <= dayOfMonth; i++) {
    const date = `${month}-${String(i).padStart(2, '0')}`
    const d = dayMap.get(date)
    byDay.push({ date, tokens: d?.tokens ?? 0, costUsd: d?.costUsd ?? 0 })
  }

  const byEmployee = [...empMap.entries()]
    .map(([aiEmployeeId, v]) => ({ aiEmployeeId, name: nameOf(aiEmployeeId), ...v }))
    .sort((a, b) => b.tokens - a.tokens)

  const tierOrder: AiModelTier[] = ['lite', 'standard', 'pro']
  const byTier = tierOrder
    .filter(t => tierMap.has(t))
    .map(t => ({ tier: t, ...tierMap.get(t)! }))

  // 月末予測: 経過日の日平均 × 月日数（活動が無い月は 0）
  const totalDays = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))
  const forecastTokens = dayOfMonth > 0 ? Math.round((totalTokens / dayOfMonth) * totalDays) : 0
  const forecastCostUsd = dayOfMonth > 0 ? (totalCostUsd / dayOfMonth) * totalDays : 0

  return { month, totalTokens, totalCostUsd, byDay, byEmployee, byTier, forecastTokens, forecastCostUsd }
}
