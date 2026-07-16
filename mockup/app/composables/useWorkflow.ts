/**
 * ワークフロー・稟議（F-07）
 * - 経路解決は utils/approval-route.ts の resolveRoute（純粋関数）を利用
 * - 承認ログ（approvalLogs）は追記のみの監査証跡。巻き戻さない
 * - 通知は補助処理（useNotifications 側で非ブロッキング保証）
 * - 状態機械: draft → submitted → in_review(step 1..n) → approved / rejected / remanded / withdrawn
 */
import type {
  ApprovalAction, DelegateSetting, Member, Result, WorkflowCategory,
  WorkflowRequest, WorkflowRouteStep,
} from '~/types/domain'
import { resolveRoute } from '~/utils/approval-route'
import { fmtYen } from '~/utils/format'
import { APPROVAL_ACTION_LABELS, WORKFLOW_CATEGORY_LABELS } from '~/utils/labels'

/** 承認ロール → 日本語ラベル（本領域固有の区分値。共有 labels.ts は編集不可のためここが SoT） */
export const APPROVER_ROLE_LABELS: Record<WorkflowRouteStep['approverRole'], string> = {
  manager: 'マネージャー',
  director: '取締役',
  president: '代表取締役',
}

export interface WorkflowInput {
  category: WorkflowCategory
  title: string
  amount: number
  body: string
  attachments: string[]
}

/** WidgetsApprovalFlow へ渡す表示用ステップ */
export interface FlowStepView {
  label: string
  name: string
  state: 'done' | 'current' | 'future' | 'rejected' | 'remanded'
}

export function useWorkflow() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { notify } = useNotifications()
  const requests = tbl('workflowRequests')
  const logs = tbl('approvalLogs')
  const routes = tbl('workflowRoutes')
  const members = tbl('members')
  const delegates = tbl('delegateSettings')
  const delegateCrud = useMasterCrud('delegateSettings', 'dg')

  function err(code: string, message: string): Result {
    return { ok: false, error: { code, message } }
  }

  // ---------- 承認者解決 ----------

  function presidentMember(): Member | undefined {
    return members.value.find(m => m.active && m.title === '代表取締役')
  }

  /** 承認ロール → 実メンバー解決（見つからなければ president へフォールバック） */
  function approverFor(role: WorkflowRouteStep['approverRole']): Member | undefined {
    const president = presidentMember()
    if (role === 'president') return president
    if (role === 'director') {
      return members.value.find(m =>
        m.active && m.employmentType === 'director' && m.id !== president?.id) ?? president
    }
    return members.value.find(m =>
      m.active && m.role === 'admin' && m.employmentType === 'employee') ?? president
  }

  /** ステップの承認者（個人指定があれば優先。無効なら ロール解決へ） */
  function stepApprover(step: WorkflowRouteStep): Member | undefined {
    if (step.approverMemberId) {
      const fixed = members.value.find(m => m.id === step.approverMemberId && m.active)
      if (fixed) return fixed
    }
    return approverFor(step.approverRole)
  }

  /** 区分×金額に合致する経路（null = 該当なし = AKO-WFL-003） */
  function resolveRouteFor(category: WorkflowCategory, amount: number): WorkflowRouteStep[] | null {
    return resolveRoute(routes.value, category, amount)
  }

  // ---------- 代理承認 ----------

  /** 期間が今日を含む有効な代理設定か */
  function isDelegateActive(d: DelegateSetting): boolean {
    const t = todayJst()
    return d.active && d.from <= t && t <= d.to
  }

  /** approverId の有効な代理人として memberId が動けるか */
  function isActiveDelegateOf(approverId: string, memberId: string): boolean {
    return delegates.value.some(d =>
      d.memberId === approverId && d.delegateMemberId === memberId && isDelegateActive(d))
  }

  const myDelegates = computed(() =>
    delegates.value.filter(d => d.memberId === currentUser.value.id && d.active))

  function saveDelegate(input: { delegateMemberId: string; from: string; to: string }): Result {
    if (!input.delegateMemberId || !input.from || !input.to) {
      return err('AKO-GEN-001', '代理人と期間を入力してください')
    }
    if (input.delegateMemberId === currentUser.value.id) {
      return err('AKO-GEN-001', '自分自身を代理人にはできません')
    }
    if (input.to < input.from) {
      return err('AKO-GEN-001', '期間の終了日は開始日以降にしてください')
    }
    return delegateCrud.save({ memberId: currentUser.value.id, ...input, active: true })
  }

  /** 代理設定の解除（論理削除） */
  function removeDelegate(id: string): Result {
    return delegateCrud.archive(id)
  }

  // ---------- 参照系 ----------

  function byId(id: string): WorkflowRequest | undefined {
    return requests.value.find(r => r.id === id)
  }

  function logsOf(requestId: string) {
    return logs.value
      .filter(l => l.requestId === requestId)
      .sort((a, b) => a.at.localeCompare(b.at))
  }

  /** 現在ステップの承認者（未確定なら undefined） */
  function currentApproverOf(req: WorkflowRequest): Member | undefined {
    const step = req.routeSnapshot[req.currentStep - 1]
    return step ? stepApprover(step) : undefined
  }

  /** memberId が本人 or 有効な代理としてこの申請を承認操作できるか */
  function canActOn(req: WorkflowRequest, memberId: string): boolean {
    if (req.status !== 'in_review' && req.status !== 'submitted') return false
    const approver = currentApproverOf(req)
    if (!approver) return false
    return approver.id === memberId || isActiveDelegateOf(approver.id, memberId)
  }

  /** 自分が現在ステップの承認者 or 代理先である承認待ち一覧 */
  function pendingFor(memberId: string): WorkflowRequest[] {
    return requests.value
      .filter(r => canActOn(r, memberId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  function memberName(id: string): string {
    return members.value.find(m => m.id === id)?.name ?? id
  }

  // ---------- 表示射影（ApprovalFlow 用） ----------

  function flowSteps(req: Pick<WorkflowRequest, 'routeSnapshot' | 'status' | 'currentStep'>): FlowStepView[] {
    return [...req.routeSnapshot]
      .sort((a, b) => a.order - b.order)
      .map((s) => {
        let state: FlowStepView['state'] = 'future'
        if (req.status === 'approved' || s.order < req.currentStep) {
          state = 'done'
        } else if (s.order === req.currentStep) {
          if (req.status === 'rejected') state = 'rejected'
          else if (req.status === 'remanded') state = 'remanded'
          else if (req.status === 'in_review' || req.status === 'submitted') state = 'current'
        }
        return {
          label: APPROVER_ROLE_LABELS[s.approverRole],
          name: stepApprover(s)?.name ?? '未設定',
          state,
        }
      })
  }

  /** 申請作成モーダルのリアルタイム経路プレビュー（null = 経路該当なし） */
  function previewSteps(category: WorkflowCategory, amount: number): FlowStepView[] | null {
    const route = resolveRouteFor(category, amount)
    if (!route) return null
    return route.map(s => ({
      label: APPROVER_ROLE_LABELS[s.approverRole],
      name: stepApprover(s)?.name ?? '未設定',
      state: 'future' as const,
    }))
  }

  // ---------- 書込系 ----------

  function appendLog(requestId: string, step: number, action: ApprovalAction, comment: string, delegateForId: string | null = null): void {
    logs.value = [...logs.value, {
      id: nextId('approvalLogs', 'apl'),
      requestId,
      step,
      actorId: currentUser.value.id,
      delegateForId,
      action,
      comment,
      at: nowJstIso(),
    }]
  }

  function patch(id: string, p: Partial<WorkflowRequest>): void {
    requests.value = requests.value.map(r => r.id === id ? { ...r, ...p } : r)
  }

  function validateInput(input: WorkflowInput): Result | null {
    if (!input.title.trim()) return err('AKO-GEN-001', '件名を入力してください')
    if (!Number.isFinite(input.amount) || input.amount < 0) {
      return err('AKO-GEN-001', '金額を 0 以上で入力してください')
    }
    return null
  }

  /** 下書き保存（経路は未確定のまま。既存下書きの更新可） */
  function saveDraft(input: WorkflowInput, requestId?: string): Result {
    const invalid = validateInput(input)
    if (invalid) return invalid
    if (requestId) {
      const existing = byId(requestId)
      if (!existing) return err('AKO-GEN-002', '対象の申請が見つかりません')
      if (existing.requesterId !== currentUser.value.id) return err('AKO-WFL-001', '申請者本人のみ編集できます')
      if (existing.status !== 'draft') return err('AKO-WFL-001', '下書き以外は下書き保存できません')
      patch(requestId, { ...input })
      commit()
      return { ok: true, id: requestId }
    }
    const id = nextId('workflowRequests', 'WF')
    requests.value = [...requests.value, {
      id,
      ...input,
      requesterId: currentUser.value.id,
      status: 'draft',
      currentStep: 0,
      routeSnapshot: [],
      createdAt: nowJstIso(),
    }]
    commit()
    return { ok: true, id }
  }

  /**
   * 申請提出。requestId 指定時は draft の申請 / remanded の再申請
   * （経路をゼロから再解決して先頭ステップへ戻す）。
   * 経路を routeSnapshot に凍結し、submitted → in_review へ即遷移する。
   */
  function submit(input: WorkflowInput, requestId?: string): Result {
    const invalid = validateInput(input)
    if (invalid) return invalid
    const route = resolveRouteFor(input.category, input.amount)
    if (!route || route.length === 0) {
      return err('AKO-WFL-003', 'この区分・金額に該当する承認経路がありません。経路設定を確認してください')
    }

    let id: string
    if (requestId) {
      const existing = byId(requestId)
      if (!existing) return err('AKO-GEN-002', '対象の申請が見つかりません')
      if (existing.requesterId !== currentUser.value.id) return err('AKO-WFL-001', '申請者本人のみ再申請できます')
      if (existing.status !== 'draft' && existing.status !== 'remanded') {
        return err('AKO-WFL-001', 'この申請は提出できる状態ではありません')
      }
      id = requestId
      patch(id, { ...input, status: 'in_review', currentStep: 1, routeSnapshot: route })
    } else {
      id = nextId('workflowRequests', 'WF')
      requests.value = [...requests.value, {
        id,
        ...input,
        requesterId: currentUser.value.id,
        status: 'in_review',
        currentStep: 1,
        routeSnapshot: route,
        createdAt: nowJstIso(),
      }]
    }
    appendLog(id, 0, 'submit', '')
    commit()

    // 補助処理: step1 承認者へ通知（失敗しても提出は成立）
    const first = route[0]
    const approver = first ? stepApprover(first) : undefined
    if (approver && approver.id !== currentUser.value.id) {
      notify(
        approver.id,
        'approval',
        `承認依頼: ${input.title}`,
        `${currentUser.value.name} さんから${WORKFLOW_CATEGORY_LABELS[input.category]}稟議（${fmtYen(input.amount)}）が届いています`,
        '/workflow',
      )
    }
    return { ok: true, id }
  }

  function notifySafe(memberId: string, title: string, body: string): void {
    if (memberId !== currentUser.value.id) {
      notify(memberId, 'approval', title, body, '/workflow')
    }
  }

  /**
   * 承認操作（approve / reject / remand / withdraw）
   * - 権限ガード: 現在ステップの承認者本人 or 有効な代理人（違反 AKO-WFL-001）
   * - reject / remand はコメント必須（AKO-WFL-002）
   * - 全アクションを approvalLogs へ追記（代理時は delegateForId を記録）
   */
  function act(requestId: string, action: Exclude<ApprovalAction, 'submit'>, comment = ''): Result {
    const req = byId(requestId)
    if (!req) return err('AKO-GEN-002', '対象の申請が見つかりません')
    const me = currentUser.value

    if (action === 'withdraw') {
      if (req.requesterId !== me.id) return err('AKO-WFL-001', '取下げは申請者本人のみ可能です')
      if (req.status !== 'in_review' && req.status !== 'submitted') {
        return err('AKO-WFL-001', 'この申請は取下げできる状態ではありません')
      }
      patch(req.id, { status: 'withdrawn' })
      appendLog(req.id, req.currentStep, 'withdraw', comment)
      commit()
      return { ok: true, id: req.id }
    }

    if (req.status !== 'in_review' && req.status !== 'submitted') {
      return err('AKO-WFL-001', 'この申請は現在承認操作できません')
    }
    const approver = currentApproverOf(req)
    if (!approver) return err('AKO-WFL-001', '現在ステップの承認者を解決できません')
    const isSelf = approver.id === me.id
    const asDelegate = !isSelf && isActiveDelegateOf(approver.id, me.id)
    if (!isSelf && !asDelegate) {
      return err('AKO-WFL-001', 'このステップの承認権限がありません')
    }
    if ((action === 'reject' || action === 'remand') && !comment.trim()) {
      return err('AKO-WFL-002', `${APPROVAL_ACTION_LABELS[action]}にはコメントの入力が必要です`)
    }
    const delegateForId = asDelegate ? approver.id : null

    if (action === 'approve') {
      const isLast = req.currentStep >= req.routeSnapshot.length
      appendLog(req.id, req.currentStep, 'approve', comment, delegateForId)
      if (isLast) {
        patch(req.id, { status: 'approved' })
        commit()
        notifySafe(req.requesterId, `決裁: ${req.title}`, `${WORKFLOW_CATEGORY_LABELS[req.category]}稟議（${fmtYen(req.amount)}）が決裁されました`)
      } else {
        const nextStep = req.currentStep + 1
        patch(req.id, { currentStep: nextStep })
        commit()
        const ns = req.routeSnapshot[nextStep - 1]
        const nextApprover = ns ? stepApprover(ns) : undefined
        if (nextApprover) {
          notifySafe(nextApprover.id, `承認依頼: ${req.title}`, `${memberName(req.requesterId)} さんの${WORKFLOW_CATEGORY_LABELS[req.category]}稟議（${fmtYen(req.amount)}）が step${nextStep} に到達しました`)
        }
      }
      return { ok: true, id: req.id }
    }

    // reject / remand
    patch(req.id, { status: action === 'reject' ? 'rejected' : 'remanded' })
    appendLog(req.id, req.currentStep, action, comment, delegateForId)
    commit()
    notifySafe(req.requesterId, `${APPROVAL_ACTION_LABELS[action]}: ${req.title}`, comment)
    return { ok: true, id: req.id }
  }

  return {
    requests,
    byId,
    logsOf,
    approverFor,
    stepApprover,
    currentApproverOf,
    resolveRouteFor,
    flowSteps,
    previewSteps,
    saveDraft,
    submit,
    act,
    canActOn,
    pendingFor,
    memberName,
    myDelegates,
    isDelegateActive,
    isActiveDelegateOf,
    saveDelegate,
    removeDelegate,
  }
}
