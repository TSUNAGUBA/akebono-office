/**
 * 日報・週報・月報の自動リマインド判定（API 側）。
 * shared/domain/report-reminder が API 側からも import でき、代表ケースが同一挙動であることを確認する
 * （境界ケースの網羅は home/tests/report-reminder.test.ts が担う）
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REMINDER_KIND_CONFIG, DEFAULT_REPORT_REMINDER, buildReminderMessage, buildWeeklyReminderMessage,
  hasSubmittedPeriodReport, lastCompletedWeekStart, lastMonthStart, missingReportDates,
  parseReminderLastSent, parseReportReminderConfig, shouldFireReminder,
} from '../../../shared/domain/report-reminder'

describe('parseReportReminderConfig（種別設定の両形対応）', () => {
  it('新形状（種別ごと）を JSON 文字列 / オブジェクトの両方で受理する', () => {
    const obj = { daily: { enabled: true, time: '08:30', external: false } }
    expect(parseReportReminderConfig(obj).daily).toEqual({ enabled: true, time: '08:30', external: false })
    expect(parseReportReminderConfig(JSON.stringify(obj)).daily.external).toBe(false)
  })

  it('旧形状 { enabled, time } は日報設定として読み替える（原則7）', () => {
    const parsed = parseReportReminderConfig({ enabled: true, time: '08:30' })
    expect(parsed.daily).toEqual({ enabled: true, time: '08:30', external: true })
    expect(parsed.weekly).toEqual(DEFAULT_REMINDER_KIND_CONFIG)
  })

  it('未設定・壊れた設定は既定値（disabled）へフォールバックする（誤送信しない）', () => {
    expect(parseReportReminderConfig(undefined)).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig('broken')).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig({ enabled: 'yes', time: '08:30' }).daily).toEqual(DEFAULT_REMINDER_KIND_CONFIG)
    expect(parseReportReminderConfig({ enabled: true, time: '24:00' }).daily).toEqual(DEFAULT_REMINDER_KIND_CONFIG)
  })
})

describe('parseReminderLastSent（送信済み記録の両形対応）', () => {
  it('旧形状（単一日付の JSON 文字列）は daily・新形状は種別ごとに読む', () => {
    expect(parseReminderLastSent('"2026-08-20"')).toEqual({ daily: '2026-08-20' })
    expect(parseReminderLastSent({ weekly: '2026-08-18' })).toEqual({ weekly: '2026-08-18' })
    expect(parseReminderLastSent(undefined)).toEqual({})
  })
})

describe('shouldFireReminder（runReportReminders の発火判定）', () => {
  const cfg = { enabled: true, time: '09:15', external: true }

  it('設定時刻以降 + 今日未送信のときのみ発火する', () => {
    expect(shouldFireReminder(cfg, '09:15', '', '2026-08-20')).toBe(true)
    expect(shouldFireReminder(cfg, '09:14', '', '2026-08-20')).toBe(false)
    expect(shouldFireReminder(cfg, '10:00', '2026-08-20', '2026-08-20')).toBe(false) // 同日再実行しない（原則2）
    expect(shouldFireReminder(cfg, '10:00', '2026-08-19', '2026-08-20')).toBe(true) // 日跨ぎで再開
    expect(shouldFireReminder({ ...cfg, enabled: false }, '10:00', '', '2026-08-20')).toBe(false)
  })
})

describe('missingReportDates / buildReminderMessage（日報）', () => {
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

describe('週報・月報の対象期間と提出判定（runReportReminders が使う代表ケース）', () => {
  it('週報 = 先週の月曜・月報 = 先月の月初', () => {
    expect(lastCompletedWeekStart('2026-08-20')).toBe('2026-08-10')
    expect(lastMonthStart('2026-08-20')).toBe('2026-07-01')
  })

  it('submitted のみ充足（下書きは未提出扱い）・週報メッセージは期間レンジ表記', () => {
    const rows = [{ memberId: 'm1', periodStart: '2026-08-10', status: 'submitted' }]
    expect(hasSubmittedPeriodReport('m1', rows, '2026-08-10')).toBe(true)
    expect(hasSubmittedPeriodReport('m2', rows, '2026-08-10')).toBe(false)
    expect(buildWeeklyReminderMessage('2026-08-10').body)
      .toBe('先週（8/10〜8/16）の週報が未提出です。記載をお願いします')
  })
})
