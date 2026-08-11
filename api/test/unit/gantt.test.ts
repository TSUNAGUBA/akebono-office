import { describe, expect, it } from 'vitest'
import { weekdayOf } from '../../../shared/domain/jst'
import {
  addMonths, ganttAnchorForToday, ganttBar, ganttColumns, ganttStep, mondayOf,
} from '../../../shared/domain/gantt'
import { improvementPlanError } from '../../../shared/domain/improvement'

describe('addMonths / mondayOf', () => {
  it('月加算は年跨ぎ・月末丸め', () => {
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28') // 2026 は非閏 → 28 で丸め
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
  })
  it('mondayOf は常に月曜（getDay=1）を返す', () => {
    for (const d of ['2026-03-01', '2026-03-04', '2026-03-08', '2026-07-20']) {
      expect(weekdayOf(mondayOf(d))).toBe(1)
    }
  })
})

describe('ganttColumns', () => {
  it('月次は 12 列・先頭がアンカー月・today 列を判定', () => {
    const cols = ganttColumns('month', '2026-03-15', '2026-05-10')
    expect(cols).toHaveLength(12)
    expect(cols[0]).toMatchObject({ key: '2026-03', label: '3月', startKey: '2026-03-01', endKey: '2026-03-31' })
    expect(cols[11]!.key).toBe('2027-02')
    expect(cols.findIndex(c => c.isToday)).toBe(2) // 2026-05
  })
  it('週次は 13 列・月曜始まり・各列 7 日', () => {
    const cols = ganttColumns('week', '2026-03-04', '2026-03-04')
    expect(cols).toHaveLength(13)
    expect(weekdayOf(cols[0]!.startKey)).toBe(1)
    expect(cols[0]!.endKey).toBe(addDaysLocal(cols[0]!.startKey, 6))
    expect(cols[1]!.startKey).toBe(addDaysLocal(cols[0]!.startKey, 7))
  })
  it('日次はその月の日数ぶん（2026-02 = 28 日）', () => {
    const cols = ganttColumns('day', '2026-02-10', '2026-02-10')
    expect(cols).toHaveLength(28)
    expect(cols[9]).toMatchObject({ key: '2026-02-10', label: '10', isToday: true })
  })
})

// テスト内ローカルの日加算（純検証用）
function addDaysLocal(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

describe('ganttBar', () => {
  const cols = ganttColumns('month', '2026-03-01', '2026-03-01') // 2026-03 .. 2027-02
  it('範囲内は列インデックスへ写像', () => {
    expect(ganttBar('2026-04-10', '2026-06-20', cols)).toEqual({ startIdx: 1, endIdx: 3 })
  })
  it('終了未設定は単日バー', () => {
    expect(ganttBar('2026-03-05', null, cols)).toEqual({ startIdx: 0, endIdx: 0 })
  })
  it('可視範囲外は null', () => {
    expect(ganttBar('2028-01-01', null, cols)).toBeNull()
    expect(ganttBar('2025-01-01', '2025-02-01', cols)).toBeNull()
  })
  it('可視範囲へクランプ（開始が範囲前）', () => {
    expect(ganttBar('2026-01-01', '2026-04-15', cols)).toEqual({ startIdx: 0, endIdx: 1 })
  })
  it('開始のみ設定は null を返さない（planStart 必須）', () => {
    expect(ganttBar(null, '2026-04-01', cols)).toBeNull()
  })
})

describe('ganttStep / ganttAnchorForToday', () => {
  it('前後の期間送り（month=±12か月 / week=±13週 / day=±1か月）', () => {
    expect(ganttStep('month', '2026-03-10', 1)).toBe('2027-03-01')
    expect(ganttStep('month', '2026-03-10', -1)).toBe('2025-03-01')
    expect(ganttStep('day', '2026-03-10', 1)).toBe('2026-04-01')
    expect(ganttStep('week', '2026-03-02', 1)).toBe('2026-06-01') // 月曜 03-02 + 91 日 = 06-01
  })
  it('今へのスナップ（month/day = 月初・week = 月曜）', () => {
    expect(ganttAnchorForToday('month', '2026-07-20')).toBe('2026-07-01')
    expect(ganttAnchorForToday('day', '2026-07-20')).toBe('2026-07-01')
    expect(weekdayOf(ganttAnchorForToday('week', '2026-07-20'))).toBe(1)
  })
})

describe('improvementPlanError', () => {
  it('未設定は許容（任意）', () => {
    expect(improvementPlanError('', '')).toBeNull()
    expect(improvementPlanError('2026-03-01', '')).toBeNull() // 単日
    expect(improvementPlanError('2026-03-01', '2026-03-10')).toBeNull()
  })
  it('不正日・逆転・終了のみはエラー', () => {
    expect(improvementPlanError('2026-13-40', '')).toBeTruthy()
    expect(improvementPlanError('2026-03-10', '2026-03-01')).toBeTruthy()
    expect(improvementPlanError('', '2026-03-01')).toBeTruthy()
  })
})
