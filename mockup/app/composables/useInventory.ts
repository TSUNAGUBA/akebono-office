/**
 * 在庫管理（F-27）
 * SoT = inventoryTransactions（台帳・追記のみ）。残高は導出（warehouse 実証方式: Σqty）。
 * 入荷/出荷/仕入/生産は本 composable の post() を通じて台帳へ書く（冪等キー = refType × refLineId × kind）。
 * 調整・移動・棚卸は本ページの操作として台帳へ追記する。
 */
import type {
  InventoryAdjustReason, InventoryTransaction, InventoryTxnKind,
} from '~/types/akebono'
import type { Result } from '~/types/domain'
import { balanceKey, foldBalances } from '~/utils/akebono'

export interface PostEntry {
  skuId: string
  warehouseId: string
  qty: number
  kind: InventoryTxnKind
  reason?: InventoryAdjustReason | null
  refType: string
  refLineId: string
  occurredAt?: string
}

export function useInventory() {
  const { tbl, commit, nextId } = useMockDb()
  const txns = tbl('inventoryTransactions')

  /** SKU × 倉庫 の残高マップ（台帳から導出） */
  const balances = computed(() => foldBalances(txns.value))

  function balanceOf(skuId: string, warehouseId: string): number {
    return balances.value.get(balanceKey(skuId, warehouseId)) ?? 0
  }

  /** SKU の全倉庫合計 */
  function totalOf(skuId: string): number {
    return txns.value.filter(t => t.skuId === skuId).reduce((s, t) => s + t.qty, 0)
  }

  /** 倉庫内の SKU 別残高（0 は除外） */
  function balancesOfWarehouse(warehouseId: string): { skuId: string; qty: number }[] {
    const map = new Map<string, number>()
    for (const t of txns.value) {
      if (t.warehouseId !== warehouseId) continue
      map.set(t.skuId, (map.get(t.skuId) ?? 0) + t.qty)
    }
    return [...map.entries()].filter(([, q]) => q !== 0).map(([skuId, qty]) => ({ skuId, qty }))
  }

  /** 台帳の明細（フィルタ・新しい順） */
  function ledgerOf(filter?: { skuId?: string; warehouseId?: string }): InventoryTransaction[] {
    return txns.value
      .filter(t => (!filter?.skuId || t.skuId === filter.skuId) && (!filter?.warehouseId || t.warehouseId === filter.warehouseId))
      .slice()
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
  }

  /**
   * 台帳へ追記する（入荷/出荷/仕入/生産の実績から呼ぶ）。
   * 冪等: 同一 (refType, refLineId, kind) が既にあればスキップ（二重生成防止）。
   * 戻り値 = 実際に追加した件数。
   */
  function post(entries: PostEntry[]): number {
    const at = nowJstIso()
    const existing = new Set(txns.value.map(t => `${t.refType}::${t.refLineId}::${t.kind}`))
    const toAdd: InventoryTransaction[] = []
    for (const e of entries) {
      if (e.qty === 0) continue
      const dedup = `${e.refType}::${e.refLineId}::${e.kind}`
      if (existing.has(dedup)) continue
      existing.add(dedup)
      toAdd.push({
        id: nextId('inventoryTransactions', 'itx'),
        skuId: e.skuId,
        warehouseId: e.warehouseId,
        qty: e.qty,
        kind: e.kind,
        reason: e.reason ?? null,
        refType: e.refType,
        refLineId: e.refLineId,
        occurredAt: e.occurredAt ?? at,
      })
    }
    if (toAdd.length > 0) {
      txns.value = [...txns.value, ...toAdd]
      commit()
    }
    return toAdd.length
  }

  /** 在庫調整（F-27-2。理由必須） */
  function adjust(input: { skuId: string; warehouseId: string; qty: number; reason: InventoryAdjustReason }): Result {
    if (!input.skuId || !input.warehouseId) {
      return { ok: false, error: { code: 'AKO-INV-001', message: 'SKU と倉庫を指定してください' } }
    }
    if (!Number.isFinite(input.qty) || input.qty === 0) {
      return { ok: false, error: { code: 'AKO-INV-002', message: '調整数量は 0 以外で指定してください' } }
    }
    const refLineId = nextId('inventoryTransactions', 'adj')
    post([{ ...input, kind: 'adjust', refType: 'adjust', refLineId }])
    return { ok: true, id: refLineId }
  }

  /** 倉庫間移動（F-27-3。出 + 入をアトミックに） */
  function transfer(input: { skuId: string; fromWarehouseId: string; toWarehouseId: string; qty: number }): Result {
    if (input.fromWarehouseId === input.toWarehouseId) {
      return { ok: false, error: { code: 'AKO-INV-003', message: '移動元と移動先が同じです' } }
    }
    if (!Number.isFinite(input.qty) || input.qty <= 0) {
      return { ok: false, error: { code: 'AKO-INV-002', message: '移動数量は 1 以上で指定してください' } }
    }
    if (balanceOf(input.skuId, input.fromWarehouseId) < input.qty) {
      return { ok: false, error: { code: 'AKO-INV-004', message: '移動元の在庫が不足しています' } }
    }
    const refLineId = nextId('inventoryTransactions', 'trf')
    post([
      { skuId: input.skuId, warehouseId: input.fromWarehouseId, qty: -input.qty, kind: 'transfer_out', refType: 'transfer', refLineId },
      { skuId: input.skuId, warehouseId: input.toWarehouseId, qty: input.qty, kind: 'transfer_in', refType: 'transfer', refLineId },
    ])
    return { ok: true, id: refLineId }
  }

  /** 棚卸確定（F-27-4。実棚数 − 理論在庫の差分を stocktake 調整として計上） */
  function stocktake(warehouseId: string, counts: { skuId: string; actualQty: number }[]): Result & { adjusted?: number } {
    const entries: PostEntry[] = []
    for (const c of counts) {
      const diff = c.actualQty - balanceOf(c.skuId, warehouseId)
      if (diff === 0) continue
      const refLineId = nextId('inventoryTransactions', 'stk')
      entries.push({ skuId: c.skuId, warehouseId, qty: diff, kind: 'stocktake', reason: 'stocktake', refType: 'stocktake', refLineId })
    }
    if (entries.length === 0) return { ok: true, adjusted: 0 }
    // 各 refLineId が一意なので post は全件追加
    post(entries)
    return { ok: true, adjusted: entries.length }
  }

  return {
    txns, balances, balanceOf, totalOf, balancesOfWarehouse, ledgerOf,
    post, adjust, transfer, stocktake,
  }
}
