/**
 * 有給休暇（F-04-5）: 付与・FIFO 引当による残数・年5日取得義務・申請/承認
 * - 付与の SoT は leaveGrants（history.ts が労基法 39 条テーブルから生成）
 * - 消化の SoT は leaveRequests（approved のみ残数に影響。half は 0.5 日）
 * - 残数 = 付与 − 消化（時効 2 年 = expireDate 超過分は除外・保有上限 40 日）
 */
import type { LeaveGrant, LeaveRequest, Result } from '~/types/domain'
import type { Tone } from '~/types/ui'
import { toDateKey } from '~/utils/format'

// ---------- 表示ラベル（labels.ts は共有ファイルのためここに定義） ----------

export const LEAVE_UNIT_LABELS: Record<LeaveRequest['unit'], string> = {
  full: '全日',
  half: '半日',
}

export const LEAVE_REQUEST_STATUS_LABELS: Record<LeaveRequest['status'], string> = {
  pending: '申請中',
  approved: '承認',
  rejected: '却下',
}

export const LEAVE_REQUEST_STATUS_TONES: Record<LeaveRequest['status'], Tone> = {
  pending: 'info',
  approved: 'ok',
  rejected: 'crit',
}

// ---------- 型 ----------

export interface LeaveGrantAllocation {
  grant: LeaveGrant
  /** この付与から引当済みの消化日数 */
  consumed: number
  /** この付与の残日数（失効判定前） */
  remaining: number
  /** 今日時点で失効しているか */
  expired: boolean
}

export interface LeaveBalance {
  /** 現在の残数（失効分を除外・保有上限 40 日） */
  remaining: number
  /** 直近の失効予定（このまま未消化なら失効する見込み日数） */
  nextExpire: { date: string; days: number } | null
  /** 今年度（4 月起算）の取得日数 */
  usedThisFiscalYear: number
  /** 付与別の引当明細 */
  allocations: LeaveGrantAllocation[]
}

export interface LeaveObligation {
  /** 年 10 日以上の付与があるか（義務の対象か） */
  applicable: boolean
  grantDate: string
  /** 取得期限（付与日から 1 年） */
  deadline: string
  /** 期間内の取得日数 */
  taken: number
  /** 必要日数（5 日） */
  required: number
  /** 期限までの残日数（負値 = 期限超過） */
  daysLeft: number
  achieved: boolean
  /** 未達かつ残り 3 ヶ月未満 */
  warn: boolean
}

const OBLIGATION_REQUIRED_DAYS = 5
const OBLIGATION_MIN_GRANT_DAYS = 10
const OBLIGATION_WARN_DAYS_LEFT = 92 // 約 3 ヶ月
const MAX_CARRY_DAYS = 40

function unitDays(unit: LeaveRequest['unit']): number {
  return unit === 'half' ? 0.5 : 1
}

/** 今年度（自社の 4 月起算）の範囲 */
function fiscalYearRange(todayKey: string): { from: string; to: string } {
  const y = Number(todayKey.slice(0, 4))
  const m = Number(todayKey.slice(5, 7))
  const start = m >= 4 ? y : y - 1
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` }
}

export function useLeave() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { notify, notifyAdmins } = useNotifications()
  const grants = tbl('leaveGrants')
  const requests = tbl('leaveRequests')

  function grantsOf(memberId: string): LeaveGrant[] {
    return grants.value
      .filter(g => g.memberId === memberId)
      .sort((a, b) => a.grantDate.localeCompare(b.grantDate))
  }

  function requestsOf(memberId: string): LeaveRequest[] {
    return requests.value
      .filter(r => r.memberId === memberId)
      .sort((a, b) => b.date.localeCompare(a.date))
  }

  /** 承認待ちの全申請（管理者ビュー用・取得日昇順） */
  const pendingRequests = computed(() =>
    requests.value
      .filter(r => r.status === 'pending')
      .sort((a, b) => a.date.localeCompare(b.date)),
  )

  /**
   * 残数の算出（純粋な射影。呼び出し側の computed 内で使えばリアクティブに追従する）
   * approved 消化を付与へ FIFO（古い付与から）で引当て、失効超過分を除いた残数を返す。
   */
  function balance(memberId: string): LeaveBalance {
    const today = todayJst()
    const gs = grantsOf(memberId)
    const consumptions = requests.value
      .filter(r => r.memberId === memberId && r.status === 'approved')
      .sort((a, b) => a.date.localeCompare(b.date))

    const alloc = gs.map(g => ({ grant: g, consumed: 0 }))
    for (const c of consumptions) {
      let rest = unitDays(c.unit)
      for (const a of alloc) {
        if (rest <= 0) break
        // 取得日時点で有効な付与（付与済み・失効前）から古い順に引当てる
        if (a.grant.grantDate > c.date || a.grant.expireDate <= c.date) continue
        const take = Math.min(a.grant.days - a.consumed, rest)
        if (take <= 0) continue
        a.consumed += take
        rest -= take
      }
      // 引当先のない消化は残数に影響させない（シード不整合時の防御）
    }

    const allocations: LeaveGrantAllocation[] = alloc.map(a => ({
      grant: a.grant,
      consumed: a.consumed,
      remaining: Math.max(0, a.grant.days - a.consumed),
      expired: a.grant.expireDate <= today,
    }))
    const remaining = Math.min(
      MAX_CARRY_DAYS,
      allocations.filter(a => !a.expired).reduce((s, a) => s + a.remaining, 0),
    )
    const next = allocations
      .filter(a => !a.expired && a.remaining > 0)
      .sort((a, b) => a.grant.expireDate.localeCompare(b.grant.expireDate))[0]

    const fy = fiscalYearRange(today)
    const usedThisFiscalYear = consumptions
      .filter(c => c.date >= fy.from && c.date <= fy.to)
      .reduce((s, c) => s + unitDays(c.unit), 0)

    return {
      remaining,
      nextExpire: next ? { date: next.grant.expireDate, days: next.remaining } : null,
      usedThisFiscalYear,
      allocations,
    }
  }

  /** 年 5 日取得義務（年 10 日以上付与された直近付与日から 1 年以内に 5 日以上） */
  function obligation(memberId: string): LeaveObligation {
    const today = todayJst()
    const target = grantsOf(memberId)
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
    const deadline = toDateKey(deadlineDate)
    const taken = requests.value
      .filter(r => r.memberId === memberId && r.status === 'approved'
        && r.date >= target.grantDate && r.date < deadline)
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

  /** 有給申請（残数チェック → pending 追記 → 管理者へ通知） */
  function request(input: { date: string; unit: LeaveRequest['unit']; reason: string }): Result {
    if (!input.date) {
      return { ok: false, error: { code: 'AKO-GEN-001', message: '取得日を選択してください' } }
    }
    const needed = unitDays(input.unit)
    const bal = balance(currentUser.value.id)
    if (bal.remaining < needed) {
      return {
        ok: false,
        error: { code: 'AKO-LEV-001', message: `有給残数が不足しています（残 ${bal.remaining} 日 / 必要 ${needed} 日）。付与状況をご確認ください` },
      }
    }
    const id = nextId('leaveRequests', 'lv')
    requests.value = [...requests.value, {
      id,
      memberId: currentUser.value.id,
      date: input.date,
      unit: input.unit,
      status: 'pending',
      reason: input.reason,
      decidedBy: null,
    }]
    commit()
    // 管理者への通知は補助処理（失敗しても申請は成立）
    notifyAdmins('approval', '有給申請',
      `${currentUser.value.name} さんから ${input.date}（${LEAVE_UNIT_LABELS[input.unit]}）の有給申請`,
      '/attendance?tab=requests')
    return { ok: true, id }
  }

  /** 有給申請の承認/却下（管理者）。pending ガード + decidedBy 記録 + 申請者へ通知 */
  function decide(requestId: string, action: 'approved' | 'rejected'): Result {
    if (currentUser.value.role !== 'admin') {
      return { ok: false, error: { code: 'AKO-LEV-003', message: 'この操作には管理者権限が必要です' } }
    }
    const req = requests.value.find(r => r.id === requestId)
    if (!req || req.status !== 'pending') {
      return { ok: false, error: { code: 'AKO-LEV-002', message: 'この申請は処理済みです' } }
    }
    if (action === 'approved') {
      const bal = balance(req.memberId)
      if (bal.remaining < unitDays(req.unit)) {
        return { ok: false, error: { code: 'AKO-LEV-001', message: '申請者の有給残数が不足しているため承認できません' } }
      }
    }
    requests.value = requests.value.map(r => r.id === requestId
      ? { ...r, status: action, decidedBy: currentUser.value.id }
      : r)
    commit()
    // 申請者への通知は補助処理
    notify(
      req.memberId,
      'approval',
      `有給申請が${action === 'approved' ? '承認' : '却下'}されました`,
      `${req.date}（${LEAVE_UNIT_LABELS[req.unit]}）`,
      '/attendance?tab=requests',
    )
    return { ok: true, id: requestId }
  }

  return { grants, requests, grantsOf, requestsOf, pendingRequests, balance, obligation, request, decide }
}
