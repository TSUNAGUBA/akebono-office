/** 稼働状況の日次集計（shared/domain/uptime。フロント/API 共有）の単体テスト */
import { describe, expect, it } from 'vitest'
import { computeUptimeDaily, IMPACT_TO_STATE, worstOf } from '../../../shared/domain/uptime'

const NOW = '2026-07-18T12:00:00+09:00'

describe('computeUptimeDaily', () => {
  it('単日で解決したインシデント: 停止分と状態写像が正しい', () => {
    const rows = computeUptimeDaily('svc-x', [
      { impact: 'major', startedAt: '2026-07-16T10:00:00+09:00', resolvedAt: '2026-07-16T12:30:00+09:00' },
    ], '2026-07-15', '2026-07-17', NOW)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ serviceId: 'svc-x', date: '2026-07-15', downMinutes: 0, worstState: 'operational' })
    expect(rows[1]).toEqual({ serviceId: 'svc-x', date: '2026-07-16', downMinutes: 150, worstState: 'partial_outage' })
    expect(rows[2]!.downMinutes).toBe(0)
  })

  it('日跨ぎのインシデントは JST 日境界で分割される', () => {
    const rows = computeUptimeDaily('svc-x', [
      { impact: 'critical', startedAt: '2026-07-16T23:00:00+09:00', resolvedAt: '2026-07-17T01:30:00+09:00' },
    ], '2026-07-16', '2026-07-17', NOW)
    expect(rows[0]).toMatchObject({ date: '2026-07-16', downMinutes: 60, worstState: 'major_outage' })
    expect(rows[1]).toMatchObject({ date: '2026-07-17', downMinutes: 90, worstState: 'major_outage' })
  })

  it('未解決インシデントは nowIso まで計上される', () => {
    const rows = computeUptimeDaily('svc-x', [
      { impact: 'minor', startedAt: '2026-07-18T09:00:00+09:00', resolvedAt: null },
    ], '2026-07-18', '2026-07-18', NOW)
    expect(rows[0]).toMatchObject({ date: '2026-07-18', downMinutes: 180, worstState: 'degraded' })
  })

  it('同日に重なる複数インシデントは区間の和集合（二重計上しない）+ 最悪値ロールアップ', () => {
    const rows = computeUptimeDaily('svc-x', [
      { impact: 'minor', startedAt: '2026-07-16T10:00:00+09:00', resolvedAt: '2026-07-16T11:00:00+09:00' },
      { impact: 'major', startedAt: '2026-07-16T10:30:00+09:00', resolvedAt: '2026-07-16T11:30:00+09:00' },
    ], '2026-07-16', '2026-07-16', NOW)
    // 10:00〜11:30 の和集合 = 90 分（重なり 30 分は 1 回だけ数える）
    expect(rows[0]).toMatchObject({ downMinutes: 90, worstState: 'partial_outage' })
  })

  it('離れた複数インシデントは合算される', () => {
    const rows = computeUptimeDaily('svc-x', [
      { impact: 'minor', startedAt: '2026-07-16T09:00:00+09:00', resolvedAt: '2026-07-16T09:30:00+09:00' },
      { impact: 'minor', startedAt: '2026-07-16T20:00:00+09:00', resolvedAt: '2026-07-16T20:45:00+09:00' },
    ], '2026-07-16', '2026-07-16', NOW)
    expect(rows[0]!.downMinutes).toBe(75)
  })

  it('発生直後（ゼロ長）の未解決インシデントでも当日の状態には写像される', () => {
    const rows = computeUptimeDaily('svc-x', [
      { impact: 'major', startedAt: NOW, resolvedAt: null },
    ], '2026-07-18', '2026-07-18', NOW)
    expect(rows[0]).toMatchObject({ downMinutes: 0, worstState: 'partial_outage' })
  })

  it('窓外のインシデントは影響しない・インシデントなしは全日 operational', () => {
    const rows = computeUptimeDaily('svc-x', [
      { impact: 'critical', startedAt: '2026-06-01T00:00:00+09:00', resolvedAt: '2026-06-02T00:00:00+09:00' },
    ], '2026-07-15', '2026-07-17', NOW)
    expect(rows.every(r => r.downMinutes === 0 && r.worstState === 'operational')).toBe(true)
  })
})

describe('IMPACT_TO_STATE / worstOf', () => {
  it('影響度写像は mockup と同一', () => {
    expect(IMPACT_TO_STATE.minor).toBe('degraded')
    expect(IMPACT_TO_STATE.major).toBe('partial_outage')
    expect(IMPACT_TO_STATE.critical).toBe('major_outage')
  })
  it('最悪値ロールアップ', () => {
    expect(worstOf('operational', 'degraded')).toBe('degraded')
    expect(worstOf('major_outage', 'degraded')).toBe('major_outage')
    expect(worstOf('maintenance', 'operational')).toBe('maintenance')
  })
})
