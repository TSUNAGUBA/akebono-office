/**
 * 出荷管理（F-26）
 * 指示（OutboundPlan・設定系・単独 DELETE 禁止 = 取消はステータス）と
 * 実績（OutboundResult・記録系・追記のみ・部分実績可・指示参照 or 直接登録）を分離。
 * 実績登録で自社倉庫から出庫（−）。出荷先が店舗（store_deposit 倉庫を持つ）の場合は
 * 預け在庫へ移動（transfer_in +）を同時に post。
 * デュアルモード（Phase C = 0032）: API モードの SoT はサーバー（outbound_plans / outbound_results +
 * inventory_transactions）。在庫不足チェック・店舗預け移動・予定ステータス再計算はサーバーが担う。
 */
import type { BillingType, OutboundPlan, OutboundResult, PlanStatus, SalesRecord, Warehouse } from '~/types/akebono'
import type { Company } from '~/types/domain'
import type { Result } from '~/types/domain'
import type { PostEntry } from '~/composables/useInventory'
import { hasPartnerRole, nextCode } from '~/utils/akebono'

export function useOutbound() {
  const { tbl, commit, nextId } = useMockDb()
  const plans = tbl('outboundPlans')
  const results = tbl('outboundResults')
  const warehouses = tbl('warehouses')
  const companies = tbl('companies')
  const sales = tbl('salesRecords')
  const inv = useInventory()
  const products = useProducts()
  const isApi = useApiMode()

  const activePlans = computed(() => plans.value.slice().sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1)))

  function planById(id: string): OutboundPlan | undefined {
    return plans.value.find(p => p.id === id)
  }
  function resultsOfPlan(planId: string): OutboundResult[] {
    return results.value.filter(r => r.planId === planId)
  }
  function shippedQtyOf(planId: string, planLineId: string): number {
    let sum = 0
    for (const r of results.value.filter(r => r.planId === planId)) {
      for (const l of r.lines) if (l.planLineId === planLineId) sum += l.qty
    }
    return sum
  }

  /** 出荷先の店舗預け倉庫（store_deposit + companyId 一致）。無ければ null */
  function storeDepositWarehouseOf(companyId: string | null): Warehouse | null {
    if (!companyId) return null
    const company = (companies.value as Company[]).find(c => c.id === companyId)
    if (!company || !hasPartnerRole(company, 'store')) return null
    return warehouses.value.find(w => w.kind === 'store_deposit' && w.companyId === companyId && w.active !== false) ?? null
  }

  async function createPlan(input: { companyId: string; warehouseId: string; segmentId: string; dueDate: string; lines: { skuId: string; qty: number }[] }): Promise<Result> {
    if (!input.companyId) return { ok: false, error: { code: 'AKO-OUT-001', message: '出荷先を指定してください' } }
    if (!input.warehouseId) return { ok: false, error: { code: 'AKO-OUT-001', message: '出荷元倉庫を指定してください' } }
    if (!input.segmentId) return { ok: false, error: { code: 'AKO-OUT-001', message: '事業セグメントを指定してください' } }
    const lines = input.lines.filter(l => l.skuId && l.qty > 0)
    if (lines.length === 0) return { ok: false, error: { code: 'AKO-OUT-002', message: '出荷明細を 1 行以上入力してください' } }
    if (isApi) {
      const res = await apiWrite<OutboundPlan>('/v1/akebono/outbound-plans', { body: { ...input, lines }, reload: ['outboundPlans'] })
      return res.ok ? { ok: true, id: res.data.id } : res
    }
    const id = nextId('outboundPlans', 'obp')
    const created: OutboundPlan = {
      id, code: nextCode(plans.value.map(p => p.code), 'OBP'),
      companyId: input.companyId, warehouseId: input.warehouseId, segmentId: input.segmentId, dueDate: input.dueDate,
      // 明細行 id はヘッダ id + index で全域一意
      status: 'pending', lines: lines.map((l, idx) => ({ id: `${id}-${idx}`, skuId: l.skuId, qty: l.qty })),
    }
    plans.value = [...plans.value, created]
    commit()
    return { ok: true, id }
  }

  function recomputeStatus(plan: OutboundPlan): PlanStatus {
    if (plan.status === 'canceled') return 'canceled'
    const totalPlanned = plan.lines.reduce((s, l) => s + l.qty, 0)
    let totalShipped = 0
    for (const l of plan.lines) totalShipped += shippedQtyOf(plan.id, l.id)
    if (totalShipped <= 0) return 'pending'
    return totalShipped >= totalPlanned ? 'completed' : 'partial'
  }

  /**
   * 出荷実績を登録（記録系・追記）。出庫（−）+ 店舗預け移動（+）を post。
   * postSales=true のときは出荷明細から売上を自動計上する（sourceKind='shipment'。F-28 連携）。
   * 店舗預け（consignment）の出荷は「販売」ではないため売上計上の対象外。二重計上は source_ref で防ぐ。
   */
  async function registerResult(input: { planId?: string | null; warehouseId?: string; companyId?: string | null; segmentId?: string | null; lines: { planLineId?: string | null; skuId: string; qty: number }[]; postSales?: boolean }): Promise<Result> {
    if (isApi) {
      const reload = ['outboundResults', 'inventoryTransactions', 'inventoryBalances', 'outboundPlans']
      if (input.postSales) reload.push('salesRecords')
      const res = await apiWrite<OutboundResult>('/v1/akebono/outbound-results', {
        body: input, reload,
      })
      if (res.ok && input.postSales) {
        const segId = (input.planId ? planById(input.planId)?.segmentId : null) ?? input.segmentId
        if (segId) invalidateIntegratedFor(segId)
      }
      return res.ok ? { ok: true, id: res.data.id } : res
    }
    const plan = input.planId ? planById(input.planId) : undefined
    const warehouseId = plan?.warehouseId ?? input.warehouseId
    const companyId = plan?.companyId ?? input.companyId ?? null
    const segmentId = plan?.segmentId ?? input.segmentId ?? null
    if (!warehouseId) return { ok: false, error: { code: 'AKO-OUT-001', message: '出荷元倉庫を指定してください（直接登録時は必須）' } }
    const lines = input.lines.filter(l => l.skuId && l.qty > 0)
    if (lines.length === 0) return { ok: false, error: { code: 'AKO-OUT-002', message: '出荷明細を 1 行以上入力してください' } }
    // 在庫不足チェック（自社倉庫）: 同一 SKU 複数行の合計で判定（行単位だと合算超過を見逃す）
    const neededBySku = new Map<string, number>()
    for (const l of lines) neededBySku.set(l.skuId, (neededBySku.get(l.skuId) ?? 0) + l.qty)
    for (const [skuId, need] of neededBySku) {
      if (inv.balanceOf(skuId, warehouseId) < need) {
        return { ok: false, error: { code: 'AKO-OUT-004', message: '出荷元の在庫が不足しています' } }
      }
    }

    const resultId = nextId('outboundResults', 'obr')
    // 明細行 id はヘッダ id + index で全域一意
    const resultLines = lines.map((l, idx) => ({
      id: `${resultId}-${idx}`, planLineId: l.planLineId ?? null, skuId: l.skuId, qty: l.qty,
    }))
    const depositWh = storeDepositWarehouseOf(companyId)

    // 売上自動計上（postSales）の事前検証（在庫 post の前に弾く = 部分適用を作らない）
    if (input.postSales) {
      if (depositWh) return { ok: false, error: { code: 'AKO-OUT-005', message: '店舗預けの出荷は売上計上できません（店舗での販売時に売上を計上します）' } }
      if (!companyId) return { ok: false, error: { code: 'AKO-OUT-005', message: '売上計上には出荷先（得意先）が必要です' } }
      if (!segmentId) return { ok: false, error: { code: 'AKO-OUT-005', message: '売上計上には事業セグメントが必要です' } }
      for (const l of resultLines) {
        const sku = products.skuById(l.skuId)
        if (!sku || !(products.sellPriceOf(sku) > 0)) {
          return { ok: false, error: { code: 'AKO-OUT-005', message: '売上単価を解決できません（商品または SKU に販売単価を設定してください）' } }
        }
      }
    }

    const created: OutboundResult = {
      id: resultId, code: nextCode(results.value.map(r => r.code), 'OBR'),
      planId: input.planId ?? null, warehouseId, companyId, shippedAt: nowJstIso(), lines: resultLines,
    }
    results.value = [...results.value, created]

    // 出庫（−）
    const posts: PostEntry[] = resultLines.map(l => ({ skuId: l.skuId, warehouseId, qty: -l.qty, kind: 'outbound', refType: 'outbound_result', refLineId: l.id }))
    // 店舗納品 = 預け在庫へ移動（+）
    if (depositWh) {
      for (const l of resultLines) {
        posts.push({ skuId: l.skuId, warehouseId: depositWh.id, qty: l.qty, kind: 'transfer_in', refType: 'outbound_result', refLineId: l.id })
      }
    }
    inv.post(posts)

    // 売上自動計上（sourceKind='shipment'。事前検証済み = ここで失敗しない）
    if (input.postSales && companyId && segmentId) {
      const newSales: SalesRecord[] = []
      for (const [idx, l] of resultLines.entries()) {
        const sku = products.skuById(l.skuId)!
        const product = products.productOfSku(l.skuId)
        const unitPrice = products.sellPriceOf(sku)
        newSales.push({
          // コードは既存 + 生成済みを含めて採番する（同一実績の複数行で SR コードが重複しないよう蓄積）
          id: `${resultId}-sr${idx}`, code: nextCode([...sales.value, ...newSales].map(r => r.code), 'SR'),
          salesDate: todayJst(), companyId, segmentId, skuId: l.skuId, qty: l.qty, unitPrice,
          amount: Math.round(l.qty * unitPrice), costPrice: products.costOf(sku),
          channel: null, billingType: (product?.billingType ?? null) as BillingType | null,
          sourceKind: 'shipment', sourceRef: `obr:${l.id}`, invoiceId: null, correctionOf: null, active: true,
        })
      }
      sales.value = [...sales.value, ...newSales]
      invalidateIntegratedFor(segmentId)
    }

    if (plan) {
      const status = recomputeStatus(plan)
      plans.value = plans.value.map(p => p.id === plan.id ? { ...p, status } : p)
    }
    commit()
    return { ok: true, id: resultId }
  }

  /** 取消（赤伝相当 = ステータス。単独 DELETE はしない） */
  async function cancelPlan(id: string): Promise<Result> {
    if (isApi) return apiWrite(`/v1/akebono/outbound-plans/${id}/cancel`, { reload: ['outboundPlans'] })
    const plan = planById(id)
    if (!plan) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    if (resultsOfPlan(id).length > 0) return { ok: false, error: { code: 'AKO-OUT-003', message: '出荷実績のある指示は取消できません' } }
    plans.value = plans.value.map(p => p.id === id ? { ...p, status: 'canceled' } : p)
    commit()
    return { ok: true, id }
  }

  return { plans, results, activePlans, planById, resultsOfPlan, shippedQtyOf, storeDepositWarehouseOf, createPlan, registerResult, cancelPlan }
}
