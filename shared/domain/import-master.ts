/**
 * 共通マスタ取込（F-30 × F-32。オペレーター指示 2026-08-09 ②）のカタログ＋値解析（純粋関数・Vue/DB 非依存）。
 *
 * 共通マスタ管理（/akebono/masters）に「データ取込・連携」と同じ外部データ取込を持たせるための
 * 宣言的カタログ。取込対象（targetEntity = master_*）ごとに対象項目・DB 列・値の種別（数値/真偽/
 * 選択値/参照）を宣言し、API 側は単一の汎用反映エンジン（applyMasterEntity）がこの表を解釈する。
 * フロントはマッピング右辺（対象項目候補）とラベル表示に同じ表を使う（両モード parity = 原則6）。
 *
 * 対象外の設計判断: 委託条件（consignmentTerms）は複合キー（取引先×セグメント×ロール×適用開始日）
 * かつ精算金額に直結する設定のため、一括取込の誤設定リスクが高く対象外とする（画面から個別登録）。
 * 事業セグメントの業態アプリ表示設定（appName/appIcon 等）も画面専用（取込対象は基幹列のみ）。
 *
 * 突合（upsert）キー: 全マスタとも「有効行の名称（name）完全一致」。一致 = 更新（空セルは変更しない）・
 * 不一致 = 新規作成・同名複数 = 隔離。再実行は同じ結果に収束する（冪等 = 原則2）。
 */

export type MasterImportFieldKind = 'text' | 'number' | 'int' | 'bool' | 'enum' | 'multiEnum' | 'ref'

export interface MasterImportField {
  /** 対象項目キー（targetItemKey。camelCase = API レスポンスの項目名と一致） */
  key: string
  label: string
  /** DB 列名（snake_case。API 反映エンジンの書込先。SQL へはカタログ経由のみ = 注入防止） */
  column: string
  kind: MasterImportFieldKind
  /** 新規作成時に必須（name は常に必須のため宣言不要。更新時は空セル = 変更しない） */
  requiredOnCreate?: boolean
  /** number / int の値域 */
  min?: number
  max?: number
  /** text の最大コードポイント数（既定 200） */
  maxLen?: number
  /** enum / multiEnum: 受理値 → 内部値（内部値そのものと和名ラベルの両方を受ける） */
  enumMap?: Record<string, string>
}

export interface MasterImportDef {
  /** ImportTargetEntity 値（import_sources.target_entity） */
  entity: string
  /** 取込対象の表示名（UI・IMPORT_ENTITY_LABELS と一致させる） */
  label: string
  /** 反映先テーブル（SQL へはカタログ経由のみ = 注入防止） */
  table: string
  /** 新規行の id プレフィクス（api/src/masters/registry.ts と一致） */
  idPrefix: string
  /** 取込後に再読込するキャッシュコレクション名（useMockDb / useApi のコレクションキー） */
  collection: string
  fields: MasterImportField[]
}

const INDUSTRY_ENUM: Record<string, string> = {
  retail: 'retail', maker: 'maker', logistics: 'logistics', it_service: 'it_service', other: 'other',
  小売業: 'retail', メーカー業: 'maker', '物流・倉庫業': 'logistics', 情報サービス業: 'it_service', その他: 'other',
}

const WAREHOUSE_KIND_ENUM: Record<string, string> = {
  own: 'own', store_deposit: 'store_deposit', external: 'external',
  自社倉庫: 'own', 店舗預け: 'store_deposit', 外部委託: 'external',
}

const DISPLAY_ORDER: MasterImportField = { key: 'displayOrder', label: '表示順', column: 'display_order', kind: 'int', min: 1, max: 9999 }

/**
 * 共通マスタ取込のカタログ（SoT）。エンティティ値・項目キーは API（applyMasterEntity）と
 * フロント（マッピング右辺候補）の許容集合。項目を追加するときは対応テーブルの列・
 * api/test/unit/import-master.test.ts の対応検証も同時に更新すること。
 */
export const MASTER_IMPORT_DEFS: Record<string, MasterImportDef> = {
  master_segment: {
    entity: 'master_segment', label: 'マスタ: 事業セグメント', table: 'business_segments', idPrefix: 'seg', collection: 'businessSegments',
    fields: [
      { key: 'name', label: 'セグメント名', column: 'name', kind: 'text', maxLen: 120 },
      { key: 'industryType', label: '業種タイプ', column: 'industry_type', kind: 'enum', enumMap: INDUSTRY_ENUM, requiredOnCreate: true },
      DISPLAY_ORDER,
    ],
  },
  master_warehouse: {
    entity: 'master_warehouse', label: 'マスタ: 倉庫・保管場所', table: 'warehouses', idPrefix: 'wh', collection: 'warehouses',
    fields: [
      { key: 'name', label: '倉庫・保管場所名', column: 'name', kind: 'text', maxLen: 120 },
      { key: 'kind', label: '種別（自社倉庫/店舗預け/外部委託）', column: 'kind', kind: 'enum', enumMap: WAREHOUSE_KIND_ENUM },
      { key: 'companyId', label: '紐付く店舗（取引先）', column: 'company_id', kind: 'ref' },
      DISPLAY_ORDER,
    ],
  },
  master_category: {
    entity: 'master_category', label: 'マスタ: 商品カテゴリ', table: 'product_categories', idPrefix: 'pcat', collection: 'productCategories',
    fields: [
      { key: 'name', label: 'カテゴリ名', column: 'name', kind: 'text', maxLen: 120 },
      { key: 'parentId', label: '親カテゴリ', column: 'parent_id', kind: 'ref' },
      DISPLAY_ORDER,
    ],
  },
  master_unit: {
    entity: 'master_unit', label: 'マスタ: 単位', table: 'units', idPrefix: 'unit', collection: 'units',
    fields: [
      { key: 'name', label: '単位名', column: 'name', kind: 'text', maxLen: 60 },
      DISPLAY_ORDER,
    ],
  },
  master_tax_rate: {
    entity: 'master_tax_rate', label: 'マスタ: 税区分', table: 'tax_rates', idPrefix: 'tax', collection: 'taxRates',
    fields: [
      { key: 'name', label: '名称', column: 'name', kind: 'text', maxLen: 120 },
      { key: 'rate', label: '税率（0.10 = 10%）', column: 'rate', kind: 'number', min: 0, max: 1, requiredOnCreate: true },
      DISPLAY_ORDER,
    ],
  },
  master_payment_term: {
    entity: 'master_payment_term', label: 'マスタ: 回収・支払条件', table: 'payment_terms', idPrefix: 'pt', collection: 'paymentTerms',
    fields: [
      { key: 'name', label: '名称', column: 'name', kind: 'text', maxLen: 120 },
      { key: 'closingDay', label: '締め日（31=末日）', column: 'closing_day', kind: 'int', min: 1, max: 31, requiredOnCreate: true },
      { key: 'payMonthOffset', label: '支払月（0=当月/1=翌月）', column: 'pay_month_offset', kind: 'int', min: 0, max: 3 },
      { key: 'payDay', label: '支払日（31=末日）', column: 'pay_day', kind: 'int', min: 1, max: 31 },
    ],
  },
  master_axis_template: {
    entity: 'master_axis_template', label: 'マスタ: バリアント軸テンプレート', table: 'variant_axis_templates', idPrefix: 'vat', collection: 'variantAxisTemplates',
    fields: [
      { key: 'name', label: 'テンプレート名', column: 'name', kind: 'text', maxLen: 120 },
      { key: 'axis1Label', label: '軸1ラベル', column: 'axis1_label', kind: 'text', maxLen: 40, requiredOnCreate: true },
      { key: 'axis2Label', label: '軸2ラベル', column: 'axis2_label', kind: 'text', maxLen: 40, requiredOnCreate: true },
      { key: 'industryTypes', label: '対象業種（カンマ区切り）', column: 'industry_types', kind: 'multiEnum', enumMap: INDUSTRY_ENUM },
      DISPLAY_ORDER,
    ],
  },
  master_image_section: {
    entity: 'master_image_section', label: 'マスタ: 画像セクション', table: 'product_image_sections', idPrefix: 'pis', collection: 'productImageSections',
    fields: [
      { key: 'name', label: 'セクション名', column: 'name', kind: 'text', maxLen: 120 },
      { key: 'isThumbnailPriority', label: 'サムネイル優先（あり/なし）', column: 'is_thumbnail_priority', kind: 'bool' },
      DISPLAY_ORDER,
    ],
  },
}

/** 共通マスタ取込の取込対象キー一覧（IMPORT_ENTITIES・CHECK 制約・UI スコープが共有） */
export const MASTER_IMPORT_ENTITIES: string[] = Object.keys(MASTER_IMPORT_DEFS)

export function masterImportDefOf(targetEntity: string): MasterImportDef | null {
  return MASTER_IMPORT_DEFS[targetEntity] ?? null
}

const NUM_RE = /^-?\d+(\.\d+)?$/
const INT_RE = /^-?\d+$/

const BOOL_TRUE = new Set(['true', '1', 'はい', 'あり', 'yes', 'on', '○'])
const BOOL_FALSE = new Set(['false', '0', 'いいえ', 'なし', 'no', 'off', '×', '－', '—'])

/** コードポイント単位の切詰め（import-link.capCp と同一。サロゲート境界を壊さない） */
function capCp(s: string, n: number): string {
  return [...s].slice(0, n).join('')
}

export type MasterParsedValue = string | number | boolean | string[] | null

export type MasterParseResult =
  | { ok: true; value: MasterParsedValue }
  | { ok: false; message: string }

/**
 * セル値の解析（種別・値域の検証込み）。空セルは null（= 更新では「変更しない」・新規では未設定）。
 * ref は参照解決（API 側の突合）に委ねるため文字列のまま返す。
 */
export function parseMasterFieldValue(field: MasterImportField, raw: string): MasterParseResult {
  const v = raw.trim()
  if (v === '') return { ok: true, value: null }
  switch (field.kind) {
    case 'text':
    case 'ref':
      return { ok: true, value: capCp(v, field.maxLen ?? 200) }
    case 'number':
    case 'int': {
      if (!NUM_RE.test(v) || (field.kind === 'int' && !INT_RE.test(v))) {
        return { ok: false, message: `${field.label}「${capCp(v, 40)}」が${field.kind === 'int' ? '整数' : '数値'}でないため隔離` }
      }
      const n = Number(v)
      if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
        return { ok: false, message: `${field.label}「${capCp(v, 40)}」が範囲外（${field.min ?? '-∞'}〜${field.max ?? '∞'}）のため隔離` }
      }
      return { ok: true, value: n }
    }
    case 'bool': {
      const low = v.toLowerCase()
      if (BOOL_TRUE.has(low)) return { ok: true, value: true }
      if (BOOL_FALSE.has(low)) return { ok: true, value: false }
      return { ok: false, message: `${field.label}「${capCp(v, 40)}」を解釈できないため隔離（あり/なし・true/false）` }
    }
    case 'enum': {
      const mapped = field.enumMap?.[v]
      if (mapped === undefined) {
        return { ok: false, message: `${field.label}「${capCp(v, 40)}」を解釈できないため隔離（${[...new Set(Object.values(field.enumMap ?? {}))].join('/')}）` }
      }
      return { ok: true, value: mapped }
    }
    case 'multiEnum': {
      const parts = v.split(/[,、]/).map(s => s.trim()).filter(Boolean)
      const out: string[] = []
      for (const p of parts) {
        const mapped = field.enumMap?.[p]
        if (mapped === undefined) {
          return { ok: false, message: `${field.label}「${capCp(p, 40)}」を解釈できないため隔離（${[...new Set(Object.values(field.enumMap ?? {}))].join('/')}）` }
        }
        if (!out.includes(mapped)) out.push(mapped)
      }
      return { ok: true, value: out }
    }
  }
}
