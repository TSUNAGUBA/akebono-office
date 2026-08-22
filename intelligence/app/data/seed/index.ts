/**
 * AKEBONO Intelligence モック DB の形と決定的シード（デモ・体感検証用）。
 * API モードでは members / companies / projects は API ハイドレーション、
 * 業務データ（日報・週報・月報・活動 4 種・月次売上）は共通 API が SoT となり、
 * ここは完全モック動作（NUXT_PUBLIC_API_BASE 未設定）のときのみ使われる。
 * インサイト・アクション・サイクルは API モードでも localStorage（モック境界 = requirements §5）。
 */
import type {
  Company, CustomerLog, DailyReport, InternalSupport, Member, MonthlyReport, Note, PartnerActivity, Project,
  SalesActivity, SalesMonthly, SupportActivity, WeeklyReport,
} from '~/types/domain'
import type { IntelAction, IntelCycle, IntelInsight } from '~/types/intelligence'
import type { MediaWeeklyReport } from '../../../../shared/domain/media-weekly-report'
import type { ConsignmentReport, EcReport } from '~/types/foundation'
import { seedCompanies, seedMembers, seedProjects } from './core'
import {
  buildCustomerLogs, buildDailyReports, buildMonthlyReports, buildPartnerActivities,
  buildSalesActivities, buildSalesMonthly, buildSupportActivities, buildWeeklyReports,
} from './history'
import {
  buildConsignmentReports, buildEcReports, buildInternalSupports, buildMediaReports, buildMinutes,
} from './foundation'
import { seedActions, seedCycles, seedInsights } from './intelligence'

export interface MockDbShape {
  members: Member[]
  companies: Company[]
  projects: Project[]
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
  // ---- データ基盤（改善要望 2026-08-22: 3 カテゴリのナレッジ・ログ系。API モードは共通 API が SoT） ----
  minutes: Note[]
  mediaReports: MediaWeeklyReport[]
  ecReports: EcReport[]
  consignmentReports: ConsignmentReport[]
  internalSupports: InternalSupport[]
}

export function buildSeed(): MockDbShape {
  return {
    members: seedMembers,
    companies: seedCompanies,
    projects: seedProjects,
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
    minutes: buildMinutes(),
    mediaReports: buildMediaReports(),
    ecReports: buildEcReports(),
    consignmentReports: buildConsignmentReports(),
    internalSupports: buildInternalSupports(),
  }
}
