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
    const recLines = lines.map(l => ({ id: nextId('purchaseRecords', 'purl') + '-' + l.skuId, skuId: l.skuId, qty: l.qty, costPrice: l.costPrice }))
    const created: PurchaseRecord = {
      id, code: nextCode(records.value.map(r => r.code), 'PUR'),
      companyId: input.companyId, segmentId: input.segmentId, purchaseDate: input.purchaseDate,
      purchaseType: input.purchaseType, inboundResultId: null, lines: recLines, correctionOf: null,
    }
    records.value = [...records.value, created]
    // 入荷管理 OFF のとき仕入計上と同時に在庫へ入庫（purchase_in）
    if (!apps.isAppEnabled('inbounds') && input.warehouseId) {
      inv.post(recLines.map(l => ({ skuId: l.skuId, warehouseId: input.warehouseId!, qty: l.qty, kind: 'purchase_in' as const, refType: 'purchase', refLineId: l.id })))
    }
    commit()
    return { ok: true, id }
  }

  /** 赤黒訂正（マイナス明細の仕入を追加。元は不変） */
  function correct(id: string): Result {
    const src = recordById(id)
    if (!src) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    if (src.correctionOf) return { ok: false, error: { code: 'AKO-PCH-003', message: '訂正伝票は再訂正できません' } }
    const newId = nextId('purchaseRecords', 'pur')
    const reversal: PurchaseRecord = {
      ...src, id: newId, code: nextCode(records.value.map(r => r.code), 'PUR'),
      purchaseDate: todayJst(), inboundResultId: null, correctionOf: id,
      lines: src.lines.map(l => ({ ...l, id: l.id + '-c', qty: -l.qty })),
    }
    records.value = [...records.value, reversal]
    commit()
    return { ok: true, id: newId }
  }

  return { records, activeRecords, recordById, recordTotal, create, correct }
}
