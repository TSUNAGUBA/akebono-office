/** 周期有給付与の候補列挙（労基法 39 条テーブル・時効・比例付与）の単体テスト */
import { describe, expect, it } from 'vitest'
import { periodicGrantsFor } from '../../src/domain/periodic-grant'

describe('periodicGrantsFor', () => {
  it('入社 + 6 ヶ月 + n 年の付与日を今日まで列挙し、時効切れは除外する', () => {
    // 2023-10-01 入社 → 付与日 2024-04-01(10 日・2026-04-01 失効 = 除外) /
    //                    2025-04-01(11 日) / 2026-04-01(12 日)
    const rows = periodicGrantsFor(
      { id: 'm-1', hireDate: '2023-10-01', weeklyDays: 5, weeklyHours: 40 }, '2026-07-17')
    expect(rows.map(r => [r.grantDate, r.days])).toEqual([
      ['2025-04-01', 11],
      ['2026-04-01', 12],
    ])
    expect(rows.every(r => r.kind === 'normal')).toBe(true)
    expect(rows[0]?.expireDate).toBe('2027-04-01')
  })

  it('週 4 日・週 30h 未満は比例付与テーブル', () => {
    const rows = periodicGrantsFor(
      { id: 'm-2', hireDate: '2025-10-01', weeklyDays: 4, weeklyHours: 24 }, '2026-07-17')
    expect(rows).toEqual([{
      memberId: 'm-2', grantDate: '2026-04-01', days: 7, kind: 'proportional', expireDate: '2028-04-01',
    }])
  })

  it('入社日なし・勤続 6 ヶ月未満は付与なし', () => {
    expect(periodicGrantsFor({ id: 'm-3', hireDate: null, weeklyDays: 5, weeklyHours: 40 }, '2026-07-17')).toEqual([])
    expect(periodicGrantsFor({ id: 'm-4', hireDate: '2026-03-01', weeklyDays: 5, weeklyHours: 40 }, '2026-07-17')).toEqual([])
  })
})
