/**
 * 承認者解決（純粋関数）。実体は shared/domain/approver.ts（API と共有）。
 * 既存 import パス互換のための再エクスポート。
 */
export { pickApprover, normalizeApproverStep } from '../../../shared/domain/approver'
export type { ApproverCandidate, ApproverStepLike, NormalizedApprover } from '../../../shared/domain/approver'
