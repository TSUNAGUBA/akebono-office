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
import type { WeeklyInsightRecord } from '../../../../shared/domain/weekly-insight'
import type {
  AkebonoAppConfig, BusinessSegment, ConsignmentTerm, ImportMapping, ImportRun, ImportSource,
  InboundPlan, InboundResult, InventoryTransaction, Invoice, ItemSetting, OutboundPlan,
  OutboundResult, PaymentNotice, PaymentReceipt, PaymentTerm, Product, ProductCategory,
  ProductImage, ProductImageSection, ProductSku, ProductionOrder, PurchaseOrder, PurchaseRecord,
  SalesRecord, TaxRate, Unit, VariantAxisTemplate, Warehouse,
} from '~/types/akebono'
import * as core from './core'
import * as akebono from './akebono'
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
  /** 週次 AI インサイトの保管（バッチ7j。導出キャッシュ = 再生成で上書き） */
  weeklyInsights: WeeklyInsightRecord[]
  // ---- Akebonoメニュー（業務アプリ群）。SoT: phase5/akebono-menu-design.md ----
  businessSegments: BusinessSegment[]
  warehouses: Warehouse[]
  units: Unit[]
  taxRates: TaxRate[]
  paymentTerms: PaymentTerm[]
  consignmentTerms: ConsignmentTerm[]
  variantAxisTemplates: VariantAxisTemplate[]
  productCategories: ProductCategory[]
  productImageSections: ProductImageSection[]
  products: Product[]
  productSkus: ProductSku[]
  productImages: ProductImage[]
  purchaseOrders: PurchaseOrder[]
  productionOrders: ProductionOrder[]
  inboundPlans: InboundPlan[]
  inboundResults: InboundResult[]
  purchaseRecords: PurchaseRecord[]
  outboundPlans: OutboundPlan[]
  outboundResults: OutboundResult[]
  inventoryTransactions: InventoryTransaction[]
  salesRecords: SalesRecord[]
  invoices: Invoice[]
  paymentNotices: PaymentNotice[]
  paymentReceipts: PaymentReceipt[]
  importSources: ImportSource[]
  importMappings: ImportMapping[]
  importRuns: ImportRun[]
  itemSettings: ItemSetting[]
  akebonoAppConfigs: AkebonoAppConfig[]
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
    companies: [...core.seedCompanies, ...akebono.seedAkebonoCompanies],
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
    // 権限の運用デフォルト（バッチ7f。API 側 migration 0025 と同一内容 = モック/API パリティ。
    // 経営情報（売上・意思決定）と管理 UI（マスタ・設定）を一般/人事から制限。個別例外は権限設定で上書き可）
    permissionRules: [
      { id: 'pr-def-01', subjectKind: 'role', subjectId: 'member', resource: 'sales', field: null, effect: 'deny', active: true },
      { id: 'pr-def-02', subjectKind: 'role', subjectId: 'member', resource: 'decision', field: null, effect: 'deny', active: true },
      { id: 'pr-def-03', subjectKind: 'role', subjectId: 'member', resource: 'masters', field: null, effect: 'deny', active: true },
      { id: 'pr-def-04', subjectKind: 'role', subjectId: 'member', resource: 'settings', field: null, effect: 'deny', active: true },
      { id: 'pr-def-05', subjectKind: 'role', subjectId: 'hr', resource: 'sales', field: null, effect: 'deny', active: true },
      { id: 'pr-def-06', subjectKind: 'role', subjectId: 'hr', resource: 'decision', field: null, effect: 'deny', active: true },
      // デモ例（F-16-7）: AI業務アシスタントの参照対象は既定 = 参照不可（許可制）。既定ユーザー（管理者 m-03）が
      // 他メンバー（m-05）のページを readonly 参照できることを示す例。API 側は権限表から同様に設定する
      { id: 'pr-demo-assist-01', subjectKind: 'member', subjectId: 'm-03', resource: 'ai-assistant', field: 'member:m-05', effect: 'allow', active: true },
    ],
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
    weeklyInsights: [], // 週次インサイトは生成時に保管（シードなし = 「生成」ボタンから作る）
    // ---- Akebonoメニュー（業務アプリ群） ----
    businessSegments: akebono.seedBusinessSegments,
    warehouses: akebono.seedWarehouses,
    units: akebono.seedUnits,
    taxRates: akebono.seedTaxRates,
    paymentTerms: akebono.seedPaymentTerms,
    consignmentTerms: akebono.seedConsignmentTerms,
    variantAxisTemplates: akebono.seedVariantAxisTemplates,
    productCategories: akebono.seedProductCategories,
    productImageSections: akebono.seedProductImageSections,
    products: akebono.seedProducts,
    productSkus: akebono.seedProductSkus,
    productImages: akebono.seedProductImages,
    purchaseOrders: akebono.seedPurchaseOrders,
    productionOrders: akebono.seedProductionOrders,
    inboundPlans: akebono.seedInboundPlans,
    inboundResults: akebono.seedInboundResults,
    purchaseRecords: akebono.seedPurchaseRecords,
    outboundPlans: akebono.seedOutboundPlans,
    outboundResults: akebono.seedOutboundResults,
    inventoryTransactions: akebono.seedInventoryTransactions,
    salesRecords: akebono.seedSalesRecords,
    invoices: akebono.seedInvoices,
    paymentNotices: akebono.seedPaymentNotices,
    paymentReceipts: akebono.seedPaymentReceipts,
    importSources: akebono.seedImportSources,
    importMappings: akebono.seedImportMappings,
    importRuns: akebono.seedImportRuns,
    itemSettings: akebono.seedItemSettings,
    akebonoAppConfigs: akebono.seedAkebonoAppConfigs,
  }
}
