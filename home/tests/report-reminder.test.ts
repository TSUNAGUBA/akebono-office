/**
 * 日報の自動リマインド（SoT = shared/domain/report-reminder.ts）。
 * - 設定パース: JSON 文字列 / オブジェクト両対応・壊れは disabled へ（原則7）
 * - 発火判定: 設定時刻以降・同日再実行しない（日次 1 回 = 原則2）
 * - 未提出判定: 前日までの直近 5 営業日（土日スキップ）・submitted のみ充足・下書きは未提出扱い
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPORT_REMINDER, buildReminderMessage, missingReportDates,
  parseReportReminderConfig, reminderWindowDates, shouldFireReminder,
} from '../../shared/domain/report-reminder'

describe('parseReportReminderConfig', () => {
  it('オブジェクト（API の app_configs jsonb）を受理する', () => {
    expect(parseReportReminderConfig({ enabled: true, time: '08:30' })).toEqual({ enabled: true, time: '08:30' })
    expect(parseReportReminderConfig({ enabled: false, time: '23:59' })).toEqual({ enabled: false, time: '23:59' })
  })

  it('JSON 文字列（home setConfig の JSON.stringify 経由）を受理する', () => {
    expect(parseReportReminderConfig('{"enabled":true,"time":"09:15"}')).toEqual({ enabled: true, time: '09:15' })
  })

  it('未設定・空文字は既定値（disabled・09:15）', () => {
    expect(parseReportReminderConfig('')).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig(undefined)).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig(null)).toEqual(DEFAULT_REPORT_REMINDER)
  })

  it('壊れた設定は disabled へフォールバックする（原則7 = 誤送信しない）', () => {
    expect(parseReportReminderConfig('not json')).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig('[]')).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig({ enabled: 'yes', time: '08:30' })).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig({ enabled: true, time: 915 })).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig({ enabled: true, time: '25:00' })).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig({ enabled: true, time: '9:15' })).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig({ enabled: true })).toEqual(DEFAULT_REPORT_REMINDER)
  })
})

describe('shouldFireReminder（発火判定の境界）', () => {
  const cfg = { enabled: true, time: '09:15' }

  it('設定時刻より前は発火しない・同時刻ちょうど以降は発火する', () => {
    expect(shouldFireReminder(cfg, '09:14', '', '2026-08-20')).toBe(false)
    expect(shouldFireReminder(cfg, '09:15', '', '2026-08-20')).toBe(true)
    expect(shouldFireReminder(cfg, '23:59', '', '2026-08-20')).toBe(true)
  })

  it('同日 2 回目は発火しない（lastSent = today。日次 1 回 = 原則2）', () => {
    expect(shouldFireReminder(cfg, '10:00', '2026-08-20', '2026-08-20')).toBe(false)
  })

  it('日を跨ぐと再び発火する（lastSent = 昨日）', () => {
    expect(shouldFireReminder(cfg, '10:00', '2026-08-19', '2026-08-20')).toBe(true)
  })

  it('無効設定は時刻・lastSent に関係なく発火しない', () => {
    expect(shouldFireReminder({ enabled: false, time: '09:15' }, '10:00', '', '2026-08-20')).toBe(false)
  })
})

describe('reminderWindowDates / missingReportDates', () => {
  it('対象窓 = 前日以前の直近 5 営業日（today は含まない・土日スキップ・昇順）', () => {
    // today = 2026-08-24（月）→ 前日 8/23(日)・8/22(土) はスキップ → 8/17(月)〜8/21(金)
    expect(reminderWindowDates('2026-08-24')).toEqual([
      '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21',
    ])
    // today = 2026-08-20（木）→ 8/13(木)・8/14(金)・8/17(月)〜8/19(水)（週末 8/15・16 をスキップ）
    expect(reminderWindowDates('2026-08-20')).toEqual([
      '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19',
    ])
  })

  it('lookback 日数は指定可能（既定 5）', () => {
    expect(reminderWindowDates('2026-08-20', 2)).toEqual(['2026-08-18', '2026-08-19'])
  })

  it('submitted のみ充足・下書きは未提出扱い・today 当日分は判定対象外', () => {
    const reports = [
      { authorKind: 'human', memberId: 'm1', date: '2026-08-19', status: 'submitted' },
      { authorKind: 'human', memberId: 'm1', date: '2026-08-18', status: 'draft' }, // 下書き = 未提出
      { authorKind: 'human', memberId: 'm1', date: '2026-08-20', status: 'submitted' }, // today = 対象外
    ]
    expect(missingReportDates('m1', reports, '2026-08-20')).toEqual([
      '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18',
    ])
  })

  it('他メンバー・AI 社員の提出は充足しない', () => {
    const reports = [
      { authorKind: 'human', memberId: 'm2', date: '2026-08-19', status: 'submitted' },
      { authorKind: 'ai', memberId: null, date: '2026-08-19', status: 'submitted' },
    ]
    expect(missingReportDates('m1', reports, '2026-08-20')).toEqual([
      '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19',
    ])
  })

  it('全営業日が提出済みなら空配列（通知しない）', () => {
    const reports = ['2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19']
      .map(date => ({ authorKind: 'human', memberId: 'm1', date, status: 'submitted' }))
    expect(missingReportDates('m1', reports, '2026-08-20')).toEqual([])
  })
})

describe('buildReminderMessage', () => {
  it('M/D 表記のカンマ区切りで本文を組み立てる', () => {
    expect(buildReminderMessage(['2026-08-18', '2026-08-19'])).toEqual({
      title: '日報リマインド',
      body: '未提出の日報があります: 8/18, 8/19。記載をお願いします',
    })
  })

  it('1 桁月日はゼロ埋めしない（1/5 表記）', () => {
    expect(buildReminderMessage(['2026-01-05']).body).toBe('未提出の日報があります: 1/5。記載をお願いします')
  })
})
