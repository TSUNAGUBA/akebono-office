import { describe, expect, it } from 'vitest'
import type { AiActivityLog } from '../app/types/domain'
import {
  DEFAULT_TOKEN_BUDGET, normalizeTokenBudget, summarizeTokenUsage,
} from '../app/utils/token-budget'

function log(partial: Partial<AiActivityLog> & { id: string }): AiActivityLog {
  return {
    aiEmployeeId: 'ai-01',
    taskId: null,
    at: '2026-08-10T10:00:00+09:00',
    kind: 'execute',
    summary: '',
    tokens: 1000,
    costUsd: 0.001,
    ...partial,
  }
}

describe('normalizeTokenBudget', () => {
  it('空値・不正値は既定値/未設定へ正規化する（原則7: 壊れた保存値でも動く）', () => {
    const s = normalizeTokenBudget({})
    expect(s.monthlyTokenBudget).toBeNull()
    expect(s.monthlyCostBudgetUsd).toBeNull()
    expect(s.alertThresholdPct).toBe(DEFAULT_TOKEN_BUDGET.alertThresholdPct)
    expect(s.overBudgetAction).toBe('warn')
    expect(s.perEmployeeMonthlyTokens).toEqual({})
  })

  it('不正な値域（負数・NaN・閾値範囲外・未知 action）を受け付けない', () => {
    const s = normalizeTokenBudget({
      monthlyTokenBudget: -5,
      monthlyCostBudgetUsd: Number.NaN,
      alertThresholdPct: 30,
      overBudgetAction: 'destroy',
      perEmployeeMonthlyTokens: { 'ai-01': 0, 'ai-02': 500.9, 'ai-03': 'x' },
    })
    expect(s.monthlyTokenBudget).toBeNull()
    expect(s.monthlyCostBudgetUsd).toBeNull()
    expect(s.alertThresholdPct).toBe(80)
    expect(s.overBudgetAction).toBe('warn')
    expect(s.perEmployeeMonthlyTokens).toEqual({ 'ai-02': 500 })
  })

  it('正しい値はそのまま保持する（小数トークンは切り捨て）', () => {
    const s = normalizeTokenBudget({
      monthlyTokenBudget: 1_500_000.7,
      monthlyCostBudgetUsd: 12.5,
      alertThresholdPct: 90,
      overBudgetAction: 'block',
      perEmployeeMonthlyTokens: { 'ai-01': 100_000 },
    })
    expect(s.monthlyTokenBudget).toBe(1_500_000)
    expect(s.monthlyCostBudgetUsd).toBe(12.5)
    expect(s.alertThresholdPct).toBe(90)
    expect(s.overBudgetAction).toBe('block')
    expect(s.perEmployeeMonthlyTokens).toEqual({ 'ai-01': 100_000 })
  })
})

describe('summarizeTokenUsage', () => {
  const tierOf = (id: string) => (id === 'ai-03' ? 'pro' as const : 'standard' as const)
  const nameOf = (id: string) => ({ 'ai-01': 'アキ', 'ai-03': 'ソラ' }[id] ?? id)

  it('当月ログのみ集計し、前月・翌月分は除外する', () => {
    const logs = [
      log({ id: 'a', at: '2026-08-01T09:00:00+09:00', tokens: 100, costUsd: 0.1 }),
      log({ id: 'b', at: '2026-08-02T09:00:00+09:00', tokens: 200, costUsd: 0.2 }),
      log({ id: 'c', at: '2026-07-31T09:00:00+09:00', tokens: 999, costUsd: 9 }),
    ]
    const u = summarizeTokenUsage(logs, '2026-08-02', tierOf, nameOf)
    expect(u.month).toBe('2026-08')
    expect(u.totalTokens).toBe(300)
    expect(u.totalCostUsd).toBeCloseTo(0.3)
  })

  it('日別系列は 1 日から今日まで穴埋めされる', () => {
    const logs = [log({ id: 'a', at: '2026-08-03T09:00:00+09:00', tokens: 500 })]
    const u = summarizeTokenUsage(logs, '2026-08-05', tierOf, nameOf)
    expect(u.byDay).toHaveLength(5)
    expect(u.byDay[0]).toEqual({ date: '2026-08-01', tokens: 0, costUsd: 0 })
    expect(u.byDay[2]!.tokens).toBe(500)
    expect(u.byDay[4]!.tokens).toBe(0)
  })

  it('AI 社員別は消費降順・ティア別は lite→standard→pro 順で返す', () => {
    const logs = [
      log({ id: 'a', aiEmployeeId: 'ai-01', tokens: 100 }),
      log({ id: 'b', aiEmployeeId: 'ai-03', tokens: 300 }),
      log({ id: 'c', aiEmployeeId: 'ai-01', tokens: 50 }),
    ]
    const u = summarizeTokenUsage(logs, '2026-08-10', tierOf, nameOf)
    expect(u.byEmployee.map(e => e.aiEmployeeId)).toEqual(['ai-03', 'ai-01'])
    expect(u.byEmployee[0]!.name).toBe('ソラ')
    expect(u.byTier.map(t => t.tier)).toEqual(['standard', 'pro'])
    expect(u.byTier.find(t => t.tier === 'pro')!.tokens).toBe(300)
  })

  it('月末予測は経過日の日平均 × 月日数（2026-08 は 31 日）', () => {
    const logs = [
      log({ id: 'a', at: '2026-08-01T09:00:00+09:00', tokens: 100, costUsd: 0.31 }),
      log({ id: 'b', at: '2026-08-02T09:00:00+09:00', tokens: 100, costUsd: 0.31 }),
    ]
    const u = summarizeTokenUsage(logs, '2026-08-02', tierOf, nameOf)
    expect(u.forecastTokens).toBe(Math.round((200 / 2) * 31))
    expect(u.forecastCostUsd).toBeCloseTo((0.62 / 2) * 31)
  })

  it('活動が無い月は合計・予測ともに 0', () => {
    const u = summarizeTokenUsage([], '2026-08-10', tierOf, nameOf)
    expect(u.totalTokens).toBe(0)
    expect(u.forecastTokens).toBe(0)
    expect(u.byEmployee).toEqual([])
    expect(u.byTier).toEqual([])
  })
})
