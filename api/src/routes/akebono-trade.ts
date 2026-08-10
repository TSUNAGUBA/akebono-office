/**
 * AKEBONO 記録系 API（Phase C = 0032。取引系）: 商品（F-21）・発注（F-23）・生産（F-22）・
 * 入荷（F-25）・仕入（F-24）・出荷（F-26）・在庫台帳（F-27）。
 *
 * - 分類と保護: 実績（inbound/outbound_results・purchase_records）と在庫台帳は**追記のみ**
 *   （更新・削除エンドポイントを設けない）。仕入の訂正は赤黒（マイナス伝票の追記）。
 *   予定・指示の取消はステータス遷移のみ（DELETE なし = 原則9.5）。
 * - 在庫の SoT = inventory_transactions（残高は Σqty で導出）。実績系の書込は同一トランザクションで
 *   台帳へ post し、冪等キー UNIQUE(ref_type, ref_line_id, kind) + ON CONFLICT DO NOTHING で
 *   二重生成を防ぐ（モックの useInventory.post と同一の意味論）。
 * - 参照整合: FK は張らず（0032 冒頭コメント）、書込パスで SKU・倉庫・会社・セグメントの存在を検証する。
 * - 認可: 参照・書込とも認証済み全員（モックの各画面に管理者ゲートが無い日常業務操作 = 社内 C2）。
 *   /v1/akebono は **featureGuard 'akebono'（F-16 = PATH_FEATURES）の対象**（機能 deny で全体を遮断できる
 *   安全側。個別アプリの表示制御は業態×アプリ設定 = クライアント側）。
 * - 伝票コード（PO-0001 等）は akebono_doc_seqs の単一 UPDATE で原子的に採番（並行安全）。
 *   行 id はヘッダ id + index（モックと同形 = 全域一意。ヘッダ id は uuid のため衝突しない）。
 * - エラーコードはモック composable と同一の AKO-PRD/POR/MFG/INB/PCH/OUT/INV 系を使用（台帳 = api-design §4）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { PO_STATUS_NEXT, PRODUCTION_STATUS_NEXT } from '../../../shared/domain/akebono'
import { nowJstIso, todayJst } from '../../../shared/domain/jst'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { runListQuery } from '../lib/list-query'
import { capCp } from '../lib/text'

// ---------- 共通ヘルパー ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function dateOf(v: unknown, label: string): string {
  const s = String(v ?? '').trim()
  if (!DATE_RE.test(s)) throw err('AKO-GEN-001', `${label}は YYYY-MM-DD 形式で指定してください`, 400)
  return s
}

function idOf(v: unknown, label: string): string {
  const s = String(v ?? '').trim()
  if (!s || s.length > 64) throw err('AKO-GEN-001', `${label}を指定してください`, 400)
  return s
}

/** 伝票コードの原子的採番（akebono_doc_seqs。単一 UPDATE = 並行安全・トランザクション内で呼ぶ） */
export async function nextDocCode(db: pg.Pool | pg.PoolClient, prefix: string): Promise<string> {
  const { rows } = await db.query<{ last: number }>(
    `INSERT INTO akebono_doc_seqs (prefix, last) VALUES ($1, 1)
     ON CONFLICT (prefix) DO UPDATE SET last = akebono_doc_seqs.last + 1
     RETURNING last`, [prefix])
  return `${prefix}-${String(rows[0]!.last).padStart(4, '0')}`
}

async function exists(db: pg.Pool | pg.PoolClient, table: string, id: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])
  return rows.length > 0
}

/** 参照存在の検証（FK なしの代替 = 書込パスで担保。0032 冒頭コメント） */
async function requireRef(db: pg.Pool | pg.PoolClient, table: string, id: string, label: string): Promise<void> {
  if (!(await exists(db, table, id))) throw err('AKO-GEN-002', `${label}が見つかりません（${id}）`, 404)
}

export interface InventoryPostEntry {
  skuId: string
  warehouseId: string
  qty: number
  kind: string
  reason?: string | null
  refType: string
  refLineId: string
  occurredAt?: string
}

/**
 * 在庫台帳へ追記する（冪等: UNIQUE(ref_type, ref_line_id, kind) + ON CONFLICT DO NOTHING =
 * モック useInventory.post と同一の二重生成防止）。qty=0 はスキップ。戻り値 = 追加行数
 */
export async function postInventory(db: pg.Pool | pg.PoolClient, entries: InventoryPostEntry[]): Promise<number> {
  const at = nowJstIso()
  let added = 0
  for (const e of entries) {
    if (e.qty === 0) continue
    const { rowCount } = await db.query(
      `INSERT INTO inventory_transactions (id, sku_id, warehouse_id, qty, kind, reason, ref_type, ref_line_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (ref_type, ref_line_id, kind) DO NOTHING`,
      [newId('itx'), e.skuId, e.warehouseId, e.qty, e.kind, e.reason ?? null, e.refType, e.refLineId, e.occurredAt ?? at])
    added += rowCount ?? 0
  }
  return added
}

/** SKU × 倉庫の残高（台帳 Σqty） */
export async function balanceOf(db: pg.Pool | pg.PoolClient, skuId: string, warehouseId: string): Promise<number> {
  const { rows } = await db.query<{ sum: number | null }>(
    `SELECT SUM(qty)::int AS sum FROM inventory_transactions WHERE sku_id = $1 AND warehouse_id = $2`,
    [skuId, warehouseId])
  return rows[0]?.sum ?? 0
}

/**
 * 在庫の check-then-act 直列化（レビュー C-1）。残高チェック → 台帳追記の間に並行トランザクションが
 * 同一 SKU × 倉庫へ出庫すると不変条件（出庫は残高 ≥ 必要数のチェック）を突破できるため、
 * （在庫調整・棚卸は意図的に負残高を作れる = このチェックを経ない。負残高からの出庫/移動は依然 409 で阻止）
 * pg_advisory_xact_lock（トランザクション終了で自動解放）でキー単位に直列化する。
 * キーは重複排除 + ソートして取得順を全呼び出しで一致させる（デッドロック防止）
 */
export async function lockInventoryKeys(db: pg.PoolClient, keys: { skuId: string; warehouseId: string }[]): Promise<void> {
  const uniq = [...new Set(keys.map(k => `inv:${k.skuId}::${k.warehouseId}`))].sort()
  for (const key of uniq) {
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key])
  }
}

interface QtyLine { skuId: string; qty: number }

/** 明細行の検証・正規化（skuId 必須・qty > 0 の整数・最大 200 行）。code = エラーコード */
function qtyLinesOf(
  v: unknown, code: string, extra?: (raw: Record<string, unknown>, line: QtyLine & Record<string, unknown>) => void,
): (QtyLine & Record<string, unknown>)[] {
  if (!Array.isArray(v) || v.length > 200) throw err(code, '明細を 1〜200 行で入力してください', 400)
  const lines: (QtyLine & Record<string, unknown>)[] = []
  for (const r of v) {
    const o = r as Record<string, unknown>
    const skuId = String(o?.skuId ?? '').trim()
    const qty = Number(o?.qty)
    if (!skuId || !Number.isInteger(qty) || qty <= 0 || qty > 1_000_000) continue
    const line: QtyLine & Record<string, unknown> = { skuId, qty }
    extra?.(o, line)
    lines.push(line)
  }
  if (lines.length === 0) throw err(code, '明細を 1 行以上入力してください', 400)
  return lines
}

/** lines 内の SKU がすべて存在するか（重複を除いて検証） */
async function requireSkus(db: pg.Pool | pg.PoolClient, lines: { skuId: string }[]): Promise<void> {
  const ids = [...new Set(lines.map(l => l.skuId))]
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM product_skus WHERE id = ANY($1)`, [ids])
  const found = new Set(rows.map(r => r.id))
  const missing = ids.find(id => !found.has(id))
  if (missing) throw err('AKO-GEN-002', `SKU が見つかりません（${missing}）`, 404)
}

const JST_TS = (col: string): string =>
  `to_char(${col} AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"')`

// ---------- 列定義（GET はモック型と同形の camelCase を返す） ----------

const PRODUCT_COLS = `id, code, name, segment_id AS "segmentId", category_id AS "categoryId",
  default_supplier_company_id AS "defaultSupplierCompanyId", list_price AS "listPrice",
  standard_cost AS "standardCost", tax_rate_id AS "taxRateId", unit_id AS "unitId",
  billing_type AS "billingType", variant_axis1_label AS "variantAxis1Label",
  variant_axis2_label AS "variantAxis2Label", description, active, custom`

const SKU_COLS = `id, product_id AS "productId", code, jan_code AS "janCode",
  axis1_value AS "axis1Value", axis2_value AS "axis2Value", sell_price AS "sellPrice",
  cost_price AS "costPrice", is_default AS "isDefault", active`

const IMAGE_COLS = `id, product_id AS "productId", sku_id AS "skuId", section_id AS "sectionId",
  display_order AS "displayOrder", filename, mime, data_url AS "dataUrl", active`

const PO_COLS = `id, code, company_id AS "companyId", segment_id AS "segmentId", status,
  order_date AS "orderDate", due_date AS "dueDate", lines, note`

const MFG_COLS = `id, code, sku_id AS "skuId", qty, warehouse_id AS "warehouseId",
  due_date AS "dueDate", status, results`

const IBP_COLS = `id, code, po_id AS "poId", warehouse_id AS "warehouseId",
  due_date AS "dueDate", status, lines`

const IBR_COLS = `id, code, plan_id AS "planId", warehouse_id AS "warehouseId",
  ${JST_TS('received_at')} AS "receivedAt", lines`

const PUR_COLS = `id, code, company_id AS "companyId", segment_id AS "segmentId",
  purchase_date AS "purchaseDate", purchase_type AS "purchaseType",
  inbound_result_id AS "inboundResultId", warehouse_id AS "warehouseId", lines,
  correction_of AS "correctionOf"`

const OBP_COLS = `id, code, company_id AS "companyId", warehouse_id AS "warehouseId",
  segment_id AS "segmentId", due_date AS "dueDate", status, lines`

const OBR_COLS = `id, code, plan_id AS "planId", warehouse_id AS "warehouseId",
  company_id AS "companyId", ${JST_TS('shipped_at')} AS "shippedAt", lines`

const ITX_COLS = `id, sku_id AS "skuId", warehouse_id AS "warehouseId", qty, kind, reason,
  ref_type AS "refType", ref_line_id AS "refLineId", ${JST_TS('occurred_at')} AS "occurredAt"`

/** 画像 data URI の検証（プロフィール画像・業態アイコンと同じ allowlist = SVG 等のスクリプト混入防止） */
const IMAGE_DATA_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/
const IMAGE_MAX_CHARS = 400_000

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

export function akebonoTradeRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // ========== 商品（F-21。設定系 = 更新可・論理削除） ==========

  app.get('/products', async (c) => {
    const { rows } = await pool.query(`SELECT ${PRODUCT_COLS} FROM products ORDER BY code LIMIT 10000`)
    return c.json({ data: rows })
  })

  app.get('/product-skus', async (c) => {
    const { rows } = await pool.query(`SELECT ${SKU_COLS} FROM product_skus ORDER BY code LIMIT 20000`)
    return c.json({ data: rows })
  })

  app.get('/product-images', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${IMAGE_COLS} FROM product_images ORDER BY product_id, display_order LIMIT 10000`)
    return c.json({ data: rows })
  })

  /** 商品の入力検証・正規化（作成 = 全項目 / 更新 = 送られたキーのみ。hasOwn = Zod v4 事故と同型の防止） */
  function productPatchOf(body: Record<string, unknown>, forCreate: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? capCp(v.trim(), 200) : null)
    if (forCreate || Object.hasOwn(body, 'code')) {
      const code = String(body.code ?? '').trim()
      if (!code || code.length > 60) throw err('AKO-PRD-001', '商品コードは必須です', 400)
      out.code = code
    }
    if (forCreate || Object.hasOwn(body, 'name')) {
      const name = String(body.name ?? '').trim()
      if (!name) throw err('AKO-PRD-001', '商品名は必須です', 400)
      out.name = capCp(name, 200)
    }
    // segmentId は作成時必須。更新でも送られたら受理する（モックの編集フォームは segmentId を送るため、
    // 無視すると「成功したのに旧セグメントのまま」= モードで挙動が乖離した = Codex P2-4）。
    // 別セグメントへの移動で同コード衝突 = 部分一意 INDEX (segment_id, code) WHERE active → 23505 →
    // PATCH ハンドラの catch が AKO-PRD-002 409 へ変換（POST/restore と同型）
    if (forCreate || Object.hasOwn(body, 'segmentId')) {
      const segmentId = String(body.segmentId ?? '').trim()
      if (!segmentId) throw err('AKO-PRD-001', '事業セグメントは必須です', 400)
      out.segmentId = segmentId
    }
    for (const k of ['categoryId', 'defaultSupplierCompanyId', 'taxRateId', 'unitId', 'variantAxis1Label', 'variantAxis2Label'] as const) {
      if (forCreate || Object.hasOwn(body, k)) out[k] = strOrNull(body[k])
    }
    for (const k of ['listPrice', 'standardCost'] as const) {
      if (forCreate || Object.hasOwn(body, k)) {
        const n = Number(body[k] ?? 0)
        if (!Number.isFinite(n) || n < 0 || n > 1e12) throw err('AKO-PRD-001', '価格を正しく入力してください', 400)
        out[k] = n
      }
    }
    if (forCreate || Object.hasOwn(body, 'billingType')) {
      const v = body.billingType
      out.billingType = v === 'one_time' || v === 'monthly' || v === 'usage' ? v : null
    }
    if (forCreate || Object.hasOwn(body, 'description')) out.description = capCp(String(body.description ?? '').trim(), 2000)
    if (forCreate || Object.hasOwn(body, 'custom')) {
      out.custom = body.custom && typeof body.custom === 'object' && !Array.isArray(body.custom) ? body.custom : {}
    }
    return out
  }

  const PRODUCT_COL_MAP: Record<string, string> = {
    code: 'code', name: 'name', segmentId: 'segment_id', categoryId: 'category_id',
    defaultSupplierCompanyId: 'default_supplier_company_id', listPrice: 'list_price',
    standardCost: 'standard_cost', taxRateId: 'tax_rate_id', unitId: 'unit_id',
    billingType: 'billing_type', variantAxis1Label: 'variant_axis1_label',
    variantAxis2Label: 'variant_axis2_label', description: 'description', custom: 'custom',
  }

  // 商品の作成（既定 SKU を同時生成 = XA-1。コード一意は部分一意 INDEX → 23505 で AKO-PRD-002）
  app.post('/products', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = productPatchOf(body, true)
    await requireRef(pool, 'business_segments', input.segmentId as string, '事業セグメント')
    const id = newId('prd')
    try {
      const created = await inTxn(pool, async (db) => {
        const fields = Object.keys(input)
        const cols = ['id', ...fields.map(f => PRODUCT_COL_MAP[f]!)]
        const params = [id, ...fields.map(f => f === 'custom' ? JSON.stringify(input[f]) : input[f])]
        await db.query(
          `INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          params)
        // 既定 SKU（展開なし商品向け。マトリクス生成時に無効化される）
        await db.query(
          `INSERT INTO product_skus (id, product_id, code, is_default) VALUES ($1, $2, $3, true)`,
          [newId('sku'), id, input.code])
        const { rows } = await db.query(`SELECT ${PRODUCT_COLS} FROM products WHERE id = $1`, [id])
        return rows[0]
      })
      await audit(pool, { actorId: user.id, action: 'create', entity: 'products', entityId: id, detail: `商品 ${input.code} を登録` })
      return c.json({ data: created }, 201)
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-PRD-002', `商品コード ${String(input.code)} は既に使われています`, 409)
      }
      throw e
    }
  })

  app.patch('/products/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const patch = productPatchOf(body, false)
    if (Object.keys(patch).length === 0) throw err('AKO-GEN-001', '更新内容がありません', 400)
    // セグメント移動時は参照先セグメントの存在を検証（作成時 requireRef と同じ担保 = FK なしの代替）
    if (Object.hasOwn(patch, 'segmentId')) {
      await requireRef(pool, 'business_segments', patch.segmentId as string, '事業セグメント')
    }
    const fields = Object.keys(patch)
    const sets = fields.map((f, i) => `${PRODUCT_COL_MAP[f]!} = $${i + 2}`)
    try {
      const { rows } = await pool.query(
        `UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${PRODUCT_COLS}`,
        [id, ...fields.map(f => f === 'custom' ? JSON.stringify(patch[f]) : patch[f])])
      if (rows.length === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      await audit(pool, { actorId: user.id, action: 'update', entity: 'products', entityId: id, detail: '商品を更新' })
      return c.json({ data: rows[0] })
    } catch (e) {
      // 同一セグメント × 有効行のコード一意（部分一意 INDEX）衝突。コード変更・セグメント移動の
      // いずれでも起きうるため両方を案内する（移動先に同コードの有効商品があるケースを含む）
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-PRD-002', '同じセグメントに同一商品コードの有効な商品が既に存在します（コードまたはセグメントを変更してください）', 409)
      }
      throw e
    }
  })

  for (const [action, active] of [['archive', false], ['restore', true]] as const) {
    app.post(`/products/:id/${action}`, async (c) => {
      const user = c.get('user')
      const id = c.req.param('id')
      try {
        const { rowCount } = await pool.query(
          `UPDATE products SET active = $2, updated_at = now() WHERE id = $1`, [id, active])
        if (rowCount === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      } catch (e) {
        // 復元は部分一意（segment × code × active）と衝突しうる（無効化後に同コードで再登録 →
        // 復元で 23505 = 500 になっていた。media_articles restore と同じ 409 + 対処案内。レビュー C-3）
        if ((e as { code?: string }).code === '23505') {
          throw err('AKO-PRD-002', '同じ商品コードの有効な商品が既に存在するため復元できません（どちらかのコードを変更してから復元してください）', 409)
        }
        throw e
      }
      await audit(pool, { actorId: user.id, action: 'update', entity: 'products', entityId: id, detail: active ? '商品を復元' : '商品を無効化' })
      return c.json({ data: { id } })
    })
  }

  // SKU マトリクス生成（軸1 × 軸2 の全組合せを追加。既存は軸値で突合しスキップ = 冪等）
  app.post('/products/:id/skus/matrix', async (c) => {
    const user = c.get('user')
    const productId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { axis1Values?: unknown; axis2Values?: unknown }
    const a1 = (Array.isArray(body.axis1Values) ? body.axis1Values : []).map(v => String(v).trim()).filter(Boolean).slice(0, 50)
    const a2raw = (Array.isArray(body.axis2Values) ? body.axis2Values : []).map(v => String(v).trim()).filter(Boolean).slice(0, 50)
    if (a1.length === 0) throw err('AKO-PRD-003', '軸1の値を 1 つ以上入力してください', 400)
    const a2 = a2raw.length > 0 ? a2raw : ['']
    const result = await inTxn(pool, async (db) => {
      const { rows: prows } = await db.query<{ code: string }>(`SELECT code FROM products WHERE id = $1 FOR UPDATE`, [productId])
      if (prows.length === 0) throw err('AKO-GEN-002', '商品が見つかりません', 404)
      const { rows: existing } = await db.query<{ axis1: string | null; axis2: string | null }>(
        `SELECT axis1_value AS axis1, axis2_value AS axis2 FROM product_skus WHERE product_id = $1`, [productId])
      const has = new Set(existing.map(s => `${s.axis1 ?? ''}::${s.axis2 ?? ''}`))
      let created = 0
      for (const v1 of a1) {
        for (const v2 of a2) {
          const axis2 = v2 === '' ? null : v2
          if (has.has(`${v1}::${axis2 ?? ''}`)) continue
          const suffix = [v1, v2].filter(Boolean).join('-')
          await db.query(
            `INSERT INTO product_skus (id, product_id, code, axis1_value, axis2_value) VALUES ($1, $2, $3, $4, $5)`,
            [newId('sku'), productId, `${prows[0]!.code}-${suffix}`, v1, axis2])
          created++
        }
      }
      // マトリクス化したら既定 SKU は無効化（展開ありへ移行 = モックと同一）
      if (created > 0) {
        await db.query(`UPDATE product_skus SET active = false, updated_at = now() WHERE product_id = $1 AND is_default`, [productId])
      }
      return created
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'product_skus', entityId: productId, detail: `SKU マトリクス生成（${result} 件）` })
    return c.json({ data: { created: result } })
  })

  app.patch('/product-skus/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const map: Record<string, string> = {
      code: 'code', janCode: 'jan_code', axis1Value: 'axis1_value', axis2Value: 'axis2_value',
      sellPrice: 'sell_price', costPrice: 'cost_price', active: 'active',
    }
    const sets: string[] = []
    const params: unknown[] = [id]
    for (const [k, col] of Object.entries(map)) {
      if (!Object.hasOwn(body, k)) continue
      let v = body[k]
      if (k === 'sellPrice' || k === 'costPrice') {
        v = v === null || v === '' ? null : Number(v)
        if (v !== null && (!Number.isFinite(v as number) || (v as number) < 0 || (v as number) > 1e12)) {
          throw err('AKO-PRD-001', '価格を正しく入力してください', 400)
        }
      } else if (k === 'active') {
        v = v === true
      } else {
        v = typeof v === 'string' && v.trim() ? capCp(v.trim(), 100) : k === 'code' ? undefined : null
        if (k === 'code' && v === undefined) throw err('AKO-PRD-001', 'SKU コードは必須です', 400)
      }
      params.push(v)
      sets.push(`${col} = $${params.length}`)
    }
    if (sets.length === 0) throw err('AKO-GEN-001', '更新内容がありません', 400)
    const { rows } = await pool.query(
      `UPDATE product_skus SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${SKU_COLS}`, params)
    if (rows.length === 0) throw err('AKO-GEN-002', 'SKU が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'product_skus', entityId: id, detail: 'SKU を更新' })
    return c.json({ data: rows[0] })
  })

  // 商品画像の追加（実体 = data URI TEXT。表示順 = 同一セクション内の末尾）
  app.post('/products/:id/images', async (c) => {
    const user = c.get('user')
    const productId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const sectionId = idOf(body.sectionId, '画像セクション')
    const skuId = typeof body.skuId === 'string' && body.skuId.trim() ? body.skuId.trim() : null
    const filename = capCp(String(body.filename ?? '').trim() || 'image', 200)
    const mime = capCp(String(body.mime ?? '').trim() || 'image/png', 100)
    const dataUrl = typeof body.dataUrl === 'string' && body.dataUrl ? body.dataUrl : null
    if (dataUrl && (!IMAGE_DATA_RE.test(dataUrl) || dataUrl.length > IMAGE_MAX_CHARS)) {
      throw err('AKO-PRD-004', '画像は data:image（png/jpeg/webp/gif・base64・400,000 文字以内）で指定してください', 400)
    }
    await requireRef(pool, 'products', productId, '商品')
    await requireRef(pool, 'product_image_sections', sectionId, '画像セクション')
    if (skuId) await requireRef(pool, 'product_skus', skuId, 'SKU')
    const id = newId('pimg')
    const { rows } = await pool.query(
      `INSERT INTO product_images (id, product_id, sku_id, section_id, display_order, filename, mime, data_url)
       VALUES ($1, $2, $3, $4,
         (SELECT COALESCE(MAX(display_order), 0) + 1 FROM product_images WHERE product_id = $2 AND section_id = $4 AND active),
         $5, $6, $7)
       RETURNING ${IMAGE_COLS}`,
      [id, productId, skuId, sectionId, filename, mime, dataUrl])
    await audit(pool, { actorId: user.id, action: 'create', entity: 'product_images', entityId: id, detail: '商品画像を追加' })
    return c.json({ data: rows[0] }, 201)
  })

  for (const [action, active] of [['archive', false], ['restore', true]] as const) {
    app.post(`/product-images/:id/${action}`, async (c) => {
      const user = c.get('user')
      const id = c.req.param('id')
      const { rowCount } = await pool.query(
        `UPDATE product_images SET active = $2, updated_at = now() WHERE id = $1`, [id, active])
      if (rowCount === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      await audit(pool, { actorId: user.id, action: 'update', entity: 'product_images', entityId: id, detail: active ? '商品画像を復元' : '商品画像を取消' })
      return c.json({ data: { id } })
    })
  }

  app.patch('/product-images/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const sectionId = idOf(body.sectionId, '画像セクション')
    await requireRef(pool, 'product_image_sections', sectionId, '画像セクション')
    const { rows } = await pool.query(
      `UPDATE product_images SET section_id = $2, updated_at = now() WHERE id = $1 RETURNING ${IMAGE_COLS}`,
      [id, sectionId])
    if (rows.length === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'product_images', entityId: id, detail: '画像セクションを変更' })
    return c.json({ data: rows[0] })
  })

  // ========== 発注（F-23。状態機械 = shared PO_STATUS_NEXT） ==========

  app.get('/purchase-orders', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'purchase_orders', cols: PO_COLS, orderBy: 'order_date DESC, id', maxLimit: 5000,
      searchCols: ['code', 'note', 'order_date::text', 'due_date::text'],
    }))
  })

  app.post('/purchase-orders', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const companyId = String(body.companyId ?? '').trim()
    const segmentId = String(body.segmentId ?? '').trim()
    if (!companyId) throw err('AKO-POR-001', '仕入先を指定してください', 400)
    if (!segmentId) throw err('AKO-POR-001', '事業セグメントを指定してください', 400)
    const orderDate = dateOf(body.orderDate, '発注日')
    const dueDate = dateOf(body.dueDate, '納期')
    const lines = qtyLinesOf(body.lines, 'AKO-POR-002', (raw, line) => {
      const p = Number(raw.unitPrice)
      line.unitPrice = Number.isFinite(p) && p >= 0 && p <= 1e12 ? p : 0
    })
    await requireRef(pool, 'companies', companyId, '仕入先')
    await requireRef(pool, 'business_segments', segmentId, '事業セグメント')
    await requireSkus(pool, lines)
    const id = newId('po')
    const created = await inTxn(pool, async (db) => {
      const code = await nextDocCode(db, 'PO')
      const orderLines = lines.map((l, idx) => ({ id: `${id}-${idx}`, ...l }))
      const { rows } = await db.query(
        `INSERT INTO purchase_orders (id, code, company_id, segment_id, status, order_date, due_date, lines, note)
         VALUES ($1, $2, $3, $4, 'ordered', $5, $6, $7, $8) RETURNING ${PO_COLS}`,
        [id, code, companyId, segmentId, orderDate, dueDate, JSON.stringify(orderLines), capCp(String(body.note ?? '').trim(), 1000)])
      return rows[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'purchase_orders', entityId: id, detail: '発注を登録' })
    return c.json({ data: created }, 201)
  })

  app.post('/purchase-orders/:id/status', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { status?: unknown }
    const status = String(body.status ?? '')
    if (!(status in PO_STATUS_NEXT)) throw err('AKO-GEN-001', 'status が不正です', 400)
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{ status: string }>(`SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE`, [id])
      if (rows.length === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      if (!PO_STATUS_NEXT[rows[0]!.status]!.includes(status)) {
        throw err('AKO-POR-003', `「${rows[0]!.status}」から「${status}」へは遷移できません`, 409)
      }
      const { rows: out } = await db.query(
        `UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${PO_COLS}`, [id, status])
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'purchase_orders', entityId: id, detail: `発注ステータス → ${status}` })
    return c.json({ data: updated })
  })

  // ========== 生産（F-22。実績は results jsonb への追記のみ + 在庫入庫） ==========

  app.get('/production-orders', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'production_orders', cols: MFG_COLS, orderBy: 'due_date DESC, id', maxLimit: 5000,
      searchCols: ['code', 'due_date::text'],
    }))
  })

  app.post('/production-orders', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const skuId = String(body.skuId ?? '').trim()
    if (!skuId) throw err('AKO-MFG-001', '対象 SKU を指定してください', 400)
    const qty = Number(body.qty)
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1_000_000) throw err('AKO-MFG-002', '数量を正しく入力してください', 400)
    const warehouseId = idOf(body.warehouseId, '入庫先倉庫')
    const dueDate = dateOf(body.dueDate, '期日')
    await requireRef(pool, 'product_skus', skuId, 'SKU')
    await requireRef(pool, 'warehouses', warehouseId, '倉庫')
    const id = newId('mfg')
    const created = await inTxn(pool, async (db) => {
      const code = await nextDocCode(db, 'MFG')
      const { rows } = await db.query(
        `INSERT INTO production_orders (id, code, sku_id, qty, warehouse_id, due_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'instructed') RETURNING ${MFG_COLS}`,
        [id, code, skuId, qty, warehouseId, dueDate])
      return rows[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'production_orders', entityId: id, detail: '生産指示を登録' })
    return c.json({ data: created }, 201)
  })

  app.post('/production-orders/:id/status', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { status?: unknown }
    const status = String(body.status ?? '')
    if (!(status in PRODUCTION_STATUS_NEXT)) throw err('AKO-GEN-001', 'status が不正です', 400)
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{ status: string }>(`SELECT status FROM production_orders WHERE id = $1 FOR UPDATE`, [id])
      if (rows.length === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      if (!PRODUCTION_STATUS_NEXT[rows[0]!.status]!.includes(status)) {
        throw err('AKO-MFG-003', `「${rows[0]!.status}」から遷移できません`, 409)
      }
      const { rows: out } = await db.query(
        `UPDATE production_orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${MFG_COLS}`, [id, status])
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'production_orders', entityId: id, detail: `生産ステータス → ${status}` })
    return c.json({ data: updated })
  })

  // 生産実績の登録（追記のみ）。完成分を在庫へ入庫（production_in）・全数完成で completed
  app.post('/production-orders/:id/results', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const completedQty = Number(body.completedQty)
    const defectQty = Number(body.defectQty ?? 0)
    if (!Number.isInteger(completedQty) || completedQty <= 0 || completedQty > 1_000_000) {
      throw err('AKO-MFG-002', '完成数を正しく入力してください', 400)
    }
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{ status: string; qty: number; skuId: string; warehouseId: string; results: { completedQty: number }[] }>(
        `SELECT status, qty, sku_id AS "skuId", warehouse_id AS "warehouseId", results FROM production_orders WHERE id = $1 FOR UPDATE`, [id])
      const o = rows[0]
      if (!o) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      if (o.status !== 'in_progress' && o.status !== 'instructed') {
        throw err('AKO-MFG-004', '指示中/進行中のみ実績登録できます', 409)
      }
      const result = {
        id: `${id}-r${o.results.length + 1}`,
        completedQty,
        defectQty: Number.isInteger(defectQty) && defectQty >= 0 ? defectQty : 0,
        completedAt: nowJstIso(),
      }
      const nextResults = [...o.results, result]
      const done = nextResults.reduce((s, r) => s + r.completedQty, 0) >= o.qty
      const { rows: out } = await db.query(
        `UPDATE production_orders SET results = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING ${MFG_COLS}`,
        [id, JSON.stringify(nextResults), done ? 'completed' : 'in_progress'])
      await postInventory(db, [{ skuId: o.skuId, warehouseId: o.warehouseId, qty: completedQty, kind: 'production_in', refType: 'production', refLineId: result.id }])
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'production_orders', entityId: id, detail: `生産実績を登録（${completedQty}）` })
    return c.json({ data: updated })
  })

  // ========== 入荷（F-25。予定 = 設定系 / 実績 = 記録系・追記のみ + 在庫入庫） ==========

  app.get('/inbound-plans', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'inbound_plans', cols: IBP_COLS, orderBy: 'due_date DESC, id', maxLimit: 5000,
      searchCols: ['code', 'due_date::text'],
    }))
  })

  app.get('/inbound-results', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'inbound_results', cols: IBR_COLS, orderBy: 'received_at DESC, id', maxLimit: 5000,
      searchCols: ['code', 'received_at::text'],
    }))
  })

  app.post('/inbound-plans', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const warehouseId = String(body.warehouseId ?? '').trim()
    if (!warehouseId) throw err('AKO-INB-001', '入荷先倉庫を指定してください', 400)
    const dueDate = dateOf(body.dueDate, '入荷予定日')
    const poId = typeof body.poId === 'string' && body.poId.trim() ? body.poId.trim() : null
    const lines = qtyLinesOf(body.lines, 'AKO-INB-002')
    await requireRef(pool, 'warehouses', warehouseId, '倉庫')
    if (poId) await requireRef(pool, 'purchase_orders', poId, '発注')
    await requireSkus(pool, lines)
    const id = newId('ibp')
    const created = await inTxn(pool, async (db) => {
      const code = await nextDocCode(db, 'IBP')
      const planLines = lines.map((l, idx) => ({ id: `${id}-${idx}`, skuId: l.skuId, qty: l.qty }))
      const { rows } = await db.query(
        `INSERT INTO inbound_plans (id, code, po_id, warehouse_id, due_date, status, lines)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING ${IBP_COLS}`,
        [id, code, poId, warehouseId, dueDate, JSON.stringify(planLines)])
      return rows[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'inbound_plans', entityId: id, detail: '入荷予定を登録' })
    return c.json({ data: created }, 201)
  })

  /** 予定ステータスの再計算（実績合計 vs 予定 = モック recomputeStatus と同一） */
  function planStatusOf(planLines: { id: string; qty: number }[], receivedByLine: Map<string, number>, current: string): string {
    if (current === 'canceled') return 'canceled'
    const totalPlanned = planLines.reduce((s, l) => s + l.qty, 0)
    let totalReceived = 0
    for (const l of planLines) totalReceived += receivedByLine.get(l.id) ?? 0
    if (totalReceived <= 0) return 'pending'
    return totalReceived >= totalPlanned ? 'completed' : 'partial'
  }

  // 入荷実績の登録（記録系・追記）。明細行単位で在庫台帳へ入庫 + 予定ステータス再計算
  app.post('/inbound-results', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const planId = typeof body.planId === 'string' && body.planId.trim() ? body.planId.trim() : null
    const lines = qtyLinesOf(body.lines, 'AKO-INB-002', (raw, line) => {
      const p = typeof raw.planLineId === 'string' && raw.planLineId ? raw.planLineId : null
      line.planLineId = p
    })
    await requireSkus(pool, lines)
    const id = newId('ibr')
    const created = await inTxn(pool, async (db) => {
      let warehouseId: string | null = null
      let plan: { id: string; status: string; lines: { id: string; qty: number }[] } | null = null
      if (planId) {
        const { rows } = await db.query<{ id: string; status: string; warehouseId: string; lines: { id: string; qty: number }[] }>(
          `SELECT id, status, warehouse_id AS "warehouseId", lines FROM inbound_plans WHERE id = $1 FOR UPDATE`, [planId])
        if (rows.length === 0) throw err('AKO-GEN-002', '入荷予定が見つかりません', 404)
        plan = rows[0]!
        warehouseId = rows[0]!.warehouseId
      } else {
        warehouseId = typeof body.warehouseId === 'string' && body.warehouseId.trim() ? body.warehouseId.trim() : null
        if (!warehouseId) throw err('AKO-INB-001', '入荷先倉庫を指定してください（直接登録時は必須）', 400)
        await requireRef(db, 'warehouses', warehouseId, '倉庫')
      }
      const code = await nextDocCode(db, 'IBR')
      const resultLines = lines.map((l, idx) => ({
        id: `${id}-${idx}`, planLineId: l.planLineId ?? null, skuId: l.skuId, qty: l.qty,
      }))
      const { rows: out } = await db.query(
        `INSERT INTO inbound_results (id, code, plan_id, warehouse_id, lines)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${IBR_COLS}`,
        [id, code, planId, warehouseId, JSON.stringify(resultLines)])
      await postInventory(db, resultLines.map(l => ({
        skuId: l.skuId, warehouseId: warehouseId!, qty: l.qty, kind: 'inbound', refType: 'inbound_result', refLineId: l.id,
      })))
      if (plan) {
        // 実績合計は既存 + 今回分（lines jsonb を横断集計）
        const { rows: rrows } = await db.query<{ lines: { planLineId: string | null; qty: number }[] }>(
          `SELECT lines FROM inbound_results WHERE plan_id = $1`, [plan.id])
        const receivedByLine = new Map<string, number>()
        for (const r of rrows) {
          for (const l of r.lines) {
            if (l.planLineId) receivedByLine.set(l.planLineId, (receivedByLine.get(l.planLineId) ?? 0) + l.qty)
          }
        }
        const status = planStatusOf(plan.lines, receivedByLine, plan.status)
        await db.query(`UPDATE inbound_plans SET status = $2, updated_at = now() WHERE id = $1`, [plan.id, status])
      }
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'inbound_results', entityId: id, detail: '入荷実績を登録' })
    return c.json({ data: created }, 201)
  })

  app.post('/inbound-plans/:id/cancel', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query(`SELECT id FROM inbound_plans WHERE id = $1 FOR UPDATE`, [id])
      if (rows.length === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      const { rows: results } = await db.query(`SELECT 1 FROM inbound_results WHERE plan_id = $1 LIMIT 1`, [id])
      if (results.length > 0) throw err('AKO-INB-003', '入荷実績のある予定は取消できません', 409)
      const { rows: out } = await db.query(
        `UPDATE inbound_plans SET status = 'canceled', updated_at = now() WHERE id = $1 RETURNING ${IBP_COLS}`, [id])
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'inbound_plans', entityId: id, detail: '入荷予定を取消' })
    return c.json({ data: updated })
  })

  // ========== 仕入（F-24。記録系・訂正は赤黒） ==========

  app.get('/purchase-records', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'purchase_records', cols: PUR_COLS, orderBy: 'purchase_date DESC, id', maxLimit: 5000,
      searchCols: ['code', 'purchase_date::text'],
    }))
  })

  // 仕入計上。warehouseId 指定時（= 入荷管理 OFF の業態。判定はアプリ設定を持つクライアント側 =
  // カタログ・プリセットがフロント静的 SoT のため。Phase B の設計判断と同一）は同時に在庫入庫
  app.post('/purchase-records', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const companyId = String(body.companyId ?? '').trim()
    const segmentId = String(body.segmentId ?? '').trim()
    if (!companyId) throw err('AKO-PCH-001', '仕入先を指定してください', 400)
    if (!segmentId) throw err('AKO-PCH-001', '事業セグメントを指定してください', 400)
    const purchaseDate = dateOf(body.purchaseDate, '仕入日')
    const purchaseType = body.purchaseType === 'consignment' ? 'consignment' : 'outright'
    const warehouseId = typeof body.warehouseId === 'string' && body.warehouseId.trim() ? body.warehouseId.trim() : null
    const lines = qtyLinesOf(body.lines, 'AKO-PCH-002', (raw, line) => {
      const p = Number(raw.costPrice)
      line.costPrice = Number.isFinite(p) && p >= 0 && p <= 1e12 ? p : 0
    })
    await requireRef(pool, 'companies', companyId, '仕入先')
    await requireRef(pool, 'business_segments', segmentId, '事業セグメント')
    if (warehouseId) await requireRef(pool, 'warehouses', warehouseId, '倉庫')
    await requireSkus(pool, lines)
    const id = newId('pur')
    const created = await inTxn(pool, async (db) => {
      const code = await nextDocCode(db, 'PUR')
      const recLines = lines.map((l, idx) => ({ id: `${id}-${idx}`, ...l }))
      const { rows } = await db.query(
        `INSERT INTO purchase_records (id, code, company_id, segment_id, purchase_date, purchase_type, warehouse_id, lines)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PUR_COLS}`,
        [id, code, companyId, segmentId, purchaseDate, purchaseType, warehouseId, JSON.stringify(recLines)])
      if (warehouseId) {
        await postInventory(db, recLines.map(l => ({
          skuId: l.skuId, warehouseId, qty: l.qty, kind: 'purchase_in', refType: 'purchase', refLineId: l.id,
        })))
      }
      return rows[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'purchase_records', entityId: id, detail: '仕入を計上' })
    return c.json({ data: created }, 201)
  })

  // 赤黒訂正（マイナス伝票の追記。元は不変）。入荷 OFF 経路で入庫済みなら在庫も戻す
  app.post('/purchase-records/:id/correct', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const newRecId = newId('pur')
    const created = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{
        companyId: string; segmentId: string; purchaseType: string; warehouseId: string | null
        correctionOf: string | null; lines: { id: string; skuId: string; qty: number; costPrice: number }[]
      }>(
        `SELECT company_id AS "companyId", segment_id AS "segmentId", purchase_type AS "purchaseType",
                warehouse_id AS "warehouseId", correction_of AS "correctionOf", lines
         FROM purchase_records WHERE id = $1 FOR UPDATE`, [id])
      const src = rows[0]
      if (!src) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      if (src.correctionOf) throw err('AKO-PCH-003', '訂正伝票は再訂正できません', 409)
      // 二重訂正の防止（同一元伝票への訂正が既にあれば拒否 = 冪等）
      const { rows: dup } = await db.query(`SELECT 1 FROM purchase_records WHERE correction_of = $1 LIMIT 1`, [id])
      if (dup.length > 0) throw err('AKO-PCH-003', 'この伝票は既に訂正済みです', 409)
      const code = await nextDocCode(db, 'PUR')
      const revLines = src.lines.map((l, idx) => ({ ...l, id: `${newRecId}-${idx}`, qty: -l.qty }))
      const { rows: out } = await db.query(
        `INSERT INTO purchase_records (id, code, company_id, segment_id, purchase_date, purchase_type, warehouse_id, lines, correction_of)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${PUR_COLS}`,
        [newRecId, code, src.companyId, src.segmentId, todayJst(), src.purchaseType, src.warehouseId, JSON.stringify(revLines), id])
      if (src.warehouseId) {
        await postInventory(db, revLines.map(l => ({
          skuId: l.skuId, warehouseId: src.warehouseId!, qty: l.qty, kind: 'purchase_in', refType: 'purchase', refLineId: l.id,
        })))
      }
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'purchase_records', entityId: newRecId, detail: `仕入を赤黒訂正（元 ${id}）` })
    return c.json({ data: created }, 201)
  })

  // ========== 出荷（F-26。指示 = 取消はステータス / 実績 = 記録系 + 出庫・店舗預け移動） ==========

  app.get('/outbound-plans', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'outbound_plans', cols: OBP_COLS, orderBy: 'due_date DESC, id', maxLimit: 5000,
      searchCols: ['code', 'due_date::text'],
    }))
  })

  app.get('/outbound-results', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'outbound_results', cols: OBR_COLS, orderBy: 'shipped_at DESC, id', maxLimit: 5000,
      searchCols: ['code', 'shipped_at::text'],
    }))
  })

  app.post('/outbound-plans', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const companyId = String(body.companyId ?? '').trim()
    const warehouseId = String(body.warehouseId ?? '').trim()
    const segmentId = String(body.segmentId ?? '').trim()
    if (!companyId) throw err('AKO-OUT-001', '出荷先を指定してください', 400)
    if (!warehouseId) throw err('AKO-OUT-001', '出荷元倉庫を指定してください', 400)
    if (!segmentId) throw err('AKO-OUT-001', '事業セグメントを指定してください', 400)
    const dueDate = dateOf(body.dueDate, '出荷予定日')
    const lines = qtyLinesOf(body.lines, 'AKO-OUT-002')
    await requireRef(pool, 'companies', companyId, '出荷先')
    await requireRef(pool, 'warehouses', warehouseId, '倉庫')
    await requireRef(pool, 'business_segments', segmentId, '事業セグメント')
    await requireSkus(pool, lines)
    const id = newId('obp')
    const created = await inTxn(pool, async (db) => {
      const code = await nextDocCode(db, 'OBP')
      const planLines = lines.map((l, idx) => ({ id: `${id}-${idx}`, skuId: l.skuId, qty: l.qty }))
      const { rows } = await db.query(
        `INSERT INTO outbound_plans (id, code, company_id, warehouse_id, segment_id, due_date, status, lines)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING ${OBP_COLS}`,
        [id, code, companyId, warehouseId, segmentId, dueDate, JSON.stringify(planLines)])
      return rows[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'outbound_plans', entityId: id, detail: '出荷指示を登録' })
    return c.json({ data: created }, 201)
  })

  /** 出荷先の店舗預け倉庫（store_deposit + companyId 一致 + 取引ロール store）。無ければ null */
  async function storeDepositWarehouseOf(db: pg.Pool | pg.PoolClient, companyId: string | null): Promise<string | null> {
    if (!companyId) return null
    const { rows: crows } = await db.query<{ kind: string; partnerRoles: string[] }>(
      `SELECT kind, partner_roles AS "partnerRoles" FROM companies WHERE id = $1`, [companyId])
    const company = crows[0]
    if (!company) return null
    const roles = company.partnerRoles.length > 0 ? company.partnerRoles : company.kind === 'customer' ? ['customer'] : []
    if (!roles.includes('store')) return null
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM warehouses WHERE kind = 'store_deposit' AND company_id = $1 AND active LIMIT 1`, [companyId])
    return rows[0]?.id ?? null
  }

  // 出荷実績の登録（記録系・追記）。出庫（−）+ 店舗納品は預け在庫へ移動（+）
  app.post('/outbound-results', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const planId = typeof body.planId === 'string' && body.planId.trim() ? body.planId.trim() : null
    const lines = qtyLinesOf(body.lines, 'AKO-OUT-002', (raw, line) => {
      const p = typeof raw.planLineId === 'string' && raw.planLineId ? raw.planLineId : null
      line.planLineId = p
    })
    await requireSkus(pool, lines)
    // 出荷実績からの売上自動計上（F-28 連携。sourceKind='shipment'）を要求されたか（既定 false = 後方互換）
    const postSales = body.postSales === true
    const id = newId('obr')
    const created = await inTxn(pool, async (db) => {
      let warehouseId: string | null = null
      let companyId: string | null = null
      let segmentId: string | null = null
      let plan: { id: string; status: string; lines: { id: string; qty: number }[] } | null = null
      if (planId) {
        const { rows } = await db.query<{ id: string; status: string; warehouseId: string; companyId: string; segmentId: string; lines: { id: string; qty: number }[] }>(
          `SELECT id, status, warehouse_id AS "warehouseId", company_id AS "companyId", segment_id AS "segmentId", lines
           FROM outbound_plans WHERE id = $1 FOR UPDATE`, [planId])
        if (rows.length === 0) throw err('AKO-GEN-002', '出荷指示が見つかりません', 404)
        plan = rows[0]!
        warehouseId = rows[0]!.warehouseId
        companyId = rows[0]!.companyId
        segmentId = rows[0]!.segmentId
      } else {
        warehouseId = typeof body.warehouseId === 'string' && body.warehouseId.trim() ? body.warehouseId.trim() : null
        companyId = typeof body.companyId === 'string' && body.companyId.trim() ? body.companyId.trim() : null
        segmentId = typeof body.segmentId === 'string' && body.segmentId.trim() ? body.segmentId.trim() : null
        if (!warehouseId) throw err('AKO-OUT-001', '出荷元倉庫を指定してください（直接登録時は必須）', 400)
        await requireRef(db, 'warehouses', warehouseId, '倉庫')
        if (companyId) await requireRef(db, 'companies', companyId, '出荷先')
      }
      // 在庫不足チェック（同一 SKU 複数行の合計で判定 = モックと同一）。
      // チェック → 出庫追記を advisory lock で直列化（並行出荷による残高マイナス防止 = C-1）
      const neededBySku = new Map<string, number>()
      for (const l of lines) neededBySku.set(l.skuId, (neededBySku.get(l.skuId) ?? 0) + l.qty)
      await lockInventoryKeys(db, [...neededBySku.keys()].map(skuId => ({ skuId, warehouseId: warehouseId! })))
      for (const [skuId, need] of neededBySku) {
        if ((await balanceOf(db, skuId, warehouseId!)) < need) {
          throw err('AKO-OUT-004', '出荷元の在庫が不足しています', 409)
        }
      }
      const code = await nextDocCode(db, 'OBR')
      const resultLines = lines.map((l, idx) => ({
        id: `${id}-${idx}`, planLineId: l.planLineId ?? null, skuId: l.skuId, qty: l.qty,
      }))
      const { rows: out } = await db.query(
        `INSERT INTO outbound_results (id, code, plan_id, warehouse_id, company_id, lines)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${OBR_COLS}`,
        [id, code, planId, warehouseId, companyId, JSON.stringify(resultLines)])
      const posts: InventoryPostEntry[] = resultLines.map(l => ({
        skuId: l.skuId, warehouseId: warehouseId!, qty: -l.qty, kind: 'outbound', refType: 'outbound_result', refLineId: l.id,
      }))
      const depositWh = await storeDepositWarehouseOf(db, companyId)
      if (depositWh) {
        for (const l of resultLines) {
          posts.push({ skuId: l.skuId, warehouseId: depositWh, qty: l.qty, kind: 'transfer_in', refType: 'outbound_result', refLineId: l.id })
        }
      }
      // 出荷実績 → 売上自動計上（F-28 連携。sourceKind='shipment'）の**事前検証 + 単価解決を在庫 post の前に置く**
      // （モック useOutbound と同順序 = 部分適用を作らない意図をトランザクション順序でも表現。監査-2）。
      // 店舗預け（consignment）の出荷は「販売」ではないため対象外（店舗での販売時に別途計上する）。
      const shipmentSales: { skuId: string; qty: number; unitPrice: number; costPrice: number | null; billingType: string | null; refLineId: string }[] = []
      if (postSales) {
        if (depositWh) throw err('AKO-OUT-005', '店舗預けの出荷は売上計上できません（店舗での販売時に売上を計上します）', 409)
        if (!companyId) throw err('AKO-OUT-005', '売上計上には出荷先（得意先）が必要です', 400)
        if (!segmentId) throw err('AKO-OUT-005', '売上計上には事業セグメントが必要です（直接登録時は segmentId を指定してください）', 400)
        await requireRef(db, 'business_segments', segmentId, '事業セグメント')
        for (const l of resultLines) {
          // 単価 = SKU 販売単価 → 商品標準販売単価 / 原価 = SKU 原価 → 商品標準原価（sales-records と同じ解決）
          const { rows: skuRows } = await db.query<{ sellPrice: number | null; listPrice: number | null; costPrice: number | null; stdCost: number | null; billingType: string | null }>(
            `SELECT s.sell_price AS "sellPrice", p.list_price AS "listPrice", s.cost_price AS "costPrice",
                    p.standard_cost AS "stdCost", p.billing_type AS "billingType"
             FROM product_skus s LEFT JOIN products p ON p.id = s.product_id WHERE s.id = $1`, [l.skuId])
          const sk = skuRows[0]
          const unitPrice = Number(sk?.sellPrice ?? sk?.listPrice ?? 0)
          if (!(unitPrice > 0)) throw err('AKO-OUT-005', '売上単価を解決できません（商品または SKU に販売単価を設定してください）', 409)
          shipmentSales.push({ skuId: l.skuId, qty: l.qty, unitPrice, costPrice: sk?.costPrice ?? sk?.stdCost ?? null, billingType: sk?.billingType ?? null, refLineId: l.id })
        }
      }
      await postInventory(db, posts)
      // 事前検証済みの明細を計上（同一トランザクションで原子的。二重計上は source_ref 一意 INDEX 0038 が最終防衛）
      for (const s of shipmentSales) {
        const salesCode = await nextDocCode(db, 'SR')
        await db.query(
          `INSERT INTO sales_records (id, code, sales_date, company_id, segment_id, sku_id, qty, unit_price, amount,
             cost_price, channel, billing_type, source_kind, source_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, 'shipment', $12)`,
          [newId('sr'), salesCode, todayJst(), companyId, segmentId, s.skuId, s.qty, s.unitPrice, Math.round(s.qty * s.unitPrice),
            s.costPrice, s.billingType, `obr:${s.refLineId}`])
      }
      if (plan) {
        const { rows: rrows } = await db.query<{ lines: { planLineId: string | null; qty: number }[] }>(
          `SELECT lines FROM outbound_results WHERE plan_id = $1`, [plan.id])
        const shippedByLine = new Map<string, number>()
        for (const r of rrows) {
          for (const l of r.lines) {
            if (l.planLineId) shippedByLine.set(l.planLineId, (shippedByLine.get(l.planLineId) ?? 0) + l.qty)
          }
        }
        const status = planStatusOf(plan.lines, shippedByLine, plan.status)
        await db.query(`UPDATE outbound_plans SET status = $2, updated_at = now() WHERE id = $1`, [plan.id, status])
      }
      return out[0]
    }).catch((e) => {
      // 出荷→売上の source_ref 一意（0038）衝突 = 同一出荷明細からの売上二重生成（リトライ等）。
      // 生 500 を出さず 409 でグレースフルに（原則4。m2）
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-OUT-005', 'この出荷からの売上は既に計上されています（二重計上の防止）', 409)
      }
      throw e
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'outbound_results', entityId: id, detail: postSales ? '出荷実績を登録（売上自動計上）' : '出荷実績を登録' })
    return c.json({ data: created }, 201)
  })

  app.post('/outbound-plans/:id/cancel', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query(`SELECT id FROM outbound_plans WHERE id = $1 FOR UPDATE`, [id])
      if (rows.length === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      const { rows: results } = await db.query(`SELECT 1 FROM outbound_results WHERE plan_id = $1 LIMIT 1`, [id])
      if (results.length > 0) throw err('AKO-OUT-003', '出荷実績のある指示は取消できません', 409)
      const { rows: out } = await db.query(
        `UPDATE outbound_plans SET status = 'canceled', updated_at = now() WHERE id = $1 RETURNING ${OBP_COLS}`, [id])
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'outbound_plans', entityId: id, detail: '出荷指示を取消' })
    return c.json({ data: updated })
  })

  // ========== 在庫（F-27。台帳 = SoT・追記のみ。残高はクライアントが Σqty で導出） ==========

  // 台帳の**表示用**明細（直近順・打ち切りあり）。残高はこの明細から導出しない（下の balances を使う）。
  // 打ち切り（LIMIT）は「新しい順に読める分だけ表示」用であり、残高計算の母集団ではない（Codex P1-2）
  app.get('/inventory-transactions', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'inventory_transactions', cols: ITX_COLS, orderBy: 'occurred_at DESC, id', maxLimit: 20000,
      searchCols: ['kind', 'reason', 'ref_type', 'ref_line_id'],
    }))
  })

  // SKU × 倉庫の**残高**（全量集約 = SUM(qty)）。台帳明細の表示打ち切り（LIMIT 20000）に依らず
  // 常に正しい残高を返す。旧実装はフロントが打ち切り済み明細を foldBalances で畳んで残高としていたため、
  // 台帳が 2 万行を超えると期首在庫・過去の移動が残高・棚卸入力から消えた（Codex P1-2）。
  // 0 残高は返さない（balanceOf は既定 0・在庫照会/棚卸は 0 を非表示 = 送信量削減）
  app.get('/inventory-balances', async (c) => {
    const { rows } = await pool.query<{ skuId: string; warehouseId: string; qty: number }>(
      `SELECT sku_id AS "skuId", warehouse_id AS "warehouseId", SUM(qty)::int AS qty
       FROM inventory_transactions
       GROUP BY sku_id, warehouse_id HAVING SUM(qty) <> 0`)
    return c.json({ data: rows })
  })

  const ADJUST_REASONS = new Set(['defective', 'lost', 'found', 'sample', 'stocktake', 'other'])

  // 在庫調整（F-27-2。理由必須）
  app.post('/inventory/adjust', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const skuId = String(body.skuId ?? '').trim()
    const warehouseId = String(body.warehouseId ?? '').trim()
    if (!skuId || !warehouseId) throw err('AKO-INV-001', 'SKU と倉庫を指定してください', 400)
    const qty = Number(body.qty)
    if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 1_000_000) {
      throw err('AKO-INV-002', '調整数量は 0 以外で指定してください', 400)
    }
    const reason = String(body.reason ?? '')
    if (!ADJUST_REASONS.has(reason)) throw err('AKO-INV-002', '調整理由を指定してください', 400)
    await requireRef(pool, 'product_skus', skuId, 'SKU')
    await requireRef(pool, 'warehouses', warehouseId, '倉庫')
    const refLineId = newId('adj')
    await postInventory(pool, [{ skuId, warehouseId, qty, kind: 'adjust', reason, refType: 'adjust', refLineId }])
    await audit(pool, { actorId: user.id, action: 'create', entity: 'inventory_transactions', entityId: refLineId, detail: `在庫調整（${qty > 0 ? '+' : ''}${qty}）` })
    return c.json({ data: { id: refLineId } }, 201)
  })

  // 倉庫間移動（F-27-3。出 + 入をアトミックに = 同一トランザクション）
  app.post('/inventory/transfer', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const skuId = String(body.skuId ?? '').trim()
    const fromWarehouseId = String(body.fromWarehouseId ?? '').trim()
    const toWarehouseId = String(body.toWarehouseId ?? '').trim()
    if (!skuId || !fromWarehouseId || !toWarehouseId) throw err('AKO-INV-001', 'SKU と倉庫を指定してください', 400)
    if (fromWarehouseId === toWarehouseId) throw err('AKO-INV-003', '移動元と移動先が同じです', 400)
    const qty = Number(body.qty)
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1_000_000) throw err('AKO-INV-002', '移動数量は 1 以上で指定してください', 400)
    await requireRef(pool, 'product_skus', skuId, 'SKU')
    await requireRef(pool, 'warehouses', fromWarehouseId, '移動元倉庫')
    await requireRef(pool, 'warehouses', toWarehouseId, '移動先倉庫')
    const refLineId = newId('trf')
    await inTxn(pool, async (db) => {
      // チェック → 追記を advisory lock で直列化（C-1。出入両キーをソート取得 = デッドロック防止）
      await lockInventoryKeys(db, [
        { skuId, warehouseId: fromWarehouseId }, { skuId, warehouseId: toWarehouseId },
      ])
      if ((await balanceOf(db, skuId, fromWarehouseId)) < qty) {
        throw err('AKO-INV-004', '移動元の在庫が不足しています', 409)
      }
      // 出/入の 2 行は同一 refLineId を共有（kind が異なるため冪等キーは衝突しない）
      await postInventory(db, [
        { skuId, warehouseId: fromWarehouseId, qty: -qty, kind: 'transfer_out', refType: 'transfer', refLineId },
        { skuId, warehouseId: toWarehouseId, qty, kind: 'transfer_in', refType: 'transfer', refLineId },
      ])
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'inventory_transactions', entityId: refLineId, detail: `倉庫間移動（${qty}）` })
    return c.json({ data: { id: refLineId } }, 201)
  })

  // 棚卸確定（F-27-4。実棚数 − 理論在庫の差分を stocktake 調整として計上）
  app.post('/inventory/stocktake', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const warehouseId = String(body.warehouseId ?? '').trim()
    if (!warehouseId) throw err('AKO-INV-001', '倉庫を指定してください', 400)
    const countsRaw = Array.isArray(body.counts) ? body.counts : []
    if (countsRaw.length === 0 || countsRaw.length > 500) throw err('AKO-INV-002', '棚卸行を 1〜500 行で指定してください', 400)
    const counts: { skuId: string; actualQty: number }[] = []
    for (const r of countsRaw) {
      const o = r as Record<string, unknown>
      const skuId = String(o?.skuId ?? '').trim()
      const actualQty = Number(o?.actualQty)
      // 実棚数（実物理在庫数）は負値も可（マイナス在庫を許容 = オペレーター指示 2026-08-10）。
      // 整数かつ絶対値の上限のみを課す（モック useInventory.stocktake・フロント入力欄と parity）
      if (!skuId || !Number.isInteger(actualQty) || Math.abs(actualQty) > 1_000_000) continue
      counts.push({ skuId, actualQty })
    }
    if (counts.length === 0) throw err('AKO-INV-002', '棚卸行を正しく入力してください', 400)
    await requireRef(pool, 'warehouses', warehouseId, '倉庫')
    await requireSkus(pool, counts)
    const adjusted = await inTxn(pool, async (db) => {
      // 理論在庫の読取り → 差分計上を advisory lock で直列化（C-1）
      await lockInventoryKeys(db, counts.map(cnt => ({ skuId: cnt.skuId, warehouseId })))
      const entries: InventoryPostEntry[] = []
      for (const cnt of counts) {
        const diff = cnt.actualQty - (await balanceOf(db, cnt.skuId, warehouseId))
        if (diff === 0) continue
        entries.push({
          skuId: cnt.skuId, warehouseId, qty: diff, kind: 'stocktake', reason: 'stocktake',
          refType: 'stocktake', refLineId: newId('stk'),
        })
      }
      if (entries.length > 0) await postInventory(db, entries)
      return entries.length
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'inventory_transactions', entityId: warehouseId, detail: `棚卸確定（調整 ${adjusted} 件）` })
    return c.json({ data: { adjusted } })
  })

  // 在庫調整・移動・棚卸の取消（原則9.5）。台帳は追記のみのため物理削除せず、反対仕訳を追記して
  // 残高を戻す（監査ログ付き = 記録系の取消の正しい形）。実績・入出荷は各画面の取消経路を使う。
  // 冪等: 反対仕訳は ref_type='reverse' + ref_line_id=<元 refType:refLineId> で UNIQUE 制約により二重取消を防ぐ。
  const REVERSIBLE_REFTYPES = new Set(['adjust', 'transfer', 'stocktake'])
  app.post('/inventory/reverse', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const transactionId = String(body.transactionId ?? '').trim()
    if (!transactionId) throw err('AKO-INV-001', '取消対象の明細を指定してください', 400)
    const reversed = await inTxn(pool, async (db) => {
      const { rows: targetRows } = await db.query<{ refType: string; refLineId: string }>(
        `SELECT ref_type AS "refType", ref_line_id AS "refLineId" FROM inventory_transactions WHERE id = $1`,
        [transactionId])
      const target = targetRows[0]
      if (!target) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      if (!REVERSIBLE_REFTYPES.has(target.refType)) {
        throw err('AKO-INV-007', 'この明細は取消できません（入出荷・仕入・生産の実績は各画面の取消をご利用ください）', 400)
      }
      const revRef = `${target.refType}:${target.refLineId}`
      const { rows: existRev } = await db.query(
        `SELECT 1 FROM inventory_transactions WHERE ref_type = 'reverse' AND ref_line_id = $1 LIMIT 1`, [revRef])
      if (existRev.length > 0) throw err('AKO-INV-008', 'この明細は既に取消済みです', 409)
      // グループ全体（移動は出/入の 2 行）を反対仕訳する
      const { rows: group } = await db.query<{ skuId: string; warehouseId: string; qty: number; kind: string }>(
        `SELECT sku_id AS "skuId", warehouse_id AS "warehouseId", qty, kind FROM inventory_transactions
         WHERE ref_type = $1 AND ref_line_id = $2`, [target.refType, target.refLineId])
      const entries: InventoryPostEntry[] = group.map(g => ({
        skuId: g.skuId, warehouseId: g.warehouseId, qty: -g.qty, kind: g.kind, reason: null,
        refType: 'reverse', refLineId: revRef,
      }))
      return postInventory(db, entries)
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'inventory_transactions', entityId: transactionId, detail: '在庫調整の取消（反対仕訳）' })
    return c.json({ data: { reversed } })
  })

  return app
}
