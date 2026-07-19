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
export type MemberRole = 'admin' | 'hr' | 'member'

export interface Member {
  id: string
  name: string
  email: string
  employmentType: EmploymentType
  /** 所属部署（Department マスタ参照。F-10-9） */
  departmentId: string
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
  /** プロフィール画像（小さな data:image/... URI。空/未設定 = イニシャル表示。本人が /profile で登録） */
  avatar?: string
  active: boolean
  custom: CustomValues
}

/**
 * 部署（F-10-9）。parentId による階層構造を持ち、組織図はここから導出する。
 * メンバーの所属は Member.departmentId が SoT。
 */
export interface Department {
  id: string
  name: string
  /** 親部署（null = トップレベル） */
  parentId: string | null
  /** 部署責任者（Member 参照。組織図に表示） */
  managerId: string | null
  description: string
  displayOrder: number
  active: boolean
}

/** 業務種別（ぽいぽいポスト・議事録の任意分類。バッチ7c） */
export interface WorkCategory {
  id: string
  name: string
  displayOrder: number
  active: boolean
}

export type NoteKind = 'poipoi' | 'minutes'

/** ノート（ぽいぽいポスト = 本人 + 管理者閲覧 / 議事録 = 全員参照。記録系 = 追記 + 取消/復元。バッチ7c/7e） */
export interface Note {
  id: string
  memberId: string
  kind: NoteKind
  title: string
  body: string
  projectId: string | null
  companyId: string | null
  workCategoryId: string | null
  source: 'text' | 'upload'
  createdAt: string
  /** 取消（論理削除）済みは false。既存データ・モック旧データは未設定 = 有効（原則7） */
  active?: boolean
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

/** 事業種別の区分値（登録 API・マスタスキーマ・mart 退化キーで共有する単一定義 = 原則3） */
export const PROJECT_TYPES = ['biz_consulting', 'sys_consulting', 'development', 'operation', 'internal'] as const
export type ProjectType = (typeof PROJECT_TYPES)[number]
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
  /** 営業曜日（0=日〜6=土）。外注等は土日を含められる（オペレーター報告 2026-07-18 #4） */
  workingWeekdays: number[]
  /** 祝日（public_holidays マスタ）を非営業日として扱うか */
  holidayAware: boolean
  active: boolean
}

/** 祝日マスタ（SoT: public_holidays。内閣府公式 CSV の取込 + 手動管理） */
export interface Holiday {
  id: string
  date: string // YYYY-MM-DD（一意）
  name: string
  source: 'official' | 'manual'
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

/**
 * 休暇種別マスタ（F-10-10）。有給以外の特別休暇（夏季・結婚特休等）は会社ごとに
 * 異なるためマスタ管理する。
 * grantMethod='periodic': 周期的に自動付与（有給 = 労基法 39 条テーブル）
 * grantMethod='manual'  : 権限者（管理者/人事）が任意タイミングで付与（個別・一括）
 */
export interface LeaveType {
  id: string
  name: string
  grantMethod: 'periodic' | 'manual'
  /** 付与日から失効までの月数（null = 期限なし） */
  expiryMonths: number | null
  /** 法定有給か（残数上限 40 日・年 5 日取得義務・比例付与の対象） */
  isStatutory: boolean
  description: string
  displayOrder: number
  active: boolean
}

export interface LeaveGrant {
  id: string
  memberId: string
  /** 休暇種別（F-10-10） */
  leaveTypeId: string
  grantDate: string
  days: number
  /** normal/proportional = 有給の自動付与区分。special = 権限者による手動付与 */
  kind: 'normal' | 'proportional' | 'special'
  expireDate: string
  /** 付与実行者（null = 周期自動付与） */
  grantedBy: string | null
}

export interface LeaveRequest {
  id: string
  memberId: string
  /** 休暇種別（F-10-10） */
  leaveTypeId: string
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

// ---------- AI業務アシスタント / 日報 AI アシスト（F-14・F-06-7/8） ----------

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

/**
 * タスク計画（AI業務アシスタント F-14）。
 * 前日の終わりに翌日のタスクへ目的・達成条件・段取りを登録し、AI コメントを受けて修正する。
 * 当日の終わりに結果・所感を記録すると日報ドラフトへ自動反映可能になる。
 * 蓄積データは管理者向けインサイト（計画率・完了率等）の元ネタ（mart 写像は data-design 参照）。
 * 記録系: 結果記録（status='done'）後は編集不可。計画中（planned）のみ修正可。
 */
export interface TaskPlan {
  id: string
  memberId: string
  /** 実施予定日（前日に登録する「明日」の日付） */
  date: string
  /** 紐付くカレンダー予定（null = 手動追加タスク） */
  calendarEventId: string | null
  title: string
  /** 目的 */
  purpose: string
  /** 達成条件 */
  doneCriteria: string
  /** 段取り・計画 */
  approach: string
  /** AI レビューコメント（モック: 決定的ヒューリスティック。本実装は LLM） */
  aiComment: string
  aiCommentAt: string | null
  status: 'planned' | 'done'
  /** 実施結果（当日の終わりに記録） */
  outcome: string
  /** 所感 */
  reflection: string
  resultAt: string | null
  createdAt: string
  updatedAt: string
}

/** アプリ全体設定（キー・バリュー。日報入力方式などの少数の設定を保持） */
export interface AppConfigItem {
  key: string
  value: string
}

/** 日報の入力方式（設定 F-13）: 通常フォーム / AI アシスト / 両方 */
export type ReportInputMode = 'form' | 'assist' | 'both'

export interface ReportEntry {
  /**
   * 業務テーマ（自由入力。オペレーター指示 2026-07-17: 選択式プロジェクトを自由入力へ変更）。
   * 旧データは theme 未設定 + projectId のみ。表示・編集時はプロジェクト名へフォールバックする（原則7）
   */
  theme?: string
  /** 旧形式（選択式プロジェクト）。新規エントリでは未使用だが既存データの表示のため保持 */
  projectId?: string
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
  /** 依頼元 AI 社員（AI 社員間の連携で作られた子タスクのみ。人間からの直接依頼は null/未設定） */
  requesterAiEmployeeId?: string | null
  /** 連携元（親）タスク（マネージャーのタスクから分担された子タスクのみ） */
  parentTaskId?: string | null
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
  /** 所属セッション。過去データ（セッション導入前のモック会話）は未設定 = 初回ロード時に移行 */
  sessionId?: string
  role: 'user' | 'assistant'
  content: string
  sources: string[]
  suggestions: string[]
  at: string
}

/**
 * 権限ルール（F-16 権限制御・オペレーター指示 2026-07-17）
 * - subjectKind: 適用レイヤ。member（個人）> title（役職）> role（ロール）の優先順で解決する
 * - resource: 機能キー（FEATURE_PERMISSION_KEYS）またはマスタエンティティキー（フィールド制御時）
 * - field: null = 機能全体の利用可否 / 値あり = 表示項目レベルの制御
 * - 既存のロールガード（admin/hr/member）は緩められない（ルールは制限レイヤ = 権限昇格しない設計）
 */
export interface PermissionRule {
  id: string
  subjectKind: 'role' | 'title' | 'member'
  /** role: admin|hr|member / title: 役職名（メンバーの title と一致）/ member: メンバー id */
  subjectId: string
  resource: string
  field: string | null
  effect: 'allow' | 'deny'
  active: boolean
}

/** チャットセッション（オペレーター指示 2026-07-17: マルチターン・過去セッション再開・新規開始） */
export interface ChatSession {
  id: string
  /** モックモードのユーザー切替用（API は認証ユーザーでスコープするためレスポンスに含まれない） */
  memberId?: string
  title: string
  createdAt: string
  updatedAt: string
  /** API の一覧レスポンスのみ（表示用） */
  messageCount?: number
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
