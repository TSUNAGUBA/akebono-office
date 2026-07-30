import { describe, expect, it } from 'vitest'
import type { WorkflowRoute, WorkflowRouteStep } from '~/types/domain'
import { resolveRoute } from '~/utils/approval-route'

// 承認ステップ（役職指定）。resolveRoute は order/category/amount/active のみ参照するため承認者は代表値でよい
const st = (order: number, approverTitle: string): WorkflowRouteStep => ({
  order, approverType: 'title', approverRole: null, approverTitle, approverMemberId: null, mode: 'serial',
})

const routes: WorkflowRoute[] = [
  { id: 'a', category: 'purchase', minAmount: 0, maxAmount: 100000, steps: [st(1, 'マネージャー')], active: true },
  { id: 'b', category: 'purchase', minAmount: 100000, maxAmount: 1000000, steps: [st(2, '取締役'), st(1, 'マネージャー')], active: true },
  { id: 'c', category: 'purchase', minAmount: 1000000, maxAmount: null, steps: [st(1, 'マネージャー'), st(2, '取締役'), st(3, '代表取締役')], active: true },
  { id: 'd', category: 'expense', minAmount: 0, maxAmount: 50000, steps: [st(1, 'マネージャー')], active: false },
]

describe('resolveRoute（職務権限マトリクス）', () => {
  it('金額帯で経路が分岐する（10 万円未満 → 1 段階）', () => {
    expect(resolveRoute(routes, 'purchase', 99999)?.length).toBe(1)
  })

  it('境界値: 10 万円ちょうどは上位帯（2 段階）', () => {
    expect(resolveRoute(routes, 'purchase', 100000)?.length).toBe(2)
  })

  it('100 万円以上は 3 段階（maxAmount=null の帯）', () => {
    expect(resolveRoute(routes, 'purchase', 5000000)?.length).toBe(3)
  })

  it('ステップは order 昇順に整列される', () => {
    const steps = resolveRoute(routes, 'purchase', 500000)!
    expect(steps.map(s => s.order)).toEqual([1, 2])
  })

  it('無効な経路定義は使用しない', () => {
    expect(resolveRoute(routes, 'expense', 10000)).toBeNull()
  })

  it('該当区分がなければ null', () => {
    expect(resolveRoute(routes, 'hiring', 0)).toBeNull()
  })
})
