/**
 * ドメイン型定義（SoT: .ai-native/outputs/phase5/data-design.md）
 * - マスタ系は論理削除（active）。記録系は追記のみで巻き戻さない。
 * - 蓄積対象はスタースキーマ（mart）へ写像可能な構造で持つ。
 */

// ---------- 共通 ----------

export type Result =
  | { ok: true; id?: string }
  | { ok: false; error: { code: string; message: string } }

export interface CustomValues {
  [key: string]: string | number | boolean | string[] | null
}

// ---------- マスタ系 ----------

export type EmploymentType = 'director' | 'employee' | 'contract' | 'parttime' | 'outsource'
export type MemberRole = 'admin' | 'member'

export interface Member {
  id: string
  name: string
  email: string
  employmentType: EmploymentType
  dept: string
  title: string
  role: MemberRole
  hireDate: string // YYYY-MM-DD
  weeklyDays: number
  weeklyHours: number
  punchRequired: boolean
  /** Google カレンダー連携済みか（本実装では OAuth トークンの有無。モックでは同意フローで切替） */
  googleCalendarConnected: boolean
  /**
   * 勤務体系（勤怠ルール）の個別指定。
   * null = 雇用区分に合致する既定ルールを自動適用（正社員でも固定時間/フレックス/時短が
   * 混在するため、雇用区分だけでは決定できないケースをここで上書きする）
   */
  attendanceRuleId: string | null
  birthDate: string
  active: boolean
  custom: CustomValues
}

export interface Industry {
  id: string
  name: string
  displayOrder: number
  active: boolean
}

export type CompanyKind = 'self' | 'customer'

export interface Company {
  id: string
  kind: CompanyKind
  name: string
  aliases: string[]
  industryIds: string[]
  primaryIndustryId: string | null
  size: string
  location: string
  description: string
  ownerMemberId: string | null
  fiscalStartMonth: number | null // 自社のみ使用
  active: boolean
  custom: CustomValues
}

export interface Contact {
  id: string
  companyId: string
  name: string
  dept: string
  title: string
  keyPerson: 1 | 2 | 3 // 3 が最重要
  email: string
  phone: string
  notes: string
  active: boolean
  custom: CustomValues
}

export type RelationAppliesTo = 'company' | 'contact'

export interface RelationType {
  id: string
  label: string
  direction: 'directed' | 'mutual'
  appliesTo: RelationAppliesTo
  active: boolean
}

export interface CompanyRelation {
  id: string
  fromCompanyId: string
  toCompanyId: string
  relationTypeId: string
  notes: string
}

export interface ContactRelation {
  id: string
  fromContactId: string
  toContactId: string
  relationTypeId: string
  notes: string
}

export type ProjectType = 'biz_consulting' | 'sys_consulting' | 'development' | 'operation' | 'internal'
export type ProjectStatus = 'planned' | 'active' | 'onhold' | 'closed'

export interface Project {
  id: string
  name: string
  companyId: string
  type: ProjectType
  status: ProjectStatus
  priority: 'high' | 'mid' | 'low'
  ownerMemberId: string
  memberIds: string[]
  startDate: string
  endDate: string | null
  budget: number
  objective: string
  active: boolean
  custom: CustomValues
}

export type KnowledgeDomain = 'industry' | 'company' | 'contact' | 'relation' | 'project'

export interface KnowledgeArticle {
  id: string
  domain: KnowledgeDomain
  targetId: string
  title: string
  body: string
  tags: string[]
  source: 'manual' | 'escalation'
  sourceRefId: string | null
  updatedAt: string
  active: boolean
}

export type AiModelTier = 'lite' | 'standard' | 'pro'

export interface AiRole {
  id: string
  name: string
  mission: string
  systemPrompt: string
  permissions: string[]
  modelTier: AiModelTier
  active: boolean
}

export type AiEmployeeStatus = 'idle' | 'working' | 'waiting_approval'

export interface AiEmployee {
  id: string
  name: string
  roleId: string
  status: AiEmployeeStatus
  deskPosition: { x: number; y: number }
  active: boolean
}

export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'multiselect' | 'boolean'
export type CustomFieldEntity = 'member' | 'company' | 'contact' | 'project'

export interface CustomFieldDef {
  id: string
  entity: CustomFieldEntity
  key: string
  label: string
  fieldType: CustomFieldType
  options: string[]
  required: boolean
  displayOrder: number
  active: boolean
}

export interface CodeMasterItem {
  id: string
  category: string // dept / title / projectStatus / documentTag / ...
  code: string
  label: string
  displayOrder: number
  active: boolean
}

export interface ExternalLink {
  id: string
  title: string
  url: string
  description: string
  icon: string // lucide アイコン名
  displayOrder: number
  active: boolean
}

export type WorkflowCategory = 'purchase' | 'contract' | 'expense' | 'hiring' | 'trip' | 'other'
export type ApprovalMode = 'serial' | 'all' | 'majority'

export interface WorkflowRouteStep {
  order: number
  approverRole: 'manager' | 'director' | 'president'
  approverMemberId: string | null
  mode: ApprovalMode
}

export interface WorkflowRoute {
  id: string
  category: WorkflowCategory
  minAmount: number
  maxAmount: number | null
  steps: WorkflowRouteStep[]
  active: boolean
}

export interface AttendanceRule {
  id: string
  name: string
  /** この勤務体系を選択できる雇用区分（メンバーマスタの個別割当の候補を絞る） */
  appliesTo: EmploymentType[]
  /**
   * この勤務体系を「既定」とする雇用区分（appliesTo の部分集合）。
   * 各雇用区分の既定は 1 ルールのみ（保存時に排他制御）。
   * 同一雇用区分に複数の勤務体系（固定/フレックス/時短等）が存在するケースに対応する
   */
  defaultFor: EmploymentType[]
  workStart: string // HH:mm
  workEnd: string
  breakMinutes: number
  flex: { enabled: boolean; coreStart: string; coreEnd: string; settlementMonths: number } | null
  closingDay: number // 締め日（月末=31）
  legalHolidayWeekday: number // 0=日曜
  active: boolean
}

export interface SystemServiceComponent {
  id: string
  name: string
}

export interface SystemService {
  id: string
  name: string
  description: string
  url: string
  components: SystemServiceComponent[]
}

// ---------- 記録系（追記のみ） ----------

export type PunchKind = 'in' | 'out' | 'break_start' | 'break_end'

export interface PunchRecord {
  id: string
  memberId: string
  date: string // YYYY-MM-DD
  kind: PunchKind
  at: string // ISO datetime
  source: 'web' | 'mobile' | 'fix'
  fixedFrom: string | null
  fixReason: string | null
  approvedBy: string | null
}

/** 勤怠 6 バケット（分）。mart の fact_attendance に写像 */
export interface AttendanceBuckets {
  scheduled: number
  statutoryOt: number
  nonStatutoryOt: number
  over60Ot: number
  night: number
  legalHoliday: number
}

export interface AttendanceFixRequest {
  id: string
  memberId: string
  date: string
  kind: PunchKind
  requestedAt: string // 修正後の打刻時刻（ISO）
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  decidedBy: string | null
}

export interface LeaveGrant {
  id: string
  memberId: string
  grantDate: string
  days: number
  kind: 'normal' | 'proportional'
  expireDate: string
}

export interface LeaveRequest {
  id: string
  memberId: string
  date: string
  unit: 'full' | 'half'
  status: 'pending' | 'approved' | 'rejected'
  reason: string
  decidedBy: string | null
}

export type ShiftPeriodStatus = 'draft' | 'open' | 'closed' | 'adjusting' | 'published'

export interface ShiftPeriod {
  id: string
  label: string
  startDate: string
  endDate: string
  wishDeadline: string
  status: ShiftPeriodStatus
}

export type ShiftWishKind = 'want' | 'ng' | 'either'

export interface ShiftWish {
  id: string
  periodId: string
  memberId: string
  date: string
  wish: ShiftWishKind
  from: string | null
  to: string | null
}

export type ShiftAssignmentStatus = 'tentative' | 'confirmed' | 'change_requested'

export interface ShiftAssignment {
  id: string
  periodId: string
  memberId: string
  date: string
  from: string
  to: string
  status: ShiftAssignmentStatus
  consentAt: string | null
}

export interface ShiftDemand {
  id: string
  periodId: string
  date: string
  from: string
  to: string
  required: number
}

// ---------- 日報 AI アシスト（F-06-7/8） ----------

export type CalendarEventSource = 'google' | 'app'

/**
 * カレンダー予定（モック）。
 * SoT: source='google' の予定は Google カレンダーが正（本アプリはキャッシュ。編集・削除不可、同期で更新）。
 *      source='app' の予定は本アプリが正（syncedToGoogle=true で Google へ反映済みを表す）。
 */
export interface CalendarEvent {
  id: string
  memberId: string
  date: string // YYYY-MM-DD
  from: string // HH:mm
  to: string
  title: string
  source: CalendarEventSource
  syncedToGoogle: boolean
  /** タイトルから推定 or 手動指定したプロジェクト（AI ドラフトの工数振り分けに使用） */
  projectId: string | null
}

/**
 * AI アシストの蓄積ログ（記録系・追記のみ。日報ドラフトの材料になる）
 * kind='qa'  : AI ヒアリングへの回答（ai-manager の checkin 方式）
 * kind='memo': ぽいぽいメモ（tokutake ぽいぽいポスト方式の低摩擦断片投稿）
 */
export interface HearingLog {
  id: string
  memberId: string
  date: string
  kind: 'qa' | 'memo'
  calendarEventId: string | null
  question: string // memo の場合は空文字
  answer: string
  at: string
}

/** アプリ全体設定（キー・バリュー。日報入力方式などの少数の設定を保持） */
export interface AppConfigItem {
  key: string
  value: string
}

/** 日報の入力方式（設定 F-13）: 通常フォーム / AI アシスト / 両方 */
export type ReportInputMode = 'form' | 'assist' | 'both'

export interface ReportEntry {
  projectId: string
  task: string
  hours: number // 0.25 刻み
  progress: number // 0-100
}

export interface DailyReport {
  id: string
  authorKind: 'human' | 'ai'
  memberId: string | null
  aiEmployeeId: string | null
  date: string
  entries: ReportEntry[]
  reflection: string
  issues: string
  tomorrow: string
  status: 'draft' | 'submitted'
  submittedAt: string | null
}

export interface WeeklyReport {
  id: string
  memberId: string
  weekStart: string
  goalReview: string
  mainWork: string
  issues: string
  nextWeek: string
  status: 'draft' | 'submitted'
}

export interface ReportComment {
  id: string
  reportId: string
  memberId: string
  body: string
  at: string
  reactions: { memberId: string; emoji: string }[]
}

export type WorkflowStatus =
  | 'draft' | 'submitted' | 'in_review' | 'approved' | 'rejected' | 'remanded' | 'withdrawn'

export interface WorkflowRequest {
  id: string // 決裁番号 WF-xxxx
  category: WorkflowCategory
  title: string
  amount: number
  body: string
  attachments: string[]
  requesterId: string
  status: WorkflowStatus
  currentStep: number
  routeSnapshot: WorkflowRouteStep[] // 申請時の経路を凍結保存
  createdAt: string
}

export type ApprovalAction = 'submit' | 'approve' | 'reject' | 'remand' | 'withdraw'

export interface ApprovalLog {
  id: string
  requestId: string
  step: number
  actorId: string
  delegateForId: string | null
  action: ApprovalAction
  comment: string
  at: string
}

export interface DelegateSetting {
  id: string
  memberId: string
  delegateMemberId: string
  from: string
  to: string
  active: boolean
}

export type AiTaskStatus = 'proposed' | 'approved' | 'in_progress' | 'blocked' | 'done' | 'cancelled'

export interface AiTask {
  id: string
  aiEmployeeId: string
  requesterId: string
  title: string
  description: string
  decomposition: { title: string; done: boolean }[]
  status: AiTaskStatus
  dueDate: string | null
  confidence: 'high' | 'mid' | 'low'
  createdAt: string
}

export type AiActivityKind = 'plan' | 'execute' | 'report' | 'escalate' | 'chat'

export interface AiActivityLog {
  id: string
  aiEmployeeId: string
  taskId: string | null
  at: string
  kind: AiActivityKind
  summary: string
  tokens: number
  costUsd: number
}

export type NotificationKind = 'approval' | 'comment' | 'reminder' | 'ai_report' | 'system' | 'escalation'

export interface AppNotification {
  id: string
  memberId: string
  kind: NotificationKind
  title: string
  body: string
  link: string
  read: boolean
  at: string
}

export type EscalationReason =
  | 'issue_reported' | 'stalled_task' | 'overload' | 'low_confidence' | 'overtime_alert'

export type EscalationResolutionType = 'answer' | 'ruling' | 'no_action'

export interface Escalation {
  id: string
  reason: EscalationReason
  targetMemberId: string | null
  targetAiEmployeeId: string | null
  context: string
  status: 'open' | 'resolved'
  resolution: {
    type: EscalationResolutionType
    body: string
    resolvedBy: string
    at: string
  } | null
  knowledgeReflected: boolean
  dedupeKey: string
  raisedAt: string
}

export type IncidentImpact = 'minor' | 'major' | 'critical'
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'

export interface ServiceIncident {
  id: string
  serviceId: string
  title: string
  impact: IncidentImpact
  status: IncidentStatus
  updates: { status: IncidentStatus; body: string; at: string }[]
  startedAt: string
  resolvedAt: string | null
}

export interface UptimeDaily {
  serviceId: string
  date: string
  downMinutes: number
  worstState: 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance'
}

export type DecisionSlot = 'A' | 'B' | 'C'
export type DecisionActionStatus = 'ok' | 'warn' | 'ng'

export interface DecisionTheme {
  id: string
  title: string
  category: 'business' | 'project'
  objective: string
  /** ①意味: 属性・KPI */
  semantics: { key: string; value: string }[]
  /** ②関係: マスタ実データへのリンク */
  links: { label: string; to: string; info: string }[]
  /** ③制約と打ち手 */
  actions: { name: string; status: DecisionActionStatus; slot: DecisionSlot | null; why: string }[]
  options: {
    slot: DecisionSlot
    recommended: boolean
    title: string
    prediction: string[]
    basis: string
  }[]
  whyRecommend: string
  /** シナリオ比較のパラメータ定義 */
  scenarioParams: { key: string; label: string; min: number; max: number; step: number; default: number; unit: string }[]
}

export interface DecisionLog {
  id: string
  themeId: string
  chosenSlot: DecisionSlot
  reason: string
  decidedBy: string
  at: string
}

export interface AuditLog {
  id: string
  actorId: string
  action: string
  entity: string
  entityId: string
  detail: string
  at: string
}

export interface SalesMonthly {
  month: string // YYYY-MM
  projectType: ProjectType
  companyId: string
  amount: number
  cost: number
}

export interface DocumentNode {
  id: string
  parentId: string | null
  kind: 'folder' | 'file'
  name: string
  tags: string[]
  updatedAt: string
  updatedBy: string
  size: string | null
  summary: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources: string[]
  suggestions: string[]
  at: string
}

export interface AkebonoWish {
  id: string
  memberId: string
  body: string
  at: string
}

export interface FeatureToggle {
  key: string
  label: string
  enabled: boolean
}

export interface EscalationRule {
  key: EscalationReason
  label: string
  enabled: boolean
  threshold: number | null
  thresholdLabel: string | null
  cooldownDays: number
}
