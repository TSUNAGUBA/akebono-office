/**
 * 日報の自動リマインド判定（API 側）。
 * shared/domain/report-reminder が API 側からも import でき、代表ケースが同一挙動であることを確認する
 * （境界ケースの網羅は home/tests/report-reminder.test.ts が担う）
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPORT_REMINDER, buildReminderMessage, missingReportDates,
  parseReportReminderConfig, shouldFireReminder,
} from '../../../shared/domain/report-reminder'

describe('parseReportReminderConfig（設定の両形対応）', () => {
  it('JSON 文字列（home setConfig 経由）とオブジェクト（app_configs jsonb）の両方を受理する', () => {
    expect(parseReportReminderConfig('{"enabled":true,"time":"08:30"}')).toEqual({ enabled: true, time: '08:30' })
    expect(parseReportReminderConfig({ enabled: true, time: '08:30' })).toEqual({ enabled: true, time: '08:30' })
  })

  it('未設定・壊れた設定は既定値（disabled）へフォールバックする（原則7 = 誤送信しない）', () => {
    expect(parseReportReminderConfig(undefined)).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig('broken')).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig({ enabled: 'yes', time: '08:30' })).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig({ enabled: true, time: '24:00' })).toEqual(DEFAULT_REPORT_REMINDER)
  })
})

describe('shouldFireReminder（runReportReminders の発火判定）', () => {
  const cfg = { enabled: true, time: '09:15' }

  it('設定時刻以降 + 今日未送信のときのみ発火する', () => {
    expect(shouldFireReminder(cfg, '09:15', '', '2026-08-20')).toBe(true)
    expect(shouldFireReminder(cfg, '09:14', '', '2026-08-20')).toBe(false)
    expect(shouldFireReminder(cfg, '10:00', '2026-08-20', '2026-08-20')).toBe(false) // 同日再実行しない（原則2）
    expect(shouldFireReminder(cfg, '10:00', '2026-08-19', '2026-08-20')).toBe(true) // 日跨ぎで再開
    expect(shouldFireReminder({ ...cfg, enabled: false }, '10:00', '', '2026-08-20')).toBe(false)
  })
})

describe('missingReportDates / buildReminderMessage', () => {
  it('前日までの直近 5 営業日のうち提出済みが無い日を昇順で返し、M/D 表記で本文へ並べる', () => {
    const reports = [
      { authorKind: 'human', memberId: 'm1', date: '2026-08-19', status: 'submitted' },
      { authorKind: 'human', memberId: 'm1', date: '2026-08-18', status: 'draft' }, // 下書きは未提出扱い
    ]
    // today = 2026-08-24（月）→ 対象窓 = 8/17〜8/21（土日 8/22・23 をスキップ・today は含まない）
    const missing = missingReportDates('m1', reports, '2026-08-24')
    expect(missing).toEqual(['2026-08-17', '2026-08-18', '2026-08-20', '2026-08-21'])
    expect(buildReminderMessage(missing)).toEqual({
      title: '日報リマインド',
      body: '未提出の日報があります: 8/17, 8/18, 8/20, 8/21。記載をお願いします',
    })
  })
})
