/** 会計年度の純粋関数（shared/domain/fiscal。フロント/API 共有）の単体テスト */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FISCAL_START_MONTH, fiscalMonthNoOf, fiscalMonthsOf, fiscalQuarterOf, fiscalYearOf,
} from '../../../shared/domain/fiscal'

describe('fiscalYearOf', () => {
  it('4 月始まり: 開始月以降は当年・開始月前は前年', () => {
    expect(fiscalYearOf('2026-04', 4)).toBe(2026)
    expect(fiscalYearOf('2026-12', 4)).toBe(2026)
    expect(fiscalYearOf('2027-03', 4)).toBe(2026)
    expect(fiscalYearOf('2026-03', 4)).toBe(2025)
  })
  it('1 月始まり: 暦年と一致', () => {
    expect(fiscalYearOf('2026-01', 1)).toBe(2026)
    expect(fiscalYearOf('2026-12', 1)).toBe(2026)
  })
  it('10 月始まり（年跨ぎの境界）', () => {
    expect(fiscalYearOf('2026-09', 10)).toBe(2025)
    expect(fiscalYearOf('2026-10', 10)).toBe(2026)
  })
})

describe('fiscalMonthsOf', () => {
  it('4 月始まりは 4 月〜翌 3 月の 12 ヶ月', () => {
    const months = fiscalMonthsOf(2026, 4)
    expect(months).toHaveLength(12)
    expect(months[0]).toBe('2026-04')
    expect(months[8]).toBe('2026-12')
    expect(months[9]).toBe('2027-01')
    expect(months[11]).toBe('2027-03')
  })
  it('1 月始まりは同一暦年の 12 ヶ月', () => {
    const months = fiscalMonthsOf(2026, 1)
    expect(months[0]).toBe('2026-01')
    expect(months[11]).toBe('2026-12')
  })
  it('fiscalYearOf と整合する（全開始月）', () => {
    for (let fsm = 1; fsm <= 12; fsm++) {
      for (const m of fiscalMonthsOf(2026, fsm)) {
        expect(fiscalYearOf(m, fsm), `fsm=${fsm} m=${m}`).toBe(2026)
      }
    }
  })
})

describe('fiscalMonthNoOf / fiscalQuarterOf', () => {
  it('開始月 = 1・期末月 = 12', () => {
    expect(fiscalMonthNoOf('2026-04', 4)).toBe(1)
    expect(fiscalMonthNoOf('2027-03', 4)).toBe(12)
    expect(fiscalMonthNoOf('2026-01', 1)).toBe(1)
  })
  it('四半期は 3 ヶ月区切り（4 月始まり: Q1=4-6 / Q4=1-3）', () => {
    expect(fiscalQuarterOf('2026-04', 4)).toBe(1)
    expect(fiscalQuarterOf('2026-06', 4)).toBe(1)
    expect(fiscalQuarterOf('2026-07', 4)).toBe(2)
    expect(fiscalQuarterOf('2027-01', 4)).toBe(4)
    expect(fiscalQuarterOf('2027-03', 4)).toBe(4)
  })
  it('既定の開始月は 4 月', () => {
    expect(DEFAULT_FISCAL_START_MONTH).toBe(4)
  })
})
