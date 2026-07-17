/**
 * 勤怠の集計ドメイン（純粋関数。mockup useAttendance の移植 = ロジック互換）
 * 6 バケット分解・打刻置換の解決は shared/domain/attendance-calc.ts を共有利用する。
 * 重い集計（月次・タイムカード・36 協定）はすべてサーバーサイドで実行する方針（Phase 7）。
 */
import {
  calcWorkedMinutes, effectivePunches, judgeArticle36, requiredBreakMinutes, splitBuckets,
  type Article36Alert, type MonthOtRecord,
} from '../../../shared/domain/attendance-calc'
import { daysInMonth, hhmmToMin, weekdayOf } from '../../../shared/domain/jst'
import type {
  AttendanceRule, EmploymentType, Member, PunchKind, PunchRecord,
} from '../../../shared/domain/types'

export type PunchState = 'before' | 'working' | 'breaking' | 'done'

export const PUNCH_ALLOWED: Record<PunchState, PunchKind[]> = {
  before: ['in'],
  working: ['break_start', 'out'],
  breaking: ['break_end'],
  done: [],
}

/** 状態機械（未出勤→勤務中⇄休憩中→退勤済）。rows は同一日の生打刻列 */
export function punchState(rows: PunchRecord[]): PunchState {
  const effective = effectivePunches(rows)
  const last = effective[effective.length - 1]
  if (!last) return 'before'
  if (last.kind === 'out') return 'done'
  if (last.kind === 'break_start') return 'breaking'
  return 'working'
}

/**
 * メンバーに適用する勤怠ルールの解決（mockup ruleFor と同一優先順）。
 * ①個別指定（attendanceRuleId・有効なもののみ） ②雇用区分の既定（defaultFor）
 * ③雇用区分で選択可能なルールの先頭 ④先頭ルール（最終フォールバック）
 */
export function resolveRule(
  member: Pick<Member, 'attendanceRuleId' | 'employmentType'> | undefined,
  rules: AttendanceRule[],
): AttendanceRule | undefined {
  if (member?.attendanceRuleId) {
    const explicit = rules.find(r => r.id === member.attendanceRuleId && r.active)
    if (explicit) return explicit
  }
  if (member) {
    const et = member.employmentType as EmploymentType
    const def = rules.find(r => r.active && r.defaultFor.includes(et))
    if (def) return def
    const applicable = rules.find(r => r.active && r.appliesTo.includes(et))
    if (applicable) return applicable
  }
  return rules[0]
}

export interface DaySummary {
  date: string
  workMinutes: number
  breakMinutes: number
  nightMinutes: number
  buckets: ReturnType<typeof splitBuckets>
  breakShortage: number
  punches: PunchRecord[]
}

/** 日次サマリ（6 バケット分解）。rows は同一メンバー・同一日の生打刻列 */
export function daySummary(
  rows: PunchRecord[],
  rule: AttendanceRule | undefined,
  date: string,
  monthOtSoFar = 0,
): DaySummary {
  const effective = effectivePunches(rows)
  const { workMinutes, breakMinutes, nightMinutes } = calcWorkedMinutes(effective)
  const scheduled = rule
    ? Math.max(0, hhmmToMin(rule.workEnd) - hhmmToMin(rule.workStart) - rule.breakMinutes)
    : 480
  const isLegalHoliday = weekdayOf(date) === (rule?.legalHolidayWeekday ?? 0)
  const buckets = splitBuckets({
    workMinutes, scheduledMinutes: scheduled, nightMinutes, isLegalHoliday,
    monthNonStatutoryOtSoFar: monthOtSoFar,
  })
  const required = requiredBreakMinutes(workMinutes)
  return {
    date, workMinutes, breakMinutes, nightMinutes, buckets,
    breakShortage: Math.max(0, required - breakMinutes),
    punches: effective,
  }
}

export interface MonthSummary {
  days: DaySummary[]
  total: {
    scheduled: number
    statutoryOt: number
    nonStatutoryOt: number
    over60Ot: number
    night: number
    legalHoliday: number
  }
  workDays: number
}

/** 月次サマリ（日別 + 合計）。punchesByDate は同一メンバーの月内打刻を日付キーで分類したもの */
export function monthSummary(
  punchesByDate: Map<string, PunchRecord[]>,
  rule: AttendanceRule | undefined,
  month: string,
): MonthSummary {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))]
  const days: DaySummary[] = []
  let otSoFar = 0
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`
    const s = daySummary(punchesByDate.get(date) ?? [], rule, date, otSoFar)
    otSoFar += s.buckets.nonStatutoryOt + s.buckets.over60Ot
    days.push(s)
  }
  const total = days.reduce((acc, s) => ({
    scheduled: acc.scheduled + s.buckets.scheduled,
    statutoryOt: acc.statutoryOt + s.buckets.statutoryOt,
    nonStatutoryOt: acc.nonStatutoryOt + s.buckets.nonStatutoryOt,
    over60Ot: acc.over60Ot + s.buckets.over60Ot,
    night: acc.night + s.buckets.night,
    legalHoliday: acc.legalHoliday + s.buckets.legalHoliday,
  }), { scheduled: 0, statutoryOt: 0, nonStatutoryOt: 0, over60Ot: 0, night: 0, legalHoliday: 0 })
  return { days, total, workDays: days.filter(s => s.workMinutes > 0).length }
}

/**
 * 36 協定アラート（endMonth を最終月とする直近 6 ヶ月）。mockup alerts と同一判定。
 * punchesByMonthDate: 6 ヶ月分の打刻を日付キーで分類したもの
 */
export function article36Alerts(
  punchesByDate: Map<string, PunchRecord[]>,
  rule: AttendanceRule | undefined,
  endMonth: string,
): Article36Alert[] {
  const [ey, em] = [Number(endMonth.slice(0, 4)), Number(endMonth.slice(5, 7))]
  const months: MonthOtRecord[] = []
  let over45 = 0
  for (let back = 5; back >= 0; back--) {
    const idx = ey * 12 + (em - 1) - back
    const month = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
    const s = monthSummary(punchesByDate, rule, month)
    const rec = {
      month,
      nonStatutoryOtMin: s.total.nonStatutoryOt + s.total.over60Ot,
      legalHolidayMin: s.total.legalHoliday,
    }
    months.push(rec)
    // 45h ちょうどは「以内」で適法のため、年 6 回カウントも厳密に「超」のみ（judgeArticle36 と統一）
    if (rec.nonStatutoryOtMin > 45 * 60) over45++
  }
  return judgeArticle36(months, over45)
}
