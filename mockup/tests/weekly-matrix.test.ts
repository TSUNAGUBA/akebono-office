/**
 * 週報マトリクスの週列生成（SoT = app/utils/report-weeks.ts）。
 * 週キー = 週初め（月曜）の日付文字列。列は昇順（右端 = today を含む今週）
 */
import { describe, expect, it } from 'vitest'
import { recentWeekStarts, weekStartOf } from '../app/utils/report-weeks'

describe('weekStartOf（週の開始日 = 月曜始まり）', () => {
  it('月曜はその日自身・火〜土は同週の月曜へ戻す', () => {
    expect(weekStartOf('2026-08-17')).toBe('2026-08-17') // 月
    expect(weekStartOf('2026-08-18')).toBe('2026-08-17') // 火
    expect(weekStartOf('2026-08-20')).toBe('2026-08-17') // 木
    expect(weekStartOf('2026-08-22')).toBe('2026-08-17') // 土
  })

  it('日曜は前週扱い（月曜始まりの週に属する）', () => {
    expect(weekStartOf('2026-08-23')).toBe('2026-08-17') // 日 → 前の月曜
  })

  it('月跨ぎ・年跨ぎも正しく月曜へ戻す', () => {
    expect(weekStartOf('2026-08-01')).toBe('2026-07-27') // 土（前月の月曜へ）
    expect(weekStartOf('2026-01-01')).toBe('2025-12-29') // 木（前年の月曜へ）
  })
})

describe('recentWeekStarts（直近 n 週の週初めリスト）', () => {
  it('n 件・すべて月曜・昇順で、右端が today を含む今週', () => {
    expect(recentWeekStarts('2026-08-20', 4)).toEqual([
      '2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17',
    ])
  })

  it('today が日曜でも右端はその日が属する週（前の月曜）', () => {
    expect(recentWeekStarts('2026-08-23', 2)).toEqual(['2026-08-10', '2026-08-17'])
  })

  it('8 週・12 週も件数どおり・7 日刻みの昇順', () => {
    for (const n of [8, 12]) {
      const weeks = recentWeekStarts('2026-08-20', n)
      expect(weeks).toHaveLength(n)
      for (let i = 1; i < weeks.length; i++) {
        expect(weeks[i]).toBe(weekStartOf(weeks[i]!)) // 各列は月曜
        expect(weeks[i]! > weeks[i - 1]!).toBe(true) // 昇順
      }
      expect(weeks[weeks.length - 1]).toBe('2026-08-17')
    }
  })

  it('年跨ぎ: 1 月上旬から遡ると前年 12 月の週が並ぶ', () => {
    // 2026-01-07 は水曜（週初め = 2026-01-05 月曜）
    expect(recentWeekStarts('2026-01-07', 4)).toEqual([
      '2025-12-15', '2025-12-22', '2025-12-29', '2026-01-05',
    ])
  })
})
