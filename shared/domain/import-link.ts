/**
 * データ取込（F-32）のマスタ間連携（突合キー）＋バリアント軸取込のカタログ（純粋関数・Vue/DB 非依存）。
 *
 * - 突合キー（lookupField）: 参照項目（得意先・セグメント・SKU 等）を「参照先マスタのどの項目と
 *   突合して解決するか」の設定。マッピング行ごとに保持し、未設定（null）は従来の既定
 *   （ID → 有効行の名称完全一致 / SKU は ID → SKU コード）で解決する（下位互換 = 原則7）。
 * - バリアント軸取込（target_entity = 'product_variant'）: グルーピングキー（商品コード）で行を商品へ
 *   束ね、SKU コードをデータレコードの固有 ID、バリアント軸1/2 の値列で SKU を展開する取込対象。
 *   軸ラベル（商品の variant_axis1_label/variant_axis2_label）は axis1Value/axis2Value に割り当てた
 *   取込元列の論理名（sourceField。例: カラー/サイズ）を用いる = 「どの列が軸を成すか」の指定。
 *
 * フロント（マッピング UI の選択肢・保存前検証）と API（保存時検証・実行時の解決）が共有する
 * （原則3 = 既存パターン再利用・原則6 = 両モード parity）。
 */
import { masterImportDefOf } from './import-master'

export interface ImportRefFieldOption { value: string; label: string }

/** 参照項目（targetItemKey）の参照先マスタと突合キー候補 */
export interface ImportRefTarget {
  /** 参照先マスタの内部キー（API 側でテーブル/列へ解決。SQL へは埋め込まずカタログ経由 = 注入防止） */
  refEntity: 'segment' | 'category' | 'company' | 'tax_rate' | 'unit' | 'industry' | 'warehouse' | 'sku'
  /** 参照先マスタの表示名（UI・隔離メッセージ用） */
  refLabel: string
  /** 選択可能な突合項目（既定 = ID → 名称/コードの自動解決） */
  fields: ImportRefFieldOption[]
  /** 参照先のカスタム項目（custom.<key>）を突合キーに使えるか（custom jsonb を持つ取引先のみ） */
  allowCustom?: boolean
}

const ID_NAME: ImportRefFieldOption[] = [{ value: 'id', label: 'ID' }, { value: 'name', label: '名称' }]

const SEGMENT: ImportRefTarget = { refEntity: 'segment', refLabel: '事業セグメント', fields: ID_NAME }
const CATEGORY: ImportRefTarget = { refEntity: 'category', refLabel: '商品カテゴリ', fields: ID_NAME }
const COMPANY: ImportRefTarget = { refEntity: 'company', refLabel: '取引先', fields: ID_NAME, allowCustom: true }
const TAX_RATE: ImportRefTarget = { refEntity: 'tax_rate', refLabel: '税区分', fields: ID_NAME }
const UNIT: ImportRefTarget = { refEntity: 'unit', refLabel: '単位', fields: ID_NAME }
const INDUSTRY: ImportRefTarget = { refEntity: 'industry', refLabel: '業界', fields: ID_NAME }
const WAREHOUSE: ImportRefTarget = { refEntity: 'warehouse', refLabel: '倉庫', fields: ID_NAME }
const SKU: ImportRefTarget = {
  refEntity: 'sku', refLabel: 'SKU',
  fields: [{ value: 'id', label: 'ID' }, { value: 'code', label: 'SKUコード' }, { value: 'janCode', label: 'JANコード' }],
}

/**
 * 取込対象（targetEntity）× 対象項目（targetItemKey）→ 参照先マスタと突合キー候補。
 * ここに無い項目は参照ではない（突合キーを設定できない）。
 * master_*（共通マスタ取込 2026-08-09）も参照項目は同じ機構で突合キーを選べる。
 */
export const IMPORT_REF_TARGETS: Record<string, Record<string, ImportRefTarget>> = {
  product: { segmentId: SEGMENT, categoryId: CATEGORY, defaultSupplierCompanyId: COMPANY, taxRateId: TAX_RATE, unitId: UNIT },
  product_variant: { segmentId: SEGMENT, categoryId: CATEGORY },
  company: { industryId: INDUSTRY },
  sales_record: { companyId: COMPANY, segmentId: SEGMENT, skuId: SKU },
  inventory: { skuId: SKU, warehouseId: WAREHOUSE },
  master_warehouse: { companyId: COMPANY },
  master_category: { parentId: CATEGORY },
}

export function importRefTargetOf(targetEntity: string, itemKey: string): ImportRefTarget | null {
  return IMPORT_REF_TARGETS[targetEntity]?.[itemKey] ?? null
}

/** 突合キーが参照先マスタで使えるか（カタログ項目 or 許可されたマスタの custom.<key>） */
export function isValidLookupField(target: ImportRefTarget, lookupField: string): boolean {
  if (target.fields.some(f => f.value === lookupField)) return true
  return target.allowCustom === true && lookupField.startsWith('custom.') && lookupField.length > 'custom.'.length
}

/** 突合キーの表示名（隔離メッセージ・UI 用） */
export function lookupKeyLabel(target: ImportRefTarget, lookupField: string): string {
  const f = target.fields.find(x => x.value === lookupField)
  if (f) return f.label
  if (lookupField.startsWith('custom.')) return `カスタム項目「${lookupField.slice('custom.'.length)}」`
  return lookupField
}

// ---------- バリアント軸取込（product_variant） ----------

/**
 * バリアント軸取込の対象項目カタログ（マッピング右辺の候補 = UI と API の許容集合）。
 * productCode = グルーピングキー / code = レコード固有 ID（SKU コード）/
 * axis1Value・axis2Value = バリアント軸を成す列（列名 = 軸ラベル）。custom.* は商品カスタム項目へ。
 */
export const VARIANT_IMPORT_FIELDS: { key: string; label: string }[] = [
  { key: 'productCode', label: '商品コード（グルーピングキー）' },
  { key: 'productName', label: '商品名' },
  { key: 'segmentId', label: '事業セグメント' },
  { key: 'categoryId', label: '商品カテゴリ' },
  { key: 'listPrice', label: '標準売価' },
  { key: 'standardCost', label: '標準原価' },
  { key: 'code', label: 'SKUコード（固有ID）' },
  { key: 'janCode', label: 'JANコード' },
  { key: 'axis1Value', label: 'バリアント軸1の値（列名＝軸ラベル）' },
  { key: 'axis2Value', label: 'バリアント軸2の値（列名＝軸ラベル）' },
  { key: 'sellPrice', label: 'SKU売価' },
  { key: 'costPrice', label: 'SKU原価' },
]

/** コードポイント単位の切詰め（import-parse.capCp と同一。サロゲート境界を壊さない） */
function capCp(s: string, n: number): string {
  return [...s].slice(0, n).join('')
}

/**
 * バリアント軸ラベルの決定: axis1Value / axis2Value に割り当てた取込元列の論理名（sourceField）。
 * 未割り当ての軸は null（商品側のラベルを変更しない）。
 */
export function variantAxisLabelsOf(
  fields: { sourceField: string; targetItemKey: string }[],
): { axis1Label: string | null; axis2Label: string | null } {
  const labelOf = (key: string): string | null => {
    const f = fields.find(x => x.targetItemKey === key)
    const label = f?.sourceField.trim() ?? ''
    return label ? capCp(label, 100) : null
  }
  return { axis1Label: labelOf('axis1Value'), axis2Label: labelOf('axis2Value') }
}

/**
 * マッピング定義の保存前検証（突合キー＋バリアント軸取込の構造）。
 * 問題があればエラーメッセージ（AKO-IMP-008 で返す想定）、なければ null。
 * モック saveMapping と API POST /import-mappings が共有（両モード parity）。
 */
export function validateImportMapping(
  targetEntity: string,
  fields: { sourceField: string; targetItemKey: string; lookupField?: string | null }[],
): string | null {
  for (const f of fields) {
    const lf = f.lookupField ?? null
    if (!lf) continue
    const target = importRefTargetOf(targetEntity, f.targetItemKey)
    if (!target) return `対象項目「${f.targetItemKey}」には突合キーを設定できません（参照項目ではありません）`
    if (!isValidLookupField(target, lf)) {
      return `対象項目「${f.targetItemKey}」の突合キー「${lf}」は${target.refLabel}マスタでは使えません`
    }
  }
  // 参照項目の重複割当は全対象で禁止: 値の抽出は「最後の行」勝ちのため、行ごとに異なる突合キーを
  // 設定できると値と突合キーの組が不定になる（レビュー指摘 2026-08-07）。非参照項目は従来どおり許容
  const refCounts = new Map<string, number>()
  for (const f of fields) {
    if (importRefTargetOf(targetEntity, f.targetItemKey)) {
      refCounts.set(f.targetItemKey, (refCounts.get(f.targetItemKey) ?? 0) + 1)
    }
  }
  for (const [key, n] of refCounts) {
    if (n > 1) {
      // 他エラーと同じく和名で示す（参照先マスタ名 + 項目キー = UI の選択肢から特定可能な表記）
      const refLabel = importRefTargetOf(targetEntity, key)!.refLabel
      return `${refLabel}を参照する対象項目（${key}）が複数行に割り当てられています（1 行にしてください）`
    }
  }
  if (targetEntity === 'product_variant') {
    const keys = fields.map(f => f.targetItemKey)
    const counts = new Map<string, number>()
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
    for (const { key, label } of VARIANT_IMPORT_FIELDS) {
      if ((counts.get(key) ?? 0) > 1) return `対象項目「${label}」が複数行に割り当てられています（1 行にしてください）`
    }
    if (!keys.includes('productCode')) return '商品コード（グルーピングキー）のマッピングが必要です'
    if (!keys.includes('code')) return 'SKUコード（固有ID）のマッピングが必要です'
    if (keys.includes('axis2Value') && !keys.includes('axis1Value')) {
      return 'バリアント軸2を使う場合はバリアント軸1のマッピングが必要です'
    }
  }
  // 共通マスタ取込（master_*）: 突合キー = 名称のため name の割当が必須。同一対象項目の重複割当も禁止
  // （値の抽出は最後の行勝ちのため、重複は値が不定になる = バリアント軸取込と同じ判断）
  const masterDef = masterImportDefOf(targetEntity)
  if (masterDef) {
    const keys = fields.map(f => f.targetItemKey)
    const counts = new Map<string, number>()
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
    for (const { key, label } of masterDef.fields) {
      if ((counts.get(key) ?? 0) > 1) return `対象項目「${label}」が複数行に割り当てられています（1 行にしてください）`
    }
    if (!keys.includes('name')) return `名称（突合キー）のマッピングが必要です（${masterDef.label}は名称で照合して登録・更新します）`
  }
  return null
}
