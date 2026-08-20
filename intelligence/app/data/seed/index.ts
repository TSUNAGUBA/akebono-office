/**
 * AKEBONO Intelligence モック DB の形と決定的シード（デモ・体感検証用）。
 * API モードでは members / companies / projects / villages は API ハイドレーション、
 * 業務データ（日報・週報・月報・活動 4 種・月次売上）は共通 API が SoT となり、
 * ここは完全モック動作（NUXT_PUBLIC_API_BASE 未設定）のときのみ使われる。
 * インサイト・アクション・サイクルは API モードでも localStorage（モック境界 = requirements §5）。
 */
import type {
  Company, CustomerLog, DailyReport, Member, MonthlyReport, PartnerActivity, Project,
  SalesActivity, SalesMonthly, SupportActivity, Village, WeeklyReport,
} from '~/types/domain'
import type { IntelAction, IntelCycle, IntelInsight } from '~/types/intelligence'
import { seedCompanies, seedMembers, seedProjects, seedVillages } from './core'
import {
  buildCustomerLogs, buildDailyReports, buildMonthlyReports, buildPartnerActivities,
  buildSalesActivities, buildSalesMonthly, buildSupportActivities, buildWeeklyReports,
} from './history'
import { seedActions, seedCycles, seedInsights } from './intelligence'

export interface MockDbShape {
  members: Member[]
  companies: Company[]
  projects: Project[]
  villages: Village[]
  dailyReports: DailyReport[]
  weeklyReports: WeeklyReport[]
  monthlyReports: MonthlyReport[]
  supportActivities: SupportActivity[]
  salesActivities: SalesActivity[]
  partnerActivities: PartnerActivity[]
  customerLogs: CustomerLog[]
  salesMonthly: SalesMonthly[]
  insights: IntelInsight[]
  actions: IntelAction[]
  cycles: IntelCycle[]
}

export function buildSeed(): MockDbShape {
  return {
    members: seedMembers,
    companies: seedCompanies,
    projects: seedProjects,
    villages: seedVillages,
    dailyReports: buildDailyReports(),
    weeklyReports: buildWeeklyReports(),
    monthlyReports: buildMonthlyReports(),
    supportActivities: buildSupportActivities(),
    salesActivities: buildSalesActivities(),
    partnerActivities: buildPartnerActivities(),
    customerLogs: buildCustomerLogs(),
    salesMonthly: buildSalesMonthly(),
    insights: seedInsights,
    actions: seedActions,
    cycles: seedCycles,
  }
}
