/**
 * 営業日・祝日の参照ヘルパー（オペレーター報告 2026-07-18 #4）。
 * - 営業日の定義はメンバーへ適用される勤怠ルール（workingWeekdays / holidayAware）が SoT。
 *   ルール解決は useAttendance().ruleFor を再利用する（原則3 = 二重実装しない）
 * - 祝日は holidays マスタ（API モード = public_holidays / モック = seed）を参照
 * - 計算本体は shared/domain/business-day.ts（API と共有の純粋関数）
 */
import { isWorkingDay, nextWorkingDay, workingDayRuleOf } from '../../../shared/domain/business-day'

export function useBusinessDay() {
  const { tbl } = useMockDb()
  const holidays = tbl('holidays')
  const { ruleFor } = useAttendance()

  const holidaySet = computed(() => new Set(holidays.value.map(h => h.date)))

  /** date が祝日ならその名称（祝日でなければ undefined）。カレンダー表示用 */
  function holidayNameOf(date: string): string | undefined {
    return holidays.value.find(h => h.date === date)?.name
  }

  /** メンバーの営業日ルールで date が営業日か */
  function isWorkingDayFor(memberId: string, date: string): boolean {
    return isWorkingDay(date, workingDayRuleOf(ruleFor(memberId)), holidaySet.value)
  }

  /** メンバーの営業日ルールでの翌営業日（date の翌日以降で最初の営業日） */
  function nextWorkingDayFor(memberId: string, date: string): string {
    return nextWorkingDay(date, workingDayRuleOf(ruleFor(memberId)), holidaySet.value)
  }

  return { holidaySet, holidayNameOf, isWorkingDayFor, nextWorkingDayFor }
}
