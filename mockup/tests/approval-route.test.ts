import { describe, expect, it } from 'vitest'
import type { WorkflowRoute } from '~/types/domain'
import { resolveRoute } from '~/utils/approval-route'

const routes: WorkflowRoute[] = [
  { id: 'a', category: 'purchase', minAmount: 0, maxAmount: 100000, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'b', category: 'purchase', minAmount: 100000, maxAmount: 1000000, steps: [{ order: 2, approverRole: 'director', approverMemberId: null, mode: 'serial' }, { order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'c', category: 'purchase', minAmount: 1000000, maxAmount: null, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }, { order: 2, approverRole: 'director', approverMemberId: null, mode: 'serial' }, { order: 3, approverRole: 'president', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'd', category: 'expense', minAmount: 0, maxAmount: 50000, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }], active: false },
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
