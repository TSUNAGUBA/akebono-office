/** 区分値 → 日本語ラベル（表示の SoT。列挙は types/domain.ts・types/intelligence.ts が正） */
import type { EmploymentType, MemberRole } from '~/types/domain'
import type { InsightTheme, IntelActionStatus } from '~/types/intelligence'
import type { Tone } from '~/types/ui'

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  admin: '管理者',
  hr: '人事',
  member: '一般',
}

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  director: '取締役',
  employee: '正社員',
  contract: '契約社員',
  parttime: 'アルバイト',
  outsource: '外注',
}

export const INSIGHT_THEME_LABELS: Record<InsightTheme, string> = {
  management: '経営',
  customer: '顧客',
  project: '案件',
}

export const INSIGHT_THEME_TONES: Record<InsightTheme, Tone> = {
  management: 'brand',
  customer: 'info',
  project: 'ok',
}

export const ACTION_STATUS_LABELS: Record<IntelActionStatus, string> = {
  planned: '計画',
  in_progress: '実行中',
  done: '完了',
  cancelled: '中止',
}

export const ACTION_STATUS_TONES: Record<IntelActionStatus, Tone> = {
  planned: 'info',
  in_progress: 'ok',
  done: 'neutral',
  cancelled: 'neutral',
}

export const CONFIDENCE_LABELS: Record<'high' | 'mid' | 'low', string> = {
  high: '確信度高',
  mid: '確信度中',
  low: '確信度低',
}

export const CONFIDENCE_TONES: Record<'high' | 'mid' | 'low', Tone> = {
  high: 'ok',
  mid: 'info',
  low: 'warn',
}

/** フィードバックの反映種別（サイクル明細の表示） */
export const FEEDBACK_EFFECT_LABELS: Record<'reinforce' | 'alternative' | 'dedupe', string> = {
  reinforce: '高評価 → 継続・強化を提案',
  alternative: '低評価 → 代替アプローチを提案',
  dedupe: '実行中 → 重複提案を抑制',
}
