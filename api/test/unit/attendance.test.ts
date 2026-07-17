/** 打刻状態機械・ルール解決・月次集計（60h 超繰越）の単体テスト */
import { describe, expect, it } from 'vitest'
import type { AttendanceRule, PunchRecord } from '../../../shared/domain/types'
import { daySummary, monthSummary, PUNCH_ALLOWED, punchState, resolveRule } from '../../src/domain/attendance'

function punch(over: Partial<PunchRecord>): PunchRecord {
  return {
    id: `p-${over.kind}-${over.at}`, memberId: 'm-01', date: '2026-07-01', kind: 'in',
    at: '2026-07-01T09:00:00+09:00', source: 'web', fixedFrom: null, fixReason: null, approvedBy: null, ...over,
  }
}

const rule: AttendanceRule = {
  id: 'ar-standard', name: '標準', appliesTo: ['employee'], defaultFor: ['employee'],
  workStart: '09:00', workEnd: '18:00', breakMinutes: 60, flex: null,
  closingDay: 31, legalHolidayWeekday: 0, active: true,
}

describe('punchState / PUNCH_ALLOWED', () => {
  it('未出勤 → in のみ許可', () => {
    expect(punchState([])).toBe('before')
    expect(PUNCH_ALLOWED.before).toEqual(['in'])
  })
  it('勤務中 → 休憩開始/退勤、休憩中 → 休憩終了、退勤済 → 何もできない', () => {
    const inP = punch({ kind: 'in' })
    expect(punchState([inP])).toBe('working')
    expect(punchState([inP, punch({ kind: 'break_start', at: '2026-07-01T12:00:00+09:00' })])).toBe('breaking')
    expect(punchState([inP, punch({ kind: 'out', at: '2026-07-01T18:00:00+09:00' })])).toBe('done')
  })
})

describe('resolveRule', () => {
  const flex: AttendanceRule = { ...rule, id: 'ar-flex', defaultFor: [], appliesTo: ['employee'] }
  it('個別指定 > 既定 > 選択可能 > 先頭 の優先順', () => {
    expect(resolveRule({ attendanceRuleId: 'ar-flex', employmentType: 'employee' }, [rule, flex])?.id).toBe('ar-flex')
    expect(resolveRule({ attendanceRuleId: null, employmentType: 'employee' }, [flex, rule])?.id).toBe('ar-standard')
    expect(resolveRule(undefined, [flex, rule])?.id).toBe('ar-flex')
  })
})

describe('daySummary / monthSummary', () => {
  it('9-19 時勤務（休憩 1h）は所定 480 + 法定内 0 + 法定外 60 分', () => {
    const s = daySummary([
      punch({ kind: 'in', at: '2026-07-01T09:00:00+09:00' }),
      punch({ kind: 'break_start', at: '2026-07-01T12:00:00+09:00' }),
      punch({ kind: 'break_end', at: '2026-07-01T13:00:00+09:00' }),
      punch({ kind: 'out', at: '2026-07-01T19:00:00+09:00' }),
    ], rule, '2026-07-01')
    expect(s.workMinutes).toBe(540)
    expect(s.breakMinutes).toBe(60)
    expect(s.buckets.scheduled).toBe(480)
    expect(s.buckets.nonStatutoryOt).toBe(60)
    expect(s.breakShortage).toBe(0)
  })

  it('月次は法定外残業の 60h 超過分を over60Ot に積む', () => {
    const byDate = new Map<string, PunchRecord[]>()
    // 平日 22 日 × 4h 残業 = 88h 残業（60h 超 28h）
    let count = 0
    for (let d = 1; d <= 31 && count < 22; d++) {
      const date = `2026-07-${String(d).padStart(2, '0')}`
      const w = new Date(`${date}T00:00:00`).getDay()
      if (w === 0 || w === 6) continue
      count++
      byDate.set(date, [
        punch({ kind: 'in', at: `${date}T09:00:00+09:00`, date }),
        punch({ kind: 'break_start', at: `${date}T12:00:00+09:00`, date }),
        punch({ kind: 'break_end', at: `${date}T13:00:00+09:00`, date }),
        punch({ kind: 'out', at: `${date}T22:00:00+09:00`, date }),
      ])
    }
    const m = monthSummary(byDate, rule, '2026-07')
    expect(m.workDays).toBe(22)
    expect(m.total.nonStatutoryOt).toBe(60 * 60)
    expect(m.total.over60Ot).toBe(28 * 60)
  })
})
