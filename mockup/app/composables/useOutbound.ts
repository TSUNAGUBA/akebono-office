/**
 * 出荷管理（F-26）
 * 指示（OutboundPlan・設定系・単独 DELETE 禁止 = 取消はステータス）と
 * 実績（OutboundResult・記録系・追記のみ・部分実績可・指示参照 or 直接登録）を分離。
 * 実績登録で自社倉庫から出庫（−）。出荷先が店舗（store_deposit 倉庫を持つ）の場合は
 * 預け在庫へ移動（transfer_in +）を同時に post。
 */
import type { OutboundPlan, OutboundResult, PlanStatus, Warehouse } from '~/types/akebono'
import type { Company } from '~/types/domain'
import type { Result } from '~/types/domain'
import { hasPartnerRole, nextCode } from '~/utils/akebono'

export function useOutbound() {
  const { tbl, commit, nextId } = useMockDb()
  const plans = tbl('outboundPlans')
  const results = tbl('outboundResults')
  const warehouses = tbl('warehouses')
  const companies = tbl('companies')
  const inv = useInventory()

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

  function createPlan(input: { companyId: string; warehouseId: string; segmentId: string; dueDate: string; lines: { skuId: string; qty: number }[] }): Result {
    if (!input.companyId) return { ok: false, error: { code: 'AKO-OUT-001', message: '出荷先を指定してください' } }
    if (!input.warehouseId) return { ok: false, error: { code: 'AKO-OUT-001', message: '出荷元倉庫を指定してください' } }
    if (!input.segmentId) return { ok: false, error: { code: 'AKO-OUT-001', message: '事業セグメントを指定してください' } }
    const lines = input.lines.filter(l => l.skuId && l.qty > 0)
    if (lines.length === 0) return { ok: false, error: { code: 'AKO-OUT-002', message: '出荷明細を 1 行以上入力してください' } }
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

  /** 出荷実績を登録（記録系・追記）。出庫（−）+ 店舗預け移動（+）を post */
  function registerResult(input: { planId?: string | null; warehouseId?: string; companyId?: string; lines: { planLineId?: string | null; skuId: string; qty: number }[] }): Result {
    const plan = input.planId ? planById(input.planId) : undefined
    const warehouseId = plan?.warehouseId ?? input.warehouseId
    const companyId = plan?.companyId ?? input.companyId ?? null
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
    const created: OutboundResult = {
      id: resultId, code: nextCode(results.value.map(r => r.code), 'OBR'),
      planId: input.planId ?? null, warehouseId, companyId, shippedAt: nowJstIso(), lines: resultLines,
    }
    results.value = [...results.value, created]

    // 出庫（−）
    const posts = resultLines.map(l => ({ skuId: l.skuId, warehouseId, qty: -l.qty, kind: 'outbound' as const, refType: 'outbound_result', refLineId: l.id }))
    // 店舗納品 = 預け在庫へ移動（+）
    const depositWh = storeDepositWarehouseOf(companyId)
    if (depositWh) {
      for (const l of resultLines) {
        posts.push({ skuId: l.skuId, warehouseId: depositWh.id, qty: l.qty, kind: 'transfer_in' as const, refType: 'outbound_result', refLineId: l.id })
      }
    }
    inv.post(posts)

    if (plan) {
      const status = recomputeStatus(plan)
      plans.value = plans.value.map(p => p.id === plan.id ? { ...p, status } : p)
    }
    commit()
    return { ok: true, id: resultId }
  }

  /** 取消（赤伝相当 = ステータス。単独 DELETE はしない） */
  function cancelPlan(id: string): Result {
    const plan = planById(id)
    if (!plan) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    if (resultsOfPlan(id).length > 0) return { ok: false, error: { code: 'AKO-OUT-003', message: '出荷実績のある指示は取消できません' } }
    plans.value = plans.value.map(p => p.id === id ? { ...p, status: 'canceled' } : p)
    commit()
    return { ok: true, id }
  }

  return { plans, results, activePlans, planById, resultsOfPlan, shippedQtyOf, storeDepositWarehouseOf, createPlan, registerResult, cancelPlan }
}
