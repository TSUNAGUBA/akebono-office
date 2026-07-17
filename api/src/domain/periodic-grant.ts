/**
 * 有給休暇の周期自動付与（労基法 39 条。F-04-5 / leave_types.grant_method='periodic'）
 * - 付与日 = 入社日 + 6 ヶ月 + n 年（JS setMonth 規約 = mockup シード history.ts と同一）
 * - 日数 = leaveGrantDays（週所定 30h/5 日以上は通常テーブル、未満は比例付与テーブル）
 * - 失効 = 付与日 + 2 年（時効）
 * - 冪等: 既に失効した過去分は生成せず、挿入は UNIQUE(member × 種別 × 付与日) で重複スキップ
 */
import { leaveGrantDays } from '../../../shared/domain/attendance-calc'
import { toDateKey } from '../../../shared/domain/jst'

export interface PeriodicGrantCandidate {
  memberId: string
  grantDate: string
  days: number
  kind: 'normal' | 'proportional'
  expireDate: string
}

export interface PeriodicGrantMemberInput {
  id: string
  hireDate: string | null
  weeklyDays: number
  weeklyHours: number
}

/** 対象メンバーの「今日までに到来し、まだ失効していない」周期付与を列挙する（純粋関数） */
export function periodicGrantsFor(member: PeriodicGrantMemberInput, today: string): PeriodicGrantCandidate[] {
  if (!member.hireDate) return []
  const rows: PeriodicGrantCandidate[] = []
  const hire = new Date(`${member.hireDate}T00:00:00`)
  for (let years = 0; years < 100; years++) {
    const grantDate = new Date(hire)
    grantDate.setMonth(grantDate.getMonth() + 6 + years * 12)
    const grantKey = toDateKey(grantDate)
    if (grantKey > today) break
    const expire = new Date(grantDate)
    expire.setFullYear(expire.getFullYear() + 2)
    const expireKey = toDateKey(expire)
    if (expireKey <= today) continue // 既に時効切れの過去分は生成しない
    const days = leaveGrantDays(member.weeklyDays, member.weeklyHours, years + 0.5)
    if (days <= 0) continue
    rows.push({
      memberId: member.id,
      grantDate: grantKey,
      days,
      kind: member.weeklyHours >= 30 || member.weeklyDays >= 5 ? 'normal' : 'proportional',
      expireDate: expireKey,
    })
  }
  return rows
}
