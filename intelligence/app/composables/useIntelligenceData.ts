/**
 * 参照データの読み取り層(FI-02)。
 * - モックモード: useMockDb のシード（決定的デモデータ）
 * - API モード: 既存の共通 API から読み取り専用で取得（本アプリは業務データへ書込しない）。
 *   権限（F-16）によるサーバー側フィルタ・403 は空データとして扱う（原則4 = 見えるデータで分析する）
 * SPA（ssr:false）専用: キャッシュはモジュールスコープ単一。
 */
import type { Ref } from 'vue'
import type {
  Company, CustomerLog, DailyReport, Member, MonthlyReport, PartnerActivity, Project,
  SalesActivity, SalesMonthly, SupportActivity, Village, WeeklyReport,
} from '~/types/domain'
import { addMonths } from '~/utils/insight-engine'

// ---------- API モードのキャッシュ ----------

const apiDaily = ref<DailyReport[]>([])
const apiWeekly = ref<WeeklyReport[]>([])
const apiMonthly = ref<MonthlyReport[]>([])
const apiSupport = ref<SupportActivity[]>([])
const apiSales = ref<SalesActivity[]>([])
const apiPartner = ref<PartnerActivity[]>([])
const apiCustomerLogs = ref<CustomerLog[]>([])
const apiSalesMonthly = ref<SalesMonthly[]>([])
const loadingCount = ref(0)

/** 日報は直近 3 ヶ月分（当月 + 前 2 ヶ月）を scope=all で取得してマージする */
const DAILY_MONTHS_BACK = 2

async function tracked(fn: () => Promise<void>): Promise<void> {
  loadingCount.value++
  try {
    await fn()
  } finally {
    loadingCount.value--
  }
}

function loadDaily(force = false): Promise<void> {
  return apiLoadOnce('intel:daily', () => tracked(async () => {
    const month = todayJst().slice(0, 7)
    const months = Array.from({ length: DAILY_MONTHS_BACK + 1 }, (_, i) => addMonths(month, -i))
    const results = await Promise.all(months.map(m =>
      apiFetch<DailyReport[]>('/v1/reports/daily', { query: { scope: 'all', month: m } }).catch(() => [])))
    apiDaily.value = results.flat()
  }), force)
}

function loadWeekly(force = false): Promise<void> {
  return apiLoadOnce('intel:weekly', () => tracked(async () => {
    apiWeekly.value = await apiFetch<WeeklyReport[]>('/v1/reports/weekly', { query: { scope: 'all' } }).catch(() => [])
  }), force)
}

function loadMonthly(force = false): Promise<void> {
  return apiLoadOnce('intel:monthly', () => tracked(async () => {
    apiMonthly.value = await apiFetch<MonthlyReport[]>('/v1/reports/monthly', { query: { scope: 'all' } }).catch(() => [])
  }), force)
}

function loadActivities(force = false): Promise<void> {
  return apiLoadOnce('intel:activities', () => tracked(async () => {
    const [sup, sal, par, clg] = await Promise.all([
      apiFetch<SupportActivity[]>('/v1/support-activities').catch(() => []),
      apiFetch<SalesActivity[]>('/v1/sales-activities').catch(() => []),
      apiFetch<PartnerActivity[]>('/v1/partner-activities').catch(() => []),
      apiFetch<CustomerLog[]>('/v1/customer-logs', { query: { scope: 'all' } }).catch(() => []),
    ])
    apiSupport.value = sup
    apiSales.value = sal
    apiPartner.value = par
    apiCustomerLogs.value = clg
  }), force)
}

function loadSalesMonthly(force = false): Promise<void> {
  return apiLoadOnce('intel:salesMonthly', () => tracked(async () => {
    apiSalesMonthly.value = await apiFetch<SalesMonthly[]>('/v1/sales').catch(() => [])
  }), force)
}

function loadAll(force = false): Promise<void> {
  return Promise.all([
    loadDaily(force), loadWeekly(force), loadMonthly(force), loadActivities(force), loadSalesMonthly(force),
  ]).then(() => {})
}

onApiReset(() => {
  apiDaily.value = []
  apiWeekly.value = []
  apiMonthly.value = []
  apiSupport.value = []
  apiSales.value = []
  apiPartner.value = []
  apiCustomerLogs.value = []
  apiSalesMonthly.value = []
  if (useApiMe().value) void loadAll(true)
})

export function useIntelligenceData() {
  const { tbl } = useMockDb()
  const isApi = useApiMode()
  if (isApi) void loadAll()

  const daily = isApi ? (apiDaily as Ref<DailyReport[]>) : tbl('dailyReports')
  const weekly = isApi ? (apiWeekly as Ref<WeeklyReport[]>) : tbl('weeklyReports')
  const monthly = isApi ? (apiMonthly as Ref<MonthlyReport[]>) : tbl('monthlyReports')
  const support = isApi ? (apiSupport as Ref<SupportActivity[]>) : tbl('supportActivities')
  const sales = isApi ? (apiSales as Ref<SalesActivity[]>) : tbl('salesActivities')
  const partner = isApi ? (apiPartner as Ref<PartnerActivity[]>) : tbl('partnerActivities')
  const customerLogs = isApi ? (apiCustomerLogs as Ref<CustomerLog[]>) : tbl('customerLogs')
  const salesMonthly = isApi ? (apiSalesMonthly as Ref<SalesMonthly[]>) : tbl('salesMonthly')

  // マスタは移行済みコレクション（API モードは tbl() がハイドレーションキャッシュを返す）
  const companies = tbl('companies') as Ref<Company[]>
  const projects = tbl('projects') as Ref<Project[]>
  const members = tbl('members') as Ref<Member[]>
  const villages = tbl('villages') as Ref<Village[]>

  const loading = computed(() => loadingCount.value > 0)

  function companyName(id: string | null): string {
    if (!id) return ''
    return companies.value.find(c => c.id === id)?.name ?? id
  }

  function projectName(id: string | null): string {
    if (!id) return ''
    return projects.value.find(p => p.id === id)?.name ?? id
  }

  function memberName(id: string | null): string {
    if (!id) return ''
    return members.value.find(m => m.id === id)?.name ?? id
  }

  /** 再読込（データソース画面の更新ボタン。モックモードは no-op） */
  async function refresh(): Promise<void> {
    if (isApi) await loadAll(true)
  }

  return {
    daily, weekly, monthly, support, sales, partner, customerLogs, salesMonthly,
    companies, projects, members, villages,
    loading, refresh, companyName, projectName, memberName,
  }
}
