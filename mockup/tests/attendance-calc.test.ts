import { describe, expect, it } from 'vitest'
import type { PunchRecord } from '~/types/domain'
import {
  calcWorkedMinutes, effectivePunches, judgeArticle36, leaveGrantDays,
  requiredBreakMinutes, splitBuckets,
} from '~/utils/attendance-calc'

describe('splitBuckets（6 バケット分解）', () => {
  it('所定内のみ（8h 勤務・所定 8h）', () => {
    const b = splitBuckets({ workMinutes: 480, scheduledMinutes: 480, nightMinutes: 0, isLegalHoliday: false, monthNonStatutoryOtSoFar: 0 })
    expect(b).toEqual({ scheduled: 480, statutoryOt: 0, nonStatutoryOt: 0, over60Ot: 0, night: 0, legalHoliday: 0 })
  })

  it('法定内残業（所定 7h・勤務 8h → 1h は割増なし残業）', () => {
    const b = splitBuckets({ workMinutes: 480, scheduledMinutes: 420, nightMinutes: 0, isLegalHoliday: false, monthNonStatutoryOtSoFar: 0 })
    expect(b.scheduled).toBe(420)
    expect(b.statutoryOt).toBe(60)
    expect(b.nonStatutoryOt).toBe(0)
  })

  it('法定外残業（所定 8h・勤務 10h → 2h が 25% 残業）', () => {
    const b = splitBuckets({ workMinutes: 600, scheduledMinutes: 480, nightMinutes: 0, isLegalHoliday: false, monthNonStatutoryOtSoFar: 0 })
    expect(b.nonStatutoryOt).toBe(120)
    expect(b.over60Ot).toBe(0)
  })

  it('月 60h 超過分は 50% バケットへ振り分ける', () => {
    const b = splitBuckets({ workMinutes: 600, scheduledMinutes: 480, nightMinutes: 0, isLegalHoliday: false, monthNonStatutoryOtSoFar: 59 * 60 })
    expect(b.nonStatutoryOt).toBe(60) // 60h までの残り 1h
    expect(b.over60Ot).toBe(60) // 超過 1h
  })

  it('法定休日は全時間が休日労働（時間外の概念なし）', () => {
    const b = splitBuckets({ workMinutes: 540, scheduledMinutes: 480, nightMinutes: 30, isLegalHoliday: true, monthNonStatutoryOtSoFar: 0 })
    expect(b.legalHoliday).toBe(540)
    expect(b.nonStatutoryOt).toBe(0)
    expect(b.night).toBe(30)
  })
})

describe('calcWorkedMinutes（打刻列の集計。実行環境の TZ に依存しない）', () => {
  const punch = (kind: PunchRecord['kind'], at: string): PunchRecord => ({
    id: `t-${kind}-${at}`, memberId: 'm-99', date: '2026-07-01', kind, at,
    source: 'web', fixedFrom: null, fixReason: null, approvedBy: null,
  })

  it('出勤→休憩→退勤で実労働と休憩を分離する', () => {
    const r = calcWorkedMinutes([
      punch('in', '2026-07-01T09:00:00+09:00'),
      punch('break_start', '2026-07-01T12:00:00+09:00'),
      punch('break_end', '2026-07-01T13:00:00+09:00'),
      punch('out', '2026-07-01T18:00:00+09:00'),
    ])
    expect(r.workMinutes).toBe(480)
    expect(r.breakMinutes).toBe(60)
    expect(r.nightMinutes).toBe(0) // 日中勤務に深夜は発生しない（UTC 環境でも 0 であること）
  })

  it('深夜帯（22-5時）の重なりは壁時計（+09:00 の時刻文字列）で判定する', () => {
    const r = calcWorkedMinutes([
      punch('in', '2026-07-01T20:00:00+09:00'),
      punch('out', '2026-07-01T23:30:00+09:00'),
    ])
    expect(r.workMinutes).toBe(210)
    expect(r.nightMinutes).toBe(90) // 22:00-23:30
  })

  it('二重の退勤打刻は無視される（状態機械ガード）', () => {
    const r = calcWorkedMinutes([
      punch('in', '2026-07-01T09:00:00+09:00'),
      punch('out', '2026-07-01T18:00:00+09:00'),
      punch('out', '2026-07-01T19:00:00+09:00'),
    ])
    expect(r.workMinutes).toBe(540)
  })
})

describe('effectivePunches（修正打刻による置換の解決）', () => {
  const rec = (id: string, kind: PunchRecord['kind'], at: string, fixedFrom: string | null = null): PunchRecord => ({
    id, memberId: 'm-99', date: '2026-07-01', kind, at,
    source: fixedFrom !== null ? 'fix' : 'web', fixedFrom, fixReason: null, approvedBy: null,
  })

  it('fix が同種・同時刻の旧打刻を置換する', () => {
    const eff = effectivePunches([
      rec('a', 'in', '2026-07-01T09:00:00+09:00'),
      rec('b', 'in', '2026-07-01T09:30:00+09:00', '2026-07-01T09:00:00+09:00'),
    ])
    expect(eff.map(p => p.id)).toEqual(['b'])
  })

  it('fix の連鎖では最新の fix だけが有効になる', () => {
    const eff = effectivePunches([
      rec('a', 'in', '2026-07-01T09:00:00+09:00'),
      rec('b', 'in', '2026-07-01T09:30:00+09:00', '2026-07-01T09:00:00+09:00'),
      rec('c', 'in', '2026-07-01T09:10:00+09:00', '2026-07-01T09:30:00+09:00'),
    ])
    expect(eff.map(p => p.id)).toEqual(['c'])
  })

  it('自己置換（at === fixedFrom）でも自分自身は除外しない', () => {
    const eff = effectivePunches([
      rec('a', 'in', '2026-07-01T09:00:00+09:00'),
      rec('b', 'in', '2026-07-01T09:00:00+09:00', '2026-07-01T09:00:00+09:00'),
    ])
    expect(eff.map(p => p.id)).toEqual(['b'])
  })

  it('別種別の打刻には影響しない', () => {
    const eff = effectivePunches([
      rec('a', 'in', '2026-07-01T09:00:00+09:00'),
      rec('b', 'out', '2026-07-01T18:00:00+09:00'),
      rec('c', 'out', '2026-07-01T19:00:00+09:00', '2026-07-01T18:00:00+09:00'),
    ])
    expect(eff.map(p => p.id)).toEqual(['a', 'c'])
  })
})

describe('requiredBreakMinutes（労基法 34 条）', () => {
  it('6h ちょうどは休憩不要', () => expect(requiredBreakMinutes(360)).toBe(0))
  it('6h 超は 45 分', () => expect(requiredBreakMinutes(361)).toBe(45))
  it('8h 超は 60 分', () => expect(requiredBreakMinutes(481)).toBe(60))
})

describe('judgeArticle36（36 協定判定）', () => {
  const month = (m: string, otH: number, holH = 0) => ({
    month: m, nonStatutoryOtMin: otH * 60, legalHolidayMin: holH * 60,
  })

  it('45h の 80% で警告', () => {
    const alerts = judgeArticle36([month('2026-07', 37)], 0)
    expect(alerts.some(a => a.code === 'AKO-ATT-A45W')).toBe(true)
  })

  it('45h 超で重大アラート', () => {
    const alerts = judgeArticle36([month('2026-07', 46)], 1)
    expect(alerts.some(a => a.code === 'AKO-ATT-A45')).toBe(true)
  })

  it('ちょうど 45h は「以内」で適法のため重大アラートは出ない（警告のみ）', () => {
    const alerts = judgeArticle36([month('2026-07', 45)], 0)
    expect(alerts.some(a => a.code === 'AKO-ATT-A45')).toBe(false)
    expect(alerts.some(a => a.code === 'AKO-ATT-A45W')).toBe(true)
  })

  it('時間外+休日の単月 100h 到達で違反', () => {
    const alerts = judgeArticle36([month('2026-07', 80, 20)], 1)
    expect(alerts.some(a => a.code === 'AKO-ATT-A100')).toBe(true)
  })

  it('2〜6 ヶ月平均 80h 超を全組み合わせで検出（2 ヶ月平均のケース）', () => {
    const alerts = judgeArticle36([month('2026-06', 90), month('2026-07', 75)], 2)
    expect(alerts.some(a => a.code === 'AKO-ATT-A80')).toBe(true)
  })

  it('平均 80h 以下なら平均アラートなし', () => {
    const alerts = judgeArticle36([month('2026-06', 40), month('2026-07', 40)], 0)
    expect(alerts.some(a => a.code === 'AKO-ATT-A80')).toBe(false)
  })

  it('45h 超が年 6 回で上限アラート', () => {
    const alerts = judgeArticle36([month('2026-07', 10)], 6)
    expect(alerts.some(a => a.code === 'AKO-ATT-A6C')).toBe(true)
  })
})

describe('leaveGrantDays（労基法 39 条 付与テーブル）', () => {
  it('週 5 日・勤続 0.5 年 → 10 日', () => expect(leaveGrantDays(5, 40, 0.5)).toBe(10))
  it('週 5 日・勤続 6.5 年以上 → 20 日', () => expect(leaveGrantDays(5, 40, 7.5)).toBe(20))
  it('週 4 日でも週 30h 以上なら通常付与（判定は 30h が先）', () => expect(leaveGrantDays(4, 32, 0.5)).toBe(10))
  it('週 3 日・週 18h・勤続 0.5 年 → 比例付与 5 日', () => expect(leaveGrantDays(3, 18, 0.5)).toBe(5))
  it('週 1 日・勤続 4.5 年 → 3 日', () => expect(leaveGrantDays(1, 6, 4.5)).toBe(3))
  it('勤続 0.5 年未満は 0 日', () => expect(leaveGrantDays(5, 40, 0.4)).toBe(0))
})
