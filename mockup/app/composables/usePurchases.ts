/**
 * 仕入管理（F-24）
 * 仕入計上（買取 / 委託）。記録系・訂正は赤黒。
 * 入荷管理 OFF の場合は仕入計上と同時に在庫へ入庫（purchase_in）。ON の場合は入荷実績で入庫済み。
 * 委託は債務確定タイミングを委託条件で設定（表示のみ。精算は請求管理 F-29-4）。
 */
import type { PurchaseRecord, PurchaseType } from '~/types/akebono'
import type { Result } from '~/types/domain'
import { nextCode } from '~/utils/akebono'

export function usePurchases() {
  const { tbl, commit, nextId } = useMockDb()
  const records = tbl('purchaseRecords')
  const inv = useInventory()
  const apps = useAkebonoApps()

  const activeRecords = computed(() => records.value.slice().sort((a, b) => (a.purchaseDate < b.purchaseDate ? 1 : -1)))

  function recordById(id: string): PurchaseRecord | undefined {
    return records.value.find(r => r.id === id)
  }
  function recordTotal(r: PurchaseRecord): number {
    return r.lines.reduce((s, l) => s + l.qty * l.costPrice, 0)
  }

  function create(input: {
    companyId: string; segmentId: string; purchaseDate: string; purchaseType: PurchaseType;
    warehouseId?: string | null; lines: { skuId: string; qty: number; costPrice: number }[]
  }): Result {
    if (!input.companyId) return { ok: false, error: { code: 'AKO-PCH-001', message: '仕入先を指定してください' } }
    if (!input.segmentId) return { ok: false, error: { code: 'AKO-PCH-001', message: '事業セグメントを指定してください' } }
    const lines = input.lines.filter(l => l.skuId && l.qty > 0)
    if (lines.length === 0) return { ok: false, error: { code: 'AKO-PCH-002', message: '仕入明細を 1 行以上入力してください' } }

    const id = nextId('purchaseRecords', 'pur')
    // 明細行 id はヘッダ id + index で全域一意（別 prefix の nextId は衝突するため使わない）
    const recLines = lines.map((l, idx) => ({ id: `${id}-${idx}`, skuId: l.skuId, qty: l.qty, costPrice: l.costPrice }))
    // 入荷管理 OFF のとき仕入計上と同時に在庫へ入庫（purchase_in）。訂正時の戻しのため warehouseId を保持
    const postedWarehouseId = !apps.isAppEnabled('inbounds') && input.warehouseId ? input.warehouseId : null
    const created: PurchaseRecord = {
      id, code: nextCode(records.value.map(r => r.code), 'PUR'),
      companyId: input.companyId, segmentId: input.segmentId, purchaseDate: input.purchaseDate,
      purchaseType: input.purchaseType, inboundResultId: null, warehouseId: postedWarehouseId, lines: recLines, correctionOf: null,
    }
    records.value = [...records.value, created]
    if (postedWarehouseId) {
      inv.post(recLines.map(l => ({ skuId: l.skuId, warehouseId: postedWarehouseId, qty: l.qty, kind: 'purchase_in' as const, refType: 'purchase', refLineId: l.id })))
    }
    commit()
    return { ok: true, id }
  }

  /** 赤黒訂正（マイナス明細の仕入を追加。元は不変）。在庫入庫済み（入荷OFF経路）なら在庫も戻す */
  function correct(id: string): Result {
    const src = recordById(id)
    if (!src) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    if (src.correctionOf) return { ok: false, error: { code: 'AKO-PCH-003', message: '訂正伝票は再訂正できません' } }
    const newId = nextId('purchaseRecords', 'pur')
    const revLines = src.lines.map((l, idx) => ({ ...l, id: `${newId}-${idx}`, qty: -l.qty }))
    const reversal: PurchaseRecord = {
      ...src, id: newId, code: nextCode(records.value.map(r => r.code), 'PUR'),
      purchaseDate: todayJst(), inboundResultId: null, warehouseId: src.warehouseId, correctionOf: id, lines: revLines,
    }
    records.value = [...records.value, reversal]
    // 入荷OFF経路で入庫済みの場合は在庫も戻す（記録と在庫の乖離防止）
    if (src.warehouseId) {
      inv.post(revLines.map(l => ({ skuId: l.skuId, warehouseId: src.warehouseId!, qty: l.qty, kind: 'purchase_in' as const, refType: 'purchase', refLineId: l.id })))
    }
    commit()
    return { ok: true, id: newId }
  }

  return { records, activeRecords, recordById, recordTotal, create, correct }
}
