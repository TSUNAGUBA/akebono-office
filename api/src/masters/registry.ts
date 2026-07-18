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
  'members': { table: 'members', idPrefix: 'm', schema: schemas.members, patchSchema: schemas.members.partial(), jsonbFields: ['custom'] },
  'departments': { table: 'departments', idPrefix: 'dep', schema: schemas.departments, patchSchema: schemas.departments.partial(), jsonbFields: [] },
  'leave-types': { table: 'leave_types', idPrefix: 'lt', schema: schemas['leave-types'], patchSchema: schemas['leave-types'].partial().omit({ isStatutory: true }), jsonbFields: [] },
  'industries': { table: 'industries', idPrefix: 'ind', schema: schemas.industries, patchSchema: schemas.industries.partial(), jsonbFields: [] },
  'companies': { table: 'companies', idPrefix: 'c', schema: schemas.companies, patchSchema: schemas.companies.partial(), jsonbFields: ['aliases', 'industryIds', 'custom'] },
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
  'workflow-routes': { table: 'workflow_routes', idPrefix: 'wr', schema: schemas['workflow-routes'], patchSchema: workflowRouteBase.partial(), jsonbFields: ['steps'] },
  'decision-themes': { table: 'decision_themes', idPrefix: 'dt', schema: schemas['decision-themes'], patchSchema: schemas['decision-themes'].partial(), jsonbFields: ['semantics', 'links', 'actions', 'options', 'scenarioParams'] },
  'ai-roles': { table: 'ai_roles', idPrefix: 'r', schema: schemas['ai-roles'], patchSchema: schemas['ai-roles'].partial(), jsonbFields: ['permissions'] },
  // status はタスク状態からの派生値（SoT: ai_tasks）。マスタ PATCH では変更させない（omit）
  'ai-employees': { table: 'ai_employees', idPrefix: 'ai', schema: schemas['ai-employees'], patchSchema: schemas['ai-employees'].partial().omit({ status: true }), jsonbFields: ['deskPosition'] },
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
