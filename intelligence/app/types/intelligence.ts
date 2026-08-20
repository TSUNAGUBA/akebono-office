/**
 * AKEBONO Intelligence アプリ固有のドメイン型（インサイト・アクション・分析サイクル）。
 * これらの SoT は現状フロントエンド（localStorage）= モック境界
 * （`.ai-native/outputs/phase3/company-intelligence-requirements.md` §5）。
 * 共通 API 本実装時はこの型を土台にサーバー側スキーマへ移行する。
 */

export type InsightTheme = 'management' | 'customer' | 'project'
export type InsightConfidence = 'high' | 'mid' | 'low'

/** 分析の根拠（参照したデータソースと件数） */
export interface InsightEvidence {
  source: string
  label: string
  count: number
}

/** インサイトからの提案（アクション化の元） */
export interface InsightProposal {
  id: string
  title: string
  description: string
  priority: 'high' | 'mid' | 'low'
}

/** 反映したフィードバックの明細（ループの可視化） */
export interface FeedbackConsidered {
  actionId: string
  title: string
  rating: number | null
  effect: 'reinforce' | 'alternative' | 'dedupe'
}

export interface IntelInsight {
  id: string
  cycleId: string
  theme: InsightTheme
  /** customer = companyId / project = projectId / management = null */
  targetId: string | null
  targetName: string
  title: string
  summary: string
  findings: string[]
  evidence: InsightEvidence[]
  proposals: InsightProposal[]
  confidence: InsightConfidence
  feedbackConsidered: FeedbackConsidered[]
  createdAt: string
  createdBy: string
  active: boolean
}

export type IntelActionStatus = 'planned' | 'in_progress' | 'done' | 'cancelled'

export interface IntelAction {
  id: string
  /** 提案からのアクション化の場合の由来（手動登録は null） */
  insightId: string | null
  proposalId: string | null
  theme: InsightTheme
  targetId: string | null
  targetName: string
  title: string
  description: string
  status: IntelActionStatus
  dueDate: string | null
  ownerId: string
  /** 実施内容・結果の記録 */
  result: string
  /** フィードバック（5 段階。未記録は null） */
  feedbackRating: number | null
  feedbackNote: string
  feedbackNext: string
  createdAt: string
  updatedAt: string
  active: boolean
}

/** 分析サイクル（生成のたびに追記する記録系。入力スナップショット + 反映フィードバック明細） */
export interface IntelCycle {
  id: string
  theme: InsightTheme
  targetId: string | null
  targetName: string
  at: string
  inputSnapshot: InsightEvidence[]
  feedbackConsidered: FeedbackConsidered[]
  insightIds: string[]
  createdBy: string
  active: boolean
}
