/**
 * データ基盤（改善要望 2026-08-22: 3 カテゴリのデータ項目 → 一覧 → 詳細）の参照専用型。
 * 本アプリは業務データへ書込しない読み取り層のため、API レスポンスのうち表示に使う
 * フィールドのみを宣言する（SoT は Home 側の各エンティティ。shared に無い AKEBONO 業務型
 * 〔支払通知書等〕は home/app/types/akebono.ts が SoT で、ここはその表示サブセット）。
 */

/** ECレポート（AKEBONO ダッシュボードの AI 分析レポート。/v1/akebono/dashboard-insights/list） */
export interface EcReport {
  id: string
  scope: 'segment' | 'company'
  segmentId: string | null
  /** 業態名（list エンドポイントが business_segments から解決。company スコープは null） */
  segmentName?: string | null
  /** 対象期間キー（例 '2026-06'） */
  periodKey: string
  insight: {
    executiveSummary?: string
    findings?: { kind: string; title: string; detail: string }[]
    actions?: { title: string; detail: string; priority: string }[]
  } | null
  llm?: boolean
  generatedAt: string
  generatedByName?: string | null
}

/** 委託販売レポート（支払通知書 = 委託精算の確定レポート。/v1/akebono/payment-notices） */
export interface ConsignmentReport {
  id: string
  code: string
  /** 作家（Company 参照） */
  companyId: string
  segmentId?: string
  periodFrom: string
  periodTo: string
  status: string
  payableAmount: number
  lines?: { id: string; description: string; amount: number }[]
  /** 委託精算取消による論理取消日時（null/未設定 = 有効） */
  voidedAt?: string | null
}
