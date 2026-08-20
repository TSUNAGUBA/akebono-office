/**
 * ガントチャートの純関数（shared/domain/gantt）。列生成・バー配置・期間ナビの決定性を検証。
 */
import { describe, expect, it } from 'vitest'
import { weekdayOf } from '../../shared/domain/jst'
import {
  ganttAnchorForToday, ganttBar, ganttColumns, ganttRangeLabel, ganttStep,
} from '../../shared/domain/gantt'

describe('ganttColumns', () => {
  it('月次12列 / 週次13列（月曜） / 日次はその月の日数', () => {
    expect(ganttColumns('month', '2026-03-15', '2026-05-10')).toHaveLength(12)
    const wk = ganttColumns('week', '2026-03-04', '2026-03-04')
    expect(wk).toHaveLength(13)
    expect(weekdayOf(wk[0]!.startKey)).toBe(1)
    expect(ganttColumns('day', '2026-02-10', '2026-02-10')).toHaveLength(28) // 2026-02 = 28 日
  })
  it('today 列を判定', () => {
    const cols = ganttColumns('month', '2026-03-01', '2026-05-10')
    expect(cols.findIndex(c => c.isToday)).toBe(2)
  })
})

describe('ganttBar', () => {
  const cols = ganttColumns('month', '2026-03-01', '2026-03-01')
  it('範囲内→列index・単日・範囲外→null・クランプ', () => {
    expect(ganttBar('2026-04-10', '2026-06-20', cols)).toEqual({ startIdx: 1, endIdx: 3 })
    expect(ganttBar('2026-03-05', null, cols)).toEqual({ startIdx: 0, endIdx: 0 })
    expect(ganttBar('2028-01-01', null, cols)).toBeNull()
    expect(ganttBar('2026-01-01', '2026-04-15', cols)).toEqual({ startIdx: 0, endIdx: 1 })
  })
})

describe('ganttStep / ganttAnchorForToday / ganttRangeLabel', () => {
  it('期間送りと今スナップ', () => {
    expect(ganttStep('month', '2026-03-10', 1)).toBe('2027-03-01')
    expect(ganttStep('day', '2026-03-10', -1)).toBe('2026-02-01')
    expect(ganttAnchorForToday('month', '2026-07-20')).toBe('2026-07-01')
  })
  it('表示範囲ラベル', () => {
    const cols = ganttColumns('month', '2026-03-01', '2026-03-01')
    expect(ganttRangeLabel(cols)).toBe('2026年3月 〜 2027年2月')
  })
})
