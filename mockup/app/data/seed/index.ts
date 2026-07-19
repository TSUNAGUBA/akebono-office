/**
 * シード統合（useMockDb が唯一の消費者）
 * コレクション名は MockDbShape のキーと 1:1。
 */
import type {
  AiActivityLog, AiEmployee, AiRole, AiTask, AkebonoWish, ApprovalLog,
  AppConfigItem, AppNotification, AttendanceFixRequest, AttendanceRule, AuditLog, CalendarEvent, ChatMessage, ChatSession, PermissionRule,
  CodeMasterItem, Company, CompanyRelation, Contact, ContactRelation,
  CustomFieldDef, DailyReport, DecisionLog, DecisionTheme, DelegateSetting, Department,
  DocumentNode, Escalation, EscalationRule, ExternalLink, FeatureToggle, HearingLog, Holiday,
  Industry, KnowledgeArticle, LeaveGrant, LeaveRequest, LeaveType, Member, Project,
  PunchRecord, RelationType, ReportComment, SalesMonthly, ServiceIncident,
  ShiftAssignment, ShiftDemand, ShiftPeriod, ShiftWish, SystemService,
  TaskPlan, UptimeDaily, WeeklyReport, WorkflowRequest, WorkflowRoute, WorkCategory, Note,
} from '~/types/domain'
import * as core from './core'
import * as attendance from './attendance'
import * as shifts from './shifts'
import * as reports from './reports'
import * as workflow from './workflow'
import * as aiCompany from './ai-company'
import * as inbox from './inbox'
import * as status from './status'
import * as decision from './decision'
import * as support from './support'
import * as misc from './misc'
import { buildCalendarEvents, buildLeaveGrants, buildPunchHistory, buildSalesMonthly, buildSpecialLeaveGrants, buildTaskPlans, buildUptimeDaily } from './history'

export interface MockDbShape {
  members: Member[]
  departments: Department[]
  leaveTypes: LeaveType[]
  industries: Industry[]
  workCategories: WorkCategory[]
  notes: Note[]
  companies: Company[]
  contacts: Contact[]
  relationTypes: RelationType[]
  companyRelations: CompanyRelation[]
  contactRelations: ContactRelation[]
  projects: Project[]
  knowledge: KnowledgeArticle[]
  codeMaster: CodeMasterItem[]
  customFieldDefs: CustomFieldDef[]
  externalLinks: ExternalLink[]
  workflowRoutes: WorkflowRoute[]
  attendanceRules: AttendanceRule[]
  holidays: Holiday[]
  systemServices: SystemService[]
  aiRoles: AiRole[]
  aiEmployees: AiEmployee[]
  featureToggles: FeatureToggle[]
  escalationRules: EscalationRule[]
  punches: PunchRecord[]
  attendanceFixRequests: AttendanceFixRequest[]
  leaveGrants: LeaveGrant[]
  leaveRequests: LeaveRequest[]
  shiftPeriods: ShiftPeriod[]
  shiftWishes: ShiftWish[]
  shiftAssignments: ShiftAssignment[]
  shiftDemands: ShiftDemand[]
  dailyReports: DailyReport[]
  weeklyReports: WeeklyReport[]
  reportComments: ReportComment[]
  workflowRequests: WorkflowRequest[]
  approvalLogs: ApprovalLog[]
  delegateSettings: DelegateSetting[]
  aiTasks: AiTask[]
  aiActivityLogs: AiActivityLog[]
  notifications: AppNotification[]
  escalations: Escalation[]
  serviceIncidents: ServiceIncident[]
  uptimeDaily: UptimeDaily[]
  decisionThemes: DecisionTheme[]
  decisionLogs: DecisionLog[]
  documents: DocumentNode[]
  chatMessages: ChatMessage[]
  chatSessions: ChatSession[]
  permissionRules: PermissionRule[]
  akebonoWishes: AkebonoWish[]
  auditLogs: AuditLog[]
  calendarEvents: CalendarEvent[]
  hearingLogs: HearingLog[]
  taskPlans: TaskPlan[]
  appConfigs: AppConfigItem[]
  salesMonthly: SalesMonthly[]
}

export function buildSeed(): MockDbShape {
  return {
    members: core.seedMembers,
    departments: core.seedDepartments,
    leaveTypes: core.seedLeaveTypes,
    industries: core.seedIndustries,
    workCategories: [
      { id: 'wc-01', name: '定例会議', displayOrder: 1, active: true },
      { id: 'wc-02', name: '顧客対応', displayOrder: 2, active: true },
      { id: 'wc-03', name: '開発作業', displayOrder: 3, active: true },
      { id: 'wc-04', name: '社内業務', displayOrder: 4, active: true },
    ],
    notes: [],
    companies: core.seedCompanies,
    contacts: core.seedContacts,
    relationTypes: core.seedRelationTypes,
    companyRelations: core.seedCompanyRelations,
    contactRelations: core.seedContactRelations,
    projects: core.seedProjects,
    knowledge: core.seedKnowledge,
    codeMaster: core.seedCodeMaster,
    customFieldDefs: core.seedCustomFieldDefs,
    externalLinks: core.seedExternalLinks,
    workflowRoutes: core.seedWorkflowRoutes,
    attendanceRules: core.seedAttendanceRules,
    holidays: [], // 祝日はデモでは空（API モードで公式 CSV 取込 / 手動登録）。空なら従来どおり土日のみ非営業
    systemServices: core.seedSystemServices,
    aiRoles: core.seedAiRoles,
    aiEmployees: core.seedAiEmployees,
    featureToggles: core.seedFeatureToggles,
    escalationRules: core.seedEscalationRules,
    punches: buildPunchHistory(),
    attendanceFixRequests: attendance.seedAttendanceFixRequests,
    leaveGrants: [...buildLeaveGrants(), ...buildSpecialLeaveGrants()],
    leaveRequests: attendance.seedLeaveRequests,
    shiftPeriods: shifts.seedShiftPeriods,
    shiftWishes: shifts.seedShiftWishes,
    shiftAssignments: shifts.seedShiftAssignments,
    shiftDemands: shifts.seedShiftDemands,
    dailyReports: reports.seedDailyReports,
    weeklyReports: reports.seedWeeklyReports,
    reportComments: reports.seedReportComments,
    workflowRequests: workflow.seedWorkflowRequests,
    approvalLogs: workflow.seedApprovalLogs,
    delegateSettings: workflow.seedDelegateSettings,
    aiTasks: aiCompany.seedAiTasks,
    aiActivityLogs: aiCompany.seedAiActivityLogs,
    notifications: inbox.seedNotifications,
    escalations: inbox.seedEscalations,
    serviceIncidents: status.seedServiceIncidents,
    uptimeDaily: buildUptimeDaily(),
    decisionThemes: decision.seedDecisionThemes,
    decisionLogs: decision.seedDecisionLogs,
    documents: support.seedDocumentNodes,
    chatMessages: [],
    chatSessions: [],
    permissionRules: [],
    akebonoWishes: misc.seedAkebonoWishes,
    auditLogs: misc.seedAuditLogs,
    // google 発予定のキャッシュは「連携済みメンバー」の分だけ初期投入する。
    // 未連携の m-03（葛西）は連携フロー体験用: 連携（擬似 OAuth）→ 初回同期で初めてキャッシュに入る
    calendarEvents: buildCalendarEvents().filter((e) => {
      if (e.source !== 'google') return true
      return core.seedMembers.find(m => m.id === e.memberId)?.googleCalendarConnected === true
    }),
    hearingLogs: [],
    taskPlans: buildTaskPlans(),
    appConfigs: [{ key: 'reportInputMode', value: 'both' }],
    salesMonthly: buildSalesMonthly(),
  }
}
