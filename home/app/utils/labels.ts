/** 区分値 → 日本語ラベル（表示の SoT。列挙は types/domain.ts が正） */
import type {
  AiEmployeeStatus, AiTaskStatus, ApprovalAction, DecisionActionStatus,
  EmploymentType, EscalationReason, EscalationResolutionType, IncidentImpact,
  IncidentStatus, KnowledgeDomain, MemberRole, NotificationKind, ProjectStatus, ProjectType,
  PunchKind, ShiftPeriodStatus, ShiftWishKind, WorkflowCategory, WorkflowStatus,
  ApprovalStepKind, ApproverType, AttendanceRequestCategory, DirectType,
} from '~/types/domain'
import { normalizeApproverStep, type ApproverStepLike } from '~/utils/approver'
import type { Tone } from '~/types/ui'

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  director: '取締役',
  employee: '正社員',
  contract: '契約社員',
  parttime: 'アルバイト',
  outsource: '外注',
}

/** 雇用区分バッジのトーン（メンバー管理・チームタブ表示メンバー設定で共有 = バッチ7k で集約） */
export const EMPLOYMENT_TYPE_TONES: Record<EmploymentType, Tone> = {
  director: 'brand',
  employee: 'info',
  contract: 'ok',
  parttime: 'warn',
  outsource: 'neutral',
}

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  admin: '管理者',
  hr: '人事',
  member: '一般',
}

export const PUNCH_KIND_LABELS: Record<PunchKind, string> = {
  in: '出勤',
  out: '退勤',
  break_start: '休憩開始',
  break_end: '休憩終了',
}

/** 直行/直帰の種別ラベル（F-04-11） */
export const DIRECT_TYPE_LABELS: Record<DirectType, string> = {
  chokkou: '直行',
  chokki: '直帰',
  both: '直行直帰',
}

/** 勤怠承認区分ラベル（経路設定タブ。F-04-12） */
export const ATTENDANCE_ROUTE_CATEGORY_LABELS: Record<AttendanceRequestCategory, string> = {
  direct: '直行/直帰申請',
  fix: '打刻修正申請',
}

/** 承認者の指定方法ラベル（役職/ロール/個人/申請者本人。稟議・勤怠 共通の経路設定。
 *  applicant は稟議の経路設定のみ提示（WidgetsApproverSteps の allowApplicant） */
export const APPROVER_TYPE_LABELS: Record<ApproverType, string> = {
  title: '役職',
  role: 'ロール',
  member: '個人',
  applicant: '申請者本人',
}

/** 経路ステップ種別ラベル（承認/決裁/確認 = 改善要望 2026-08-17。値域 SoT = shared/domain/approver） */
export const APPROVAL_STEP_KIND_LABELS: Record<ApprovalStepKind, string> = {
  approval: '承認',
  decision: '決裁',
  confirm: '確認',
}

/**
 * 承認ステップの対象（承認者指定）を短いラベルで表す。稟議・勤怠 の経路一覧/承認フロー表示で共通利用。
 * title=役職ラベル / role=ロール名（MEMBER_ROLE_LABELS）/ member=「個人指定」。旧形式も normalize が吸収。
 */
export function approverTargetLabel(step: ApproverStepLike): string {
  // applicant は normalize 前に判定（normalize は member/null へ落とすため表示名が失われる）
  if (step.approverType === 'applicant') return '申請者本人'
  const spec = normalizeApproverStep(step)
  if (spec.type === 'title') return spec.title ?? '役職'
  if (spec.type === 'role') return spec.role ? MEMBER_ROLE_LABELS[spec.role] : 'ロール'
  return '個人指定'
}

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  biz_consulting: '業務コンサル',
  sys_consulting: 'システムコンサル',
  development: '受託開発',
  operation: '運用',
  internal: '自社',
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: '計画中',
  active: '進行中',
  onhold: '保留',
  closed: '完了',
}

export const WORKFLOW_CATEGORY_LABELS: Record<WorkflowCategory, string> = {
  purchase: '購買',
  contract: '契約',
  expense: '経費',
  hiring: '採用',
  trip: '出張',
  other: 'その他',
}

/** 稟議区分の説明（新規申請フォームのヒント表示 = 改善要望 2026-08-17。文言はオペレーター指定） */
export const WORKFLOW_CATEGORY_DESCRIPTIONS: Record<WorkflowCategory, string> = {
  purchase: '購買：物品・備品・ソフトウェア・SaaS等の購入',
  expense: '経費：会食・研修・広告・イベント等の費用支出',
  trip: '出張：交通・宿泊を伴う出張の事前申請',
  contract: '契約：業務委託・顧問等の契約締結・更新',
  hiring: '採用：求人・採用活動・雇用に関する申請',
  other: 'その他：上記に該当しない申請',
}

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  draft: '下書き',
  submitted: '申請中',
  in_review: '承認中',
  approved: '決裁済',
  rejected: '却下',
  remanded: '差戻し',
  withdrawn: '取下げ',
}

export const WORKFLOW_STATUS_TONES: Record<WorkflowStatus, Tone> = {
  draft: 'neutral',
  submitted: 'info',
  in_review: 'info',
  approved: 'ok',
  rejected: 'crit',
  remanded: 'warn',
  withdrawn: 'neutral',
}

export const APPROVAL_ACTION_LABELS: Record<ApprovalAction, string> = {
  submit: '申請',
  approve: '承認',
  reject: '却下',
  remand: '差戻し',
  withdraw: '取下げ',
}

export const SHIFT_PERIOD_STATUS_LABELS: Record<ShiftPeriodStatus, string> = {
  draft: '準備中',
  open: '希望受付中',
  closed: '締切',
  adjusting: '調整中',
  published: '確定公開',
}

export const SHIFT_WISH_LABELS: Record<ShiftWishKind, string> = {
  want: '出勤希望',
  ng: 'NG',
  either: 'どちらでも',
}

export const AI_EMPLOYEE_STATUS_LABELS: Record<AiEmployeeStatus, string> = {
  idle: '待機中',
  working: '実行中',
  waiting_approval: '承認待ち',
}

export const AI_TASK_STATUS_LABELS: Record<AiTaskStatus, string> = {
  proposed: '提案中',
  approved: '承認済',
  in_progress: '実行中',
  blocked: 'ブロック',
  done: '完了',
  cancelled: '中止',
}

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  approval: '承認依頼',
  comment: 'コメント',
  reminder: 'リマインド',
  ai_report: 'AI報告',
  system: 'システム',
  escalation: 'エスカレーション',
  poipoi: 'ぽいぽいポスト', // 旧称: 改善のタネ（改善要望 2026-08-21 で再改称。キーは不変。日報内の「改善のタネ欄」の名称は現状維持）
}

export const ESCALATION_REASON_LABELS: Record<EscalationReason, string> = {
  issue_reported: '課題の報告',
  stalled_task: 'タスク停滞',
  overload: '過負荷',
  low_confidence: 'AI確信度低',
  overtime_alert: '残業アラート',
}

export const ESCALATION_RESOLUTION_LABELS: Record<EscalationResolutionType, string> = {
  answer: '回答送信',
  ruling: '裁定記録',
  no_action: '対応不要',
}

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  investigating: '調査中',
  identified: '原因特定',
  monitoring: '経過観察',
  resolved: '解決済み',
}

export const INCIDENT_IMPACT_LABELS: Record<IncidentImpact, string> = {
  minor: '軽微',
  major: '重大',
  critical: '致命的',
}

export const SERVICE_STATE_LABELS: Record<string, string> = {
  operational: '正常稼働',
  degraded: '性能低下',
  partial_outage: '一部障害',
  major_outage: '重大障害',
  maintenance: 'メンテナンス中',
}

export const SERVICE_STATE_TONES: Record<string, Tone> = {
  operational: 'ok',
  degraded: 'warn',
  partial_outage: 'serious',
  major_outage: 'crit',
  maintenance: 'info',
}

export const KNOWLEDGE_DOMAIN_LABELS: Record<KnowledgeDomain, string> = {
  industry: '業界',
  company: '顧客(会社)',
  contact: '顧客(人)',
  relation: '顧客関係',
  project: 'プロジェクト',
}

export const DECISION_ACTION_META: Record<DecisionActionStatus, { symbol: string; tone: Tone }> = {
  ok: { symbol: '○', tone: 'ok' },
  warn: { symbol: '△', tone: 'warn' },
  ng: { symbol: '✗', tone: 'crit' },
}
