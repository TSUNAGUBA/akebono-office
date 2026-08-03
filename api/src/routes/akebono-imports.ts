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
 * - エラーコード: AKO-IMP-001（取込元名未入力）/ AKO-IMP-002（有効マッピングなし）/
 *   AKO-IMP-003（マッピング項目なし）/ AKO-IMP-004（取込内容なし・復号不可）/ AKO-IMP-005（取込元が無効）/
 *   AKO-IMP-006（行数超過）/ AKO-IMP-007（API 接続失敗）/ AKO-IMP-008（マッピング定義不備）。台帳 = api-design §4。
 */
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import type pg from 'pg'
import { requireAdmin } from '../auth'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { safeFetch } from '../lib/safe-fetch'
import { capCp } from '../lib/text'
import { normalizeFieldLocators, normalizeImportSourceConfig, rowsToCsv } from '../../../shared/domain/import-parse'
import {
  extractCsvRecords, extractFixedRecords, extractJsonRecords, MAX_IMPORT_ROWS,
  type ImportExtractResult, type ImportRecord, type ImportRunFieldDef,
} from '../../../shared/domain/import-run'
import type { Env } from '../env'
import { fetchSheetRows } from './sheets'
import { nextDocCode, postInventory } from './akebono-trade'

const IMPORT_METHODS = ['file_csv', 'file_fixed', 'file_json', 'api_pull', 'sheets_pull']
const IMPORT_ENTITIES = ['product', 'sku', 'company', 'sales_record', 'inventory']

const SRC_COLS = `id, name, method, encoding, target_entity AS "targetEntity", schedule, active, config`
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
  const segments = await loadNameLookup(db, 'business_segments')
  const categories = await loadNameLookup(db, 'product_categories')
  const companies = await loadNameLookup(db, 'companies')
  const taxRates = await loadNameLookup(db, 'tax_rates')
  const units = await loadNameLookup(db, 'units')
  const out: ApplyOutcome = { applied: 0, skipped: 0, issues: [] }

  for (const rec of records) {
    const v = rec.values
    const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
    const code = v.code ?? ''
    const name = v.name ?? ''
    if (!code) { fail('商品コードが空のため隔離'); continue }
    const seg = v.segmentId ? resolveByIdOrName(segments, v.segmentId) : null
    // 参照解決（id or 有効行の名称完全一致）。未解決は隔離（マスタ整備 → 再実行で取り込める = 冪等）
    const refs: Record<string, string | null> = {}
    let refError = ''
    for (const [key, lookup, label] of [
      ['categoryId', categories, '商品カテゴリ'], ['defaultSupplierCompanyId', companies, '既定仕入先'],
      ['taxRateId', taxRates, '税区分'], ['unitId', units, '単位'],
    ] as const) {
      const raw = v[key] ?? ''
      if (raw === '') { refs[key] = null; continue }
      const id = resolveByIdOrName(lookup, raw)
      if (!id) { refError = `${label}「${raw}」がマスタ未登録のため隔離`; break }
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
    if (!seg) { fail(`事業セグメント「${v.segmentId ?? ''}」を解決できないため隔離`); continue }
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

/** 取引先（company）: 有効行の会社名完全一致の upsert（同名複数 = 隔離） */
async function applyCompanies(
  db: pg.PoolClient, records: ImportRecord[], fields: ImportRunFieldDef[],
): Promise<ApplyOutcome> {
  assertKnownTargets(fields, new Set(['name', 'kind', 'industryId', 'size', 'location', 'description']), true)
  const industries = await loadNameLookup(db, 'industries')
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
    const industryId = industryRaw === '' ? null : resolveByIdOrName(industries, industryRaw)
    if (industryRaw !== '' && !industryId) { fail(`業界「${industryRaw}」がマスタ未登録のため隔離`); continue }
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
  const segments = await loadNameLookup(db, 'business_segments')
  const companies = await loadNameLookup(db, 'companies')
  /** ファイル内の同一内容行の出現序数（フィンガープリントの一部 = MINOR-7 対応） */
  const seen = new Map<string, number>()
  const out: ApplyOutcome = { applied: 0, skipped: 0, issues: [] }
  for (const rec of records) {
    const v = rec.values
    const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
    const salesDate = v.salesDate ?? ''
    if (!DATE_RE.test(salesDate)) { fail(`売上日「${salesDate}」が YYYY-MM-DD でないため隔離（変換に date を指定できます）`); continue }
    const companyId = v.companyId ? resolveByIdOrName(companies, v.companyId) : null
    if (!companyId) { fail(`得意先「${v.companyId ?? ''}」がマスタ未登録のため隔離`); continue }
    const segmentId = v.segmentId ? resolveByIdOrName(segments, v.segmentId) : null
    if (!segmentId) { fail(`事業セグメント「${v.segmentId ?? ''}」がマスタ未登録のため隔離`); continue }
    // SKU は id → 有効 SKU コードの順で解決（取込ファイルは通常コードを持つ）
    const skuRaw = v.skuId ?? ''
    const { rows: skuRows } = await db.query<{ id: string; costPrice: number | null; stdCost: number | null; billingType: string | null }>(
      `SELECT s.id, s.cost_price AS "costPrice", p.standard_cost AS "stdCost", p.billing_type AS "billingType"
       FROM product_skus s LEFT JOIN products p ON p.id = s.product_id
       WHERE s.id = $1 OR (s.code = $1 AND s.active = true) LIMIT 2`, [skuRaw])
    if (skuRows.length === 0) { fail(`SKU「${skuRaw}」がマスタ未登録のため隔離`); continue }
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
  const warehouses = await loadNameLookup(db, 'warehouses')
  const KIND_MAP: Record<string, string> = { adjust: 'adjust', stocktake: 'stocktake', 調整: 'adjust', 棚卸: 'stocktake' }
  const REASONS = new Set(['defective', 'lost', 'found', 'sample', 'stocktake', 'other'])
  const out: ApplyOutcome = { applied: 0, skipped: 0, issues: [] }
  for (const rec of records) {
    const v = rec.values
    const fail = (message: string): void => { out.issues.push({ rowNo: rec.rowNo, rawText: rec.raw, message }) }
    const skuRaw = v.skuId ?? ''
    const { rows: skuRows } = await db.query<{ id: string }>(
      `SELECT id FROM product_skus WHERE id = $1 OR (code = $1 AND active = true) LIMIT 2`, [skuRaw])
    if (skuRows.length !== 1) { fail(`SKU「${skuRaw}」を特定できないため隔離`); continue }
    const warehouseId = v.warehouseId ? resolveByIdOrName(warehouses, v.warehouseId) : null
    if (!warehouseId) { fail(`倉庫「${v.warehouseId ?? ''}」がマスタ未登録のため隔離`); continue }
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

async function requireSource(db: pg.Pool | pg.PoolClient, id: string): Promise<void> {
  const { rows } = await db.query(`SELECT 1 FROM import_sources WHERE id = $1`, [id])
  if (rows.length === 0) throw err('AKO-GEN-002', '取込元が見つかりません', 404)
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
    const { rows } = await pool.query(`SELECT ${RUN_COLS} FROM import_runs ORDER BY started_at DESC, id LIMIT 5000`)
    return c.json({ data: rows })
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
    const id = newId('imp')
    const { rows } = await pool.query(
      `INSERT INTO import_sources (id, name, method, encoding, target_entity, config)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SRC_COLS}`,
      [id, name, method, encoding, targetEntity, JSON.stringify(config)])
    await audit(pool, { actorId: user.id, action: 'create', entity: 'import_sources', entityId: id, detail: `取込元を登録（${name}）` })
    return c.json({ data: rows[0] }, 201)
  })

  // 方式別設定の更新（エンドポイント/トークン・CSV ヘッダ有無等の編集。method は method に応じて正規化）
  app.put('/import-sources/:id/config', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const { rows: srows } = await pool.query<{ method: string }>(`SELECT method FROM import_sources WHERE id = $1`, [id])
    if (srows.length === 0) throw err('AKO-GEN-002', '取込元が見つかりません', 404)
    const config = normalizeImportSourceConfig(body.config, srows[0]!.method)
    const { rows } = await pool.query(
      `UPDATE import_sources SET config = $2, updated_at = now() WHERE id = $1 RETURNING ${SRC_COLS}`,
      [id, JSON.stringify(config)])
    // 変更キー名のみ記録（秘匿値は残さない = 監査性と最小権限の両立。config は設定系のため上書き = §45-4）
    await audit(pool, { actorId: user.id, action: 'update', entity: 'import_sources', entityId: id, detail: `取込元の方式別設定を更新（${Object.keys(config).join(', ') || '設定なし'}）` })
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
    await requireSource(pool, sourceId)
    const id = newId('impm')
    const fields = importFieldsOf(id, body.fields)
    if (!fields) throw err('AKO-IMP-003', '取込元項目と対象項目キーを 1 行以上入力してください', 400)
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
      method: string; encoding: string; targetEntity: string; active: boolean; config: Record<string, unknown> | null
    }>(
      `SELECT method, encoding, target_entity AS "targetEntity", active, config FROM import_sources WHERE id = $1`,
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

    // 3) 検証 → 反映 → 実行履歴を同一トランザクションで確定（同一取込元の並行実行は直列化 = 冪等判定を安定させる）
    const id = newId('impr')
    const created = await inTxn(pool, async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`imprun:${sourceId}`])
      const records = extracted.records
      let outcome: ApplyOutcome
      switch (source.targetEntity) {
        case 'product':
          outcome = await applyProducts(db, records, mapping.fields)
          break
        case 'sku':
          outcome = await applySkus(db, records, mapping.fields)
          break
        case 'company':
          outcome = await applyCompanies(db, records, mapping.fields)
          break
        case 'sales_record':
          outcome = await applySalesRecords(db, sourceId, records, mapping.fields)
          break
        default:
          outcome = await applyInventory(db, sourceId, records, mapping.fields)
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
