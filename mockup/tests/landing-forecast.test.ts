/**
 * 着地予報エンジン（shared/domain/landing-forecast）の回帰テスト。
 * cockpit-design §2.3 の指定ケース: 月初 elapsed=0 / 全営業日経過 / inverse(残業) / rate / 0 target のゼロ除算
 */
import { describe, expect, it } from 'vitest'
import {
  buildForecast, summarizeForecasts, type ForecastInput,
} from '../../shared/domain/landing-forecast'

function input(over: Partial<ForecastInput> = {}): ForecastInput {
  return {
    id: 'seg-01-sales',
    label: '陶磁器委託販売の売上',
    kind: 'amount',
    current: 100_000,
    target: 220_000,
    unit: 'currency',
    elapsedWorkingDays: 10,
    totalWorkingDays: 22,
    ...over,
  }
}

describe('buildForecast', () => {
  it('決定的（同入力 → 同出力）・日割り外挿の着地予測', () => {
    const i = input()
    expect(buildForecast(i)).toEqual(buildForecast(i))
    const r = buildForecast(i)
    expect(r.projected).toBe(220_000) // 100,000 / 10 * 22
    expect(r.achieved).toBe(true)
    expect(r.tone).toBe('ok')
    expect(r.progressRatio).toBeCloseTo(100_000 / 220_000)
    expect(r.projectedRatio).toBeCloseTo(1)
    expect(r.reason).toContain('残り 12 営業日')
    expect(r.reason).toContain('日割りペース')
  })

  it('月初（elapsed=0）は外挿せず current をそのまま着地見込みにする', () => {
    const r = buildForecast(input({ current: 0, elapsedWorkingDays: 0 }))
    expect(r.projected).toBe(0)
    expect(r.tone).toBe('warn')
    expect(Number.isFinite(r.projected)).toBe(true) // 0 除算で NaN/Infinity にしない
    const withCarry = buildForecast(input({ current: 30_000, elapsedWorkingDays: 0, target: 30_000 }))
    expect(withCarry.projected).toBe(30_000)
    expect(withCarry.tone).toBe('ok')
  })

  it('全営業日経過（elapsed=total）は実績 = 着地', () => {
    const r = buildForecast(input({ current: 200_000, elapsedWorkingDays: 22, totalWorkingDays: 22 }))
    expect(r.projected).toBe(200_000)
    expect(r.achieved).toBe(false) // 220,000 に未達
    expect(r.tone).toBe('warn')
    expect(r.reason).toContain('残り 0 営業日')
  })

  it('inverse（残業などの上限型）は予測 >= 上限で warn・以下なら ok', () => {
    const over = buildForecast(input({
      id: 'my-overtime', label: '自分の残業', kind: 'amount', unit: 'hours',
      current: 20, target: 36, inverse: true, elapsedWorkingDays: 10, totalWorkingDays: 22,
    }))
    expect(over.projected).toBeCloseTo(44)
    expect(over.achieved).toBe(false)
    expect(over.tone).toBe('warn')
    const under = buildForecast(input({
      id: 'my-overtime', label: '自分の残業', kind: 'amount', unit: 'hours',
      current: 10, target: 36, inverse: true, elapsedWorkingDays: 10, totalWorkingDays: 22,
    }))
    expect(under.projected).toBe(22)
    expect(under.achieved).toBe(true)
    expect(under.tone).toBe('ok')
  })

  it('rate は外挿しない（現在値 = 着地見込み。根拠に明示）', () => {
    const r = buildForecast(input({
      id: 'report-rate', label: '日報提出率', kind: 'rate', unit: 'percent',
      current: 85, target: 90, elapsedWorkingDays: 10, totalWorkingDays: 22,
    }))
    expect(r.projected).toBe(85) // 85 / 10 * 22 に外挿しない
    expect(r.achieved).toBe(false)
    expect(r.tone).toBe('warn')
    expect(r.reason).toContain('外挿せず')
  })

  it('target=0 のゼロ除算: 比率は 0・達成判定は成立する（NaN を出さない）', () => {
    const r = buildForecast(input({ current: 50_000, target: 0 }))
    expect(r.progressRatio).toBe(0)
    expect(r.projectedRatio).toBe(0)
    expect(r.achieved).toBe(true) // 予測 >= 0
    const inv = buildForecast(input({ current: 1, target: 0, inverse: true }))
    expect(inv.achieved).toBe(false) // 上限 0 を超過
    expect(inv.tone).toBe('warn')
    expect(Number.isNaN(inv.progressRatio)).toBe(false)
  })

  it('進捗バー用の比率はクランプしない（超過は 1 を超える値のまま返す）', () => {
    const r = buildForecast(input({ current: 300_000, target: 220_000, elapsedWorkingDays: 22, totalWorkingDays: 22 }))
    expect(r.progressRatio).toBeGreaterThan(1)
  })
})

describe('summarizeForecasts', () => {
  it('warn が 1 本もない日は「順調」1 行（見なくていい日を明示）', () => {
    const ok = buildForecast(input())
    expect(summarizeForecasts([ok, ok])).toEqual({ headline: '今週の見通し: 順調', tone: 'ok', warnCount: 0 })
  })

  it('warn があれば「針路修正 N 件」', () => {
    const ok = buildForecast(input())
    const warn = buildForecast(input({ current: 10_000 }))
    expect(summarizeForecasts([ok, warn, warn])).toEqual({ headline: '針路修正 2 件', tone: 'warn', warnCount: 2 })
  })

  it('空配列は順調扱い（目標未設定のフォールバック表示は呼び出し側の責務）', () => {
    expect(summarizeForecasts([]).tone).toBe('ok')
  })
})
