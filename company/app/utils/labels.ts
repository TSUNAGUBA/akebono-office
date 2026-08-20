/** 区分値 → 日本語ラベル（表示の SoT。列挙は types/domain.ts が正。Home 版から本アプリで使う区分のみ抜粋） */
import type {
  AiEmployeeStatus, AiTaskStatus, EmploymentType, EscalationReason,
  EscalationResolutionType, MemberRole, NotificationKind,
} from '~/types/domain'
import type { Tone } from '~/types/ui'

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  director: '取締役',
  employee: '正社員',
  contract: '契約社員',
  parttime: 'アルバイト',
  outsource: '外注',
}

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  admin: '管理者',
  hr: '人事',
  member: '一般',
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
  poipoi: '改善のタネ',
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

export const ESCALATION_REASON_TONES: Record<EscalationReason, Tone> = {
  issue_reported: 'info',
  stalled_task: 'warn',
  overload: 'serious',
  low_confidence: 'warn',
  overtime_alert: 'crit',
}
