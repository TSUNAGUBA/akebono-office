/**
 * 承認経路解決（純粋関数・Vue 非依存）
 * 職務権限マトリクス（WorkflowRoute: 区分×金額帯）から申請の経路を決定する。
 */
import type { WorkflowCategory, WorkflowRoute, WorkflowRouteStep } from '~/types/domain'

/**
 * 区分と金額に合致する経路を返す。
 * 該当が複数ある場合は金額帯の下限が最も高い（= 最も具体的な）定義を採用する。
 * 該当がない場合は null（呼び出し側で AKO-WFL-003 として扱う）。
 */
export function resolveRoute(
  routes: WorkflowRoute[],
  category: WorkflowCategory,
  amount: number,
): WorkflowRouteStep[] | null {
  const candidates = routes
    .filter(r => r.active && r.category === category)
    .filter(r => amount >= r.minAmount && (r.maxAmount === null || amount < r.maxAmount))
    .sort((a, b) => b.minAmount - a.minAmount)
  const hit = candidates[0]
  if (!hit) return null
  return [...hit.steps].sort((a, b) => a.order - b.order)
}
