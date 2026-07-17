/**
 * 勤怠ドメインのシードデータ（このファイルは F-04 実装者が所有・拡充する）
 * - 打刻履歴・有給付与の生成ロジックは history.ts（buildPunchHistory / buildLeaveGrants）が SoT
 * - ここには申請系の記録（打刻修正申請・有給申請）を置く
 * - 打刻履歴は平日のみ生成されるため、対象日は平日に丸めて整合を保つ（決定的）
 */
import type { AttendanceFixRequest, LeaveRequest } from '~/types/domain'
import { addDays, weekdayOf } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

/** N 日前に最も近い過去の平日（土日は避ける） */
function pastWeekday(back: number): string {
  let d = addDays(today, -back)
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, -1)
  return d
}

/** N 日後に最も近い未来の平日（土日は避ける） */
function futureWeekday(fwd: number): string {
  let d = addDays(today, fwd)
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, 1)
  return d
}

/** 打刻修正申請（pending 1 / approved 1） */
export const seedAttendanceFixRequests: AttendanceFixRequest[] = [
  { id: 'fix-0001', memberId: 'm-07', date: pastWeekday(3), kind: 'out', requestedAt: `${pastWeekday(3)}T19:30:00+09:00`, reason: '退勤打刻を忘れて帰宅したため', status: 'pending', decidedBy: null },
  { id: 'fix-0002', memberId: 'm-05', date: pastWeekday(7), kind: 'in', requestedAt: `${pastWeekday(7)}T08:55:00+09:00`, reason: '客先直行のため出勤打刻ができなかった', status: 'approved', decidedBy: 'm-03' },
]

/** 休暇申請（有給 4 件 + 特別休暇 2 件。休暇管理の一覧・明細デモを兼ねる） */
export const seedLeaveRequests: LeaveRequest[] = [
  { id: 'lv-0001', memberId: 'm-06', leaveTypeId: 'lt-paid', date: futureWeekday(7), unit: 'full', status: 'pending', reason: '私用のため', decidedBy: null },
  { id: 'lv-0002', memberId: 'm-04', leaveTypeId: 'lt-paid', date: pastWeekday(14), unit: 'full', status: 'approved', reason: '家族旅行', decidedBy: 'm-03' },
  { id: 'lv-0003', memberId: 'm-10', leaveTypeId: 'lt-paid', date: pastWeekday(5), unit: 'half', status: 'approved', reason: '通院のため', decidedBy: 'm-01' },
  { id: 'lv-0004', memberId: 'm-04', leaveTypeId: 'lt-paid', date: futureWeekday(3), unit: 'full', status: 'rejected', reason: '帰省のため', decidedBy: 'm-03' },
  { id: 'lv-0005', memberId: 'm-05', leaveTypeId: 'lt-summer', date: pastWeekday(10), unit: 'full', status: 'approved', reason: '夏季休暇の取得', decidedBy: 'm-10' },
  { id: 'lv-0006', memberId: 'm-06', leaveTypeId: 'lt-wedding', date: futureWeekday(14), unit: 'full', status: 'approved', reason: '結婚式のため', decidedBy: 'm-10' },
]
