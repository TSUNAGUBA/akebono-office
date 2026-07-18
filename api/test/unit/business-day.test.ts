import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKING_DAY_RULE, isWorkingDay, nextWorkingDay, workingDayRuleOf,
} from '../../../shared/domain/business-day'
import { parseHolidaysCsv } from '../../src/routes/holidays'

const NO_HOLIDAYS = new Set<string>()
// 2026-07-18 は土曜・2026-07-20 は月曜（オペレーター報告 #4 の実ケース）
const MARINE_DAY = new Set(['2026-07-20']) // 海の日（月曜）を祝日とした場合

describe('business-day（営業日計算）', () => {
  it('既定ルール: 土日をスキップして翌営業日を返す（土曜 → 月曜）', () => {
    expect(nextWorkingDay('2026-07-18', DEFAULT_WORKING_DAY_RULE, NO_HOLIDAYS)).toBe('2026-07-20')
    expect(nextWorkingDay('2026-07-17', DEFAULT_WORKING_DAY_RULE, NO_HOLIDAYS)).toBe('2026-07-20') // 金曜 → 月曜
    expect(nextWorkingDay('2026-07-15', DEFAULT_WORKING_DAY_RULE, NO_HOLIDAYS)).toBe('2026-07-16') // 水曜 → 木曜
  })

  it('祝日考慮: 月曜が祝日なら火曜まで送られる。連休もまとめてスキップ', () => {
    expect(nextWorkingDay('2026-07-18', DEFAULT_WORKING_DAY_RULE, MARINE_DAY)).toBe('2026-07-21')
    const golden = new Set(['2026-05-04', '2026-05-05', '2026-05-06'])
    expect(nextWorkingDay('2026-05-01', DEFAULT_WORKING_DAY_RULE, golden)).toBe('2026-05-07') // 金曜 → 翌木曜
  })

  it('週末稼働ルール（外注等）: 土日も営業日・祝日も営業（holidayAware=false）', () => {
    const weekendWorker = { workingWeekdays: [0, 1, 2, 3, 4, 5, 6], holidayAware: false }
    expect(nextWorkingDay('2026-07-17', weekendWorker, MARINE_DAY)).toBe('2026-07-18') // 金曜 → 土曜
    expect(isWorkingDay('2026-07-19', weekendWorker, MARINE_DAY)).toBe(true) // 日曜
    expect(isWorkingDay('2026-07-20', weekendWorker, MARINE_DAY)).toBe(true) // 祝日も営業
  })

  it('週末のみ稼働のルールでも動く（土日だけが営業日）', () => {
    const weekendOnly = { workingWeekdays: [0, 6], holidayAware: true }
    expect(nextWorkingDay('2026-07-13', weekendOnly, NO_HOLIDAYS)).toBe('2026-07-18') // 月曜 → 土曜
  })

  it('workingDayRuleOf: 列未設定の旧データ・不正値は既定（月〜金 + 祝日考慮）へフォールバック', () => {
    expect(workingDayRuleOf(undefined)).toEqual(DEFAULT_WORKING_DAY_RULE)
    expect(workingDayRuleOf({ workingWeekdays: null, holidayAware: undefined })).toEqual(DEFAULT_WORKING_DAY_RULE)
    expect(workingDayRuleOf({ workingWeekdays: [9, 'x'], holidayAware: 1 })).toEqual(DEFAULT_WORKING_DAY_RULE)
    expect(workingDayRuleOf({ workingWeekdays: [0, 6], holidayAware: false }))
      .toEqual({ workingWeekdays: [0, 6], holidayAware: false })
  })

  it('全曜日が非営業のルールでも無限ループしない（370 日で打ち切り翌日を返す）', () => {
    expect(nextWorkingDay('2026-07-18', { workingWeekdays: [], holidayAware: true }, NO_HOLIDAYS)).toBe('2026-07-19')
  })
})

describe('parseHolidaysCsv（内閣府 CSV の解析）', () => {
  it('ヘッダ行をスキップし、YYYY/M/D を日付キーへ正規化する', () => {
    const csv = '国民の祝日・休日月日,国民の祝日・休日名称\r\n2026/1/1,元日\r\n2026/7/20,海の日\r\n'
    expect(parseHolidaysCsv(csv)).toEqual([
      { date: '2026-01-01', name: '元日' },
      { date: '2026-07-20', name: '海の日' },
    ])
  })

  it('不正行・空行・名称なしはスキップする', () => {
    const csv = '\nこれは不正な行\n2026/13x/1,壊れた日付\n2026/2/11,\n2026/2/23,天皇誕生日'
    expect(parseHolidaysCsv(csv)).toEqual([{ date: '2026-02-23', name: '天皇誕生日' }])
  })
})
