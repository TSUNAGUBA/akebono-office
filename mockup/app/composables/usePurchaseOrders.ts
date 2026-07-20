/**
 * 発注管理（F-23）
 * 仕入先への発注。状態機械 draft→ordered→partially_received→closed / canceled。
 * 入荷実績（poId 紐付け）から消込率を導出。情報サービスは外注費に読み替え（ラベルは F-20-6）。
 */
import type { OrderLine, PoStatus, PurchaseOrder } from '~/types/akebono'
import type { Result } from '~/types/domain'
import { nextCode } from '~/utils/akebono'

export function usePurchaseOrders() {
  const { tbl, commit, nextId } = useMockDb()
  const orders = tbl('purchaseOrders')
  const inboundResults = tbl('inboundResults')
  const inboundPlans = tbl('inboundPlans')

  const activeOrders = computed(() => orders.value.slice().sort((a, b) => (a.orderDate < b.orderDate ? 1 : -1)))

  function orderById(id: string): PurchaseOrder | undefined {
    return orders.value.find(o => o.id === id)
  }
  function orderTotal(o: PurchaseOrder): number {
    return o.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)
  }
  /** 発注に紐付く入荷実績の受入合計（poId → InboundPlan → InboundResult） */
  function receivedQtyOf(poId: string): number {
    const planIds = new Set(inboundPlans.value.filter(p => p.poId === poId).map(p => p.id))
    let sum = 0
    for (const r of inboundResults.value) {
      if (r.planId && planIds.has(r.planId)) sum += r.lines.reduce((s, l) => s + l.qty, 0)
    }
    return sum
  }
  function orderedQtyOf(o: PurchaseOrder): number {
    return o.lines.reduce((s, l) => s + l.qty, 0)
  }

  function createOrder(input: { companyId: string; segmentId: string; orderDate: string; dueDate: string; note?: string; lines: { skuId: string; qty: number; unitPrice: number }[] }): Result {
    if (!input.companyId) return { ok: false, error: { code: 'AKO-POR-001', message: '仕入先を指定してください' } }
    if (!input.segmentId) return { ok: false, error: { code: 'AKO-POR-001', message: '事業セグメントを指定してください' } }
    const lines = input.lines.filter(l => l.skuId && l.qty > 0)
    if (lines.length === 0) return { ok: false, error: { code: 'AKO-POR-002', message: '発注明細を 1 行以上入力してください' } }
    const id = nextId('purchaseOrders', 'po')
    const orderLines: OrderLine[] = lines.map(l => ({ id: nextId('purchaseOrders', 'pol') + '-' + l.skuId, skuId: l.skuId, qty: l.qty, unitPrice: l.unitPrice }))
    const created: PurchaseOrder = {
      id, code: nextCode(orders.value.map(o => o.code), 'PO'),
      companyId: input.companyId, segmentId: input.segmentId, status: 'ordered',
      orderDate: input.orderDate, dueDate: input.dueDate, note: input.note ?? '', lines: orderLines,
    }
    orders.value = [...orders.value, created]
    commit()
    return { ok: true, id }
  }

  const NEXT: Record<PoStatus, PoStatus[]> = {
    draft: ['ordered', 'canceled'],
    ordered: ['partially_received', 'closed', 'canceled'],
    partially_received: ['closed', 'canceled'],
    closed: [],
    canceled: [],
  }
  function setStatus(id: string, status: PoStatus): Result {
    const o = orderById(id)
    if (!o) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    if (!NEXT[o.status].includes(status)) {
      return { ok: false, error: { code: 'AKO-POR-003', message: `「${o.status}」から「${status}」へは遷移できません` } }
    }
    orders.value = orders.value.map(x => x.id === id ? { ...x, status } : x)
    commit()
    return { ok: true, id }
  }

  return { orders, activeOrders, orderById, orderTotal, orderedQtyOf, receivedQtyOf, createOrder, setStatus, NEXT }
}
