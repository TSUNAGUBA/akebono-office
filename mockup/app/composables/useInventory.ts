/**
 * 在庫管理（F-27）
 * SoT = inventoryTransactions（台帳・追記のみ）。残高は導出（warehouse 実証方式: Σqty）。
 * 入荷/出荷/仕入/生産は本 composable の post() を通じて台帳へ書く（冪等キー = refType × refLineId × kind）。
 * 調整・移動・棚卸は本ページの操作として台帳へ追記する。
 * デュアルモード（Phase C = 0032）: API モードの SoT はサーバー（inventory_transactions）。
 * 残高・台帳表示はハイドレーション済みキャッシュからの導出（両モード共通の純関数 = foldBalances）。
 * post() はモックモード専用（API では各実績エンドポイントがサーバー側で台帳へ書く）。
 */
import type {
  InventoryAdjustReason, InventoryTransaction, InventoryTxnKind,
} from '~/types/akebono'
import type { Result } from '~/types/domain'
import { balanceKey, foldBalances, nextCode } from '~/utils/akebono'

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
  const isApi = useApiMode()
  // 残高の母集団: API モードは**サーバー集約**（inventory-balances = 全量 Σqty）を使う。
  // 台帳明細（txns = inventory-transactions）は表示用で LIMIT 打ち切りがあり、2 万行を超えると
  // 期首在庫・過去の移動が残高から消える（Codex P1-2）。モックモードは従来どおり台帳を
  // foldBalances でローカル集約（全件ローカル = 不変）。書込後は各実績経路が inventoryBalances も再取得する。
  const serverBalances = isApi
    ? apiCollection<{ skuId: string; warehouseId: string; qty: number }>('inventoryBalances')
    : null

  /** SKU × 倉庫 の残高マップ（API = サーバー集約 / モック = 台帳から導出） */
  const balances = computed(() => {
    if (serverBalances) {
      const map = new Map<string, number>()
      for (const b of serverBalances.value) map.set(balanceKey(b.skuId, b.warehouseId), b.qty)
      return map
    }
    return foldBalances(txns.value)
  })

  function balanceOf(skuId: string, warehouseId: string): number {
    return balances.value.get(balanceKey(skuId, warehouseId)) ?? 0
  }

  /** SKU の全倉庫合計 */
  function totalOf(skuId: string): number {
    if (serverBalances) return serverBalances.value.filter(b => b.skuId === skuId).reduce((s, b) => s + b.qty, 0)
    return txns.value.filter(t => t.skuId === skuId).reduce((s, t) => s + t.qty, 0)
  }

  /** 倉庫内の SKU 別残高（0 は除外） */
  function balancesOfWarehouse(warehouseId: string): { skuId: string; qty: number }[] {
    if (serverBalances) {
      return serverBalances.value
        .filter(b => b.warehouseId === warehouseId && b.qty !== 0)
        .map(b => ({ skuId: b.skuId, qty: b.qty }))
    }
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

  /**
   * 派生 id（調整/移動/棚卸の refLineId）の採番。
   * nextId(collection, prefix) はコレクションのトップレベル id（itx-*）しか走査しないため、
   * 別 prefix の refLineId には使えない（常に -0001 → 冪等キー衝突で 2 回目以降が破棄される）。
   * ここでは既存の refLineId 実値を走査して一意連番を生成する。
   */
  function nextRefLineId(prefix: string): string {
    return nextCode(txns.value.map(t => t.refLineId), prefix)
  }

  /** 在庫調整（F-27-2。理由必須） */
  async function adjust(input: { skuId: string; warehouseId: string; qty: number; reason: InventoryAdjustReason }): Promise<Result> {
    if (!input.skuId || !input.warehouseId) {
      return { ok: false, error: { code: 'AKO-INV-001', message: 'SKU と倉庫を指定してください' } }
    }
    if (!Number.isFinite(input.qty) || input.qty === 0) {
      return { ok: false, error: { code: 'AKO-INV-002', message: '調整数量は 0 以外で指定してください' } }
    }
    if (isApi) return apiWrite('/v1/akebono/inventory/adjust', { body: input, reload: ['inventoryTransactions', 'inventoryBalances'] })
    const refLineId = nextRefLineId('adj')
    post([{ ...input, kind: 'adjust', refType: 'adjust', refLineId }])
    return { ok: true, id: refLineId }
  }

  /** 倉庫間移動（F-27-3。出 + 入をアトミックに） */
  async function transfer(input: { skuId: string; fromWarehouseId: string; toWarehouseId: string; qty: number }): Promise<Result> {
    if (input.fromWarehouseId === input.toWarehouseId) {
      return { ok: false, error: { code: 'AKO-INV-003', message: '移動元と移動先が同じです' } }
    }
    if (!Number.isFinite(input.qty) || input.qty <= 0) {
      return { ok: false, error: { code: 'AKO-INV-002', message: '移動数量は 1 以上で指定してください' } }
    }
    if (isApi) return apiWrite('/v1/akebono/inventory/transfer', { body: input, reload: ['inventoryTransactions', 'inventoryBalances'] })
    if (balanceOf(input.skuId, input.fromWarehouseId) < input.qty) {
      return { ok: false, error: { code: 'AKO-INV-004', message: '移動元の在庫が不足しています' } }
    }
    // 出/入の 2 行は同一 refLineId を共有（kind が異なるため冪等キーは衝突しない）。イベント間は一意
    const refLineId = nextRefLineId('trf')
    post([
      { skuId: input.skuId, warehouseId: input.fromWarehouseId, qty: -input.qty, kind: 'transfer_out', refType: 'transfer', refLineId },
      { skuId: input.skuId, warehouseId: input.toWarehouseId, qty: input.qty, kind: 'transfer_in', refType: 'transfer', refLineId },
    ])
    return { ok: true, id: refLineId }
  }

  /** 棚卸確定（F-27-4。実棚数 − 理論在庫の差分を stocktake 調整として計上） */
  async function stocktake(warehouseId: string, counts: { skuId: string; actualQty: number }[]): Promise<Result & { adjusted?: number }> {
    if (isApi) {
      const res = await apiWrite<{ adjusted: number }>('/v1/akebono/inventory/stocktake', {
        body: { warehouseId, counts }, reload: ['inventoryTransactions', 'inventoryBalances'],
      })
      return res.ok ? { ok: true, adjusted: res.data.adjusted } : res
    }
    // 各明細行は同一 kind 'stocktake' なので refLineId を行ごとに一意化する（1 回の post 内でも衝突させない）
    const base = nextRefLineId('stk')
    let seq = Number(base.slice(4))
    const entries: PostEntry[] = []
    for (const c of counts) {
      const diff = c.actualQty - balanceOf(c.skuId, warehouseId)
      if (diff === 0) continue
      entries.push({ skuId: c.skuId, warehouseId, qty: diff, kind: 'stocktake', reason: 'stocktake', refType: 'stocktake', refLineId: `stk-${String(seq).padStart(4, '0')}` })
      seq++
    }
    if (entries.length === 0) return { ok: true, adjusted: 0 }
    post(entries)
    return { ok: true, adjusted: entries.length }
  }

  // 反対仕訳（取消）まわり。調整/移動/棚卸のみ取消可（実績・入出荷は各画面の取消経路を使う）
  const REVERSIBLE_REFTYPES = new Set(['adjust', 'transfer', 'stocktake'])
  function reverseRefOf(t: { refType: string; refLineId: string }): string {
    return `${t.refType}:${t.refLineId}`
  }
  /** 取消済みグループキー（反対仕訳の ref_line_id）の集合。状態判定を O(1) にする */
  const reversedRefs = computed(() => {
    const s = new Set<string>()
    for (const t of txns.value) if (t.refType === 'reverse') s.add(t.refLineId)
    return s
  })

  /**
   * 台帳明細の取消状態（原則9.5）。
   * - 'reversible': 調整/移動/棚卸で、まだ取消していない → 取消ボタンを出す
   * - 'reversed': 反対仕訳済み → 取消済みバッジ
   * - 'na': 実績・入出荷・既存の反対仕訳 → 取消不可（各画面の取消経路を使う）
   */
  function reverseStateOf(t: InventoryTransaction): 'reversible' | 'reversed' | 'na' {
    if (t.refType === 'reverse' || !REVERSIBLE_REFTYPES.has(t.refType)) return 'na'
    return reversedRefs.value.has(reverseRefOf(t)) ? 'reversed' : 'reversible'
  }

  /**
   * 在庫調整・移動・棚卸の取消（原則9.5）。台帳は追記のみのため物理削除せず、反対仕訳を追記して
   * 残高を戻す。移動は出/入の 2 行をまとめて反対仕訳する。冪等 = 既に取消済みなら弾く。
   */
  async function reverse(transactionId: string): Promise<Result> {
    const target = txns.value.find(t => t.id === transactionId)
    if (!target) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    if (!REVERSIBLE_REFTYPES.has(target.refType)) {
      return { ok: false, error: { code: 'AKO-INV-007', message: 'この明細は取消できません（入出荷・仕入・生産の実績は各画面の取消をご利用ください）' } }
    }
    if (isApi) {
      return apiWrite('/v1/akebono/inventory/reverse', {
        body: { transactionId }, reload: ['inventoryTransactions', 'inventoryBalances'], idempotent: true,
      })
    }
    const revRef = reverseRefOf(target)
    if (reversedRefs.value.has(revRef)) {
      return { ok: false, error: { code: 'AKO-INV-008', message: 'この明細は既に取消済みです' } }
    }
    const group = txns.value.filter(t => t.refType === target.refType && t.refLineId === target.refLineId)
    post(group.map(t => ({
      skuId: t.skuId, warehouseId: t.warehouseId, qty: -t.qty, kind: t.kind, reason: null,
      refType: 'reverse', refLineId: revRef,
    })))
    return { ok: true, id: revRef }
  }

  return {
    txns, balances, balanceOf, totalOf, balancesOfWarehouse, ledgerOf,
    post, adjust, transfer, stocktake, reverse, reverseStateOf,
  }
}
