/**
 * 売上サマリ集計（F-01-1）
 * SoT: salesMonthly コレクション。表示射影はすべて純粋 computed / 純粋関数。
 * 会計年度は自社（companies kind='self'）の fiscalStartMonth 起点で解釈する。
 */
import type { ProjectType } from '~/types/domain'
import { toDateKey } from '~/utils/format'
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

  /** 今日が属する会計年度（開始年の西暦） */
  const currentFiscalYear = computed(() => {
    const y = Number(todayKey.slice(0, 4))
    const m = Number(todayKey.slice(5, 7))
    return m >= fiscalStartMonth.value ? y : y - 1
  })

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

  /** チャート X 軸ラベル（「4月」〜「3月」） */
  const fiscalMonthLabels = computed(() =>
    fiscalMonthsOf(currentFiscalYear.value).map(m => `${Number(m.slice(5, 7))}月`))

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

  const currentFySeries = computed(() => monthlySeriesOf(currentFiscalYear.value))
  const previousFySeries = computed(() => monthlySeriesOf(currentFiscalYear.value - 1))

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

  /** 今年度（期初〜当月）の事業種別内訳（ドーナツ用） */
  const typeBreakdown = computed(() => {
    const months = new Set(fiscalMonthsOf(currentFiscalYear.value).filter(m => m <= currentMonth))
    const byType = new Map<ProjectType, number>()
    for (const r of salesMonthly.value) {
      if (!months.has(r.month)) continue
      byType.set(r.projectType, (byType.get(r.projectType) ?? 0) + r.amount)
    }
    return [...byType.entries()]
      .map(([t, value]) => ({ label: PROJECT_TYPE_LABELS[t], value }))
      .sort((a, b) => b.value - a.value)
  })

  return {
    fiscalStartMonth,
    currentFiscalYear,
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
  }
}
