/**
 * AKEBONO Intelligence ドメイン型の再エクスポート。
 * SoT は repo 直下 shared/domain/intelligence.ts（本実装 = 改善要望 2026-08-22 で API サービスと共有化。
 * サーバー側スキーマ〔intel_* テーブル〕と分析エンジンの型はここへ集約）。
 * 既存の `~/types/intelligence` import を維持するためのシム。型の追加・変更は shared 側で行う。
 */
export type {
  FeedbackConsidered, InsightConfidence, InsightEvidence, InsightProposal, InsightTheme,
  IntelAction, IntelActionStatus, IntelCycle, IntelInsight,
} from '../../../shared/domain/intelligence'
