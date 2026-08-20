/**
 * 生産管理（F-22。v1 = 指示 + 実績 + 在庫連動の薄い実装）
 * 情報サービス業は「案件/開発タスク × 工数」に読み替え（ラベルは F-20-6。在庫連動なし）。
 * 状態機械 draft→instructed→in_progress→completed / canceled。完成 → 在庫へ入庫（production_in）。
 * デュアルモード（Phase C = 0032）: API モードの SoT はサーバー（production_orders +
 * inventory_transactions）。実績登録は 1 リクエストで実績追記 + 在庫入庫 + ステータス更新（トランザクション）。
 */
import type { ProductionOrder, ProductionResult, ProductionStatus } from '~/types/akebono'
import type { CustomValues, Result } from '~/types/domain'
import { nextCode } from '~/utils/akebono'

export function useProduction() {
  const { tbl, commit, nextId } = useMockDb()
  const orders = tbl('productionOrders')
  const inv = useInventory()
  const isApi = useApiMode()

  const activeOrders = computed(() => orders.value.slice().sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1)))
  function orderById(id: string): ProductionOrder | undefined {
    return orders.value.find(o => o.id === id)
  }
  function completedQtyOf(o: ProductionOrder): number {
    return o.results.reduce((s, r) => s + r.completedQty, 0)
  }

  async function createOrder(input: { skuId: string; qty: number; warehouseId: string; dueDate: string; custom?: CustomValues }): Promise<Result> {
    if (!input.skuId) return { ok: false, error: { code: 'AKO-MFG-001', message: '対象 SKU を指定してください' } }
    if (!Number.isFinite(input.qty) || input.qty <= 0) return { ok: false, error: { code: 'AKO-MFG-002', message: '数量を正しく入力してください' } }
    if (isApi) {
      const res = await apiWrite<ProductionOrder>('/v1/akebono/production-orders', { body: input, reload: ['productionOrders'] })
      return res.ok ? { ok: true, id: res.data.id } : res
    }
    const id = nextId('productionOrders', 'mfg')
    const created: ProductionOrder = {
      id, code: nextCode(orders.value.map(o => o.code), 'MFG'),
      skuId: input.skuId, qty: input.qty, warehouseId: input.warehouseId, dueDate: input.dueDate,
      status: 'instructed', results: [], custom: input.custom ?? {},
    }
    orders.value = [...orders.value, created]
    commit()
    return { ok: true, id }
  }

  const NEXT: Record<ProductionStatus, ProductionStatus[]> = {
    draft: ['instructed', 'canceled'],
    instructed: ['in_progress', 'canceled'],
    in_progress: ['completed', 'canceled'],
    completed: [],
    canceled: [],
  }
  async function setStatus(id: string, status: ProductionStatus): Promise<Result> {
    if (isApi) {
      return apiWrite(`/v1/akebono/production-orders/${id}/status`, { body: { status }, reload: ['productionOrders'] })
    }
    const o = orderById(id)
    if (!o) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    if (!NEXT[o.status].includes(status)) return { ok: false, error: { code: 'AKO-MFG-003', message: `「${o.status}」から遷移できません` } }
    orders.value = orders.value.map(x => x.id === id ? { ...x, status } : x)
    commit()
    return { ok: true, id }
  }

  /** 生産実績を登録（追記）。完成分を在庫へ入庫（production_in）。全数完成で completed */
  async function registerResult(id: string, input: { completedQty: number; defectQty: number }): Promise<Result> {
    if (isApi) {
      const res = await apiWrite<ProductionOrder>(`/v1/akebono/production-orders/${id}/results`, {
        body: input, reload: ['productionOrders', 'inventoryTransactions', 'inventoryBalances'],
      })
      return res.ok ? { ok: true, id: res.data.id } : res
    }
    const o = orderById(id)
    if (!o) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    if (o.status !== 'in_progress' && o.status !== 'instructed') {
      return { ok: false, error: { code: 'AKO-MFG-004', message: '指示中/進行中のみ実績登録できます' } }
    }
    if (!Number.isFinite(input.completedQty) || input.completedQty <= 0) {
      return { ok: false, error: { code: 'AKO-MFG-002', message: '完成数を正しく入力してください' } }
    }
    // 実績 id はオーダー id + 連番で全域一意（nextId は別 prefix を採番できず常に mfgr-0001 になる = 生産入庫が破棄される）
    const result: ProductionResult = { id: `${o.id}-r${o.results.length + 1}`, completedQty: input.completedQty, defectQty: input.defectQty, completedAt: nowJstIso() }
    const nextResults = [...o.results, result]
    const done = nextResults.reduce((s, r) => s + r.completedQty, 0) >= o.qty
    orders.value = orders.value.map(x => x.id === id ? { ...x, results: nextResults, status: done ? 'completed' : 'in_progress' } : x)
    // 在庫入庫（production_in）
    inv.post([{ skuId: o.skuId, warehouseId: o.warehouseId, qty: input.completedQty, kind: 'production_in', refType: 'production', refLineId: result.id }])
    commit()
    return { ok: true, id: result.id }
  }

  return { orders, activeOrders, orderById, completedQtyOf, createOrder, setStatus, registerResult, NEXT }
}
