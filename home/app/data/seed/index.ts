/**
 * シード統合（useMockDb が唯一の消費者）
 * コレクション名は MockDbShape のキーと 1:1。
 */
import type {
  ActivityLog,
  AiActivityLog, AiEmployee, AiRole, AiTask, AkebonoWish, ApprovalLog,
  AppConfigItem, AppNotification, AttendanceFixRequest, AttendanceRoute, AttendanceRule, AuditLog, CalendarEvent, ChatMessage, ChatSession, DirectRequest, PermissionRule,
  CodeMasterItem, Company, CompanyRelation, Contact, ContactRelation,
  CustomerContext, CustomerContextNote,
  CustomerLog, CustomFieldDef, DailyReport, DecisionLog, DecisionTheme, DelegateSetting, Department,
  DocumentNode, Escalation, EscalationRule, ExternalLink, FeatureToggle, HearingLog, Holiday,
  Industry, InternalSupport, KnowledgeArticle, LeaveGrant, LeaveRequest, LeaveType, Member, MonthlyReport, Project,
  PartnerActivity, PunchRecord, RelationType, ReportComment, ReportRead, SalesActivity, SalesApproach, SalesMonthly, ServiceIncident,
  ShiftAssignment, ShiftDemand, ShiftPeriod, ShiftWish, SupportActivity, SystemService,
  TaskPlan, UptimeDaily, Village, WeeklyReport, WorkflowRequest, WorkflowRoute, WorkCategory, Note,
} from '~/types/domain'
import type { WeeklyInsightRecord } from '../../../../shared/domain/weekly-insight'
import type { MediaInsightRecord } from '../../../../shared/domain/media-insight'
import type { MediaMeasure, MediaWeeklyReport } from '../../../../shared/domain/media-weekly-report'
import type { DashboardInsightRecord } from '../../../../shared/domain/portfolio-insight'
import type { ImprovementItem, ImprovementNote, ImprovementRequest, ImprovementRequestComment } from '../../../../shared/domain/improvement'
import type {
  AkebonoAppConfig, BusinessSegment, ConsignmentTerm, ImportMapping, ImportRun, ImportSource,
  InboundPlan, InboundResult, InventoryTransaction, Invoice, ItemSetting, OutboundPlan,
  OutboundResult, PaymentNotice, PaymentReceipt, PaymentTerm, Product, ProductCategory,
  ProductImage, ProductImageSection, ProductSku, ProductionOrder, PurchaseOrder, PurchaseRecord,
  SalesRecord, TaxRate, Unit, VariantAxisTemplate, Warehouse,
} from '~/types/akebono'
import type { ArticleBrief, GeneratedArticle, MediaArticle, MediaChannel, MediaExternalArticle } from '~/types/media'
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
import { buildCustomerLogs } from './customer-logs'
import { buildCustomerContextNotes, buildCustomerContexts } from './customer-context'
import { buildInternalSupports, buildPartnerActivities, buildPartnerActivityLogs, buildSalesActivities, buildSalesActivityLogs, buildSupportActivities } from './activities'
import * as media from './media'
import { buildCalendarEvents, buildLeaveGrants, buildPunchHistory, buildSalesMonthly, buildSpecialLeaveGrants, buildTaskPlans, buildUptimeDaily } from './history'

export interface MockDbShape {
  members: Member[]
  departments: Department[]
  leaveTypes: LeaveType[]
  industries: Industry[]
  villages: Village[]
  workCategories: WorkCategory[]
  notes: Note[]
  customerLogs: CustomerLog[]
  // ---- 活動記録 3 種（チーム共有の記録系。改修依頼 2026-08-18・F-43/F-44/F-45） ----
  supportActivities: SupportActivity[]
  /**
   * 社内サポート活動（改善要望 2026-08-22・F-57）: メンバー間フォローアップの記録（チーム共有）。
   * API モードは /v1/internal-supports の全量ハイドレーション（CUSTOM_COLLECTION_ENDPOINTS）。
   * AKEBONO Intelligence のナレッジカテゴリ「社内サポート」の AI 分析材料になる
   */
  internalSupports: InternalSupport[]
  salesActivities: SalesActivity[]
  partnerActivities: PartnerActivity[]
  /**
   * 活動ログ（案件ヘッダー = 営業/パートナー活動にぶら下がる時系列の記録。改修依頼 2026-08-20・Units 2+4）。
   * モックモード専用のコレクション。API モードはネスト資源（/v1/xxx-activities/:id/logs）を都度フェッチし、
   * このコレクションキャッシュは使わない（設計判断の詳細は useActivityLogs.ts の docblock）
   */
  salesActivityLogs: ActivityLog[]
  partnerActivityLogs: ActivityLog[]
  /**
   * 顧客コンテキスト（改修依頼 2026-08-20）: 顧客ごとの定性情報（1社1行 = 設定系・upsert）と
   * 時系列メモ（記録系 = 追記 + 論理取消 archivedAt。research = AI リサーチ反映の自動追記）。
   * API モードは /v1/customer-contexts（+ /notes）の全量ハイドレーション（CUSTOM_COLLECTION_ENDPOINTS）
   */
  customerContexts: CustomerContext[]
  customerContextNotes: CustomerContextNote[]
  /**
   * 営業アプローチリスト（改善要望 2026-08-21・F-53）: 顧客ごとのアプローチ状態・方針（1社1行）。
   * チーム共有。API モードは /v1/sales-approaches の全量ハイドレーション（CUSTOM_COLLECTION_ENDPOINTS）
   */
  salesApproaches: SalesApproach[]
  /**
   * メディア分析の AI 週次レポート・改善施策（改善要望 2026-08-21・F-55/F-56）。
   * モックはレポートを訪問時に決定的へ遅延生成する（useMediaReports.ensureMockReports）。
   * API モードは /v1/media/weekly-reports・/v1/media/measures が SoT
   */
  mediaWeeklyReports: MediaWeeklyReport[]
  mediaMeasures: MediaMeasure[]
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
  directRequests: DirectRequest[]
  attendanceRoutes: AttendanceRoute[]
  leaveGrants: LeaveGrant[]
  leaveRequests: LeaveRequest[]
  shiftPeriods: ShiftPeriod[]
  shiftWishes: ShiftWish[]
  shiftAssignments: ShiftAssignment[]
  shiftDemands: ShiftDemand[]
  dailyReports: DailyReport[]
  weeklyReports: WeeklyReport[]
  /** 月報（改修依頼 2026-08-19 第4弾。週報と同型で新設） */
  monthlyReports: MonthlyReport[]
  reportComments: ReportComment[]
  /** 日報・週報の既読（全員の日報/週報タブの未読可視化。オペレーター指示 2026-07-31） */
  reportReads: ReportRead[]
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
  // ---- メディア分析（独立チャンネル + 任意の業態連携）。SoT: shared/domain/media-* + types/media ----
  /** メディアチャンネル（旧 mediaSettings を置換・拡張。任意で業態と連携） */
  mediaChannels: MediaChannel[]
  mediaArticles: MediaArticle[]
  /** メディア AI インサイトの保管（scope='media'/'integrated'。導出キャッシュ = 再生成で上書き） */
  mediaInsights: MediaInsightRecord[]
  articleBriefs: ArticleBrief[]
  generatedArticles: GeneratedArticle[]
  /** 外部投稿記事の原文（media インサイト生成の材料。取消/復元 = 原則9.5） */
  mediaExternalArticles: MediaExternalArticle[]
  /**
   * ダッシュボード AI インサイトの保管（scope='segment'/'company'。導出キャッシュ = 再生成で上書き）。
   * セグメント別/会社全体の「サマリー + AI レポート + AI インサイト」を保持する（F-41）。
   */
  dashboardInsights: DashboardInsightRecord[]
  // ---- 改善要望（F-42）。生要望（SoT・追記系）+ AI 集約の改修単位 + 時系列メモ ----
  improvementRequests: ImprovementRequest[]
  improvementItems: ImprovementItem[]
  improvementNotes: ImprovementNote[]
  improvementRequestComments: ImprovementRequestComment[]
}

export function buildSeed(): MockDbShape {
  return {
    members: core.seedMembers,
    departments: core.seedDepartments,
    leaveTypes: core.seedLeaveTypes,
    industries: core.seedIndustries,
    // 事業区分（Village）マスタ（改修依頼 2026-08-19 第4弾）。活動記録の最上段で参照・自由入力で新規登録可
    villages: [
      { id: 'vil-01', name: 'AKEBONO', displayOrder: 1, active: true },
      { id: 'vil-02', name: 'つなぐば', displayOrder: 2, active: true },
      { id: 'vil-03', name: 'コーポレート', displayOrder: 3, active: true },
    ],
    workCategories: [
      { id: 'wc-01', name: '定例会議', displayOrder: 1, active: true },
      { id: 'wc-02', name: '顧客対応', displayOrder: 2, active: true },
      { id: 'wc-03', name: '開発作業', displayOrder: 3, active: true },
      { id: 'wc-04', name: '社内業務', displayOrder: 4, active: true },
    ],
    notes: [],
    customerLogs: buildCustomerLogs(),
    supportActivities: buildSupportActivities(),
    internalSupports: buildInternalSupports(),
    salesActivities: buildSalesActivities(),
    partnerActivities: buildPartnerActivities(),
    salesActivityLogs: buildSalesActivityLogs(),
    partnerActivityLogs: buildPartnerActivityLogs(),
    customerContexts: buildCustomerContexts(),
    customerContextNotes: buildCustomerContextNotes(),
    salesApproaches: [], // デモは空（UI から登録。API モードはサーバー SoT）
    mediaWeeklyReports: [], // 訪問時に直近週分を決定的へ遅延生成（useMediaReports）
    mediaMeasures: [],

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
    directRequests: attendance.seedDirectRequests,
    attendanceRoutes: attendance.seedAttendanceRoutes,
    leaveGrants: [...buildLeaveGrants(), ...buildSpecialLeaveGrants()],
    leaveRequests: attendance.seedLeaveRequests,
    shiftPeriods: shifts.seedShiftPeriods,
    shiftWishes: shifts.seedShiftWishes,
    shiftAssignments: shifts.seedShiftAssignments,
    shiftDemands: shifts.seedShiftDemands,
    dailyReports: reports.seedDailyReports,
    weeklyReports: reports.seedWeeklyReports,
    monthlyReports: reports.seedMonthlyReports,
    reportComments: reports.seedReportComments,
    reportReads: [], // 既読は空スタート（ユーザーの閲覧操作でのみ増える）

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
    // ---- メディア分析 ----
    mediaChannels: media.seedMediaChannels,
    mediaArticles: media.seedMediaArticles,
    mediaInsights: media.seedMediaInsights, // 生成時に保管（シードなし）
    articleBriefs: media.seedArticleBriefs,
    generatedArticles: media.seedGeneratedArticles,
    mediaExternalArticles: media.seedMediaExternalArticles,
    dashboardInsights: [], // ダッシュボードインサイトは生成時に保管（シードなし = 「生成」ボタンから作る）
    // ---- 改善要望（F-42） ----
    improvementRequests: misc.seedImprovementRequests, // デモの生要望（集約済み + 未集約）
    improvementItems: misc.seedImprovementItems, // 改修単位デモ（カンバン/ガント初期表示。対応予定期間あり）
    improvementNotes: misc.seedImprovementNotes, // 改修単位の時系列メモ（デモ）
    improvementRequestComments: misc.seedImprovementRequestComments, // 生要望へのコメント（選別のやり取りデモ）
  }
}
