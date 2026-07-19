/**
 * 週次 AI インサイト（バッチ7g・オペレーター指示 2026-07-19 #9）
 * - API モード: GET /v1/reports/weekly-insight（集計 = サーバー・洞察 = Vertex AI → 失敗時ヒューリスティック）
 * - モックモード: モックコレクションから同一の WeeklyMetrics を決定的に集計し、
 *   shared/domain/weekly-insight の heuristicWeeklyInsight で洞察を生成（API フォールバックと同一関数）
 * - 参照範囲は閲覧権限準拠（提出済み日報 = 全員可視・売上は can('sales') のみ供給）
 */
import type {
  AiTask, DailyReport, Escalation, Member, Note, ReportEntry, SalesMonthly, TaskPlan,
  WeeklyReport, WorkflowRequest,
} from '~/types/domain'
import { addDays } from '~/utils/format'
import {
  heuristicWeeklyInsight, type WeeklyInsight, type WeeklyMetrics,
} from '../../../shared/domain/weekly-insight'

export type { WeeklyInsight, WeeklyMetrics }

export interface WeeklyInsightResult {
  metrics: WeeklyMetrics
  insight: WeeklyInsight
  /** 洞察が LLM 生成か（false = 決定的ヒューリスティック） */
  llm: boolean
}

export function useWeeklyInsight() {
  const { tbl } = useMockDb()
  const { can } = usePermissions()
  const isApi = useApiMode()

  async function generate(weekStart: string): Promise<WeeklyInsightResult> {
    if (isApi) {
      return await apiFetch<WeeklyInsightResult>('/v1/reports/weekly-insight', { query: { weekStart } })
    }
    return mockInsight(weekStart)
  }

  function mockInsight(weekStart: string): WeeklyInsightResult {
    const weekEnd = addDays(weekStart, 6)
    const inWeek = (dateKey: string): boolean => dateKey >= weekStart && dateKey <= weekEnd
    const members = (tbl('members').value as Member[]).filter(m => m.active)
    const nameOf = new Map(members.map(m => [m.id, m.name]))

    const dailies = (tbl('dailyReports').value as DailyReport[])
      .filter(r => r.authorKind === 'human' && r.status === 'submitted' && inWeek(r.date))
    const memberHours = new Map<string, number>()
    const themeHours = new Map<string, number>()
    const daily = new Map<string, number>()
    const reporters = new Set<string>()
    const issues: { member: string; issue: string }[] = []
    let totalHours = 0
    for (const r of dailies) {
      const name = (r.memberId && nameOf.get(r.memberId)) || '不明'
      reporters.add(r.memberId ?? name)
      daily.set(r.date, (daily.get(r.date) ?? 0) + 1)
      for (const e of (r.entries as ReportEntry[])) {
        totalHours += e.hours
        memberHours.set(name, (memberHours.get(name) ?? 0) + e.hours)
        const theme = (e.theme || '').trim() || 'その他'
        themeHours.set(theme, (themeHours.get(theme) ?? 0) + e.hours)
      }
      if (r.issues.trim()) issues.push({ member: name, issue: [...r.issues.trim()].slice(0, 120).join('') })
    }
    const plans = (tbl('taskPlans').value as TaskPlan[]).filter(p => inWeek(p.date))
    const wfs = (tbl('workflowRequests').value as WorkflowRequest[]).filter(w => inWeek(w.createdAt.slice(0, 10)))
    const escs = (tbl('escalations').value as Escalation[]).filter(e => inWeek(e.raisedAt.slice(0, 10)))
    const aiTasks = tbl('aiTasks').value as AiTask[]
    const notes = (tbl('notes').value as Note[]).filter(n => n.active !== false && inWeek(n.createdAt.slice(0, 10)))
    const sales = can('sales')
      ? (tbl('salesMonthly').value as SalesMonthly[])
          .filter(s => s.month === weekStart.slice(0, 7))
          .reduce((sum, s) => sum + s.amount, 0)
      : null

    const metrics: WeeklyMetrics = {
      weekStart,
      weekEnd,
      reportSubmitted: dailies.length,
      reporters: reporters.size,
      membersActive: members.length,
      totalHours: Math.round(totalHours * 4) / 4,
      memberHours: [...memberHours.entries()].map(([name, hours]) => ({ name, hours: Math.round(hours * 4) / 4 }))
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
      aiTasksDone: aiTasks.filter(t => t.status === 'done').length,
      aiTasksActive: aiTasks.filter(t => t.status === 'proposed' || t.status === 'in_progress' || t.status === 'blocked').length,
      minutesCount: notes.filter(n => n.kind === 'minutes').length,
      poipoiCount: notes.filter(n => n.kind === 'poipoi').length,
      salesMonthAmount: sales,
    }
    return { metrics, insight: heuristicWeeklyInsight(metrics), llm: false }
  }

  return { generate }
}
