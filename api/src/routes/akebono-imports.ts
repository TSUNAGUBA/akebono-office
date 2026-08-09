/**
 * AKEBONO データ取込・連携 API（F-32。Phase D = 0035 → 実取込 = 監査指摘 2026-07-30 ①）。
 * 取込元（import_sources = 設定系・論理削除で取消）・項目マッピング（import_mappings = 設定系/版管理・
 * 新版追記で旧版は superseded）・取込実行履歴（import_runs = 記録系・追記のみ）を永続化する。
 *
 * - 認可: 参照は認証済み全員（akebono featureGuard の配下）・**書込は管理者のみ**（取込設定は
 *   マスタ運用 = 設定画面の管理者ゲートと一致。imports 画面は管理者専用）。発行・取消は監査ログ。
 * - 取消可能性（原則9.5）: 取込元 = 論理削除 + 復元。マッピング = 新版で上書き（旧版は履歴に残る）。
 *   実行履歴 = 記録系のため訂正しない（監査性）。反映済みデータの取消は各アプリの既存フロー
 *   （商品 = 無効化 / 売上 = 赤黒訂正 / 在庫 = adjust）を使う。
 * - 取込実行（run）= **実取込**: ファイル（CSV/固定長/JSON = base64 添付）または API 接続（pull・
 *   SSRF 対策 = lib/safe-fetch）から取得 → マッピング適用（shared/domain/import-run）→ 検証 →
 *   対象テーブルへ反映（商品/SKU/取引先 = upsert・売上/在庫 = フィンガープリント冪等の追記）。
 *   エラー行は隔離して残りを反映する（原則4）。再実行は upsert / ON CONFLICT スキップで冪等（原則2）。
 * - バリアント軸取込（target_entity = 'product_variant'。2026-08-07）: グルーピングキー（商品コード）で
 *   行を商品へ束ね、SKU コード = レコード固有 ID・バリアント軸1/2 の値列（列名 = 軸ラベル）で
 *   商品＋SKU を同時に upsert する（カラー×サイズ等の 2 次元バリアント表の縦持ちデータを想定）。
 * - マスタ間連携キー（突合キー lookupField。2026-08-07）: 参照項目（得意先・セグメント・SKU 等）を
 *   参照先マスタのどの項目（ID/名称/SKU コード/JAN/取引先カスタム項目）と突合して解決するかを
 *   マッピング行ごとに設定できる（shared/domain/import-link のカタログで検証。未設定 = 従来の既定解決）。
 * - エラーコード: AKO-IMP-001（取込元名未入力）/ AKO-IMP-002（有効マッピングなし）/
 *   AKO-IMP-003（マッピング項目なし）/ AKO-IMP-004（取込内容なし・復号不可）/ AKO-IMP-005（取込元が無効）/
 *   AKO-IMP-006（行数超過）/ AKO-IMP-007（API 接続失敗）/ AKO-IMP-008（マッピング定義不備 =
 *   突合キー不正・バリアント必須項目欠落を含む。保存時と実行時の両方で検証）。台帳 = api-design §4。
 */
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import type pg from 'pg'
import { requireAdmin } from '../auth'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { runListQuery } from '../lib/list-query'
import { safeFetch } from '../lib/safe-fetch'
import { capCp } from '../lib/text'
import {
  importRefTargetOf, isValidLookupField, lookupKeyLabel, validateImportMapping, variantAxisLabelsOf,
  VARIANT_IMPORT_FIELDS, type ImportRefTarget,
} from '../../../shared/domain/import-link'
import {
  masterImportDefOf, parseMasterFieldValue, MASTER_IMPORT_ENTITIES,
  type MasterImportDef, type MasterImportField,
} from '../../../shared/domain/import-master'
import { normalizeFieldLocators, normalizeImportSourceConfig, rowsToCsv } from '../../../shared/domain/import-parse'
import {
  extractCsvRecords, extractFixedRecords, extractJsonRecords, MAX_IMPORT_ROWS,
  type ImportExtractResult, type ImportRecord, type ImportRunFieldDef,
} from '../../../shared/domain/import-run'
import type { Env } from '../env'
import { fetchSheetRows } from './sheets'
import { nextDocCode, postInventory } from './akebono-trade'

const IMPORT_METHODS = ['file_csv', 'file_fixed', 'file_json', 'api_pull', 'sheets_pull']
const IMPORT_ENTITIES = ['product', 'sku', 'company', 'sales_record', 'inventory', 'product_variant',
  ...MASTER_IMPORT_ENTITIES]

/** 事業セグメントを取込元単位で持つ取込対象（0054。列取込ではなく import_sources.segment_id を共通適用） */
const SEGMENT_SCOPED_ENTITIES = new Set(['product', 'product_variant', 'sales_record'])

const SRC_COLS = `id, name, method, encoding, target_entity AS "targetEntity", schedule, active, config,
  segment_id AS "segmentId"`
const MAP_COLS = `id, source_id AS "sourceId", version, status, fields,
  to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt"`
const RUN_COLS = `id, code, source_id AS "sourceId", mapping_version AS "mappingVersion",
  to_char(started_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "startedAt",
  to_char(finished_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "finishedAt",
  status, counts, errors`

export interface ImportFieldInput {
  id: string
  sourceField: string
  targetItemKey: string
  transform: string
  columnIndex: number | null
  byteStart: number | null
  byteEnd: number | null
  jsonKey: string | null
  /** 参照項目の突合キー（import-link カタログで検証。null = 既定の ID → 名称/コード解決） */
  lookupField: string | null
}

/**
 * マッピング項目の検証・正規化（純粋関数・単体テスト対象）。
 * sourceField / targetItemKey が空の行は捨て、残りに行 id を付与する（モック saveMapping と同じフィルタ）。
 * 方式別ロケータ（CSV 列番号 columnIndex / 固定長 byteStart-byteEnd / JSON jsonKey）は shared の
 * normalizeFieldLocators で正規化（モックと同一関数 = 両モード parity）。有効行が 0 のときは null（AKO-IMP-003）。
 */
export function importFieldsOf(mappingId: string, raw: unknown): ImportFieldInput[] | null {
  if (!Array.isArray(raw)) return null
  const out: ImportFieldInput[] = []
  for (const r of raw) {
    const o = r as Record<string, unknown> | null
    if (!o || typeof o !== 'object') continue
    const sourceField = capCp(String(o.sourceField ?? '').trim(), 120)
    const targetItemKey = capCp(String(o.targetItemKey ?? '').trim(), 120)
    if (!sourceField || !targetItemKey) continue
    out.push({
      id: `${mappingId}-f${out.length}`,
      sourceField,
      targetItemKey,
      transform: capCp(String(o.transform ?? '').trim(), 60),
      ...normalizeFieldLocators(o),
    })
  }
  return out.length > 0 ? out : null
}

/** 非管理者向けに認証情報（config.authValue）を伏せる（実値は管理者のみ受け取り編集で pre-fill 可。参照は全員だが秘匿値は最小権限） */
function maskImportSecret(row: Record<string, unknown>): Record<string, unknown> {
  const cfg = row.config as Record<string, unknown> | null
  if (cfg && typeof cfg === 'object' && cfg.authValue) return { ...row, config: { ...cfg, authValue: '' } }
  return row
}

// ---------- 実取込エンジン（監査指摘 2026-07-30 ①） ----------

/** 取込ファイル・API 応答のサイズ上限 */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024

interface RowIssue { rowNo: number; rawText: string; message: string }

interface ApplyOutcome {
  applied: number
  skipped: number
  issues: RowIssue[]
}

/** 復号（utf8 / sjis）。Shift_JIS は ICU の TextDecoder に委譲（ビルド差で不可なら明示エラー） */
export function decodeImportBytes(bytes: Buffer, encoding: string): string {
  if (encoding === 'sjis') {
    try {
      return new TextDecoder('shift_jis').decode(bytes)
    } catch {
      throw err('AKO-IMP-004', 'Shift_JIS を復号できませんでした（サーバーが Shift_JIS 非対応です。UTF-8 で保存し直してください）', 400)
    }
  }
  return bytes.toString('utf8')
}

/** 生バイトを行ごとの Uint8Array へ分割（LF 区切り・末尾 CR 除去・空行スキップ。固定長のバイト位置スライス用） */
export function splitLineBytes(bytes: Buffer): Uint8Array[] {
  const lines: Uint8Array[] = []
  let start = 0
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0A) {
      let end = i
      if (end > start && bytes[end - 1] === 0x0D) end--
      if (end > start) lines.push(bytes.subarray(start, end))
      start = i + 1
    }
  }
  return lines
}

/** 行フィンガープリント（再実行の冪等キー。source_ref / ref_line_id に使う） */
function rowFingerprint(sourceId: string, parts: (string | number)[]): string {
  const h = createHash('sha256').update(`${sourceId}|${parts.join('|')}`).digest('hex').slice(0, 32)
  return `import:${sourceId}:${h}`
}

/**
 * 行単位のセーブポイント実行。一意制約衝突等の想定外 DB エラーでラン全体（トランザクション）を
 * 失敗させず、当該行だけを隔離して残りを反映する（原則4 = エラー行隔離）
 */
async function rowWrite<T>(db: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await db.query('SAVEPOINT imp_row')
  try {
    const out = await fn()
    await db.query('RELEASE SAVEPOINT imp_row')
    return out
  } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT imp_row')
    throw e
  }
}

/** id 一致 → 有効行の name 完全一致で参照を解決（同名複数 = ambiguous は null）。lookup = id → name の有効行 */
function resolveByIdOrName(lookup: Map<string, string>, value: string): string | null {
  if (lookup.has(value)) return value
  const hits = [...lookup.entries()].filter(([, name]) => name === value)
  return hits.length === 1 ? hits[0]![0] : null
}

async function loadNameLookup(db: pg.Pool | pg.PoolClient, table: string): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM ${table} WHERE active = true`)
  return new Map(rows.map(r => [r.id, r.name]))
}

// ---------- マスタ間連携キー（突合キー lookupField。2026-08-07） ----------

/** 参照先マスタ（import-link の refEntity）→ 実テーブル。SQL への識別子はこの表経由のみ（注入防止） */
const REF_TABLES: Record<ImportRefTarget['refEntity'], string> = {
  segment: 'business_segments', category: 'product_categories', company: 'companies',
  tax_rate: 'tax_rates', unit: 'units', industry: 'industries', warehouse: 'warehouses',
  sku: 'product_skus',
}

interface RefLookup {
  resolve: (value: string) => string | null
  /** 突合キーの表示名（隔離メッセージ用）。null = 既定（ID → 名称の自動解決） */
  keyLabel: string | null
}

/**
 * マッピング項目の突合キー（lookupField）を取り出しカタログで検証する。
 * 保存時（validateImportMapping）に検証済みだが、旧版マッピングや手組みデータへの再防衛として
 * 実行時にも不正はマッピング定義エラー（AKO-IMP-008）で止める。
 */
function refLookupSpec(
  targetEntity: string, fields: ImportRunFieldDef[], itemKey: string,
): { target: ImportRefTarget; lookupField: string | null } {
  const target = importRefTargetOf(targetEntity, itemKey)
  if (!target) throw err('AKO-IMP-008', `対象項目「${itemKey}」は参照項目ではありません（内部不整合）`, 400)
  // 重複割当は保存時に拒否済みだが、旧版マッピングでは値の抽出（最後の行勝ち）と揃え最終行を採用する
  const lf = fields.findLast(f => f.targetItemKey === itemKey)?.lookupField ?? null
  if (lf && !isValidLookupField(target, lf)) {
    throw err('AKO-IMP-008', `対象項目「${itemKey}」の突合キー「${lf}」は使えません（マッピングを保存し直してください）`, 400)
  }
  return { target, lookupField: lf }
}

/**
 * 参照マスタの解決器を作る。突合キー未設定（null）は従来の既定（ID → 有効行の名称完全一致）で解決し、
 * 設定時は指定項目（id / name / custom.<key>）の有効行完全一致・一意のときのみ解決する
 * （0 件・複数一致は null = 呼び出し側で隔離）。custom キーはパラメータで渡す（注入防止）。
 */
async function refLookupOf(
  db: pg.Pool | pg.PoolClient, target: ImportRefTarget, lookupField: string | null,
): Promise<RefLookup> {
  // SKU 参照はテーブル構造が異なる（name 列なし・code/janCode）ため per-row の skuCondOf 経由のみ。
  // 誤ってここへ来たら暗黙のフォールバックで誤突合させず止める（監査指摘 2026-08-07）
  if (target.refEntity === 'sku') {
    throw err('AKO-IMP-008', 'SKU 参照はマスタ表引きでは解決できません（内部不整合）', 400)
  }
  const table = REF_TABLES[target.refEntity]
  if (!lookupField) {
    const map = await loadNameLookup(db, table)
    return { resolve: v => resolveByIdOrName(map, v), keyLabel: null }
  }
  const params: unknown[] = []
  let expr: string
  if (lookupField === 'id') {
    expr = 'id'
  } else if (lookupField === 'name') {
    expr = 'name'
  } else if (lookupField.startsWith('custom.')) {
    expr = 'custom->>$1'
    params.push(lookupField.slice('custom.'.length))
  } else {
    // カタログ検証（refLookupSpec）を通過しないキーの暗黙 id フォールバックは誤突合の温床のため遮断
    throw err('AKO-IMP-008', `突合キー「${lookupField}」は使えません（マッピングを保存し直してください）`, 400)
  }
  const { rows } = await db.query<{ id: string; v: string | null }>(
    `SELECT id, ${expr} AS v FROM ${table} WHERE active = true`, params)
  const map = new Map<string, string[]>()
  for (const r of rows) {
    if (r.v == null || r.v === '') continue
    map.set(r.v, [...(map.get(r.v) ?? []), r.id])
  }
  return {
    resolve: (v) => {
      const ids = map.get(v)
      return ids && ids.length === 1 ? ids[0]! : null
    },
    keyLabel: lookupKeyLabel(target, lookupField),
  }
}

/** 参照項目の解決器（突合キーの検証込み）。apply 系が対象項目ごとに 1 回だけ作る */
async function importRefLookup(
  db: pg.Pool | pg.PoolClient, targetEntity: string, fields: ImportRunFieldDef[], itemKey: string,
): Promise<RefLookup> {
  const { target, lookupField } = refLookupSpec(targetEntity, fields, itemKey)
  return refLookupOf(db, target, lookupField)
}

/** 参照未解決の隔離メッセージ（突合キー設定時はキー名を明示。既定は従来文言 = 下位互換） */
function unresolvedRefMsg(label: string, raw: string, lk: RefLookup): string {
  return lk.keyLabel
    ? `${label}「${raw}」を突合キー（${lk.keyLabel}）で解決できない（未登録・複数一致・無効）ため隔離`
    : `${label}「${raw}」がマスタ未登録のため隔離`
}

/** SKU 参照の突合条件（product_skus s に対する WHERE 断片。値は $1）。null = 既定（ID → 有効 SKU コード）。
 *  明示指定時は有効行のみ（refLookupOf と同じ宣言）。既定の id 素通しは従来挙動の維持（下位互換） */
function skuCondOf(lookupField: string | null): { cond: string; keyLabel: string | null } {
  switch (lookupField) {
    case 'id': return { cond: 's.id = $1 AND s.active = true', keyLabel: 'ID' }
    case 'code': return { cond: 's.code = $1 AND s.active = true', keyLabel: 'SKUコード' }
    case 'janCode': return { cond: 's.jan_code = $1 AND s.active = true', keyLabel: 'JANコード' }
    default: return { cond: '(s.id = $1 OR (s.code = $1 AND s.active = true))', keyLabel: null }
  }
}

const NUM_RE = /^-?\d+(\.\d+)?$/

/** 数値項目のパース（空 = null。非数値は undefined = 呼び出し側で隔離） */
function numOf(v: string | undefined): number | null | undefined {
  if (v === undefined || v === '') return null
  return NUM_RE.test(v) ? Number(v) : undefined
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const BILLING_TYPES: Record<string, string> = {
  one_time: 'one_time', monthly: 'monthly', usage: 'usage',
  買切: 'one_time', 月額: 'monthly', 従量: 'usage',
}

/** targetItemKey の集合検証（カタログ外キーはマッピング定義エラー = 実行前に止める） */
function assertKnownTargets(fields: ImportRunFieldDef[], known: Set<string>, allowCustom: boolean): void {
  for (const f of fields) {
    if (known.has(f.targetItemKey)) continue
    if (allowCustom && f.targetItemKey.startsWith('custom.')) continue
    throw err('AKO-IMP-008', `対象項目キー「${f.targetItemKey}」はこの取込対象で使えません（マッピングを保存し直してください）`, 400)
  }
}

/** custom.* 項目を values から抽出（カスタム項目 = jsonb custom 配下へ保存） */
function customOf(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) {
    if (k.startsWith('custom.') && v !== '') out[k.slice('custom.'.length)] = v
  }
  return out
}

/** 商品（product）: (segment, code) の upsert。既定 SKU は新規作成時のみ生成（POST /products と同型） */
async function applyProducts(
  db: pg.PoolClient, records: ImportRecord[], fields: ImportRunFieldDef[],
): Promise<ApplyOutcome> {
  assertKnownTargets(fields, new Set([
    'code', 'name', 'segmentId', 'categoryId', 'defaultSupplierCompanyId', 'listPrice', 'standardCost',
    'taxRateId', 'unitId', 'variantAxes', 'billingType', 'description',
  ]), true)
  const segments = await importRefLookup(db, 'product', fields, 'segmentId')
  const categories = await importRefLookup(db, 'product', fields, 'categoryId')
  const companies = await importRefLookup(db, 'product', fields, 'defaultSupplierCompanyId')
  const taxRates = await importRefLookup(db, 'product', fields, 'taxRateId')
  const units = await importRefLookup(db, 'product', fields, 'unitId')
  const out: ApplyOutcome = { applied: 0, skipped: 0, issues: [] }

  for (const rec of records) {
    const v = rec.values
    const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
    const code = v.code ?? ''
    const name = v.name ?? ''
    if (!code) { fail('商品コードが空のため隔離'); continue }
    const seg = v.segmentId ? segments.resolve(v.segmentId) : null
    // 参照解決（既定 = id or 有効行の名称完全一致・突合キー設定時は指定項目）。未解決は隔離
    // （マスタ整備 → 再実行で取り込める = 冪等）
    const refs: Record<string, string | null> = {}
    let refError = ''
    for (const [key, lookup, label] of [
      ['categoryId', categories, '商品カテゴリ'], ['defaultSupplierCompanyId', companies, '既定仕入先'],
      ['taxRateId', taxRates, '税区分'], ['unitId', units, '単位'],
    ] as const) {
      const raw = v[key] ?? ''
      if (raw === '') { refs[key] = null; continue }
      const id = lookup.resolve(raw)
      if (!id) { refError = unresolvedRefMsg(label, raw, lookup); break }
      refs[key] = id
    }
    if (refError) { fail(refError); continue }
    const listPrice = numOf(v.listPrice)
    const standardCost = numOf(v.standardCost)
    if (listPrice === undefined || standardCost === undefined) { fail('価格が数値でないため隔離'); continue }
    if ((listPrice !== null && (listPrice < 0 || listPrice > 1e12))
      || (standardCost !== null && (standardCost < 0 || standardCost > 1e12))) {
      fail('価格が範囲外（0〜1 兆）のため隔離')
      continue
    }
    const billingRaw = v.billingType ?? ''
    const billingType = billingRaw === '' ? null : BILLING_TYPES[billingRaw]
    if (billingType === undefined) { fail(`課金区分「${billingRaw}」を解釈できないため隔離（買切/月額/従量）`); continue }
    // バリアント軸（"カラー×サイズ" 形式 → 軸1/軸2 ラベル）
    const axes = (v.variantAxes ?? '').split(/[×x]/).map(s => s.trim()).filter(Boolean)
    const custom = customOf(v)

    const { rows: existing } = await db.query<{ id: string; custom: Record<string, unknown> }>(
      `SELECT id, custom FROM products WHERE code = $1 AND active = true
         AND ($2::text IS NULL OR segment_id = $2) ORDER BY created_at LIMIT 2`,
      [code, seg])
    if (existing.length > 1) { fail(`商品コード「${code}」が複数セグメントに存在します（セグメント列を指定してください）`); continue }
    const target = existing[0]

    if (target) {
      // 空セルは「変更しない」（取込で既存値を消さない = 部分更新の Zod v4 事故と同じ思想の防御）
      const sets: string[] = []
      const params: unknown[] = [target.id]
      const push = (col: string, val: unknown): void => { params.push(val); sets.push(`${col} = $${params.length}`) }
      if (name) push('name', capCp(name, 200))
      if (seg) push('segment_id', seg)
      if (refs.categoryId) push('category_id', refs.categoryId)
      if (refs.defaultSupplierCompanyId) push('default_supplier_company_id', refs.defaultSupplierCompanyId)
      if (refs.taxRateId) push('tax_rate_id', refs.taxRateId)
      if (refs.unitId) push('unit_id', refs.unitId)
      if (listPrice !== null) push('list_price', listPrice)
      if (standardCost !== null) push('standard_cost', standardCost)
      if (billingType) push('billing_type', billingType)
      if ((v.description ?? '') !== '') push('description', capCp(v.description!, 2000))
      if (axes.length > 0) {
        push('variant_axis1_label', axes[0] ?? null)
        push('variant_axis2_label', axes[1] ?? null)
      }
      if (Object.keys(custom).length > 0) {
        push('custom', JSON.stringify({ ...(target.custom ?? {}), ...custom }))
      }
      if (sets.length === 0) { out.skipped++; continue }
      try {
        await rowWrite(db, () => db.query(`UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params))
        out.applied++
      } catch (e) {
        fail((e as { code?: string }).code === '23505'
          ? `商品コード「${code}」が移動先セグメントと衝突するため隔離`
          : `商品「${code}」の更新に失敗したため隔離（${(e as Error).message}）`)
      }
      continue
    }

    // 新規作成（作成必須 = code・name・segmentId は POST /products と同じ）
    if (!name) { fail(`商品「${code}」は未登録のため新規作成が必要ですが商品名が空のため隔離`); continue }
    if (!seg) {
      fail(segments.keyLabel
        ? unresolvedRefMsg('事業セグメント', v.segmentId ?? '', segments)
        : `事業セグメント「${v.segmentId ?? ''}」を解決できないため隔離`)
      continue
    }
    try {
      await rowWrite(db, async () => {
        const id = newId('prd')
        await db.query(
          `INSERT INTO products (id, code, name, segment_id, category_id, default_supplier_company_id,
             list_price, standard_cost, tax_rate_id, unit_id, billing_type,
             variant_axis1_label, variant_axis2_label, description, custom)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [id, code, capCp(name, 200), seg, refs.categoryId, refs.defaultSupplierCompanyId,
            listPrice ?? 0, standardCost ?? 0, refs.taxRateId, refs.unitId, billingType,
            axes[0] ?? null, axes[1] ?? null, capCp(v.description ?? '', 2000), JSON.stringify(custom)])
        await db.query(
          `INSERT INTO product_skus (id, product_id, code, is_default) VALUES ($1, $2, $3, true)`,
          [newId('sku'), id, code])
      })
      out.applied++
    } catch (e) {
      fail(`商品「${code}」の作成に失敗したため隔離（${(e as Error).message}）`)
    }
  }
  return out
}

/** SKU（sku）: SKU コード一致の**更新のみ**（SKU の親商品はマッピングで表現できないため新規作成は対象外） */
async function applySkus(
  db: pg.PoolClient, records: ImportRecord[], fields: ImportRunFieldDef[],
): Promise<ApplyOutcome> {
  assertKnownTargets(fields, new Set(['code', 'janCode', 'axis1Value', 'axis2Value', 'sellPrice', 'costPrice']), false)
  const out: ApplyOutcome = { applied: 0, skipped: 0, issues: [] }
  for (const rec of records) {
    const v = rec.values
    const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
    const code = v.code ?? ''
    if (!code) { fail('SKU コードが空のため隔離'); continue }
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM product_skus WHERE code = $1 AND active = true LIMIT 2`, [code])
    if (rows.length === 0) { fail(`SKU コード「${code}」がマスタ未登録のため隔離（商品取込か SKU 展開で先に登録してください）`); continue }
    if (rows.length > 1) { fail(`SKU コード「${code}」が一意でないため隔離`); continue }
    const sellPrice = numOf(v.sellPrice)
    const costPrice = numOf(v.costPrice)
    if (sellPrice === undefined || costPrice === undefined) { fail('価格が数値でないため隔離'); continue }
    if ((sellPrice !== null && (sellPrice < 0 || sellPrice > 1e12))
      || (costPrice !== null && (costPrice < 0 || costPrice > 1e12))) {
      fail('価格が範囲外（0〜1 兆）のため隔離')
      continue
    }
    // 空セルは「変更しない」（既存値の意図しないクリアを防ぐ）
    const sets: string[] = []
    const params: unknown[] = [rows[0]!.id]
    const push = (col: string, val: unknown): void => { params.push(val); sets.push(`${col} = $${params.length}`) }
    if ((v.janCode ?? '') !== '') push('jan_code', v.janCode)
    if ((v.axis1Value ?? '') !== '') push('axis1_value', v.axis1Value)
    if ((v.axis2Value ?? '') !== '') push('axis2_value', v.axis2Value)
    if (sellPrice !== null) push('sell_price', sellPrice)
    if (costPrice !== null) push('cost_price', costPrice)
    if (sets.length === 0) { out.skipped++; continue }
    try {
      await rowWrite(db, () => db.query(`UPDATE product_skus SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params))
      out.applied++
    } catch (e) {
      fail(`SKU「${code}」の更新に失敗したため隔離（${(e as Error).message}）`)
    }
  }
  return out
}

/**
 * 商品＋SKU バリアント展開（product_variant。2026-08-07）: グルーピングキー（productCode）で行を商品へ
 * 束ね、SKU コード（code = レコード固有 ID）で SKU を upsert する。バリアント軸ラベルは
 * axis1Value / axis2Value に割り当てた取込元列の論理名（sourceField。例: カラー/サイズ）。
 * 新規商品は既定 SKU を作らない（実 SKU が本取込で入る）。既存商品へ実 SKU が新規追加されたら
 * 既定 SKU を無効化する（SKU マトリクス生成 POST /products/:id/skus/matrix と同一挙動）。
 * 再実行は商品・SKU とも upsert = 冪等（原則2）。商品レベルの失敗はグループ全行を隔離する。
 * 検証順序: グループ検証 → 行検証（価格・SKU 衝突）→ 商品書込 → SKU 書込。全行隔離のグループは
 * 商品を書かない = status='failed' の run はデータを変更しない（検証起因の隔離に限る。独立レビュー是正）。
 * SKU 突合は有効な実 SKU（NOT is_default）のみ = 既定 SKU コードとの衝突行は新規 SKU として作成し
 * 無効化で置き換える（更新→無効化の非冪等を防ぐ）。
 */
async function applyProductVariants(
  db: pg.PoolClient, records: ImportRecord[], fields: ImportRunFieldDef[],
): Promise<ApplyOutcome> {
  assertKnownTargets(fields, new Set(VARIANT_IMPORT_FIELDS.map(f => f.key)), true)
  // 保存時検証の再防衛（旧データ・手組みマッピングでも実行前に構造不備を止める）
  const structErr = validateImportMapping('product_variant', fields)
  if (structErr) throw err('AKO-IMP-008', structErr, 400)
  const { axis1Label, axis2Label } = variantAxisLabelsOf(fields)
  const segments = await importRefLookup(db, 'product_variant', fields, 'segmentId')
  const categories = await importRefLookup(db, 'product_variant', fields, 'categoryId')
  const out: ApplyOutcome = { applied: 0, skipped: 0, issues: [] }

  // グルーピングキー（productCode）で商品グループへ（出現順維持）。キー欠落行は先に隔離
  const groups = new Map<string, ImportRecord[]>()
  for (const rec of records) {
    const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
    if (!(rec.values.productCode ?? '')) { fail('商品コード（グルーピングキー）が空のため隔離'); continue }
    if (!(rec.values.code ?? '')) { fail('SKUコード（固有ID）が空のため隔離'); continue }
    const key = rec.values.productCode!
    groups.set(key, [...(groups.get(key) ?? []), rec])
  }

  for (const [productCode, recs] of groups) {
    const failGroup = (message: string): void => {
      for (const rec of recs) out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message })
    }
    // 商品項目はグループ先頭の非空値を採用（同一キーの行間で値が割れても先勝ち = 決定的）
    const firstOf = (key: string): string => recs.map(r => r.values[key] ?? '').find(s => s !== '') ?? ''
    const name = firstOf('productName')
    const segRaw = firstOf('segmentId')
    const seg = segRaw ? segments.resolve(segRaw) : null
    if (segRaw && !seg) { failGroup(unresolvedRefMsg('事業セグメント', segRaw, segments)); continue }
    const catRaw = firstOf('categoryId')
    const cat = catRaw ? categories.resolve(catRaw) : null
    if (catRaw && !cat) { failGroup(unresolvedRefMsg('商品カテゴリ', catRaw, categories)); continue }
    const listPrice = numOf(firstOf('listPrice'))
    const standardCost = numOf(firstOf('standardCost'))
    if (listPrice === undefined || standardCost === undefined) { failGroup('商品価格が数値でないため隔離'); continue }
    if ((listPrice !== null && (listPrice < 0 || listPrice > 1e12))
      || (standardCost !== null && (standardCost < 0 || standardCost > 1e12))) {
      failGroup('商品価格が範囲外（0〜1 兆）のため隔離')
      continue
    }
    // 商品カスタム項目（custom.*）: グループ内の先勝ちでマージ
    const custom: Record<string, string> = {}
    for (const rec of recs) {
      for (const [k, cv] of Object.entries(customOf(rec.values))) {
        if (!(k in custom)) custom[k] = cv
      }
    }

    // 商品の特定（applyProducts と同じ (segment, code) 有効行キー。書込はまだ行わない）
    const { rows: existing } = await db.query<{ id: string; custom: Record<string, unknown> }>(
      `SELECT id, custom FROM products WHERE code = $1 AND active = true
         AND ($2::text IS NULL OR segment_id = $2) ORDER BY created_at LIMIT 2`,
      [productCode, seg])
    if (existing.length > 1) { failGroup(`商品コード「${productCode}」が複数セグメントに存在します（セグメント列を指定してください）`); continue }
    let productId = existing[0]?.id ?? null

    // 新規作成の前提（code・name・segmentId 必須 = POST /products と同じ）も商品書込前に確定する
    if (!productId) {
      if (!name) { failGroup(`商品「${productCode}」は未登録のため新規作成が必要ですが商品名が空のため隔離`); continue }
      if (!seg) { failGroup('事業セグメントが空のため隔離（新規商品の作成に必須。セグメント列の割り当てと値が必要です）'); continue }
    }

    // 行レベルの事前検証（価格・SKU コード衝突）を商品書込より前に確定する:
    // 全行隔離になるグループは商品を書かず、「status=failed なのに商品が変わる」経路を作らない（監査/レビュー指摘）。
    // SKU 突合は**既定 SKU を除外**（既定 SKU のコード = 商品コードと衝突する行は実 SKU として新規作成し、
    // 既定 SKU は後段の無効化で置き換える = マトリクス生成と同じ収束。更新→無効化の非冪等を防ぐ = レビュー MAJOR）
    interface RowPlan { rec: ImportRecord; sellPrice: number | null; costPrice: number | null; skuId: string | null }
    const plans: RowPlan[] = []
    for (const rec of recs) {
      const v = rec.values
      const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
      const sellPrice = numOf(v.sellPrice)
      const costPrice = numOf(v.costPrice)
      if (sellPrice === undefined || costPrice === undefined) { fail('SKU 価格が数値でないため隔離'); continue }
      if ((sellPrice !== null && (sellPrice < 0 || sellPrice > 1e12))
        || (costPrice !== null && (costPrice < 0 || costPrice > 1e12))) {
        fail('SKU 価格が範囲外（0〜1 兆）のため隔離')
        continue
      }
      // 有効 SKU を既定も含めて取得: 別商品のヒットは既定/実を問わず隔離（誤マッピングの混線防止）。
      // 自商品の既定 SKU ヒットのみ「更新せず新規の実 SKU を作成」（後段の無効化で置き換え = 非冪等の排除）
      const { rows: skuRows } = await db.query<{ id: string; productId: string; isDefault: boolean }>(
        `SELECT id, product_id AS "productId", is_default AS "isDefault" FROM product_skus
          WHERE code = $1 AND active = true LIMIT 5`, [v.code!])
      const realHits = skuRows.filter(s => !s.isDefault)
      if (realHits.length > 1) { fail(`SKUコード「${v.code}」が一意でないため隔離`); continue }
      const hit = realHits[0] ?? null
      // 商品未登録（これから作成）のときのヒットは必ず別商品の SKU
      if (hit && (!productId || hit.productId !== productId)) { fail(`SKUコード「${v.code}」は別の商品に登録済みのため隔離`); continue }
      if (!hit && skuRows.some(s => s.isDefault && (!productId || s.productId !== productId))) {
        fail(`SKUコード「${v.code}」は別の商品に登録済みのため隔離`)
        continue
      }
      plans.push({ rec, sellPrice, costPrice, skuId: hit?.id ?? null })
    }
    if (plans.length === 0) continue // 全行隔離 = 商品も書かない
    const failPlans = (message: string): void => {
      for (const p of plans) out.issues.push({ rowNo: p.rec.rowNo, rawText: p.rec.raw, message })
    }

    // 商品の upsert（有効な行が 1 行以上あるときのみ）
    if (productId) {
      // 空セルは「変更しない」（取込で既存値を消さない）。軸ラベルはマッピングで軸を割り当てたときのみ更新
      const sets: string[] = []
      const params: unknown[] = [productId]
      const push = (col: string, val: unknown): void => { params.push(val); sets.push(`${col} = $${params.length}`) }
      if (name) push('name', capCp(name, 200))
      if (seg) push('segment_id', seg)
      if (cat) push('category_id', cat)
      if (listPrice !== null) push('list_price', listPrice)
      if (standardCost !== null) push('standard_cost', standardCost)
      if (axis1Label) push('variant_axis1_label', axis1Label)
      if (axis2Label) push('variant_axis2_label', axis2Label)
      if (Object.keys(custom).length > 0) push('custom', JSON.stringify({ ...(existing[0]!.custom ?? {}), ...custom }))
      if (sets.length > 0) {
        try {
          await rowWrite(db, () => db.query(`UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params))
        } catch (e) {
          failPlans((e as { code?: string }).code === '23505'
            ? `商品コード「${productCode}」が移動先セグメントと衝突するため隔離`
            : `商品「${productCode}」の更新に失敗したため隔離（${(e as Error).message}）`)
          continue
        }
      }
    } else {
      // 新規作成（前提は検証済み）。既定 SKU は作らない（実 SKU が本取込で入る）
      try {
        productId = await rowWrite(db, async () => {
          const id = newId('prd')
          await db.query(
            `INSERT INTO products (id, code, name, segment_id, category_id, list_price, standard_cost,
               variant_axis1_label, variant_axis2_label, custom)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [id, productCode, capCp(name, 200), seg, cat, listPrice ?? 0, standardCost ?? 0,
              axis1Label, axis2Label, JSON.stringify(custom)])
          return id
        })
      } catch (e) {
        failPlans(`商品「${productCode}」の作成に失敗したため隔離（${(e as Error).message}）`)
        continue
      }
    }

    // SKU の upsert（code = レコード固有 ID の有効な実 SKU 一致。既定 SKU は対象外）
    let createdSkus = 0
    /** グループ内の同一 SKU コード行: 2 行目以降は 1 行目の INSERT 結果への更新に収束させる */
    const insertedByCode = new Map<string, string>()
    for (const { rec, sellPrice, costPrice, skuId } of plans) {
      const v = rec.values
      const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
      const skuCode = v.code!
      const effectiveId = skuId ?? insertedByCode.get(skuCode) ?? null
      if (effectiveId) {
        // 空セルは「変更しない」（既存値の意図しないクリアを防ぐ = applySkus と同じ）
        const sets: string[] = []
        const params: unknown[] = [effectiveId]
        const push = (col: string, val: unknown): void => { params.push(val); sets.push(`${col} = $${params.length}`) }
        if ((v.janCode ?? '') !== '') push('jan_code', capCp(v.janCode!, 100))
        if ((v.axis1Value ?? '') !== '') push('axis1_value', capCp(v.axis1Value!, 100))
        if ((v.axis2Value ?? '') !== '') push('axis2_value', capCp(v.axis2Value!, 100))
        if (sellPrice !== null) push('sell_price', sellPrice)
        if (costPrice !== null) push('cost_price', costPrice)
        if (sets.length === 0) { out.skipped++; continue }
        try {
          await rowWrite(db, () => db.query(`UPDATE product_skus SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params))
          out.applied++
        } catch (e) {
          fail(`SKU「${skuCode}」の更新に失敗したため隔離（${(e as Error).message}）`)
        }
        continue
      }
      try {
        const newSkuId = newId('sku')
        await rowWrite(db, () => db.query(
          `INSERT INTO product_skus (id, product_id, code, jan_code, axis1_value, axis2_value, sell_price, cost_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [newSkuId, productId, skuCode,
            (v.janCode ?? '') !== '' ? capCp(v.janCode!, 100) : null,
            (v.axis1Value ?? '') !== '' ? capCp(v.axis1Value!, 100) : null,
            (v.axis2Value ?? '') !== '' ? capCp(v.axis2Value!, 100) : null,
            sellPrice, costPrice]))
        insertedByCode.set(skuCode, newSkuId)
        createdSkus++
        out.applied++
      } catch (e) {
        fail(`SKU「${skuCode}」の作成に失敗したため隔離（${(e as Error).message}）`)
      }
    }

    // 実 SKU が新規に入った商品は既定 SKU を無効化（SKU マトリクス生成と同一挙動 = 展開ありへ移行）。
    // 補助処理のため失敗しても反映済み行は取り消さない（原則4）
    if (createdSkus > 0) {
      try {
        await rowWrite(db, () => db.query(
          `UPDATE product_skus SET active = false, updated_at = now() WHERE product_id = $1 AND is_default AND active`,
          [productId]))
      } catch { /* 既定 SKU の無効化失敗は無視（再実行・SKU 画面から回復可能） */ }
    }
  }
  return out
}

/** 取引先（company）: 有効行の会社名完全一致の upsert（同名複数 = 隔離） */
async function applyCompanies(
  db: pg.PoolClient, records: ImportRecord[], fields: ImportRunFieldDef[],
): Promise<ApplyOutcome> {
  assertKnownTargets(fields, new Set(['name', 'kind', 'industryId', 'size', 'location', 'description']), true)
  const industries = await importRefLookup(db, 'company', fields, 'industryId')
  const out: ApplyOutcome = { applied: 0, skipped: 0, issues: [] }
  for (const rec of records) {
    const v = rec.values
    const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
    const name = v.name ?? ''
    if (!name) { fail('会社名が空のため隔離'); continue }
    const kindRaw = v.kind ?? ''
    const kind = kindRaw === '' ? null : (kindRaw === 'self' || kindRaw === '自社' ? 'self' : kindRaw === 'customer' || kindRaw === '顧客' ? 'customer' : undefined)
    if (kind === undefined) { fail(`区分「${kindRaw}」を解釈できないため隔離（self/customer）`); continue }
    const industryRaw = v.industryId ?? ''
    const industryId = industryRaw === '' ? null : industries.resolve(industryRaw)
    if (industryRaw !== '' && !industryId) { fail(unresolvedRefMsg('業界', industryRaw, industries)); continue }
    const custom = customOf(v)
    const { rows } = await db.query<{ id: string; industryIds: string[]; custom: Record<string, unknown> }>(
      `SELECT id, industry_ids AS "industryIds", custom FROM companies WHERE name = $1 AND active = true LIMIT 2`, [name])
    if (rows.length > 1) { fail(`会社名「${name}」が一意でないため隔離`); continue }
    const target = rows[0]
    if (target) {
      const sets: string[] = []
      const params: unknown[] = [target.id]
      const push = (col: string, val: unknown): void => { params.push(val); sets.push(`${col} = $${params.length}`) }
      if (kind) push('kind', kind)
      if (industryId) {
        push('primary_industry_id', industryId)
        const ids = Array.isArray(target.industryIds) ? target.industryIds : []
        push('industry_ids', JSON.stringify(ids.includes(industryId) ? ids : [...ids, industryId]))
      }
      if (v.size !== undefined && v.size !== '') push('size', capCp(v.size, 100))
      if (v.location !== undefined && v.location !== '') push('location', capCp(v.location, 200))
      if (v.description !== undefined && v.description !== '') push('description', capCp(v.description, 2000))
      if (Object.keys(custom).length > 0) push('custom', JSON.stringify({ ...(target.custom ?? {}), ...custom }))
      if (sets.length === 0) { out.skipped++; continue }
      try {
        await rowWrite(db, () => db.query(`UPDATE companies SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params))
        out.applied++
      } catch (e) {
        fail(`会社「${name}」の更新に失敗したため隔離（${(e as Error).message}）`)
      }
      continue
    }
    try {
      await rowWrite(db, () => db.query(
        `INSERT INTO companies (id, kind, name, industry_ids, primary_industry_id, size, location, description, custom)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [newId('c'), kind ?? 'customer', capCp(name, 200), JSON.stringify(industryId ? [industryId] : []),
          industryId ?? '', capCp(v.size ?? '', 100), capCp(v.location ?? '', 200),
          capCp(v.description ?? '', 2000), JSON.stringify(custom)]))
      out.applied++
    } catch (e) {
      fail(`会社「${name}」の作成に失敗したため隔離（${(e as Error).message}）`)
    }
  }
  return out
}

/** 売上明細（sales_record）: フィンガープリント冪等の追記（source_kind='import'。再実行 = skipped） */
async function applySalesRecords(
  db: pg.PoolClient, sourceId: string, records: ImportRecord[], fields: ImportRunFieldDef[],
): Promise<ApplyOutcome> {
  assertKnownTargets(fields, new Set(['salesDate', 'companyId', 'segmentId', 'skuId', 'qty', 'unitPrice', 'channel']), true)
  const segments = await importRefLookup(db, 'sales_record', fields, 'segmentId')
  const companies = await importRefLookup(db, 'sales_record', fields, 'companyId')
  const skuCond = skuCondOf(refLookupSpec('sales_record', fields, 'skuId').lookupField)
  /** ファイル内の同一内容行の出現序数（フィンガープリントの一部 = MINOR-7 対応） */
  const seen = new Map<string, number>()
  const out: ApplyOutcome = { applied: 0, skipped: 0, issues: [] }
  for (const rec of records) {
    const v = rec.values
    const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
    const salesDate = v.salesDate ?? ''
    if (!DATE_RE.test(salesDate)) { fail(`売上日「${salesDate}」が YYYY-MM-DD でないため隔離（変換に date を指定できます）`); continue }
    const companyId = v.companyId ? companies.resolve(v.companyId) : null
    if (!companyId) { fail(unresolvedRefMsg('得意先', v.companyId ?? '', companies)); continue }
    const segmentId = v.segmentId ? segments.resolve(v.segmentId) : null
    if (!segmentId) { fail(unresolvedRefMsg('事業セグメント', v.segmentId ?? '', segments)); continue }
    // SKU の突合（既定 = id → 有効 SKU コードの順。突合キー設定時は指定項目のみで解決）
    const skuRaw = v.skuId ?? ''
    const { rows: skuRows } = await db.query<{ id: string; costPrice: number | null; stdCost: number | null; billingType: string | null }>(
      `SELECT s.id, s.cost_price AS "costPrice", p.standard_cost AS "stdCost", p.billing_type AS "billingType"
       FROM product_skus s LEFT JOIN products p ON p.id = s.product_id
       WHERE ${skuCond.cond} LIMIT 2`, [skuRaw])
    if (skuRows.length === 0) {
      fail(skuCond.keyLabel
        ? `SKU「${skuRaw}」を突合キー（${skuCond.keyLabel}）で解決できないため隔離`
        : `SKU「${skuRaw}」がマスタ未登録のため隔離`)
      continue
    }
    if (skuRows.length > 1) { fail(`SKU「${skuRaw}」が一意でないため隔離`); continue }
    const sku = skuRows[0]!
    const qty = Number(v.qty)
    const unitPrice = Number(v.unitPrice)
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1_000_000) { fail(`数量「${v.qty ?? ''}」が正の整数でないため隔離`); continue }
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1e12) { fail(`単価「${v.unitPrice ?? ''}」が数値でないため隔離`); continue }
    // 金額の列上限（numeric(14,2)）を超える行は DB エラーでなく検証で隔離する（レビュー M-2）
    if (Math.round(qty * unitPrice) > 999_999_999_999) { fail('金額（数量 × 単価）が上限（1 兆円未満）を超えるため隔離'); continue }
    const channel = v.channel ? capCp(v.channel, 100) : null
    // 同一ファイル内の正当な同一内容行（同日・同 SKU・同数量…の複数行）を黙って収束させないよう、
    // ファイル内の出現序数をフィンガープリントへ含める（同一ファイルの再実行では序数も再現される = 冪等維持）
    const contentKey = [salesDate, companyId, segmentId, sku.id, qty, unitPrice, channel ?? ''].join('|')
    const ordinal = seen.get(contentKey) ?? 0
    seen.set(contentKey, ordinal + 1)
    const sourceRef = rowFingerprint(sourceId, [contentKey, ordinal])
    try {
      const rowCount = await rowWrite(db, async () => {
        const code = await nextDocCode(db, 'SR')
        const { rowCount: n } = await db.query(
          `INSERT INTO sales_records (id, code, sales_date, company_id, segment_id, sku_id, qty, unit_price, amount,
             cost_price, channel, billing_type, source_kind, source_ref, custom)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'import', $13, $14)
           ON CONFLICT (source_ref) WHERE source_kind = 'import' AND source_ref IS NOT NULL DO NOTHING`,
          [newId('sr'), code, salesDate, companyId, segmentId, sku.id, qty, unitPrice, Math.round(qty * unitPrice),
            sku.costPrice ?? sku.stdCost ?? null, channel, sku.billingType, sourceRef, JSON.stringify(customOf(v))])
        return n ?? 0
      })
      if (rowCount === 0) out.skipped++ // 同一内容行の再取込（冪等 = 原則2）
      else out.applied++
    } catch (e) {
      fail(`売上明細の登録に失敗したため隔離（${(e as Error).message}）`)
    }
  }
  return out
}

/** 在庫トランザクション（inventory）: adjust / stocktake のみ受理し台帳へ冪等追記 */
async function applyInventory(
  db: pg.PoolClient, sourceId: string, records: ImportRecord[], fields: ImportRunFieldDef[],
): Promise<ApplyOutcome> {
  assertKnownTargets(fields, new Set(['skuId', 'warehouseId', 'qty', 'kind', 'reason', 'occurredAt']), false)
  const warehouses = await importRefLookup(db, 'inventory', fields, 'warehouseId')
  const skuCond = skuCondOf(refLookupSpec('inventory', fields, 'skuId').lookupField)
  const KIND_MAP: Record<string, string> = { adjust: 'adjust', stocktake: 'stocktake', 調整: 'adjust', 棚卸: 'stocktake' }
  const REASONS = new Set(['defective', 'lost', 'found', 'sample', 'stocktake', 'other'])
  const out: ApplyOutcome = { applied: 0, skipped: 0, issues: [] }
  for (const rec of records) {
    const v = rec.values
    const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
    const skuRaw = v.skuId ?? ''
    const { rows: skuRows } = await db.query<{ id: string }>(
      `SELECT s.id FROM product_skus s WHERE ${skuCond.cond} LIMIT 2`, [skuRaw])
    if (skuRows.length !== 1) {
      fail(`SKU「${skuRaw}」を特定できない${skuCond.keyLabel ? `（突合キー: ${skuCond.keyLabel}）` : ''}ため隔離`)
      continue
    }
    const warehouseId = v.warehouseId ? warehouses.resolve(v.warehouseId) : null
    if (!warehouseId) { fail(unresolvedRefMsg('倉庫', v.warehouseId ?? '', warehouses)); continue }
    const qty = Number(v.qty)
    if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 1_000_000) { fail(`増減数「${v.qty ?? ''}」が 0 以外の整数でないため隔離`); continue }
    const kind = KIND_MAP[v.kind ?? '']
    if (!kind) { fail(`区分「${v.kind ?? ''}」は取込で使えません（adjust=調整 / stocktake=棚卸のみ）`); continue }
    const reason = v.reason && REASONS.has(v.reason) ? v.reason : kind === 'stocktake' ? 'stocktake' : 'other'
    // 発生日は YYYY-MM-DD のみ受理（不正文字列を timestamptz へ流すとトランザクション全体が壊れる = 隔離）
    const dateRaw = v.occurredAt ?? ''
    if (dateRaw !== '' && !DATE_RE.test(dateRaw)) {
      fail(`発生日「${dateRaw}」が YYYY-MM-DD でないため隔離（変換に date を指定できます）`)
      continue
    }
    const occurredAt = dateRaw ? `${dateRaw}T00:00:00+09:00` : undefined
    const refLineId = rowFingerprint(sourceId, [skuRows[0]!.id, warehouseId, qty, kind, dateRaw])
    try {
      const added = await rowWrite(db, () => postInventory(db, [{
        skuId: skuRows[0]!.id, warehouseId, qty, kind, reason,
        refType: 'import', refLineId, occurredAt,
      }]))
      if (added === 0) out.skipped++ // 同一内容行の再取込（UNIQUE(ref_type, ref_line_id, kind) = 冪等）
      else out.applied++
    } catch (e) {
      fail(`在庫トランザクションの登録に失敗したため隔離（${(e as Error).message}）`)
    }
  }
  return out
}

/**
 * 共通マスタ取込（master_*。0054）: 名称（name）完全一致の upsert。
 * カタログ（shared/domain/import-master）の宣言に従い、種別・値域を検証して隔離し、健全行のみ反映する。
 * 一致 = 更新（空セルは変更しない = 既存値を消さない）・不一致 = 新規作成・同名複数 = 隔離。
 * 参照項目（ref。倉庫の店舗・カテゴリの親）は突合キー機構で解決する（未解決は隔離）。
 * 再実行は同じ結果へ収束（冪等 = 原則2）。委託条件は対象外（カタログの設計判断）。
 */
async function applyMasterEntity(
  db: pg.PoolClient, def: MasterImportDef, records: ImportRecord[], fields: ImportRunFieldDef[],
): Promise<ApplyOutcome> {
  const known = new Set(def.fields.map(f => f.key))
  assertKnownTargets(fields, known, false)
  // 保存時検証の再防衛（旧データ・手組みマッピングでも実行前に構造不備 = name 未割当等を止める）
  const structErr = validateImportMapping(def.entity, fields)
  if (structErr) throw err('AKO-IMP-008', structErr, 400)
  const fieldByKey = new Map(def.fields.map(f => [f.key, f]))
  // 参照項目（ref）の解決器を対象項目ごとに 1 度だけ作る（突合キーの検証込み = importRefLookup）
  const refLookups = new Map<string, RefLookup>()
  for (const f of def.fields) {
    if (f.kind === 'ref' && fields.some(x => x.targetItemKey === f.key)) {
      refLookups.set(f.key, await importRefLookup(db, def.entity, fields, f.key))
    }
  }
  const out: ApplyOutcome = { applied: 0, skipped: 0, issues: [] }
  for (const rec of records) {
    const v = rec.values
    const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
    // name はカタログの maxLen で切詰め（他項目は parseMasterFieldValue で cap 済み・他エンティティの name と一貫）
    const name = capCp((v.name ?? '').trim(), fieldByKey.get('name')?.maxLen ?? 120)
    if (!name) { fail('名称が空のため隔離'); continue }

    // 各対象項目を解析（種別・値域の検証。ref は突合解決）。1 つでも失敗すれば行ごと隔離
    const cols: { column: string; value: unknown; kind: MasterImportField['kind'] }[] = []
    let rowError = ''
    for (const [key, raw] of Object.entries(v)) {
      if (key === 'name') continue
      const field = fieldByKey.get(key)
      if (!field) continue // assertKnownTargets 済みのため通常起きない（防御）
      if (field.kind === 'ref') {
        if ((raw ?? '') === '') { cols.push({ column: field.column, value: null, kind: 'ref' }); continue }
        const lk = refLookups.get(key)!
        const id = lk.resolve(raw)
        if (!id) { rowError = unresolvedRefMsg(field.label, raw, lk); break }
        cols.push({ column: field.column, value: id, kind: 'ref' })
        continue
      }
      const parsed = parseMasterFieldValue(field, raw)
      if (!parsed.ok) { rowError = parsed.message; break }
      cols.push({ column: field.column, value: parsed.value, kind: field.kind })
    }
    if (rowError) { fail(rowError); continue }

    // 新規作成の必須（requiredOnCreate）チェックは対象行が新規のときのみ（後述）
    const { rows: existing } = await db.query<{ id: string }>(
      `SELECT id FROM ${def.table} WHERE name = $1 AND active = true ORDER BY created_at LIMIT 2`, [name])
    if (existing.length > 1) { fail(`名称「${name}」が一意でないため隔離`); continue }
    const target = existing[0]

    const jsonbCols = new Set(def.fields.filter(f => f.kind === 'multiEnum').map(f => f.column))
    const encode = (c: { column: string; value: unknown }): unknown =>
      jsonbCols.has(c.column) ? JSON.stringify(c.value) : c.value

    if (target) {
      // 空セル（null）は「変更しない」（取込で既存値を消さない = 部分更新の思想）
      const sets: string[] = []
      const params: unknown[] = [target.id]
      for (const c of cols) {
        if (c.value === null) continue
        params.push(encode(c))
        sets.push(`${c.column} = $${params.length}`)
      }
      if (sets.length === 0) { out.skipped++; continue }
      try {
        await rowWrite(db, () => db.query(`UPDATE ${def.table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params))
        out.applied++
      } catch (e) {
        fail(`「${name}」の更新に失敗したため隔離（${(e as Error).message}）`)
      }
      continue
    }

    // 新規作成: requiredOnCreate の欠落を隔離（name は上で担保済み）
    const missing = def.fields.find(f => f.requiredOnCreate && !cols.some(c => c.column === f.column && c.value !== null))
    if (missing) { fail(`「${name}」は新規のため「${missing.label}」が必要ですが空のため隔離`); continue }
    const insertCols = ['id', 'name', ...cols.filter(c => c.value !== null).map(c => c.column)]
    const insertVals: unknown[] = [newId(def.idPrefix), name, ...cols.filter(c => c.value !== null).map(encode)]
    const placeholders = insertVals.map((_, i) => `$${i + 1}`)
    try {
      await rowWrite(db, () => db.query(
        `INSERT INTO ${def.table} (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})`, insertVals))
      out.applied++
    } catch (e) {
      fail(`「${name}」の作成に失敗したため隔離（${(e as Error).message}）`)
    }
  }
  return out
}

/**
 * 取込元の事業セグメント（0054）を正規化・検証する。
 * - 空/未指定 → null（従来のマッピング列解決へフォールバック）
 * - セグメントを持たない取込対象（在庫・取引先・master_* 等）→ 常に null（無関係な値を保存しない）
 * - 指定時は有効な事業セグメントのみ受理（不正 id は AKO-IMP-009）
 */
async function normalizeSourceSegment(
  db: pg.Pool | pg.PoolClient, targetEntity: string, raw: unknown,
): Promise<string | null> {
  const segmentId = String(raw ?? '').trim()
  if (!segmentId || !SEGMENT_SCOPED_ENTITIES.has(targetEntity)) return null
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM business_segments WHERE id = $1 AND active = true`, [segmentId])
  if (rows.length === 0) throw err('AKO-IMP-009', '選択した事業セグメントが見つかりません（有効なセグメントを選択してください）', 400)
  return segmentId
}

async function requireSource(db: pg.Pool | pg.PoolClient, id: string): Promise<{ targetEntity: string }> {
  const { rows } = await db.query<{ targetEntity: string }>(
    `SELECT target_entity AS "targetEntity" FROM import_sources WHERE id = $1`, [id])
  if (rows.length === 0) throw err('AKO-GEN-002', '取込元が見つかりません', 404)
  return rows[0]!
}

export function akebonoImportsRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // ---------- 参照（全員可。書込判定はメニューの管理者ゲートに任せ、ハイドレーションを妨げない） ----------

  app.get('/import-sources', async (c) => {
    const user = c.get('user')
    const { rows } = await pool.query(`SELECT ${SRC_COLS} FROM import_sources ORDER BY created_at DESC, id LIMIT 2000`)
    // 認証情報は管理者のみ実値を返す（非管理者はマスク = 最小権限。編集は管理者専用画面）
    return c.json({ data: user.role === 'admin' ? rows : rows.map(maskImportSecret) })
  })

  app.get('/import-mappings', async (c) => {
    const { rows } = await pool.query(`SELECT ${MAP_COLS} FROM import_mappings ORDER BY source_id, version DESC LIMIT 5000`)
    return c.json({ data: rows })
  })

  app.get('/import-runs', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'import_runs', cols: RUN_COLS, orderBy: 'started_at DESC, id', maxLimit: 5000,
      searchCols: ['code', 'status', 'started_at::text'],
    }))
  })

  // ---------- 取込元（設定系・CRUD・論理削除で取消 = 原則9.5） ----------

  app.post('/import-sources', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const name = capCp(String(body.name ?? '').trim(), 120)
    if (!name) throw err('AKO-IMP-001', '取込元名は必須です', 400)
    const method = IMPORT_METHODS.includes(String(body.method)) ? String(body.method) : 'file_csv'
    const encoding = String(body.encoding) === 'sjis' ? 'sjis' : 'utf8'
    const targetEntity = IMPORT_ENTITIES.includes(String(body.targetEntity)) ? String(body.targetEntity) : 'product'
    const config = normalizeImportSourceConfig(body.config, method)
    // 事業セグメントは取込元単位（0054）。セグメントを持つ取込対象のみ保存し、有効なセグメントのみ受理
    const segmentId = await normalizeSourceSegment(pool, targetEntity, body.segmentId)
    const id = newId('imp')
    const { rows } = await pool.query(
      `INSERT INTO import_sources (id, name, method, encoding, target_entity, config, segment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${SRC_COLS}`,
      [id, name, method, encoding, targetEntity, JSON.stringify(config), segmentId])
    await audit(pool, { actorId: user.id, action: 'create', entity: 'import_sources', entityId: id, detail: `取込元を登録（${name}）` })
    return c.json({ data: rows[0] }, 201)
  })

  // 方式別設定の更新（エンドポイント/トークン・CSV ヘッダ有無等の編集。method は method に応じて正規化）
  app.put('/import-sources/:id/config', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const { rows: srows } = await pool.query<{ method: string; targetEntity: string }>(
      `SELECT method, target_entity AS "targetEntity" FROM import_sources WHERE id = $1`, [id])
    if (srows.length === 0) throw err('AKO-GEN-002', '取込元が見つかりません', 404)
    const config = normalizeImportSourceConfig(body.config, srows[0]!.method)
    // 事業セグメントの変更（0054）: body に segmentId があるときのみ更新。無ければ現状維持（部分更新）
    const hasSegment = Object.hasOwn(body, 'segmentId')
    const segmentId = hasSegment ? await normalizeSourceSegment(pool, srows[0]!.targetEntity, body.segmentId) : null
    const { rows } = await pool.query(
      `UPDATE import_sources SET config = $2${hasSegment ? ', segment_id = $3' : ''}, updated_at = now()
       WHERE id = $1 RETURNING ${SRC_COLS}`,
      hasSegment ? [id, JSON.stringify(config), segmentId] : [id, JSON.stringify(config)])
    // 変更キー名のみ記録（秘匿値は残さない = 監査性と最小権限の両立。config は設定系のため上書き = §45-4）
    await audit(pool, { actorId: user.id, action: 'update', entity: 'import_sources', entityId: id, detail: `取込元の方式別設定を更新（${Object.keys(config).join(', ') || '設定なし'}${hasSegment ? '・事業セグメント' : ''}）` })
    return c.json({ data: rows[0] })
  })

  // 論理削除（取消）と復元（原則9.5。media_articles の archive/restore と同型）
  for (const [action, active] of [['archive', false], ['restore', true]] as const) {
    app.post(`/import-sources/:id/${action}`, async (c) => {
      const user = requireAdmin(c)
      const id = c.req.param('id')
      const { rows } = await pool.query(
        `UPDATE import_sources SET active = $2, updated_at = now() WHERE id = $1 RETURNING ${SRC_COLS}`, [id, active])
      if (rows.length === 0) throw err('AKO-GEN-002', '取込元が見つかりません', 404)
      await audit(pool, { actorId: user.id, action: 'update', entity: 'import_sources', entityId: id, detail: active ? '取込元を復元' : '取込元を無効化' })
      return c.json({ data: rows[0] })
    })
  }

  // ---------- 項目マッピング（設定系/版管理・新版追記で旧版は superseded） ----------

  app.post('/import-mappings', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const sourceId = String(body.sourceId ?? '').trim()
    if (!sourceId) throw err('AKO-GEN-001', '取込元を指定してください', 400)
    const source = await requireSource(pool, sourceId)
    const id = newId('impm')
    const fields = importFieldsOf(id, body.fields)
    if (!fields) throw err('AKO-IMP-003', '取込元項目と対象項目キーを 1 行以上入力してください', 400)
    // 突合キー・バリアント軸取込の構造検証（モック saveMapping と同一の共有関数 = 両モード parity）
    const mapErr = validateImportMapping(source.targetEntity, fields)
    if (mapErr) throw err('AKO-IMP-008', mapErr, 400)
    const created = await inTxn(pool, async (db) => {
      // 版番号の採番を直列化（並行 saveMapping の同一 version 二重採番 = 部分一意 INDEX 衝突を防ぐ = C-1 と同思想）
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`impmap:${sourceId}`])
      const { rows: vrows } = await db.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) AS version FROM import_mappings WHERE source_id = $1`, [sourceId])
      const nextVersion = vrows[0]!.version + 1
      // 旧 active を superseded へ（部分一意 INDEX に触れないよう新版 INSERT の前に更新する）
      await db.query(
        `UPDATE import_mappings SET status = 'superseded' WHERE source_id = $1 AND status = 'active'`, [sourceId])
      const { rows } = await db.query(
        `INSERT INTO import_mappings (id, source_id, version, status, fields)
         VALUES ($1, $2, $3, 'active', $4) RETURNING ${MAP_COLS}`,
        [id, sourceId, nextVersion, JSON.stringify(fields)])
      return rows[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'import_mappings', entityId: id, detail: '取込マッピングを保存（新版）' })
    return c.json({ data: created }, 201)
  })

  // ---------- 取込実行（記録系・追記。実取込 = 監査指摘 2026-07-30 ①） ----------

  app.post('/import-runs', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const sourceId = String(body.sourceId ?? '').trim()
    if (!sourceId) throw err('AKO-GEN-001', '取込元を指定してください', 400)
    const { rows: srcRows } = await pool.query<{
      method: string; encoding: string; targetEntity: string; active: boolean
      config: Record<string, unknown> | null; segmentId: string | null
    }>(
      `SELECT method, encoding, target_entity AS "targetEntity", active, config, segment_id AS "segmentId"
       FROM import_sources WHERE id = $1`,
      [sourceId])
    const source = srcRows[0]
    if (!source) throw err('AKO-GEN-002', '取込元が見つかりません', 404)
    if (!source.active) throw err('AKO-IMP-005', '無効化された取込元では実行できません（復元してから実行してください）', 409)
    const { rows: mrows } = await pool.query<{ version: number; fields: ImportRunFieldDef[] }>(
      `SELECT version, fields FROM import_mappings WHERE source_id = $1 AND status = 'active'`, [sourceId])
    if (mrows.length === 0) {
      throw err('AKO-IMP-002', '有効なマッピング定義がありません（先にマッピングを保存してください）', 409)
    }
    const mapping = mrows[0]!
    const cfg = source.config ?? {}

    // 1) 取込内容の取得（ファイル添付 or API pull = SSRF ガード付き）
    let bytes: Buffer
    if (source.method === 'api_pull') {
      const endpoint = String(cfg.endpoint ?? '').trim()
      if (!endpoint) throw err('AKO-IMP-007', 'API エンドポイントが未設定です（マッピング設定から登録してください）', 409)
      const headers: Record<string, string> = { accept: 'application/json' }
      const authValue = String(cfg.authValue ?? '')
      if (cfg.authType === 'bearer' && authValue) headers.authorization = `Bearer ${authValue}`
      if (cfg.authType === 'api_key' && authValue) headers['x-api-key'] = authValue
      if (cfg.authType === 'basic' && authValue) headers.authorization = `Basic ${Buffer.from(authValue).toString('base64')}`
      let res: { status: number; body: Buffer }
      try {
        res = await safeFetch(endpoint, { headers, maxBytes: MAX_IMPORT_BYTES })
      } catch (e) {
        throw err('AKO-IMP-007', `API 接続に失敗しました: ${(e as Error).message}`, 502)
      }
      if (res.status < 200 || res.status >= 300) {
        throw err('AKO-IMP-007', `API 接続に失敗しました（HTTP ${res.status}）。エンドポイント・認証設定をご確認ください`, 502)
      }
      bytes = res.body
    } else if (source.method === 'sheets_pull') {
      // Google スプレッドシートの指定範囲（開始行/列）を読み取り CSV 化 → 既存 CSV 抽出へ流す（2026-08-03）。
      // fetchSheetRows は未連携・対象未設定・API 失敗を AKO-SHEETS-* で投げる（非該当なら伝播）
      const rows = await fetchSheetRows(pool, env, cfg)
      bytes = Buffer.from(rowsToCsv(rows), 'utf8')
    } else {
      const contentBase64 = String(body.contentBase64 ?? '')
      if (!contentBase64) throw err('AKO-IMP-004', '取込ファイルを添付してください', 400)
      if (contentBase64.length > MAX_IMPORT_BYTES * 1.4) {
        throw err('AKO-IMP-004', 'ファイルが大きすぎます（10MB 以下にしてください）', 400)
      }
      bytes = Buffer.from(contentBase64, 'base64')
      if (bytes.length === 0 || bytes.length > MAX_IMPORT_BYTES) {
        throw err('AKO-IMP-004', 'ファイルが空か大きすぎます（10MB 以下にしてください）', 400)
      }
    }

    // 2) マッピング適用（shared/domain/import-run = 純粋関数）
    let extracted: ImportExtractResult
    if (source.method === 'file_fixed') {
      const lineBytes = splitLineBytes(bytes)
      extracted = extractFixedRecords(lineBytes, mapping.fields, b => decodeImportBytes(Buffer.from(b), source.encoding))
    } else if (source.method === 'file_csv' || source.method === 'sheets_pull') {
      // sheets_pull は rowsToCsv 済み（UTF-8・区切り ','・開始行スライスでヘッダ行が先頭 = hasHeader:true）
      const isSheets = source.method === 'sheets_pull'
      extracted = extractCsvRecords(decodeImportBytes(bytes, isSheets ? 'utf8' : source.encoding), mapping.fields, {
        hasHeader: isSheets ? true : cfg.hasHeader !== false,
        delimiter: isSheets ? ',' : (typeof cfg.delimiter === 'string' && cfg.delimiter ? cfg.delimiter : ','),
      })
    } else {
      extracted = extractJsonRecords(decodeImportBytes(bytes, source.encoding), mapping.fields,
        typeof cfg.jsonRootPath === 'string' && cfg.jsonRootPath ? cfg.jsonRootPath : undefined)
    }
    if (extracted.mappingError) throw err('AKO-IMP-008', extracted.mappingError, 400)
    if (extracted.records.length === 0) throw err('AKO-IMP-004', '取込対象のデータ行がありません', 400)
    if (extracted.records.length > MAX_IMPORT_ROWS) {
      throw err('AKO-IMP-006', `1 回の取込は ${MAX_IMPORT_ROWS} 行までです（分割して実行してください）`, 400)
    }

    // 事業セグメントを取込元単位で持つ取込対象（0054）: 設定されていれば全レコードへ共通注入する
    // （列取込ではなく取込元で 1 度だけ選ぶ = オペレーター指示 2026-08-09）。未設定（null）は従来のマッピング列解決へ
    // フォールバック（原則7）。実行時点でセグメントが無効化されていれば行ごとでなく単一エラーで止める（明確な導線）。
    const injectSegment = Boolean(source.segmentId) && SEGMENT_SCOPED_ENTITIES.has(source.targetEntity)
    if (injectSegment) {
      const { rows: segRows } = await pool.query(`SELECT 1 FROM business_segments WHERE id = $1 AND active = true`, [source.segmentId])
      if (segRows.length === 0) {
        throw err('AKO-IMP-009', 'この取込元の事業セグメントが無効化されています（有効なセグメントに変更してから実行してください）', 409)
      }
      for (const rec of extracted.records) rec.values.segmentId = source.segmentId!
    }
    // 取込元セグメント適用時はマッピングの segmentId 行を無視し、注入した実 ID を既定（id→名称）解決に統一する。
    // 旧版マッピングが segmentId に名称突合キーを持つと、注入 id が名称解決器で解けず全行隔離になるのを防ぐ。
    const applyFields = injectSegment ? mapping.fields.filter(f => f.targetItemKey !== 'segmentId') : mapping.fields

    // 3) 検証 → 反映 → 実行履歴を同一トランザクションで確定（同一取込元の並行実行は直列化 = 冪等判定を安定させる）
    const id = newId('impr')
    const created = await inTxn(pool, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`imprun:${sourceId}`])
      const masterDef = masterImportDefOf(source.targetEntity)
      if (source.targetEntity === 'product_variant' || masterDef) {
        // 新規 INSERT を持つ取込対象は、名称/コードの DB 一意制約が無い（セグメント違いの同名等が正当なため）。
        // 取込元をまたぐ並行実行での同一名二重 INSERT をエンティティ単位の直列化で防ぐ（監査指摘 2026-08-07）。
        // ロック順は常に「取込元 → エンティティ」= 循環しない（デッドロックなし）
        await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`imprun-entity:${source.targetEntity}`])
      }
      const records = extracted.records
      let outcome: ApplyOutcome
      if (masterDef) {
        outcome = await applyMasterEntity(db, masterDef, records, applyFields)
      } else {
        switch (source.targetEntity) {
          case 'product':
            outcome = await applyProducts(db, records, applyFields)
            break
          case 'product_variant':
            outcome = await applyProductVariants(db, records, applyFields)
            break
          case 'sku':
            outcome = await applySkus(db, records, applyFields)
            break
          case 'company':
            outcome = await applyCompanies(db, records, applyFields)
            break
          case 'sales_record':
            outcome = await applySalesRecords(db, sourceId, records, applyFields)
            break
          default:
            outcome = await applyInventory(db, sourceId, records, applyFields)
        }
      }
      const counts = {
        staged: records.length,
        applied: outcome.applied,
        skipped: outcome.skipped,
        failed: outcome.issues.length,
      }
      const status = counts.applied === 0 && counts.skipped === 0 && counts.failed > 0 ? 'failed' : 'applied'
      const code = await nextDocCode(db, 'RUN')
      const { rows } = await db.query(
        `INSERT INTO import_runs (id, code, source_id, mapping_version, started_at, finished_at, status, counts, errors)
         VALUES ($1, $2, $3, $4, now(), now(), $5, $6, $7) RETURNING ${RUN_COLS}`,
        [id, code, sourceId, mapping.version, status, JSON.stringify(counts),
          JSON.stringify(outcome.issues.slice(0, 50))]) // 隔離行の記録は 50 件まで（jsonb 肥大防止）
      return rows[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'import_runs', entityId: id, detail: '取込を実行' })
    return c.json({ data: created }, 201)
  })

  return app
}

async function inTxn<T>(pool: pg.Pool, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
