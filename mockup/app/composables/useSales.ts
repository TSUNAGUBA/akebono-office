/**
 * 売上サマリ集計（F-01-1）
 * SoT: salesMonthly コレクション。表示射影はすべて純粋 computed / 純粋関数。
 * 表示用の選択状態は selectedFy（表示対象の会計年度。既定 = 現年度）のみで、データは書き換えない。
 * 会計年度は自社（companies kind='self'）の fiscalStartMonth 起点で解釈する。
 */
import type { ProjectType } from '~/types/domain'
import { PROJECT_TYPE_LABELS } from '~/utils/labels'

export function useSales() {
  const { tbl } = useMockDb()
  const salesMonthly = tbl('salesMonthly')
  const companies = tbl('companies')

  /** 自社の会計年度開始月（未設定時は 4 月） */
  const fiscalStartMonth = computed(() =>
    companies.value.find(c => c.kind === 'self')?.fiscalStartMonth ?? 4)

  const todayKey = todayJst()
  /** 当月（YYYY-MM） */
  const currentMonth = todayKey.slice(0, 7)

  /** YYYY-MM が属する会計年度（開始年の西暦） */
  function fiscalYearOf(month: string): number {
    const y = Number(month.slice(0, 4))
    const m = Number(month.slice(5, 7))
    return m >= fiscalStartMonth.value ? y : y - 1
  }

  /** 今日が属する会計年度（開始年の西暦） */
  const currentFiscalYear = computed(() => fiscalYearOf(currentMonth))

  /** 売上データが存在する会計年度の一覧（新しい順。年度選択の選択肢） */
  const fiscalYearOptions = computed(() => {
    const fys = new Set<number>()
    for (const r of salesMonthly.value) fys.add(fiscalYearOf(r.month))
    return [...fys].sort((a, b) => b - a)
  })

  /** 表示対象の会計年度（既定 = 現年度。ダッシュボードの年度セレクタが更新） */
  const selectedFy = ref<number>(currentFiscalYear.value)

  /** 会計年度 fy に属する 12 ヶ月の YYYY-MM 配列（開始月起点） */
  function fiscalMonthsOf(fy: number): string[] {
    const months: string[] = []
    for (let i = 0; i < 12; i++) {
      const m0 = fiscalStartMonth.value - 1 + i
      const y = fy + Math.floor(m0 / 12)
      const m = (m0 % 12) + 1
      months.push(`${y}-${String(m).padStart(2, '0')}`)
    }
    return months
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
  }
}
