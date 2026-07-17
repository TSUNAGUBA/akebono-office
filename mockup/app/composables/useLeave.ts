/**
 * 休暇管理（F-04-5 / F-04-9）: 付与・FIFO 引当による残数・年5日取得義務・申請/承認・手動付与
 * - 休暇種別は leaveTypes マスタ（F-10-10）。有給（lt-paid）は周期自動付与、特別休暇は権利者の手動付与
 * - 付与の SoT は leaveGrants（有給は周期付与 API。特別休暇は grant/bulkGrant）
 * - 消化の SoT は leaveRequests（approved のみ残数に影響。half は 0.5 日）
 * - 残数 = 付与 − 消化（expireDate 超過分は除外。法定有給のみ保有上限 40 日）
 * - 付与（grant/bulkGrant）と申請の承認/却下は 管理者/人事（isHrOrAdmin）のみ実行可
 *
 * デュアルモード（バッチ2b-2）:
 * - API モードは /v1/leave の grants/requests をハイドレーションし、残数・義務の射影
 *   （balance/obligation = 純関数）は共通利用する。書込（申請・承認・付与）は API を呼んでから
 *   キャッシュを取り直す（原則6）。残数チェック等の最終判定はサーバー側が FOR UPDATE で行う。
 */
import type { Ref } from 'vue'
import type { LeaveGrant, LeaveRequest, LeaveType, Result } from '~/types/domain'
import type { Tone } from '~/types/ui'
import { toDateKey } from '~/utils/format'

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiGrants = ref<LeaveGrant[]>([])
const apiRequests = ref<LeaveRequest[]>([])

function loadGrants(force = false): Promise<void> {
  return apiLoadOnce('leave:grants', async () => {
    const me = useApiMe().value
    const scopeAll = me?.role === 'admin' || me?.role === 'hr'
    apiGrants.value = await apiFetch<LeaveGrant[]>('/v1/leave/grants',
      { query: scopeAll ? {} : { memberId: me?.id ?? '' } })
  }, force)
}

function loadRequests(force = false): Promise<void> {
  return apiLoadOnce('leave:requests', async () => {
    const me = useApiMe().value
    const scopeAll = me?.role === 'admin' || me?.role === 'hr'
    apiRequests.value = await apiFetch<LeaveRequest[]>('/v1/leave/requests',
      { query: scopeAll ? { scope: 'all' } : {} })
  }, force)
}

// ログイン確立・切替時に取り直す（キーの解除は resetApiData が一括で行う）
onApiReset(() => {
  apiGrants.value = []
  apiRequests.value = []
  void loadGrants(true)
  void loadRequests(true)
})

/** 法定有給の休暇種別 id（labels ではなくシード規約。seed/core.ts の seedLeaveTypes と一致） */
export const PAID_LEAVE_TYPE_ID = 'lt-paid'

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
  const { currentUser, isHrOrAdmin } = useCurrentUser()
  const { notify, notifyAdmins } = useNotifications()
  const isApi = useApiMode()
  // API モードは付与・申請をサーバーからハイドレーションし、残数等の射影ロジックを共通利用する
  const grants = isApi ? (apiGrants as Ref<LeaveGrant[]>) : tbl('leaveGrants')
  const requests = isApi ? (apiRequests as Ref<LeaveRequest[]>) : tbl('leaveRequests')
  const leaveTypes = tbl('leaveTypes')
  if (isApi) {
    void loadGrants()
    void loadRequests()
  }

  const activeLeaveTypes = computed(() =>
    leaveTypes.value.filter(t => t.active).sort((a, b) => a.displayOrder - b.displayOrder))

  function leaveTypeOf(leaveTypeId: string): LeaveType | undefined {
    return leaveTypes.value.find(t => t.id === leaveTypeId)
  }

  function leaveTypeName(leaveTypeId: string): string {
    return leaveTypeOf(leaveTypeId)?.name ?? leaveTypeId
  }

  function grantsOf(memberId: string, leaveTypeId = PAID_LEAVE_TYPE_ID): LeaveGrant[] {
    return grants.value
      .filter(g => g.memberId === memberId && g.leaveTypeId === leaveTypeId)
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
   * 保有上限 40 日は法定有給（isStatutory）のみ適用。
   */
  function balance(memberId: string, leaveTypeId = PAID_LEAVE_TYPE_ID): LeaveBalance {
    const today = todayJst()
    const gs = grantsOf(memberId, leaveTypeId)
    const consumptions = requests.value
      .filter(r => r.memberId === memberId && r.leaveTypeId === leaveTypeId && r.status === 'approved')
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
    const rawRemaining = allocations.filter(a => !a.expired).reduce((s, a) => s + a.remaining, 0)
    const remaining = leaveTypeOf(leaveTypeId)?.isStatutory
      ? Math.min(MAX_CARRY_DAYS, rawRemaining)
      : rawRemaining
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

  /** 休暇申請（種別別の残数チェック → pending 追記 → 管理者へ通知） */
  async function request(input: { date: string; unit: LeaveRequest['unit']; reason: string; leaveTypeId?: string }): Promise<Result> {
    if (!input.date) {
      return { ok: false, error: { code: 'AKO-GEN-001', message: '取得日を選択してください' } }
    }
    const leaveTypeId = input.leaveTypeId ?? PAID_LEAVE_TYPE_ID
    const typeName = leaveTypeName(leaveTypeId)
    const needed = unitDays(input.unit)
    const bal = balance(currentUser.value.id, leaveTypeId)
    if (bal.remaining < needed) {
      return {
        ok: false,
        error: { code: 'AKO-LEV-001', message: `${typeName}の残数が不足しています（残 ${bal.remaining} 日 / 必要 ${needed} 日）。付与状況をご確認ください` },
      }
    }
    if (isApi) {
      // 残数の最終判定・管理者通知はサーバー。成立後に申請一覧を取り直す（原則6）
      const res = await apiResult(() => apiFetch<{ id: string }>('/v1/leave/requests', {
        method: 'POST',
        body: { date: input.date, unit: input.unit, reason: input.reason, leaveTypeId },
      }))
      if (res.ok) await loadRequests(true)
      return res
    }
    const id = nextId('leaveRequests', 'lv')
    requests.value = [...requests.value, {
      id,
      memberId: currentUser.value.id,
      leaveTypeId,
      date: input.date,
      unit: input.unit,
      status: 'pending',
      reason: input.reason,
      decidedBy: null,
    }]
    commit()
    // 管理者への通知は補助処理（失敗しても申請は成立）
    notifyAdmins('approval', `${typeName}申請`,
      `${currentUser.value.name} さんから ${input.date}（${LEAVE_UNIT_LABELS[input.unit]}）の${typeName}申請`,
      '/attendance?tab=requests')
    return { ok: true, id }
  }

  /** 休暇申請の承認/却下（管理者/人事）。pending ガード + decidedBy 記録 + 申請者へ通知 */
  async function decide(requestId: string, action: 'approved' | 'rejected'): Promise<Result> {
    if (!isHrOrAdmin.value) {
      return { ok: false, error: { code: 'AKO-LEV-003', message: 'この操作には管理者または人事の権限が必要です' } }
    }
    if (isApi) {
      // pending ガード・残数再チェック・申請者通知はサーバー（FOR UPDATE）。成立後に一覧を取り直す
      const res = await apiResult(() =>
        apiFetch(`/v1/leave/requests/${requestId}/decision`, { method: 'POST', body: { action } }))
      if (res.ok) await loadRequests(true)
      return res
    }
    const req = requests.value.find(r => r.id === requestId)
    if (!req || req.status !== 'pending') {
      return { ok: false, error: { code: 'AKO-LEV-002', message: 'この申請は処理済みです' } }
    }
    if (action === 'approved') {
      const bal = balance(req.memberId, req.leaveTypeId)
      if (bal.remaining < unitDays(req.unit)) {
        return { ok: false, error: { code: 'AKO-LEV-001', message: `申請者の${leaveTypeName(req.leaveTypeId)}残数が不足しているため承認できません` } }
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
      `${leaveTypeName(req.leaveTypeId)}申請が${action === 'approved' ? '承認' : '却下'}されました`,
      `${req.date}（${LEAVE_UNIT_LABELS[req.unit]}）`,
      '/attendance?tab=requests',
    )
    return { ok: true, id: requestId }
  }

  // ---------- 手動付与（F-04-9。管理者/人事のみ） ----------

  /** 付与日 + 種別の使用期限（expiryMonths）から失効日を算出（期限なしは 9999-12-31） */
  function expireDateFor(leaveTypeId: string, grantDate: string): string {
    const months = leaveTypeOf(leaveTypeId)?.expiryMonths
    if (months == null) return '9999-12-31'
    const d = new Date(`${grantDate}T00:00:00`)
    d.setMonth(d.getMonth() + months)
    return toDateKey(d)
  }

  /**
   * 休暇の個別付与。冪等ガード: 同一メンバー × 種別 × 付与日の重複付与はスキップする
   * （誤操作・一括付与の再実行で残数が二重に増えるのを防ぐ）。
   */
  async function grant(input: { memberId: string; leaveTypeId: string; days: number; grantDate?: string }): Promise<Result & { skipped?: boolean }> {
    if (!isHrOrAdmin.value) {
      return { ok: false, error: { code: 'AKO-LEV-004', message: '休暇の付与には管理者または人事の権限が必要です' } }
    }
    const type = leaveTypeOf(input.leaveTypeId)
    if (!type || !type.active) {
      return { ok: false, error: { code: 'AKO-LEV-005', message: '有効な休暇種別を選択してください' } }
    }
    if (!(input.days > 0) || input.days > 40) {
      return { ok: false, error: { code: 'AKO-LEV-006', message: '付与日数は 1〜40 日で入力してください' } }
    }
    if (isApi) {
      // 冪等（同一メンバー×種別×付与日はスキップ）・本人通知はサーバー。成立後に付与一覧を取り直す
      try {
        const data = await apiFetch<{ id?: string; skipped: boolean }>('/v1/leave/grants', { method: 'POST', body: input })
        await loadGrants(true)
        return data.skipped ? { ok: true, skipped: true } : { ok: true, id: data.id }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const grantDate = input.grantDate || todayJst()
    const dup = grants.value.some(g =>
      g.memberId === input.memberId && g.leaveTypeId === input.leaveTypeId && g.grantDate === grantDate)
    if (dup) {
      return { ok: true, skipped: true }
    }
    const id = nextId('leaveGrants', 'lg')
    grants.value = [...grants.value, {
      id,
      memberId: input.memberId,
      leaveTypeId: input.leaveTypeId,
      grantDate,
      days: input.days,
      kind: 'special',
      expireDate: expireDateFor(input.leaveTypeId, grantDate),
      grantedBy: currentUser.value.id,
    }]
    commit()
    // 本人への通知は補助処理
    notify(
      input.memberId,
      'system',
      `${type.name}が付与されました`,
      `${input.days} 日（有効期限 ${expireDateFor(input.leaveTypeId, grantDate)}）`,
      '/attendance?tab=leave',
    )
    return { ok: true, id }
  }

  /**
   * 一括付与（夏季休暇等を特定の対象へまとめて付与）。
   * 個別付与を対象者分繰り返す（重複はスキップ）。一部失敗でも続行し、結果件数を返す。
   */
  async function bulkGrant(input: { memberIds: string[]; leaveTypeId: string; days: number; grantDate?: string }):
  Promise<Result & { granted?: number; skipped?: number }> {
    if (!isHrOrAdmin.value) {
      return { ok: false, error: { code: 'AKO-LEV-004', message: '休暇の付与には管理者または人事の権限が必要です' } }
    }
    if (input.memberIds.length === 0) {
      return { ok: false, error: { code: 'AKO-LEV-007', message: '付与対象のメンバーを選択してください' } }
    }
    if (isApi) {
      // 一括付与はサーバーが 1 リクエストで処理（重複スキップで冪等）。成立後に付与一覧を取り直す
      try {
        const data = await apiFetch<{ granted: number; skipped: number }>('/v1/leave/grants/bulk', { method: 'POST', body: input })
        await loadGrants(true)
        return { ok: true, ...data }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    let granted = 0
    let skipped = 0
    for (const memberId of input.memberIds) {
      const r = await grant({ memberId, leaveTypeId: input.leaveTypeId, days: input.days, grantDate: input.grantDate })
      if (!r.ok) return { ok: false, error: r.error } // 権限・種別・日数エラーは全員共通のため即返す
      if (r.skipped) skipped++
      else granted++
    }
    return { ok: true, granted, skipped }
  }

  return {
    grants, requests, leaveTypes, activeLeaveTypes, leaveTypeOf, leaveTypeName,
    grantsOf, requestsOf, pendingRequests, balance, obligation, request, decide,
    grant, bulkGrant,
  }
}
