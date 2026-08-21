/**
 * 日報・週報・月報の自動リマインド（SoT = shared/domain/report-reminder.ts）。
 * - 設定パース: 種別ごとの設定。JSON 文字列 / オブジェクト両対応・壊れは disabled へ・
 *   旧形状 { enabled, time } は日報設定として読み替え（原則7）
 * - 発火判定: 種別ごとに設定時刻以降・同日再実行しない（日次 1 回 = 原則2）
 * - 未提出判定: 日報 = 前日までの直近 5 営業日 / 週報 = 先週 / 月報 = 先月・submitted のみ充足
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REMINDER_KIND_CONFIG, DEFAULT_REPORT_REMINDER, buildMonthlyReminderMessage, buildReminderMessage,
  buildWeeklyReminderMessage, hasSubmittedPeriodReport, lastCompletedWeekStart, lastMonthStart,
  missingReportDates, parseReminderLastSent, parseReportReminderConfig, reminderWindowDates,
  shouldFireReminder, weekStartKeyOf,
} from '../../shared/domain/report-reminder'

describe('parseReportReminderConfig（種別ごとの設定）', () => {
  it('新形状（daily/weekly/monthly）を受理する。external 欠落は true（従来挙動）', () => {
    const parsed = parseReportReminderConfig({
      daily: { enabled: true, time: '08:30', external: false },
      weekly: { enabled: true, time: '10:00' },
      monthly: { enabled: false, time: '09:15', external: true },
    })
    expect(parsed.daily).toEqual({ enabled: true, time: '08:30', external: false })
    expect(parsed.weekly).toEqual({ enabled: true, time: '10:00', external: true })
    expect(parsed.monthly).toEqual({ enabled: false, time: '09:15', external: true })
  })

  it('旧形状 { enabled, time } は日報設定として読み替える（週報・月報は既定 = disabled。原則7）', () => {
    const parsed = parseReportReminderConfig({ enabled: true, time: '08:30' })
    expect(parsed.daily).toEqual({ enabled: true, time: '08:30', external: true })
    expect(parsed.weekly).toEqual(DEFAULT_REMINDER_KIND_CONFIG)
    expect(parsed.monthly).toEqual(DEFAULT_REMINDER_KIND_CONFIG)
    // JSON 文字列（home setConfig の JSON.stringify 経由）でも同じ
    expect(parseReportReminderConfig('{"enabled":true,"time":"09:15"}').daily.enabled).toBe(true)
  })

  it('未設定・空文字・壊れた設定は既定値（全種別 disabled）', () => {
    expect(parseReportReminderConfig('')).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig(undefined)).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig(null)).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig('not json')).toEqual(DEFAULT_REPORT_REMINDER)
    expect(parseReportReminderConfig('[]')).toEqual(DEFAULT_REPORT_REMINDER)
  })

  it('壊れた種別だけが disabled へフォールバックする（他種別は生かす）', () => {
    const parsed = parseReportReminderConfig({
      daily: { enabled: true, time: '25:00' }, // 不正時刻
      weekly: { enabled: true, time: '10:00' },
      monthly: { enabled: 'yes', time: '09:15' }, // 型不一致
    })
    expect(parsed.daily).toEqual(DEFAULT_REMINDER_KIND_CONFIG)
    expect(parsed.weekly.enabled).toBe(true)
    expect(parsed.monthly).toEqual(DEFAULT_REMINDER_KIND_CONFIG)
  })

  it('旧形状の壊れ値（時刻形式ずれ・欠落）も disabled', () => {
    expect(parseReportReminderConfig({ enabled: true, time: '9:15' }).daily).toEqual(DEFAULT_REMINDER_KIND_CONFIG)
    expect(parseReportReminderConfig({ enabled: true }).daily).toEqual(DEFAULT_REMINDER_KIND_CONFIG)
  })
})

describe('parseReminderLastSent（種別ごとの最終送信日）', () => {
  it('新形状（種別ごとのオブジェクト）を受理する', () => {
    expect(parseReminderLastSent({ daily: '2026-08-20', weekly: '2026-08-18' }))
      .toEqual({ daily: '2026-08-20', weekly: '2026-08-18' })
  })

  it('旧形状は daily として読み替える（原則7。API = jsonb デコード済みの素の日付 / mock = JSON 文字列）', () => {
    expect(parseReminderLastSent('2026-08-20')).toEqual({ daily: '2026-08-20' }) // jsonb 経由（監査 R1 MAJOR-1）
    expect(parseReminderLastSent('"2026-08-20"')).toEqual({ daily: '2026-08-20' }) // JSON 文字列経由
    expect(parseReminderLastSent('not-a-date')).toEqual({}) // 日付でない文字列は未送信扱い
  })

  it('未設定・壊れは空（= 未送信扱い。誤抑制しない）', () => {
    expect(parseReminderLastSent(undefined)).toEqual({})
    expect(parseReminderLastSent('')).toEqual({})
    expect(parseReminderLastSent('broken')).toEqual({})
    expect(parseReminderLastSent([])).toEqual({})
  })
})

describe('shouldFireReminder（発火判定の境界。種別設定単位）', () => {
  const cfg = { enabled: true, time: '09:15', external: true }

  it('設定時刻より前は発火しない・同時刻ちょうど以降は発火する', () => {
    expect(shouldFireReminder(cfg, '09:14', '', '2026-08-20')).toBe(false)
    expect(shouldFireReminder(cfg, '09:15', '', '2026-08-20')).toBe(true)
    expect(shouldFireReminder(cfg, '23:59', '', '2026-08-20')).toBe(true)
  })

  it('同日 2 回目は発火しない（lastSent = today。日次 1 回 = 原則2）・日跨ぎで再開', () => {
    expect(shouldFireReminder(cfg, '10:00', '2026-08-20', '2026-08-20')).toBe(false)
    expect(shouldFireReminder(cfg, '10:00', '2026-08-19', '2026-08-20')).toBe(true)
  })

  it('無効設定は時刻・lastSent に関係なく発火しない', () => {
    expect(shouldFireReminder({ ...cfg, enabled: false }, '10:00', '', '2026-08-20')).toBe(false)
  })
})

describe('reminderWindowDates / missingReportDates（日報）', () => {
  it('対象窓 = 前日以前の直近 5 営業日（today は含まない・土日スキップ・昇順）', () => {
    // today = 2026-08-24（月）→ 前日 8/23(日)・8/22(土) はスキップ → 8/17(月)〜8/21(金)
    expect(reminderWindowDates('2026-08-24')).toEqual([
      '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21',
    ])
    expect(reminderWindowDates('2026-08-20', 2)).toEqual(['2026-08-18', '2026-08-19'])
  })

  it('submitted のみ充足・下書きは未提出扱い・today 当日分は判定対象外・他人/AI は充足しない', () => {
    const reports = [
      { authorKind: 'human', memberId: 'm1', date: '2026-08-19', status: 'submitted' },
      { authorKind: 'human', memberId: 'm1', date: '2026-08-18', status: 'draft' },
      { authorKind: 'human', memberId: 'm1', date: '2026-08-20', status: 'submitted' }, // today = 対象外
      { authorKind: 'human', memberId: 'm2', date: '2026-08-17', status: 'submitted' }, // 他人
      { authorKind: 'ai', memberId: null, date: '2026-08-14', status: 'submitted' }, // AI 社員
    ]
    expect(missingReportDates('m1', reports, '2026-08-20')).toEqual([
      '2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18',
    ])
  })

  it('全営業日が提出済みなら空配列（通知しない）', () => {
    const reports = ['2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19']
      .map(date => ({ authorKind: 'human', memberId: 'm1', date, status: 'submitted' }))
    expect(missingReportDates('m1', reports, '2026-08-20')).toEqual([])
  })
})

describe('週・月の期間キー（weekStartKeyOf / lastCompletedWeekStart / lastMonthStart）', () => {
  it('週キー = 月曜始まり（report-weeks.ts weekStartOf と同一定義。日曜は前週の月曜へ）', () => {
    expect(weekStartKeyOf('2026-08-20')).toBe('2026-08-17') // 木 → 同週月曜
    expect(weekStartKeyOf('2026-08-17')).toBe('2026-08-17') // 月曜自身
    expect(weekStartKeyOf('2026-08-23')).toBe('2026-08-17') // 日曜 = 前週扱い
  })

  it('週報の対象 = 先週（直近の完了週）の月曜', () => {
    expect(lastCompletedWeekStart('2026-08-20')).toBe('2026-08-10')
    expect(lastCompletedWeekStart('2026-08-17')).toBe('2026-08-10') // 週明け月曜でも先週分
  })

  it('月報の対象 = 先月の月初（年跨ぎも吸収）', () => {
    expect(lastMonthStart('2026-08-20')).toBe('2026-07-01')
    expect(lastMonthStart('2026-01-15')).toBe('2025-12-01')
  })
})

describe('hasSubmittedPeriodReport（週報・月報の提出判定）', () => {
  const rows = [
    { memberId: 'm1', periodStart: '2026-08-10', status: 'submitted' },
    { memberId: 'm2', periodStart: '2026-08-10', status: 'draft' },
  ]

  it('submitted のみ充足・下書きは未提出扱い・期間キー一致が必要', () => {
    expect(hasSubmittedPeriodReport('m1', rows, '2026-08-10')).toBe(true)
    expect(hasSubmittedPeriodReport('m2', rows, '2026-08-10')).toBe(false) // 下書き
    expect(hasSubmittedPeriodReport('m1', rows, '2026-08-17')).toBe(false) // 別期間
    expect(hasSubmittedPeriodReport('m3', rows, '2026-08-10')).toBe(false) // 未提出者
  })
})

describe('通知メッセージ', () => {
  it('日報: M/D 表記のカンマ区切り（1 桁はゼロ埋めしない）', () => {
    expect(buildReminderMessage(['2026-08-18', '2026-08-19'])).toEqual({
      title: '日報リマインド',
      body: '未提出の日報があります: 8/18, 8/19。記載をお願いします',
    })
    expect(buildReminderMessage(['2026-01-05']).body).toBe('未提出の日報があります: 1/5。記載をお願いします')
  })

  it('週報: 先週の期間レンジを M/D〜M/D で示す', () => {
    expect(buildWeeklyReminderMessage('2026-08-10')).toEqual({
      title: '週報リマインド',
      body: '先週（8/10〜8/16）の週報が未提出です。記載をお願いします',
    })
  })

  it('月報: 先月を YYYY年M月 で示す', () => {
    expect(buildMonthlyReminderMessage('2026-07-01')).toEqual({
      title: '月報リマインド',
      body: '先月（2026年7月）の月報が未提出です。記載をお願いします',
    })
  })
})
