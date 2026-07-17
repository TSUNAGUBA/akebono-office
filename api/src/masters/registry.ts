/**
 * 汎用マスタ CRUD の台帳（mockup useMasterCrud の対応物）。
 * - エンティティごとにテーブル・id プレフィックス・zod スキーマ・jsonb 列・ガードを宣言する
 * - 論理削除のみ（active=false）。例外: 関係エッジ（company/contact-relations）は物理削除可
 *   （data-design §1.1 の設計判断。削除は監査ログ必須）
 * - バリデーションは API の責務（モックでは画面側の責務だったが、公開 I/F になるためここで担保）
 */
import { z } from 'zod'

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD 形式で入力してください')
/** 空文字を null として扱う日付（画面の未入力と互換） */
const dateKeyOrNull = z.union([dateKey, z.literal(''), z.null()]).transform(v => (v ? v : null))
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, '時刻は HH:mm 形式で入力してください')

const employmentType = z.enum(['director', 'employee', 'contract', 'parttime', 'outsource'])

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
    type: z.enum(['biz_consulting', 'sys_consulting', 'development', 'operation', 'internal']).default('internal'),
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
  }),
} as const

export type MasterEntity = keyof typeof schemas

export interface MasterDef {
  table: string
  idPrefix: string
  /** 追加時の入力スキーマ */
  schema: z.ZodType
  /** 部分更新時の入力スキーマ（physicalDelete 系は更新不可のため未定義） */
  patchSchema?: z.ZodType
  /** jsonb 列（書込時に JSON.stringify が必要な camelCase フィールド名） */
  jsonbFields: string[]
  /** 物理削除可の関係エッジか（archive/restore の代わりに DELETE を許可） */
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
  'relation-types': { table: 'relation_types', idPrefix: 'rt', schema: schemas['relation-types'], patchSchema: schemas['relation-types'].partial(), jsonbFields: [] },
  'company-relations': { table: 'company_relations', idPrefix: 'cr', schema: schemas['company-relations'], jsonbFields: [], physicalDelete: true, noActive: true },
  'contact-relations': { table: 'contact_relations', idPrefix: 'pr', schema: schemas['contact-relations'], jsonbFields: [], physicalDelete: true, noActive: true },
  'projects': { table: 'projects', idPrefix: 'pj', schema: schemas.projects, patchSchema: schemas.projects.partial(), jsonbFields: ['memberIds', 'custom'] },
  'knowledge': { table: 'knowledge_articles', idPrefix: 'ka', schema: schemas.knowledge, patchSchema: schemas.knowledge.partial(), jsonbFields: ['tags'] },
  'custom-field-defs': { table: 'custom_field_defs', idPrefix: 'cf', schema: schemas['custom-field-defs'], patchSchema: schemas['custom-field-defs'].partial(), jsonbFields: ['options'] },
  'code-masters': { table: 'code_masters', idPrefix: 'cm', schema: schemas['code-masters'], patchSchema: schemas['code-masters'].partial(), jsonbFields: [] },
  'external-links': { table: 'external_links', idPrefix: 'el', schema: schemas['external-links'], patchSchema: schemas['external-links'].partial(), jsonbFields: [] },
  'attendance-rules': { table: 'attendance_rules', idPrefix: 'ar', schema: schemas['attendance-rules'], patchSchema: schemas['attendance-rules'].partial(), jsonbFields: ['appliesTo', 'defaultFor', 'flex'] },
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
