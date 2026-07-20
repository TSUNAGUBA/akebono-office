/**
 * 入荷管理（F-25）
 * 予定（InboundPlan・設定系）と実績（InboundResult・記録系・追記のみ・部分実績可）を分離。
 * 実績登録で在庫台帳へ入庫（+）を post（明細行単位の冪等キー）。
 */
import type { InboundPlan, InboundResult, PlanStatus } from '~/types/akebono'
import type { Result } from '~/types/domain'
import { nextCode } from '~/utils/akebono'

export function useInbound() {
  const { tbl, commit, nextId } = useMockDb()
  const plans = tbl('inboundPlans')
  const results = tbl('inboundResults')
  const inv = useInventory()

  const activePlans = computed(() => plans.value.slice().sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1)))

  function planById(id: string): InboundPlan | undefined {
    return plans.value.find(p => p.id === id)
  }
  function resultsOfPlan(planId: string): InboundResult[] {
    return results.value.filter(r => r.planId === planId)
  }
  /** 予定明細ごとの入荷済み数 */
  function receivedQtyOf(planId: string, planLineId: string): number {
    let sum = 0
    for (const r of results.value.filter(r => r.planId === planId)) {
      for (const l of r.lines) if (l.planLineId === planLineId) sum += l.qty
    }
    return sum
  }

  function createPlan(input: { poId?: string | null; warehouseId: string; dueDate: string; lines: { skuId: string; qty: number }[] }): Result {
    if (!input.warehouseId) return { ok: false, error: { code: 'AKO-INB-001', message: '入荷先倉庫を指定してください' } }
    const lines = input.lines.filter(l => l.skuId && l.qty > 0)
    if (lines.length === 0) return { ok: false, error: { code: 'AKO-INB-002', message: '入荷明細を 1 行以上入力してください' } }
    const id = nextId('inboundPlans', 'ibp')
    const created: InboundPlan = {
      id, code: nextCode(plans.value.map(p => p.code), 'IBP'),
      poId: input.poId ?? null, warehouseId: input.warehouseId, dueDate: input.dueDate, status: 'pending',
      // 明細行 id はヘッダ id + index で全域一意（nextId は別 prefix を採番できず衝突するため使わない）
      lines: lines.map((l, idx) => ({ id: `${id}-${idx}`, skuId: l.skuId, qty: l.qty })),
    }
    plans.value = [...plans.value, created]
    commit()
    return { ok: true, id }
  }

  /** 予定のステータス再計算（実績合計 vs 予定） */
  function recomputeStatus(plan: InboundPlan): PlanStatus {
    if (plan.status === 'canceled') return 'canceled'
    const totalPlanned = plan.lines.reduce((s, l) => s + l.qty, 0)
    let totalReceived = 0
    for (const l of plan.lines) totalReceived += receivedQtyOf(plan.id, l.id)
    if (totalReceived <= 0) return 'pending'
    return totalReceived >= totalPlanned ? 'completed' : 'partial'
  }

  /**
   * 入荷実績を登録（記録系・追記）。指示参照 or 直接登録。
   * 明細行ごとに在庫台帳へ入庫（+）を post。予定のステータスを再計算。
   */
  function registerResult(input: { planId?: string | null; warehouseId?: string; lines: { planLineId?: string | null; skuId: string; qty: number }[] }): Result {
    const plan = input.planId ? planById(input.planId) : undefined
    const warehouseId = plan?.warehouseId ?? input.warehouseId
    if (!warehouseId) return { ok: false, error: { code: 'AKO-INB-001', message: '入荷先倉庫を指定してください（直接登録時は必須）' } }
    const lines = input.lines.filter(l => l.skuId && l.qty > 0)
    if (lines.length === 0) return { ok: false, error: { code: 'AKO-INB-002', message: '入荷明細を 1 行以上入力してください' } }

    const resultId = nextId('inboundResults', 'ibr')
    // 明細行 id はヘッダ id + index で全域一意（同一 SKU 複数行・別実績の同一 SKU も分離 = 冪等キー衝突しない）
    const resultLines = lines.map((l, idx) => ({
      id: `${resultId}-${idx}`,
      planLineId: l.planLineId ?? null, skuId: l.skuId, qty: l.qty,
    }))
    const created: InboundResult = {
      id: resultId, code: nextCode(results.value.map(r => r.code), 'IBR'),
      planId: input.planId ?? null, warehouseId, receivedAt: nowJstIso(), lines: resultLines,
    }
    results.value = [...results.value, created]
    // 在庫台帳へ入庫（明細行単位）
    inv.post(resultLines.map(l => ({ skuId: l.skuId, warehouseId, qty: l.qty, kind: 'inbound' as const, refType: 'inbound_result', refLineId: l.id })))
    // 予定ステータス再計算
    if (plan) {
      const status = recomputeStatus(plan)
      plans.value = plans.value.map(p => p.id === plan.id ? { ...p, status } : p)
    }
    commit()
    return { ok: true, id: resultId }
  }

  function cancelPlan(id: string): Result {
    const plan = planById(id)
    if (!plan) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    if (resultsOfPlan(id).length > 0) return { ok: false, error: { code: 'AKO-INB-003', message: '入荷実績のある予定は取消できません' } }
    plans.value = plans.value.map(p => p.id === id ? { ...p, status: 'canceled' } : p)
    commit()
    return { ok: true, id }
  }

  return { plans, results, activePlans, planById, resultsOfPlan, receivedQtyOf, createPlan, registerResult, cancelPlan }
}
