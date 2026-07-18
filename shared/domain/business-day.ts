/**
 * 営業日計算（フロント/API 共有の純粋関数。オペレーター報告 2026-07-18 #4）
 *
 * - 営業日の定義は勤怠ルールマスタ（attendance_rules）で制御する:
 *   workingWeekdays = 営業曜日（0=日〜6=土）/ holidayAware = 祝日を非営業日として扱うか。
 *   外注等の「平日以外も営業日」な勤務体系は workingWeekdays に土日を含める・
 *   holidayAware を false にすることで表現する
 * - 祝日の SoT は public_holidays マスタ（内閣府の公式 CSV から取込 + 手動管理）。
 *   呼び出し側が日付キー Set を渡す（この層は DB・キャッシュに依存しない）
 * - ルール未設定のメンバーは DEFAULT_WORKING_DAY_RULE（月〜金 + 祝日考慮）= 従来挙動と同じ
 */
import { addDays, weekdayOf } from './jst'

export interface WorkingDayRule {
  /** 営業曜日（0=日曜〜6=土曜） */
  workingWeekdays: number[]
  /** 祝日（public_holidays）を非営業日として扱うか */
  holidayAware: boolean
}

/** 既定の営業日ルール（月〜金 + 祝日は休み）。勤怠ルール未割当・未設定時のフォールバック */
export const DEFAULT_WORKING_DAY_RULE: WorkingDayRule = {
  workingWeekdays: [1, 2, 3, 4, 5],
  holidayAware: true,
}

/** 勤怠ルール行（部分的でよい）から営業日ルールを解決する（列未設定の旧データは既定へ） */
export function workingDayRuleOf(
  rule: { workingWeekdays?: unknown; holidayAware?: unknown } | null | undefined,
): WorkingDayRule {
  const weekdays = Array.isArray(rule?.workingWeekdays)
    ? (rule.workingWeekdays as unknown[]).filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
    : []
  return {
    workingWeekdays: weekdays.length > 0 ? weekdays : DEFAULT_WORKING_DAY_RULE.workingWeekdays,
    holidayAware: typeof rule?.holidayAware === 'boolean' ? rule.holidayAware : true,
  }
}

/** date（YYYY-MM-DD）が営業日か */
export function isWorkingDay(date: string, rule: WorkingDayRule, holidays: ReadonlySet<string>): boolean {
  if (!rule.workingWeekdays.includes(weekdayOf(date))) return false
  if (rule.holidayAware && holidays.has(date)) return false
  return true
}

/**
 * 翌営業日（date の翌日以降で最初の営業日）。
 * 全曜日が非営業のルール等での無限ループを防ぐため 370 日で打ち切り（その場合は翌日を返す）
 */
export function nextWorkingDay(date: string, rule: WorkingDayRule, holidays: ReadonlySet<string>): string {
  let next = addDays(date, 1)
  for (let i = 0; i < 370 && !isWorkingDay(next, rule, holidays); i++) next = addDays(next, 1)
  return isWorkingDay(next, rule, holidays) ? next : addDays(date, 1)
}
