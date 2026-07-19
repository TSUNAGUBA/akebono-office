/**
 * 週次 AI インサイト（バッチ7g → バッチ7j・オペレーター指示 2026-07-19 #9/#12）
 * - 一度生成したら保管し、再生成されるまでは保存済みの結果を表示する（永続化 = 導出キャッシュ。
 *   API = weekly_insights テーブル / モック = weeklyInsights コレクション）
 * - 集計は「前日（asOf）まで」基準（日報は前日分までが正常な運用 = 当日を未提出として悲観評価しない）
 * - 全体共通（company）と個別ユーザー向け（personal = ロール・役職・所属部署に最適化）を分けて提供
 * - 全体は閲覧者ごとに配信時マスク（売上 = can('sales')・メンバー名 = 日報参照権限 F-16-6）
 * - モックモード: API と同一の集計・ヒューリスティック（shared/domain/weekly-insight）で決定的に生成
 */
import type {
  AiTask, DailyReport, Escalation, Holiday, Member, Note, ReportEntry, SalesMonthly, TaskPlan,
  WeeklyReport, WorkflowRequest,
} from '~/types/domain'
import { DEFAULT_WORKING_DAY_RULE, isWorkingDay } from '../../../shared/domain/business-day'
import { addDays } from '~/utils/format'
import {
  heuristicPersonalInsight, heuristicWeeklyInsight,
  type PersonalWeeklyInsight, type PersonalWeeklyMetrics,
  type WeeklyInsight, type WeeklyInsightRecord, type WeeklyMetrics,
} from '../../../shared/domain/weekly-insight'

export type { PersonalWeeklyInsight, PersonalWeeklyMetrics, WeeklyInsight, WeeklyMetrics }

export interface CompanyInsightView {
  metrics: WeeklyMetrics
  insight: WeeklyInsight
  /** 洞察が LLM 生成か（false = 決定的ヒューリスティック） */
  llm: boolean
  generatedAt: string
  generatedByName: string | null
}

export interface PersonalInsightView {
  metrics: PersonalWeeklyMetrics
  insight: PersonalWeeklyInsight
  llm: boolean
  generatedAt: string
}

export interface WeeklyInsightBundle {
  company: CompanyInsightView | null
  personal: PersonalInsightView | null
}

interface ApiStored {
  metrics: unknown
  insight: unknown
  llm: boolean
  generatedAt: string
  generatedByName?: string | null
}

export function useWeeklyInsight() {
  const { tbl, commit, nextId } = useMockDb()
  const { can, canViewMemberReports } = usePermissions()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()

  /** 保管済みインサイトの取得（生成しない。未生成は company/personal とも null） */
  async function load(weekStart: string): Promise<WeeklyInsightBundle> {
    if (isApi) {
      return toBundle(await apiFetch<{ company: ApiStored | null; personal: ApiStored | null }>(
        '/v1/reports/weekly-insight', { query: { weekStart } }))
    }
    return mockBundle(weekStart)
  }

  /** 生成・再生成（全体共通 + ログインユーザーの個別を集計 → 保管 = upsert） */
  async function generate(weekStart: string): Promise<WeeklyInsightBundle> {
    if (isApi) {
      return toBundle(await apiFetch<{ company: ApiStored | null; personal: ApiStored | null }>(
        '/v1/reports/weekly-insight', { method: 'POST', body: { weekStart } }))
    }
    mockGenerate(weekStart)
    return mockBundle(weekStart)
  }

  function toBundle(data: { company: ApiStored | null; personal: ApiStored | null }): WeeklyInsightBundle {
    return {
      company: data.company
        ? {
            metrics: data.company.metrics as WeeklyMetrics,
            insight: data.company.insight as WeeklyInsight,
            llm: data.company.llm,
            generatedAt: data.company.generatedAt,
            generatedByName: data.company.generatedByName ?? null,
          }
        : null,
      personal: data.personal
        ? {
            metrics: data.personal.metrics as PersonalWeeklyMetrics,
            insight: data.personal.insight as PersonalWeeklyInsight,
            llm: data.personal.llm,
            generatedAt: data.personal.generatedAt,
          }
        : null,
    }
  }

  // ---------- モックモード（API と同一の集計・洞察ロジック） ----------

  /** 集計基準（バッチ7j）: asOf = min(weekEnd, 前日)・経過営業日（祝日マスタ + 月〜金既定） */
  function windowOf(weekStart: string, weekEnd: string): { asOf: string; businessDaysElapsed: number } {
    const yesterday = addDays(todayJst(), -1)
    const asOf = yesterday < weekEnd ? yesterday : weekEnd
    const holidays = new Set((tbl('holidays').value as Holiday[]).map(h => h.date))
    let businessDaysElapsed = 0
    for (let d = weekStart; d <= asOf; d = addDays(d, 1)) {
      if (isWorkingDay(d, DEFAULT_WORKING_DAY_RULE, holidays)) businessDaysElapsed++
    }
    return { asOf, businessDaysElapsed }
  }

  /** 全体集計（保管用 = 閲覧者に依存しない全量。マスクは配信時） */
  function computeCompanyMetrics(weekStart: string): WeeklyMetrics {
    const weekEnd = addDays(weekStart, 6)
    const { asOf, businessDaysElapsed } = windowOf(weekStart, weekEnd)
    const inWeek = (dateKey: string): boolean => dateKey >= weekStart && dateKey <= weekEnd
    const members = (tbl('members').value as Member[]).filter(m => m.active)
    const nameOf = new Map(members.map(m => [m.id, m.name]))

    const dailies = (tbl('dailyReports').value as DailyReport[])
      .filter(r => r.authorKind === 'human' && r.status === 'submitted' && inWeek(r.date))
    const memberHours = new Map<string, { name: string; hours: number }>()
    const themeHours = new Map<string, number>()
    const daily = new Map<string, number>()
    const reporters = new Set<string>()
    const issues: { memberId?: string; member: string; issue: string }[] = []
    let totalHours = 0
    let submittedUpToAsOf = 0
    for (const r of dailies) {
      const name = (r.memberId && nameOf.get(r.memberId)) || '不明'
      if (r.date <= asOf) {
        submittedUpToAsOf++
        reporters.add(r.memberId ?? name)
      }
      daily.set(r.date, (daily.get(r.date) ?? 0) + 1)
      for (const e of (r.entries as ReportEntry[])) {
        totalHours += e.hours
        const key = r.memberId ?? name
        const cur = memberHours.get(key) ?? { name, hours: 0 }
        memberHours.set(key, { name, hours: cur.hours + e.hours })
        const theme = (e.theme || '').trim() || 'その他'
        themeHours.set(theme, (themeHours.get(theme) ?? 0) + e.hours)
      }
      if (r.issues.trim()) {
        issues.push({ memberId: r.memberId ?? undefined, member: name, issue: [...r.issues.trim()].slice(0, 120).join('') })
      }
    }
    const plans = (tbl('taskPlans').value as TaskPlan[]).filter(p => inWeek(p.date))
    const wfs = (tbl('workflowRequests').value as WorkflowRequest[]).filter(w => inWeek(w.createdAt.slice(0, 10)))
    const escs = (tbl('escalations').value as Escalation[]).filter(e => inWeek(e.raisedAt.slice(0, 10)))
    const aiTasks = tbl('aiTasks').value as AiTask[]
    // 完了の週内判定: API は updated_at（JST 日付）で判定するが、モックの AiTask に updatedAt は
    // 無いため「最終成果物の記録日時（無ければ作成日時）」で近似する（差異は api-design.md に記載）
    const doneDateOf = (t: AiTask): string =>
      (t.outputs && t.outputs.length > 0 ? t.outputs[t.outputs.length - 1]!.at : t.createdAt).slice(0, 10)
    const notes = (tbl('notes').value as Note[]).filter(n => n.active !== false && inWeek(n.createdAt.slice(0, 10)))
    const sales = (tbl('salesMonthly').value as SalesMonthly[])
      .filter(s => s.month === weekStart.slice(0, 7))
      .reduce((sum, s) => sum + s.amount, 0)

    return {
      weekStart,
      weekEnd,
      asOf,
      businessDaysElapsed,
      reportSubmitted: submittedUpToAsOf,
      reporters: reporters.size,
      membersActive: members.length,
      totalHours: Math.round(totalHours * 4) / 4,
      memberHours: [...memberHours.entries()]
        .map(([memberId, v]) => ({ memberId, name: v.name, hours: Math.round(v.hours * 4) / 4 }))
        .sort((a, b) => b.hours - a.hours).slice(0, 10),
      themeHours: [...themeHours.entries()].map(([theme, hours]) => ({ theme, hours: Math.round(hours * 4) / 4 }))
        .sort((a, b) => b.hours - a.hours).slice(0, 8),
      dailySubmissions: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(weekStart, i)
        return { date, count: daily.get(date) ?? 0 }
      }),
      issues: issues.slice(0, 10),
      weeklyCount: (tbl('weeklyReports').value as WeeklyReport[])
        .filter(w => w.weekStart === weekStart && w.status === 'submitted').length,
      planDone: plans.filter(p => p.status === 'done').length,
      planTotal: plans.length,
      workflowSubmitted: wfs.filter(w => w.status !== 'draft').length,
      workflowApproved: wfs.filter(w => w.status === 'approved').length,
      escalationRaised: escs.length,
      escalationResolved: escs.filter(e => e.status === 'resolved').length,
      aiTasksDone: aiTasks.filter(t => t.status === 'done' && inWeek(doneDateOf(t))).length,
      aiTasksActive: aiTasks.filter(t => t.status === 'proposed' || t.status === 'in_progress' || t.status === 'blocked').length,
      minutesCount: notes.filter(n => n.kind === 'minutes').length,
      poipoiCount: notes.filter(n => n.kind === 'poipoi').length,
      salesMonthAmount: sales,
    }
  }

  /** 個別インサイトの材料（ログインユーザーの週次実績 + 属性） */
  function computePersonalMetrics(
    weekStart: string,
    window: { asOf: string; businessDaysElapsed: number },
  ): PersonalWeeklyMetrics {
    const weekEnd = addDays(weekStart, 6)
    const inWeek = (dateKey: string): boolean => dateKey >= weekStart && dateKey <= weekEnd
    const me = currentUser.value
    const member = (tbl('members').value as Member[]).find(m => m.id === me.id)
    const deptName = member?.departmentId
      ? (tbl('departments').value as { id: string; name: string }[]).find(d => d.id === member.departmentId)?.name ?? ''
      : ''
    const dailies = (tbl('dailyReports').value as DailyReport[])
      .filter(r => r.authorKind === 'human' && r.memberId === me.id && r.status === 'submitted' && inWeek(r.date))
    const themeHours = new Map<string, number>()
    const issues: string[] = []
    let totalHours = 0
    let submitted = 0
    for (const r of dailies) {
      if (r.date <= window.asOf) submitted++
      for (const e of (r.entries as ReportEntry[])) {
        totalHours += e.hours
        const theme = (e.theme || '').trim() || 'その他'
        themeHours.set(theme, (themeHours.get(theme) ?? 0) + e.hours)
      }
      if (r.issues.trim()) issues.push([...r.issues.trim()].slice(0, 120).join(''))
    }
    const plans = (tbl('taskPlans').value as TaskPlan[]).filter(p => p.memberId === me.id && inWeek(p.date))
    const weekly = (tbl('weeklyReports').value as WeeklyReport[])
      .some(w => w.memberId === me.id && w.weekStart === weekStart && w.status === 'submitted')
    return {
      memberId: me.id,
      memberName: member?.name ?? me.name,
      role: member?.role ?? 'member',
      title: member?.title ?? '',
      department: deptName,
      reportSubmitted: submitted,
      businessDaysElapsed: window.businessDaysElapsed,
      totalHours: Math.round(totalHours * 4) / 4,
      themeHours: [...themeHours.entries()].map(([theme, hours]) => ({ theme, hours: Math.round(hours * 4) / 4 }))
        .sort((a, b) => b.hours - a.hours).slice(0, 5),
      issues: issues.slice(0, 5),
      planDone: plans.filter(p => p.status === 'done').length,
      planTotal: plans.length,
      weeklySubmitted: weekly,
    }
  }

  /** 閲覧者マスク（配信時 = API の maskCompanyForViewer と同一基準） */
  function maskForViewer(metrics: WeeklyMetrics): WeeklyMetrics {
    const visible = (memberId?: string): boolean => !memberId || canViewMemberReports(memberId)
    return {
      ...metrics,
      salesMonthAmount: can('sales') ? metrics.salesMonthAmount : null,
      memberHours: metrics.memberHours.filter(x => visible(x.memberId)),
      issues: metrics.issues.filter(x => visible(x.memberId)),
    }
  }

  function upsertRecord(weekStart: string, audience: string, metrics: unknown, insight: unknown): void {
    const records = tbl('weeklyInsights')
    const rec: WeeklyInsightRecord = {
      id: records.value.find(r => r.weekStart === weekStart && r.audience === audience)?.id
        ?? nextId('weeklyInsights', 'wi'),
      weekStart,
      audience,
      metrics: metrics as WeeklyInsightRecord['metrics'],
      insight: insight as WeeklyInsightRecord['insight'],
      llm: false,
      generatedBy: currentUser.value.id,
      generatedAt: nowJstIso(),
    }
    records.value = [
      ...records.value.filter(r => !(r.weekStart === weekStart && r.audience === audience)),
      rec,
    ]
    commit()
  }

  function mockGenerate(weekStart: string): void {
    const metrics = computeCompanyMetrics(weekStart)
    // 全体の洞察は売上を伏せた集計から生成（売上権限のない閲覧者にも配信されるため = API と同一）
    const companyInsight = heuristicWeeklyInsight({ ...metrics, salesMonthAmount: null })
    upsertRecord(weekStart, 'company', metrics, companyInsight)
    const personalMetrics = computePersonalMetrics(weekStart, {
      asOf: metrics.asOf, businessDaysElapsed: metrics.businessDaysElapsed,
    })
    const personalInsight = heuristicPersonalInsight(personalMetrics, maskForViewer(metrics))
    upsertRecord(weekStart, `member:${currentUser.value.id}`, personalMetrics, personalInsight)
  }

  function mockBundle(weekStart: string): WeeklyInsightBundle {
    const records = tbl('weeklyInsights').value as WeeklyInsightRecord[]
    const nameOf = new Map((tbl('members').value as Member[]).map(m => [m.id, m.name]))
    const company = records.find(r => r.weekStart === weekStart && r.audience === 'company')
    const personal = records.find(r => r.weekStart === weekStart && r.audience === `member:${currentUser.value.id}`)
    return {
      company: company
        ? {
            metrics: maskForViewer(company.metrics as WeeklyMetrics),
            insight: company.insight as WeeklyInsight,
            llm: company.llm,
            generatedAt: company.generatedAt,
            generatedByName: nameOf.get(company.generatedBy) ?? null,
          }
        : null,
      personal: personal
        ? {
            metrics: personal.metrics as PersonalWeeklyMetrics,
            insight: personal.insight as PersonalWeeklyInsight,
            llm: personal.llm,
            generatedAt: personal.generatedAt,
          }
        : null,
    }
  }

  return { load, generate }
}
