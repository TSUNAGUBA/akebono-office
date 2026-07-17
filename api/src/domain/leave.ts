/**
 * 休暇残数の算出（純粋関数。mockup useLeave.balance の移植 = ロジック互換）
 * - approved 消化を付与へ FIFO（古い付与から）で引当て、失効超過分を除いた残数を返す
 * - 保有上限 40 日は法定有給（isStatutory）のみ適用
 * フロント接続完了後は本モジュールが残数計算の SoT となる（クライアント側計算は廃止予定）。
 */
import type { LeaveGrant, LeaveRequest, LeaveType } from '../../../shared/domain/types'

export const MAX_CARRY_DAYS = 40
export const OBLIGATION_REQUIRED_DAYS = 5
export const OBLIGATION_MIN_GRANT_DAYS = 10
export const OBLIGATION_WARN_DAYS_LEFT = 92

export interface LeaveGrantAllocation {
  grant: LeaveGrant
  consumed: number
  remaining: number
  expired: boolean
}

export interface LeaveBalance {
  remaining: number
  nextExpire: { date: string; days: number } | null
  usedThisFiscalYear: number
  allocations: LeaveGrantAllocation[]
}

function unitDays(unit: LeaveRequest['unit']): number {
  return unit === 'half' ? 0.5 : 1
}

function fiscalYearRange(todayKey: string): { from: string; to: string } {
  const y = Number(todayKey.slice(0, 4))
  const m = Number(todayKey.slice(5, 7))
  const start = m >= 4 ? y : y - 1
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` }
}

/**
 * @param grants 対象メンバー × 種別の付与（grantDate 昇順である必要はない。内部でソート）
 * @param approvedRequests 対象メンバー × 種別の approved 消化
 */
export function calcLeaveBalance(
  grants: LeaveGrant[],
  approvedRequests: LeaveRequest[],
  leaveType: LeaveType | undefined,
  today: string,
): LeaveBalance {
  const gs = [...grants].sort((a, b) => a.grantDate.localeCompare(b.grantDate))
  const consumptions = [...approvedRequests].sort((a, b) => a.date.localeCompare(b.date))

  const alloc = gs.map(g => ({ grant: g, consumed: 0 }))
  for (const cReq of consumptions) {
    let rest = unitDays(cReq.unit)
    for (const a of alloc) {
      if (rest <= 0) break
      // 取得日時点で有効な付与（付与済み・失効前）から古い順に引当てる
      if (a.grant.grantDate > cReq.date || a.grant.expireDate <= cReq.date) continue
      const take = Math.min(a.grant.days - a.consumed, rest)
      if (take <= 0) continue
      a.consumed += take
      rest -= take
    }
    // 引当先のない消化は残数に影響させない（データ不整合時の防御）
  }

  const allocations: LeaveGrantAllocation[] = alloc.map(a => ({
    grant: a.grant,
    consumed: a.consumed,
    remaining: Math.max(0, a.grant.days - a.consumed),
    expired: a.grant.expireDate <= today,
  }))
  const rawRemaining = allocations.filter(a => !a.expired).reduce((s, a) => s + a.remaining, 0)
  const remaining = leaveType?.isStatutory ? Math.min(MAX_CARRY_DAYS, rawRemaining) : rawRemaining
  const next = allocations
    .filter(a => !a.expired && a.remaining > 0)
    .sort((a, b) => a.grant.expireDate.localeCompare(b.grant.expireDate))[0]

  const fy = fiscalYearRange(today)
  const usedThisFiscalYear = consumptions
    .filter(cReq => cReq.date >= fy.from && cReq.date <= fy.to)
    .reduce((s, cReq) => s + unitDays(cReq.unit), 0)

  return {
    remaining,
    nextExpire: next ? { date: next.grant.expireDate, days: next.remaining } : null,
    usedThisFiscalYear,
    allocations,
  }
}

export interface LeaveObligation {
  applicable: boolean
  grantDate: string
  deadline: string
  taken: number
  required: number
  daysLeft: number
  achieved: boolean
  warn: boolean
}

/** 年 5 日取得義務（年 10 日以上付与された直近付与日から 1 年以内に 5 日以上）。mockup useLeave.obligation の移植 */
export function calcObligation(
  statutoryGrants: LeaveGrant[],
  approvedRequests: LeaveRequest[],
  today: string,
): LeaveObligation {
  const target = [...statutoryGrants]
    .filter(g => g.days >= OBLIGATION_MIN_GRANT_DAYS && g.grantDate <= today)
    .sort((a, b) => b.grantDate.localeCompare(a.grantDate))[0]
  if (!target) {
    return {
      applicable: false, grantDate: '', deadline: '', taken: 0,
      required: OBLIGATION_REQUIRED_DAYS, daysLeft: 0, achieved: false, warn: false,
    }
  }
  const deadlineDate = new Date(`${target.grantDate}T00:00:00`)
  deadlineDate.setFullYear(deadlineDate.getFullYear() + 1)
  const deadline = `${deadlineDate.getFullYear()}-${String(deadlineDate.getMonth() + 1).padStart(2, '0')}-${String(deadlineDate.getDate()).padStart(2, '0')}`
  const taken = approvedRequests
    .filter(r => r.date >= target.grantDate && r.date < deadline)
    .reduce((s, r) => s + unitDays(r.unit), 0)
  const daysLeft = Math.ceil(
    (deadlineDate.getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000,
  )
  const achieved = taken >= OBLIGATION_REQUIRED_DAYS
  return {
    applicable: true,
    grantDate: target.grantDate,
    deadline,
    taken,
    required: OBLIGATION_REQUIRED_DAYS,
    daysLeft,
    achieved,
    warn: !achieved && daysLeft < OBLIGATION_WARN_DAYS_LEFT,
  }
}

/** 付与日 + 種別の使用期限（expiryMonths）から失効日を算出（期限なしは 9999-12-31）。mockup と同一規約（JS setMonth） */
export function expireDateFor(expiryMonths: number | null, grantDate: string): string {
  if (expiryMonths == null) return '9999-12-31'
  const d = new Date(`${grantDate}T00:00:00`)
  d.setMonth(d.getMonth() + expiryMonths)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
