/**
 * 分析エンジン（FI-03）の再エクスポート。
 * SoT は repo 直下 shared/domain/intelligence.ts（本実装 = 改善要望 2026-08-22）。
 * API サービス（/v1/intelligence/generate の LLM フォールバック）とモックモードが
 * 同一関数を共有する（パリティの SoT）。既存の `~/utils/insight-engine` import を維持するためのシム。
 */
export {
  addMonths, generateInsightDraft,
  type EngineData, type EngineInsightDraft, type EngineOptions, type EngineResult,
} from '../../../shared/domain/intelligence'
