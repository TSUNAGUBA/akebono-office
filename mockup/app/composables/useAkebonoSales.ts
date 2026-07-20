/**
 * 売上管理（F-28。F-15 を明細型へ強化）
 * SoT = salesRecords（売上明細）。月次・セグメント別サマリは導出。訂正は赤黒（記録系）。
 * 会計年度計算は shared/domain/fiscal を既存 useSales と共有。
 */
import {
  DEFAULT_FISCAL_START_MONTH, fiscalMonthsOf as fiscalMonthsOfFy, fiscalYearOf as fiscalYearOfMonth,
} from '../../../shared/domain/fiscal'
import type { BillingType, BusinessSegment, SalesRecord } from '~/types/akebono'
import type { Company, Result } from '~/types/domain'
import { nextCode } from '~/utils/akebono'

export function useAkebonoSales() {
  const { tbl, commit, nextId } = useMockDb()
  const records = tbl('salesRecords')
  const segments = tbl('businessSegments')
  const companies = tbl('companies')
  const products = useProducts()

  const activeRecords = computed(() => records.value.filter(r => r.active !== false))

  const fiscalStartMonth = computed(() =>
    (companies.value as Company[]).find(c => c.kind === 'self' && c.active !== false)?.fiscalStartMonth
      ?? DEFAULT_FISCAL_START_MONTH)

  const currentMonth = todayJst().slice(0, 7)
  function fiscalYearOf(month: string): number {
    return fiscalYearOfMonth(month, fiscalStartMonth.value)
  }
  const currentFiscalYear = computed(() => fiscalYearOf(currentMonth))
  function fiscalMonthsOf(fy: number): string[] {
    return fiscalMonthsOfFy(fy, fiscalStartMonth.value)
  }
  const fiscalYearOptions = computed(() => {
    const fys = new Set<number>()
    for (const r of activeRecords.value) fys.add(fiscalYearOf(r.salesDate.slice(0, 7)))
    fys.add(currentFiscalYear.value)
    return [...fys].sort((a, b) => b - a)
  })
  const selectedFy = ref<number>(currentFiscalYear.value)

  /** セグメント絞り込み（'' = 全セグメント合算） */
  const segmentFilter = ref<string>('')

  const activeSegments = computed(() =>
    (segments.value as BusinessSegment[]).filter(s => s.active !== false).sort((a, b) => a.displayOrder - b.displayOrder))

  function segmentName(id: string): string {
    return activeSegments.value.find(s => s.id === id)?.name ?? id
  }
  function companyName(id: string): string {
    return (companies.value as Company[]).find(c => c.id === id)?.name ?? id
  }

  /** フィルタ適用済みの明細（セグメント） */
  const filteredRecords = computed(() =>
    activeRecords.value.filter(r => !segmentFilter.value || r.segmentId === segmentFilter.value))

  function monthOf(r: SalesRecord): string {
    return r.salesDate.slice(0, 7)
  }
  function amountOfMonth(month: string, segmentId?: string): number {
    return filteredRecords.value
      .filter(r => monthOf(r) === month && (!segmentId || r.segmentId === segmentId))
      .reduce((s, r) => s + r.amount, 0)
  }

  // ---------- KPI（当月） ----------
  const currentMonthSales = computed(() => amountOfMonth(currentMonth))
  const prevYearSameMonth = computed(() => `${Number(currentMonth.slice(0, 4)) - 1}-${currentMonth.slice(5, 7)}`)
  const currentMonthYoY = computed(() => {
    const prev = amountOfMonth(prevYearSameMonth.value)
    return prev <= 0 ? null : (currentMonthSales.value - prev) / prev
  })
  const currentMonthMargin = computed(() => {
    const rows = filteredRecords.value.filter(r => monthOf(r) === currentMonth)
    const amount = rows.reduce((s, r) => s + r.amount, 0)
    if (amount <= 0) return null
    const cost = rows.reduce((s, r) => s + (r.costPrice ?? 0) * r.qty, 0)
    return (amount - cost) / amount
  })

  // ---------- 月次推移（選択年度 vs 前年） ----------
  const fiscalMonthLabels = computed(() => fiscalMonthsOf(selectedFy.value).map(m => `${Number(m.slice(5, 7))}月`))
  function monthlySeriesOf(fy: number): (number | null)[] {
    return fiscalMonthsOf(fy).map(m => (m > currentMonth ? null : amountOfMonth(m)))
  }
  const currentFySeries = computed(() => monthlySeriesOf(selectedFy.value))
  const previousFySeries = computed(() => monthlySeriesOf(selectedFy.value - 1))

  function selectedFyMonths(): Set<string> {
    return new Set(fiscalMonthsOf(selectedFy.value).filter(m => m <= currentMonth))
  }

  /** セグメント別内訳（選択年度・期初〜当月）。全セグメント合算ビューで使う */
  const segmentBreakdown = computed(() => {
    const months = selectedFyMonths()
    const map = new Map<string, number>()
    for (const r of activeRecords.value) {
      if (!months.has(monthOf(r))) continue
      map.set(r.segmentId, (map.get(r.segmentId) ?? 0) + r.amount)
    }
    return [...map.entries()].map(([id, value]) => ({ label: segmentName(id), value, segmentId: id }))
      .sort((a, b) => b.value - a.value)
  })

  /** 顧客別内訳（Top5 + その他。フィルタ適用） */
  const customerBreakdown = computed(() => {
    const months = selectedFyMonths()
    const map = new Map<string, number>()
    for (const r of filteredRecords.value) {
      if (!months.has(monthOf(r))) continue
      map.set(r.companyId, (map.get(r.companyId) ?? 0) + r.amount)
    }
    const sorted = [...map.entries()].map(([id, value]) => ({ label: companyName(id), value }))
      .sort((a, b) => b.value - a.value)
    if (sorted.length <= 5) return sorted
    const head = sorted.slice(0, 5)
    const rest = sorted.slice(5).reduce((s, x) => s + x.value, 0)
    return [...head, { label: 'その他', value: rest }]
  })

  /** セグメント別合計（非フィルタ = activeRecords ベース。並列比較用に汚染させない） */
  function segmentTotalIn(months: Set<string>, segmentId: string): number {
    return activeRecords.value
      .filter(r => months.has(monthOf(r)) && r.segmentId === segmentId)
      .reduce((s, r) => s + r.amount, 0)
  }

  /** セグメント並列比較（選択年度・期初〜当月の各セグメント合計。segmentFilter に依存しない） */
  const segmentComparison = computed(() => {
    const months = selectedFyMonths()
    return activeSegments.value.map(s => ({ segment: s, amount: segmentTotalIn(months, s.id) }))
  })

  // ---------- 書込 ----------
  function create(input: {
    salesDate: string; companyId: string; segmentId: string; skuId: string; qty: number; unitPrice: number;
    channel?: string | null; sourceKind?: SalesRecord['sourceKind']
  }): Result {
    if (!input.companyId || !input.segmentId || !input.skuId) {
      return { ok: false, error: { code: 'AKO-SLS-001', message: '得意先・セグメント・SKU は必須です' } }
    }
    if (!Number.isFinite(input.qty) || input.qty <= 0 || !Number.isFinite(input.unitPrice) || input.unitPrice < 0) {
      return { ok: false, error: { code: 'AKO-SLS-001', message: '数量・単価を正しく入力してください' } }
    }
    const sku = products.skuById(input.skuId)
    const product = sku ? products.productById(sku.productId) : undefined
    const id = nextId('salesRecords', 'sr')
    const created: SalesRecord = {
      id, code: nextCode(records.value.map(r => r.code), 'SR'),
      salesDate: input.salesDate, companyId: input.companyId, segmentId: input.segmentId, skuId: input.skuId,
      qty: input.qty, unitPrice: input.unitPrice, amount: Math.round(input.qty * input.unitPrice),
      costPrice: sku ? products.costOf(sku) : null,
      channel: input.channel ?? null, billingType: (product?.billingType ?? null) as BillingType | null,
      sourceKind: input.sourceKind ?? 'manual', sourceRef: null, invoiceId: null, correctionOf: null, active: true,
    }
    records.value = [...records.value, created]
    commit()
    return { ok: true, id }
  }

  /** 赤黒訂正（元明細のマイナス明細を追加。元は不変 = 記録系） */
  function correct(id: string): Result {
    const src = records.value.find(r => r.id === id)
    if (!src) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    if (src.correctionOf) return { ok: false, error: { code: 'AKO-SLS-002', message: '訂正明細は再訂正できません' } }
    if (src.invoiceId) return { ok: false, error: { code: 'AKO-SLS-003', message: '請求済みの明細は訂正できません（請求側で赤伝を発行してください）' } }
    const newId = nextId('salesRecords', 'sr')
    const reversal: SalesRecord = {
      ...src, id: newId, code: nextCode(records.value.map(r => r.code), 'SR'),
      qty: -src.qty, amount: -src.amount, salesDate: todayJst(), sourceKind: 'manual', correctionOf: id, invoiceId: null,
    }
    records.value = [...records.value, reversal]
    commit()
    return { ok: true, id: newId }
  }

  return {
    records, activeRecords, filteredRecords, activeSegments, segmentFilter, selectedFy,
    fiscalYearOptions, fiscalMonthLabels, currentFySeries, previousFySeries, currentMonth,
    currentMonthSales, currentMonthYoY, currentMonthMargin,
    segmentBreakdown, customerBreakdown, segmentComparison,
    segmentName, companyName, monthOf, create, correct,
  }
}
