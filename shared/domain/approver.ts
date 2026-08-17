/**
 * 承認者の解決（純粋関数・Vue/DB 非依存）。稟議・勤怠の承認経路で共通利用する。
 * 承認ステップの指定方法（役職/ロール/個人）から在籍メンバーを決定的に 1 名選ぶ。
 * 旧形式（approverType 無し・approverRole が manager/director/president/hr）も normalizeApproverStep が
 * 新形式へ吸収するため、移行前データでも壊れない（下位互換 = 原則7）。
 */
import type { ApprovalStepKind, ApproverType, MemberRole } from './types'

/** 承認者候補（在籍者）。id 昇順・active フィルタで first-match を決定的にする */
export interface ApproverCandidate {
  id: string
  role: string
  title: string
  active?: boolean
}

/** 承認ステップの承認者指定（新旧どちらの形状も受ける緩い型） */
export interface ApproverStepLike {
  approverType?: ApproverType | null
  approverRole?: string | null
  approverTitle?: string | null
  approverMemberId?: string | null
}

/** 正規化済みの承認者指定 */
export interface NormalizedApprover {
  type: ApproverType
  role: MemberRole | null
  title: string | null
  memberId: string | null
}

/** 旧形式 approverRole → 新形式（役職/ロール）への行動保存的なマッピング */
const LEGACY_ROLE_MAP: Record<string, NormalizedApprover> = {
  president: { type: 'title', role: null, title: '代表取締役', memberId: null },
  director: { type: 'title', role: null, title: '取締役', memberId: null },
  manager: { type: 'title', role: null, title: 'マネージャー', memberId: null },
  hr: { type: 'role', role: 'hr', title: null, memberId: null },
}

/**
 * 承認ステップを新形式（type/role/title/memberId）へ正規化する。
 * approverType が指定済みならそのまま。未指定（旧データ）は approverMemberId 優先 → 旧 approverRole をマップ。
 */
export function normalizeApproverStep(step: ApproverStepLike): NormalizedApprover {
  if (step.approverType === 'member' || step.approverType === 'title' || step.approverType === 'role') {
    return {
      type: step.approverType,
      role: (step.approverRole ?? null) as MemberRole | null,
      title: step.approverTitle ?? null,
      memberId: step.approverMemberId ?? null,
    }
  }
  // applicant（申請者本人）は提出時に member（申請者 id）へ解決して凍結される想定。
  // 未解決のまま渡された場合は member/null 扱い = pickApprover の管理者フォールバックで行き止まりを避ける
  if (step.approverType === 'applicant') {
    return { type: 'member', role: null, title: null, memberId: step.approverMemberId ?? null }
  }
  // 旧形式
  if (step.approverMemberId) return { type: 'member', role: null, title: null, memberId: step.approverMemberId }
  const mapped = step.approverRole ? LEGACY_ROLE_MAP[step.approverRole] : undefined
  // 未知値の最終フォールバック = 管理者ロール（承認の行き止まりを避ける）
  return mapped ?? { type: 'role', role: 'admin', title: null, memberId: null }
}

/**
 * 承認ステップ → 承認者（在籍者）を 1 名解決する。
 * - member: 指定メンバー（在籍優先。不在なら任意の管理者へフォールバック）
 * - title:  役職ラベル一致（id 昇順の先頭）。不在なら任意の管理者
 * - role:   ロール一致（id 昇順の先頭）。不在なら任意の管理者
 * 該当が全く無ければ undefined（呼び出し側は管理者単段等へフォールバック）。
 */
export function pickApprover<M extends ApproverCandidate>(members: M[], step: ApproverStepLike): M | undefined {
  const actives = members.filter(m => m.active !== false).sort((a, b) => a.id.localeCompare(b.id))
  const anyAdmin = actives.find(m => m.role === 'admin')
  const spec = normalizeApproverStep(step)
  if (spec.type === 'member') {
    return actives.find(m => m.id === spec.memberId) ?? anyAdmin
  }
  if (spec.type === 'title') {
    return actives.find(m => m.title === spec.title) ?? anyAdmin
  }
  return actives.find(m => m.role === spec.role) ?? anyAdmin
}

// ---------- ステップ種別（承認/決裁/確認。改善要望 2026-08-17） ----------

export const APPROVAL_STEP_KINDS: ApprovalStepKind[] = ['approval', 'decision', 'confirm']

/**
 * ステップ種別の解決（表示用）。未設定（旧データ・旧スナップショット）は
 * 「最終ステップ = 決裁・それ以外 = 承認」として扱う（従来の直列承認の意味と一致 = 下位互換）。
 * 進行の状態機械は種別に依らず直列で不変（種別は設定・可視化のためのタグ）。
 */
export function stepKindOf(step: { stepKind?: ApprovalStepKind | null }, isLast: boolean): ApprovalStepKind {
  if (step.stepKind && APPROVAL_STEP_KINDS.includes(step.stepKind)) return step.stepKind
  return isLast ? 'decision' : 'approval'
}

/**
 * 経路凍結時の申請者本人（applicant）解決（改善要望 2026-08-17）。routeSnapshot へ保存する前に、
 * applicant ステップを member（requesterId = その申請の申請者）へ変換する。
 * スナップショットは自己完結 = 以降の承認ロジック・表示は従来型（title/role/member）のみを扱う。
 * mock useWorkflow.submit と API workflows.ts submit が共有（両モード parity = 原則3・6）。
 */
export function resolveApplicantSteps<S extends ApproverStepLike>(steps: S[], requesterId: string): S[] {
  return steps.map(s => (s.approverType === 'applicant'
    ? { ...s, approverType: 'member' as ApproverType, approverMemberId: requesterId }
    : s))
}
