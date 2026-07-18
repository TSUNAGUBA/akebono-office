/**
 * 売上サマリ集計（F-15 / F-01-1）
 * SoT: salesMonthly コレクション（API モードは /v1/sales = sales_monthly テーブル）。
 * 表示射影はすべて純粋 computed / 純粋関数（会計年度計算は shared/domain/fiscal を API と共有）。
 * 表示用の選択状態は selectedFy（表示対象の会計年度。既定 = 現年度）のみで、データは書き換えない。
 * 会計年度は自社（companies kind='self'）の fiscalStartMonth 起点で解釈する。
 * 登録/取込（upsert）は管理者のみ（冪等キー = month × company × projectType。API はサーバーが強制）。
 */
import {
  DEFAULT_FISCAL_START_MONTH, fiscalMonthsOf as fiscalMonthsOfFy, fiscalYearOf as fiscalYearOfMonth,
} from '../../../shared/domain/fiscal'
import type { ProjectType, Result, SalesMonthly } from '~/types/domain'
import { PROJECT_TYPE_LABELS } from '~/utils/labels'

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiSalesMonthly = ref<SalesMonthly[]>([])

function loadSalesMonthly(force = false): Promise<void> {
  return apiLoadOnce('sales:monthly', async () => {
    apiSalesMonthly.value = await apiFetch<SalesMonthly[]>('/v1/sales')
  }, force)
}

onApiReset(() => {
  apiSalesMonthly.value = []
})

export function useSales() {
  const { tbl, commit } = useMockDb()
  const isApi = useApiMode()
  const salesMonthly = isApi ? apiSalesMonthly : tbl('salesMonthly')
  const companies = tbl('companies')
  if (isApi) void loadSalesMonthly()

  /** 月次実績の取り直し（ページ表示時に呼ぶ。他管理者の登録の取り込み） */
  async function refresh(): Promise<void> {
    if (!isApi) return
    await loadSalesMonthly(true)
  }

  /** 自社の会計年度開始月（未設定時は 4 月。active な自社のみ = サーバー側 selfFiscalStartMonth と同一解釈） */
  const fiscalStartMonth = computed(() =>
    companies.value.find(c => c.kind === 'self' && c.active !== false)?.fiscalStartMonth
      ?? DEFAULT_FISCAL_START_MONTH)

  const todayKey = todayJst()
  /** 当月（YYYY-MM） */
  const currentMonth = todayKey.slice(0, 7)

  /** YYYY-MM が属する会計年度（開始年の西暦） */
  function fiscalYearOf(month: string): number {
    return fiscalYearOfMonth(month, fiscalStartMonth.value)
  }

  /** 今日が属する会計年度（開始年の西暦） */
  const currentFiscalYear = computed(() => fiscalYearOf(currentMonth))

  /** 売上データが存在する会計年度の一覧（新しい順。年度選択の選択肢） */
  const fiscalYearOptions = computed(() => {
    const fys = new Set<number>()
    for (const r of salesMonthly.value) fys.add(fiscalYearOf(r.month))
    return [...fys].sort((a, b) => b - a)
  })

  /** 表示対象の会計年度（既定 = 現年度。年度セレクタが更新） */
  const selectedFy = ref<number>(currentFiscalYear.value)

  /** 会計年度 fy に属する 12 ヶ月の YYYY-MM 配列（開始月起点） */
  function fiscalMonthsOf(fy: number): string[] {
    return fiscalMonthsOfFy(fy, fiscalStartMonth.value)
  }

  /** チャート X 軸ラベル（「4月」〜「3月」。選択年度に追従） */
  const fiscalMonthLabels = computed(() =>
    fiscalMonthsOf(selectedFy.value).map(m => `${Number(m.slice(5, 7))}月`))

  function amountOf(month: string): number {
    return salesMonthly.value.filter(r => r.month === month).reduce((s, r) => s + r.amount, 0)
  }

  function costOf(month: string): number {
    return salesMonthly.value.filter(r => r.month === month).reduce((s, r) => s + r.cost, 0)
  }

  /** 会計年度 fy の月次売上系列（当月より先の月はデータなし = null） */
  function monthlySeriesOf(fy: number): (number | null)[] {
    return fiscalMonthsOf(fy).map(m => (m > currentMonth ? null : amountOf(m)))
  }

  /** 選択年度（既定 = 現年度）の月次売上系列 */
  const currentFySeries = computed(() => monthlySeriesOf(selectedFy.value))
  /** 選択年度の前年度の月次売上系列 */
  const previousFySeries = computed(() => monthlySeriesOf(selectedFy.value - 1))

  /** 前年同月（YYYY-MM） */
  const prevYearSameMonth = computed(() =>
    `${Number(currentMonth.slice(0, 4)) - 1}-${currentMonth.slice(5, 7)}`)

  /** 今月売上 */
  const currentMonthSales = computed(() => amountOf(currentMonth))

  /** 今月売上の前年同月比（前年実績なしは null） */
  const currentMonthYoY = computed(() => {
    const prev = amountOf(prevYearSameMonth.value)
    if (prev <= 0) return null
    return (currentMonthSales.value - prev) / prev
  })

  /** 当月の粗利率（(売上 - 原価) / 売上。売上ゼロは null） */
  const currentMonthMarginRate = computed(() => {
    const a = currentMonthSales.value
    if (a <= 0) return null
    return (a - costOf(currentMonth)) / a
  })

  /** 粗利率の前年同月差（パーセントポイント。比較不能は null） */
  const marginYoYDiff = computed(() => {
    const cur = currentMonthMarginRate.value
    const prevA = amountOf(prevYearSameMonth.value)
    if (cur === null || prevA <= 0) return null
    const prev = (prevA - costOf(prevYearSameMonth.value)) / prevA
    return cur - prev
  })

  /** 選択年度（期初〜当月）の対象 YYYY-MM 集合 */
  function selectedFyMonths(): Set<string> {
    return new Set(fiscalMonthsOf(selectedFy.value).filter(m => m <= currentMonth))
  }

  /** 選択年度（期初〜当月）の事業種別内訳（ドーナツ用） */
  const typeBreakdown = computed(() => {
    const months = selectedFyMonths()
    const byType = new Map<ProjectType, number>()
    for (const r of salesMonthly.value) {
      if (!months.has(r.month)) continue
      byType.set(r.projectType, (byType.get(r.projectType) ?? 0) + r.amount)
    }
    return [...byType.entries()]
      .map(([t, value]) => ({ label: PROJECT_TYPE_LABELS[t], value }))
      .sort((a, b) => b.value - a.value)
  })

  /** 選択年度（期初〜当月）の顧客別売上 Top5 + その他（companies から名前解決） */
  const customerBreakdown = computed(() => {
    const months = selectedFyMonths()
    const byCompany = new Map<string, number>()
    for (const r of salesMonthly.value) {
      if (!months.has(r.month)) continue
      byCompany.set(r.companyId, (byCompany.get(r.companyId) ?? 0) + r.amount)
    }
    const sorted = [...byCompany.entries()]
      .map(([companyId, value]) => ({
        label: companies.value.find(c => c.id === companyId)?.name ?? companyId,
        value,
      }))
      .sort((a, b) => b.value - a.value)
    const TOP = 5
    if (sorted.length <= TOP) return sorted
    const head = sorted.slice(0, TOP)
    const restSum = sorted.slice(TOP).reduce((s, x) => s + x.value, 0)
    return [...head, { label: 'その他', value: restSum }]
  })

  /**
   * 月次実績の登録/更新（管理者のみ。冪等キー = month × company × projectType の upsert）。
   * API モードはサーバー書込 → キャッシュ取り直し（原則6）。モックは同一キー行の置換。
   */
  async function upsert(input: SalesMonthly): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch('/v1/sales', { method: 'POST', body: { rows: [input] } }))
      if (res.ok) await loadSalesMonthly(true)
      return res
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) {
      return { ok: false, error: { code: 'AKO-SAL-001', message: 'month は YYYY-MM 形式で指定してください' } }
    }
    if (!companies.value.some(c => c.id === input.companyId)) {
      return { ok: false, error: { code: 'AKO-SAL-002', message: '顧客(会社)が未登録です' } }
    }
    if (!Number.isFinite(input.amount) || input.amount < 0 || !Number.isFinite(input.cost) || input.cost < 0) {
      return { ok: false, error: { code: 'AKO-SAL-001', message: 'amount / cost は 0 以上の数値で指定してください' } }
    }
    const row: SalesMonthly = { ...input, amount: Math.round(input.amount), cost: Math.round(input.cost) }
    const idx = salesMonthly.value.findIndex(r =>
      r.month === row.month && r.companyId === row.companyId && r.projectType === row.projectType)
    salesMonthly.value = idx >= 0
      ? [...salesMonthly.value.slice(0, idx), row, ...salesMonthly.value.slice(idx + 1)]
      : [...salesMonthly.value, row]
    commit()
    return { ok: true }
  }

  return {
    fiscalStartMonth,
    currentFiscalYear,
    fiscalYearOptions,
    selectedFy,
    currentMonth,
    fiscalMonthsOf,
    fiscalMonthLabels,
    currentFySeries,
    previousFySeries,
    currentMonthSales,
    currentMonthYoY,
    currentMonthMarginRate,
    marginYoYDiff,
    typeBreakdown,
    customerBreakdown,
    refresh,
    upsert,
  }
}
