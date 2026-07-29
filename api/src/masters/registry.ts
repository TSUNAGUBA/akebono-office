/**
 * 汎用マスタ CRUD の台帳（mockup useMasterCrud の対応物）。
 * - エンティティごとにテーブル・id プレフィックス・zod スキーマ・jsonb 列・ガードを宣言する
 * - 論理削除のみ（active=false）。例外: 関係エッジ（company/contact-relations）と
 *   未使用の関係種別（relation-types。参照ガードは masters.ts）は物理削除可
 *   （data-design §1.1 の設計判断。削除は監査ログ必須）
 * - バリデーションは API の責務（モックでは画面側の責務だったが、公開 I/F になるためここで担保）
 */
import { z } from 'zod'
import { PROJECT_TYPES } from '../../../shared/domain/types'

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD 形式で入力してください')
/** 空文字を null として扱う日付（画面の未入力と互換） */
const dateKeyOrNull = z.union([dateKey, z.literal(''), z.null()]).transform(v => (v ? v : null))
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, '時刻は HH:mm 形式で入力してください')

const employmentType = z.enum(['director', 'employee', 'contract', 'parttime', 'outsource'])

// ---------- Akebono 設定系（Phase B = 0031。値域は mockup/app/types/akebono.ts の union が SoT） ----------

const industryType = z.enum(['retail', 'maker', 'logistics', 'it_service', 'other'])
/** 空文字を null として扱う任意文字列（画面の未選択・未入力と互換）。cap はコードポイントでなく length（ASCII 前提でない表示名は余裕を持たせる） */
const optText = (max: number) => z.string().trim().max(max).nullable().default(null).transform(v => (v ? v : null))
/**
 * アイコン画像（data URI）。プロフィール画像（app.ts PUT /v1/me/profile）と同じ
 * サブタイプ allowlist + base64 必須（SVG 等のスクリプト混入形式を拒否）。
 * 上限 400,000 文字 = フロントの IMAGE_MAX_CHARS（utils/thumb）と一致させる
 */
const iconImage = z.string()
  .regex(/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/, 'アイコン画像は data:image/png・jpeg・webp の base64 形式で指定してください')
  .max(400_000, 'アイコン画像が大きすぎます（縮小して再度お試しください）')
  .nullable().default(null)

/** workflow-routes の基底（PATCH は .partial() を使うためクロスフィールド検証前の形を保持） */
const workflowRouteBase = z.object({
  category: z.enum(['purchase', 'contract', 'expense', 'hiring', 'trip', 'other']),
  minAmount: z.number().min(0).default(0),
  maxAmount: z.number().min(0).nullable().default(null),
  steps: z.array(z.object({
    order: z.number().int().min(1),
    approverRole: z.enum(['manager', 'director', 'president']),
    approverMemberId: z.string().nullable().default(null),
    mode: z.enum(['serial', 'all', 'majority']).default('serial'),
  })).min(1, '承認ステップを 1 つ以上設定してください'),
  active: z.boolean().default(true),
})

/** permission-rules の基底（PATCH は .partial() を使うためクロスフィールド検証前の形を保持） */
const permissionRuleBase = z.object({
  subjectKind: z.enum(['role', 'title', 'member']),
  subjectId: z.string().trim().min(1, '対象を指定してください'),
  resource: z.string().trim().min(1, 'リソースを指定してください'),
  field: z.string().trim().nullable().default(null),
  effect: z.enum(['allow', 'deny']),
})

/**
 * subjectKind / subjectId のペア整合。不整合ルールはマッチ不能（inert）で昇格リスクはないが、
 * 「登録したのに効かない」事故を防ぐ。object 単位の superRefine は .partial() に引き継がれないため
 * create / patch の両スキーマへ個別に適用する
 */
function permissionSubjectCheck(v: { subjectKind?: string; subjectId?: string }, ctx: z.RefinementCtx): void {
  if (v.subjectKind === undefined && v.subjectId === undefined) return
  if (v.subjectKind === undefined || v.subjectId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['subjectKind'], message: '対象レイヤ（subjectKind）と対象（subjectId）は同時に指定してください' })
    return
  }
  if (v.subjectKind === 'role' && !['admin', 'hr', 'member'].includes(v.subjectId)) {
    ctx.addIssue({ code: 'custom', path: ['subjectId'], message: 'ロール層の対象は admin / hr / member のいずれかです' })
  }
}

/**
 * goals の基底（PATCH は .partial() を使うためクロスフィールド検証前の形を保持）。
 * segment_sales = 円（対象業態必須）/ report_rate = %（全社 = segmentId null・0-100）
 */
const goalBase = z.object({
  metric: z.enum(['segment_sales', 'report_rate']),
  segmentId: z.string().trim().nullable().default(null).transform(v => (v ? v : null)),
  monthlyValue: z.number().min(0, '目標値は 0 以上で入力してください').max(1e12, '目標値が大きすぎます'),
  note: z.string().default(''),
})

/**
 * goals の metric × segmentId × 値域のペア整合（POST = 全フィールド確定時の検証）。
 * object 単位の superRefine は .partial() に引き継がれず、部分 PATCH は単独フィールドの変更で
 * 既存行との組み合わせ不変条件を破れるため、PATCH は masters.ts の goalCrossGuard
 * （既存行とマージした結果で検証 = workflow-routes と同型）+ goals テーブルの CHECK 制約
 * （migration 0039）が同じ不変条件を担保する
 */
function goalMetricCheck(
  v: { metric?: string; segmentId?: string | null; monthlyValue?: number },
  ctx: z.RefinementCtx,
): void {
  if (v.metric === 'segment_sales' && !v.segmentId) {
    ctx.addIssue({ code: 'custom', path: ['segmentId'], message: '業態売上の目標は対象業態を指定してください' })
  }
  if (v.metric === 'report_rate') {
    if (v.segmentId) {
      ctx.addIssue({ code: 'custom', path: ['segmentId'], message: '日報提出率の目標は全社です（業態は指定できません）' })
    }
    if (v.monthlyValue !== undefined && v.monthlyValue > 100) {
      ctx.addIssue({ code: 'custom', path: ['monthlyValue'], message: '日報提出率は 0〜100 で入力してください' })
    }
  }
}

const schemas = {
  members: z.object({
    name: z.string().trim().min(1, '氏名は必須です'),
    email: z.string().trim().default(''),
    employmentType: employmentType.default('employee'),
    departmentId: z.string().default(''),
    title: z.string().default(''),
    role: z.enum(['admin', 'hr', 'member']).default('member'),
    hireDate: dateKeyOrNull.default(null),
    weeklyDays: z.number().min(0).max(7).default(5),
    weeklyHours: z.number().min(0).max(80).default(40),
    punchRequired: z.boolean().default(true),
    googleCalendarConnected: z.boolean().default(false),
    attendanceRuleId: z.string().nullable().default(null),
    birthDate: dateKeyOrNull.default(null),
    // 担当業態（businessSegments 参照。F-01 コックピットの事業計器の出し分け。空 = 未設定 = 下位互換）
    segmentIds: z.array(z.string()).default([]),
    custom: z.record(z.string(), z.unknown()).default({}),
  }),
  departments: z.object({
    name: z.string().trim().min(1, '部署名は必須です'),
    parentId: z.string().nullable().default(null).transform(v => (v ? v : null)),
    managerId: z.string().nullable().default(null).transform(v => (v ? v : null)),
    description: z.string().default(''),
    displayOrder: z.number().int().default(1),
  }),
  'leave-types': z.object({
    name: z.string().trim().min(1, '種別名は必須です'),
    grantMethod: z.enum(['periodic', 'manual']).default('manual'),
    expiryMonths: z.number().int().min(1).max(120).nullable().default(null),
    isStatutory: z.boolean().default(false),
    description: z.string().default(''),
    displayOrder: z.number().int().default(1),
  }),
  industries: z.object({
    name: z.string().trim().min(1, '業界名は必須です'),
    displayOrder: z.number().int().default(1),
  }),
  'work-categories': z.object({
    name: z.string().trim().min(1, '業務種別名は必須です'),
    displayOrder: z.number().int().default(1),
  }),
  companies: z.object({
    kind: z.enum(['self', 'customer']).default('customer'),
    name: z.string().trim().min(1, '会社名は必須です'),
    aliases: z.array(z.string()).default([]),
    industryIds: z.array(z.string()).default([]),
    primaryIndustryId: z.string().default(''),
    size: z.string().default(''),
    location: z.string().default(''),
    description: z.string().default(''),
    ownerMemberId: z.string().default(''),
    fiscalStartMonth: z.number().int().min(1).max(12).nullable().default(null),
    // Akebono 拡張（F-30-1 = Phase C 0032 で物理列化。空 = customer は ['customer'] 相当のアプリ層互換）
    partnerRoles: z.array(z.enum(['customer', 'supplier', 'consignor_artist', 'store', 'subcontractor'])).default([]),
    paymentTermId: z.string().nullable().default(null).transform(v => (v ? v : null)),
    billingTermId: z.string().nullable().default(null).transform(v => (v ? v : null)),
    custom: z.record(z.string(), z.unknown()).default({}),
  }),
  contacts: z.object({
    companyId: z.string().min(1, '所属会社は必須です'),
    name: z.string().trim().min(1, '氏名は必須です'),
    dept: z.string().default(''),
    title: z.string().default(''),
    keyPerson: z.number().int().min(1).max(3).default(1),
    email: z.string().default(''),
    phone: z.string().default(''),
    notes: z.string().default(''),
    custom: z.record(z.string(), z.unknown()).default({}),
  }),
  'relation-types': z.object({
    label: z.string().trim().min(1, '関係種別名は必須です'),
    direction: z.enum(['directed', 'mutual']).default('directed'),
    appliesTo: z.enum(['company', 'contact']).default('company'),
  }),
  'company-relations': z.object({
    fromCompanyId: z.string().min(1),
    toCompanyId: z.string().min(1),
    relationTypeId: z.string().min(1),
    notes: z.string().default(''),
  }).refine(v => v.fromCompanyId !== v.toCompanyId, { message: '同一会社への関係は登録できません' }),
  'contact-relations': z.object({
    fromContactId: z.string().min(1),
    toContactId: z.string().min(1),
    relationTypeId: z.string().min(1),
    notes: z.string().default(''),
  }).refine(v => v.fromContactId !== v.toContactId, { message: '同一人物への関係は登録できません' }),
  projects: z.object({
    name: z.string().trim().min(1, 'プロジェクト名は必須です'),
    companyId: z.string().default(''),
    type: z.enum(PROJECT_TYPES).default('internal'),
    status: z.string().default('active'),
    priority: z.string().default('mid'),
    ownerMemberId: z.string().default(''),
    memberIds: z.array(z.string()).default([]),
    startDate: dateKeyOrNull.default(null),
    endDate: dateKeyOrNull.default(null),
    budget: z.number().nullable().default(null),
    objective: z.string().default(''),
    custom: z.record(z.string(), z.unknown()).default({}),
  }),
  knowledge: z.object({
    domain: z.enum(['industry', 'company', 'contact', 'relation', 'project']),
    targetId: z.string().default(''),
    title: z.string().trim().min(1, 'タイトルは必須です'),
    body: z.string().default(''),
    tags: z.array(z.string()).default([]),
    source: z.enum(['manual', 'escalation']).default('manual'),
    sourceRefId: z.string().nullable().default(null),
  }),
  'custom-field-defs': z.object({
    entity: z.string().min(1),
    key: z.string().trim().min(1, 'キーは必須です'),
    label: z.string().trim().min(1, 'ラベルは必須です'),
    fieldType: z.enum(['text', 'number', 'date', 'select', 'multiselect', 'boolean']).default('text'),
    options: z.array(z.string()).default([]),
    required: z.boolean().default(false),
    displayOrder: z.number().int().default(1),
  }),
  'code-masters': z.object({
    category: z.string().trim().min(1, 'カテゴリは必須です'),
    code: z.string().trim().min(1, 'コードは必須です'),
    label: z.string().trim().min(1, 'ラベルは必須です'),
    displayOrder: z.number().int().default(1),
  }),
  'external-links': z.object({
    title: z.string().trim().min(1, 'タイトルは必須です'),
    url: z.string().trim().min(1, 'URL は必須です'),
    description: z.string().default(''),
    icon: z.string().default(''),
    displayOrder: z.number().int().default(1),
  }),
  'attendance-rules': z.object({
    name: z.string().trim().min(1, 'ルール名は必須です'),
    appliesTo: z.array(employmentType).default([]),
    defaultFor: z.array(employmentType).default([]),
    workStart: hhmm.default('09:00'),
    workEnd: hhmm.default('18:00'),
    breakMinutes: z.number().int().min(0).max(240).default(60),
    flex: z.object({
      coreStart: hhmm,
      coreEnd: hhmm,
      settlementMonths: z.number().int().min(1).max(3),
    }).nullable().default(null),
    closingDay: z.number().int().min(1).max(31).default(31),
    legalHolidayWeekday: z.number().int().min(0).max(6).default(0),
    // 営業日定義（オペレーター報告 2026-07-18 #4: 外注等は平日以外も営業日になり得る）
    workingWeekdays: z.array(z.number().int().min(0).max(6)).min(1, '営業曜日を 1 つ以上選択してください').default([1, 2, 3, 4, 5]),
    holidayAware: z.boolean().default(true),
  }),
  // 祝日マスタ（SoT。内閣府公式 CSV の取込 = POST /v1/holidays/import と手動管理の両対応）
  'holidays': z.object({
    date: dateKey,
    name: z.string().trim().min(1, '祝日名は必須です'),
    source: z.enum(['official', 'manual']).default('manual'),
  }),
  // 目標マスタ（F-01 コックピット着地予報。cockpit-design §2.2。migration 0039）
  'goals': goalBase.superRefine(goalMetricCheck),
  'workflow-routes': workflowRouteBase.superRefine((v, ctx) => {
    // どの金額にもマッチしない経路・重複ステップの作成をサーバー側でも防ぐ（UI 検証のミラー）
    if (v.maxAmount !== null && v.maxAmount <= v.minAmount) {
      ctx.addIssue({ code: 'custom', path: ['maxAmount'], message: '上限金額は下限金額より大きくしてください' })
    }
    if (new Set(v.steps.map(s => s.order)).size !== v.steps.length) {
      ctx.addIssue({ code: 'custom', path: ['steps'], message: '承認ステップの順序（order）が重複しています' })
    }
  }),
  'decision-themes': z.object({
    title: z.string().trim().min(1, 'テーマ名は必須です'),
    category: z.enum(['business', 'project']),
    objective: z.string().default(''),
    semantics: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
    links: z.array(z.object({ label: z.string(), to: z.string(), info: z.string() })).default([]),
    actions: z.array(z.object({
      name: z.string(),
      status: z.enum(['ok', 'warn', 'ng']),
      slot: z.enum(['A', 'B', 'C']).nullable().default(null),
      why: z.string().default(''),
    })).default([]),
    // 配列内の検証は .partial()（部分 PATCH）でも維持されるため、スロット重複チェックはここで行う
    options: z.array(z.object({
      slot: z.enum(['A', 'B', 'C']),
      recommended: z.boolean().default(false),
      title: z.string(),
      prediction: z.array(z.string()).default([]),
      basis: z.string().default(''),
    })).min(1, '選択肢を 1 つ以上設定してください').superRefine((opts, ctx) => {
      if (new Set(opts.map(o => o.slot)).size !== opts.length) {
        ctx.addIssue({ code: 'custom', message: '選択肢のスロット（A/B/C）が重複しています' })
      }
    }),
    whyRecommend: z.string().default(''),
    scenarioParams: z.array(z.object({
      key: z.string(), label: z.string(), min: z.number(), max: z.number(),
      step: z.number(), default: z.number(), unit: z.string(),
    })).default([]),
    active: z.boolean().default(true),
  }),
  'permission-rules': permissionRuleBase.superRefine(permissionSubjectCheck),
  'ai-roles': z.object({
    name: z.string().trim().min(1, 'ロール名は必須です'),
    mission: z.string().default(''),
    systemPrompt: z.string().default(''),
    permissions: z.array(z.string()).default([]),
    modelTier: z.enum(['lite', 'standard', 'pro']).default('standard'),
    active: z.boolean().default(true),
  }),
  'ai-employees': z.object({
    name: z.string().trim().min(1, '名前は必須です'),
    roleId: z.string().trim().min(1, 'ロールを指定してください'),
    // status はタスク状態からの派生値（/v1/ai-company がタスク操作時に同期）。マスタからは初期値のみ
    status: z.enum(['idle', 'working', 'waiting_approval']).default('idle'),
    deskPosition: z.object({ x: z.number().int(), y: z.number().int() }).default({ x: 1, y: 1 }),
    active: z.boolean().default(true),
  }),
  // ---------- Akebono 設定系マスタ（Phase B = 0031。/akebono/masters・/akebono/settings/segments） ----------
  'business-segments': z.object({
    name: z.string().trim().min(1, 'セグメント名は必須です'),
    industryType,
    displayOrder: z.number().int().default(1),
    // 業態別アプリの表示・入力既定（F-20 拡張。すべて任意 = 未設定はフォールバック）
    appName: optText(60),
    appIcon: optText(40),
    appIconImage: iconImage,
    defaultUnitId: optText(64),
    defaultBillingType: z.enum(['one_time', 'monthly', 'usage']).nullable().default(null),
    defaultVariantAxis1Label: optText(40),
    defaultVariantAxis2Label: optText(40),
  }),
  'warehouses': z.object({
    name: z.string().trim().min(1, '倉庫・保管場所名は必須です'),
    kind: z.enum(['own', 'store_deposit', 'external']).default('own'),
    companyId: optText(64),
    displayOrder: z.number().int().default(1),
  }),
  'units': z.object({
    name: z.string().trim().min(1, '単位名は必須です'),
    displayOrder: z.number().int().default(1),
  }),
  'tax-rates': z.object({
    name: z.string().trim().min(1, '名称は必須です'),
    rate: z.number().min(0, '税率は 0〜1 で入力してください').max(1, '税率は 0〜1 で入力してください'),
    displayOrder: z.number().int().default(1),
  }),
  'payment-terms': z.object({
    name: z.string().trim().min(1, '名称は必須です'),
    closingDay: z.number().int().min(1).max(31),
    // 画面の未入力（null）は既定値へ倒す（PaymentTerm 型は number 必須）
    payMonthOffset: z.number().int().min(0).max(3).nullable().default(1).transform(v => v ?? 1),
    payDay: z.number().int().min(1).max(31).nullable().default(31).transform(v => v ?? 31),
  }),
  'consignment-terms': z.object({
    companyId: z.string().trim().min(1, '取引先は必須です'),
    segmentId: z.string().trim().min(1, '事業セグメントは必須です'),
    role: z.enum(['store', 'consignor_artist']),
    marginRate: z.number().min(0).max(1).nullable().default(null),
    payoutMethod: z.enum(['sales_rate', 'purchase_cost']).nullable().default(null),
    payoutRate: z.number().min(0).max(1).nullable().default(null),
    liabilityTiming: z.enum(['on_sale', 'on_receipt']).nullable().default(null),
    taxRateId: optText(64),
    taxIncluded: z.boolean().default(false),
    rounding: z.enum(['floor', 'ceil', 'round']).default('floor'),
    validFrom: dateKey,
  }),
  'variant-axis-templates': z.object({
    name: z.string().trim().min(1, 'テンプレート名は必須です'),
    axis1Label: z.string().trim().min(1, '軸1ラベルは必須です'),
    axis2Label: z.string().trim().min(1, '軸2ラベルは必須です'),
    industryTypes: z.array(industryType).default([]),
    displayOrder: z.number().int().default(1),
  }),
  'product-categories': z.object({
    name: z.string().trim().min(1, 'カテゴリ名は必須です'),
    parentId: optText(64),
    displayOrder: z.number().int().default(1),
  }),
  'product-image-sections': z.object({
    name: z.string().trim().min(1, 'セクション名は必須です'),
    isThumbnailPriority: z.boolean().default(false),
    // 既定シードは migration 投入のみ。POST の明示 true は 409（AKO-AKB-002）・無効化ガードも masters.ts
    isSeed: z.boolean().default(false),
    displayOrder: z.number().int().default(1),
  }),
} as const

export type MasterEntity = keyof typeof schemas

export interface MasterDef {
  table: string
  idPrefix: string
  /** 追加時の入力スキーマ */
  schema: z.ZodType
  /** 部分更新時の入力スキーマ（関係エッジは削除→再登録運用のため未定義。relation-types は物理削除可だが更新も可） */
  patchSchema?: z.ZodType
  /** jsonb 列（書込時に JSON.stringify が必要な camelCase フィールド名） */
  jsonbFields: string[]
  /** DELETE を許可するか（関係エッジ = 常時可 / 関係種別 = 未使用のみ。ガードは masters.ts） */
  physicalDelete?: boolean
  /** 論理削除を持たないか（physicalDelete 系は active 列なし） */
  noActive?: boolean
}

export const MASTERS: Record<MasterEntity, MasterDef> = {
  'members': { table: 'members', idPrefix: 'm', schema: schemas.members, patchSchema: schemas.members.partial(), jsonbFields: ['segmentIds', 'custom'] },
  'departments': { table: 'departments', idPrefix: 'dep', schema: schemas.departments, patchSchema: schemas.departments.partial(), jsonbFields: [] },
  'leave-types': { table: 'leave_types', idPrefix: 'lt', schema: schemas['leave-types'], patchSchema: schemas['leave-types'].partial().omit({ isStatutory: true }), jsonbFields: [] },
  'industries': { table: 'industries', idPrefix: 'ind', schema: schemas.industries, patchSchema: schemas.industries.partial(), jsonbFields: [] },
  // 業務種別（ぽいぽいポスト・議事録の任意分類。バッチ7c）
  'work-categories': { table: 'work_categories', idPrefix: 'wc', schema: schemas['work-categories'], patchSchema: schemas['work-categories'].partial(), jsonbFields: [] },
  'companies': { table: 'companies', idPrefix: 'c', schema: schemas.companies, patchSchema: schemas.companies.partial(), jsonbFields: ['aliases', 'industryIds', 'partnerRoles', 'custom'] },
  'contacts': { table: 'contacts', idPrefix: 'p', schema: schemas.contacts, patchSchema: schemas.contacts.partial(), jsonbFields: ['custom'] },
  // 関係種別は論理削除（無効化）に加え、未使用時のみ物理削除可（参照ガードは masters.ts の DELETE 側）
  'relation-types': { table: 'relation_types', idPrefix: 'rt', schema: schemas['relation-types'], patchSchema: schemas['relation-types'].partial(), jsonbFields: [], physicalDelete: true },
  'permission-rules': { table: 'permission_rules', idPrefix: 'pm', schema: schemas['permission-rules'], patchSchema: permissionRuleBase.partial().superRefine(permissionSubjectCheck), jsonbFields: [] },
  'company-relations': { table: 'company_relations', idPrefix: 'cr', schema: schemas['company-relations'], jsonbFields: [], physicalDelete: true, noActive: true },
  'contact-relations': { table: 'contact_relations', idPrefix: 'pr', schema: schemas['contact-relations'], jsonbFields: [], physicalDelete: true, noActive: true },
  'projects': { table: 'projects', idPrefix: 'pj', schema: schemas.projects, patchSchema: schemas.projects.partial(), jsonbFields: ['memberIds', 'custom'] },
  'knowledge': { table: 'knowledge_articles', idPrefix: 'ka', schema: schemas.knowledge, patchSchema: schemas.knowledge.partial(), jsonbFields: ['tags'] },
  'custom-field-defs': { table: 'custom_field_defs', idPrefix: 'cf', schema: schemas['custom-field-defs'], patchSchema: schemas['custom-field-defs'].partial(), jsonbFields: ['options'] },
  'code-masters': { table: 'code_masters', idPrefix: 'cm', schema: schemas['code-masters'], patchSchema: schemas['code-masters'].partial(), jsonbFields: [] },
  'external-links': { table: 'external_links', idPrefix: 'el', schema: schemas['external-links'], patchSchema: schemas['external-links'].partial(), jsonbFields: [] },
  'attendance-rules': { table: 'attendance_rules', idPrefix: 'ar', schema: schemas['attendance-rules'], patchSchema: schemas['attendance-rules'].partial(), jsonbFields: ['appliesTo', 'defaultFor', 'flex', 'workingWeekdays'] },
  // 祝日は date 一意（重複 POST は 409）。誤登録の取り消しは物理削除（記録系ではない設定データ）
  'holidays': { table: 'public_holidays', idPrefix: 'hd', schema: schemas.holidays, patchSchema: schemas.holidays.partial(), jsonbFields: [], physicalDelete: true, noActive: true },
  // 目標マスタ（F-01 コックピット着地予報。同一 (metric, segmentId) の active 重複は後勝ち = 画面側が警告。
  // PATCH のクロスフィールド不変条件は masters.ts の goalCrossGuard（既存行とマージ）+ DB CHECK が担保
  // = workflow-routes と同型のクロスガード方式）
  'goals': { table: 'goals', idPrefix: 'g', schema: schemas.goals, patchSchema: goalBase.partial(), jsonbFields: [] },
  'workflow-routes': { table: 'workflow_routes', idPrefix: 'wr', schema: schemas['workflow-routes'], patchSchema: workflowRouteBase.partial(), jsonbFields: ['steps'] },
  'decision-themes': { table: 'decision_themes', idPrefix: 'dt', schema: schemas['decision-themes'], patchSchema: schemas['decision-themes'].partial(), jsonbFields: ['semantics', 'links', 'actions', 'options', 'scenarioParams'] },
  'ai-roles': { table: 'ai_roles', idPrefix: 'r', schema: schemas['ai-roles'], patchSchema: schemas['ai-roles'].partial(), jsonbFields: ['permissions'] },
  // status はタスク状態からの派生値（SoT: ai_tasks）。マスタ PATCH では変更させない（omit）
  'ai-employees': { table: 'ai_employees', idPrefix: 'ai', schema: schemas['ai-employees'], patchSchema: schemas['ai-employees'].partial().omit({ status: true }), jsonbFields: ['deskPosition'] },
  // ---------- Akebono 設定系マスタ（Phase B = 0031。id プレフィクスはモックシードと一致 = 互換） ----------
  'business-segments': { table: 'business_segments', idPrefix: 'seg', schema: schemas['business-segments'], patchSchema: schemas['business-segments'].partial(), jsonbFields: [] },
  'warehouses': { table: 'warehouses', idPrefix: 'wh', schema: schemas.warehouses, patchSchema: schemas.warehouses.partial(), jsonbFields: [] },
  'units': { table: 'units', idPrefix: 'unit', schema: schemas.units, patchSchema: schemas.units.partial(), jsonbFields: [] },
  'tax-rates': { table: 'tax_rates', idPrefix: 'tax', schema: schemas['tax-rates'], patchSchema: schemas['tax-rates'].partial(), jsonbFields: [] },
  'payment-terms': { table: 'payment_terms', idPrefix: 'pt', schema: schemas['payment-terms'], patchSchema: schemas['payment-terms'].partial(), jsonbFields: [] },
  'consignment-terms': { table: 'consignment_terms', idPrefix: 'ct', schema: schemas['consignment-terms'], patchSchema: schemas['consignment-terms'].partial(), jsonbFields: [] },
  'variant-axis-templates': { table: 'variant_axis_templates', idPrefix: 'vat', schema: schemas['variant-axis-templates'], patchSchema: schemas['variant-axis-templates'].partial(), jsonbFields: ['industryTypes'] },
  'product-categories': { table: 'product_categories', idPrefix: 'pcat', schema: schemas['product-categories'], patchSchema: schemas['product-categories'].partial(), jsonbFields: [] },
  // 既定シード（is_seed）は無効化不可（AKO-AKB-002 ガード = masters.ts）・isSeed は PATCH 対象外
  'product-image-sections': { table: 'product_image_sections', idPrefix: 'pis', schema: schemas['product-image-sections'], patchSchema: schemas['product-image-sections'].partial().omit({ isSeed: true }), jsonbFields: [] },
}

export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`)
}

export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())
}

/** DB 行（snake_case）→ API レスポンス（camelCase） */
export function rowToCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v
  return out
}
