/**
 * AKEBONO 記録系 API（Phase C = 0032。売上・請求系）: 売上明細（F-28）・請求/入金（F-29-1/2/3）・
 * 委託精算（F-29-4）。
 *
 * - sales_records = 売上の SoT（記録系・訂正は赤黒 = マイナス明細の追記・元は不変）。
 *   F-15 の sales_monthly（月次実績）とは別系統（明細型）。統合メトリクス（/v1/media/integrated）の
 *   売上軸は本テーブルから組み立てる。
 * - invoices / payment_notices = 確定系（issued/confirmed 以降は不変・訂正は赤伝 = credit_for）。
 * - 金額算定（税・店舗マージン・作家支払）は shared/domain/akebono の純関数をモックと共有 =
 *   両モードで同一の計算結果になる（原則3・6）。
 * - 認可: 認証済み全員（akebono-trade.ts と同判断）。発行・精算・赤伝は監査ログへ記録。
 * - エラーコードはモック composable と同一の AKO-SLS/BIL 系（台帳 = api-design §4）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import {
  buildSettlementSnapshot, calcPayoutAmount, calcStoreMargin, calcTax, monthEndOf,
  type AkebonoConsignmentTermLike, type AkebonoSettlementSnapshot,
} from '../../../shared/domain/akebono'
import { todayJst } from '../../../shared/domain/jst'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { runListQuery } from '../lib/list-query'
import { capCp } from '../lib/text'
import { nextDocCode } from './akebono-trade'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/

function dateOf(v: unknown, label: string): string {
  const s = String(v ?? '').trim()
  if (!DATE_RE.test(s)) throw err('AKO-GEN-001', `${label}は YYYY-MM-DD 形式で指定してください`, 400)
  return s
}

const JST_TS = (col: string): string =>
  `to_char(${col} AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"')`

const SR_COLS = `id, code, sales_date AS "salesDate", company_id AS "companyId",
  segment_id AS "segmentId", sku_id AS "skuId", qty, unit_price AS "unitPrice", amount,
  cost_price AS "costPrice", channel, billing_type AS "billingType", source_kind AS "sourceKind",
  source_ref AS "sourceRef", invoice_id AS "invoiceId", correction_of AS "correctionOf", active, custom`

const INV_COLS = `id, code, company_id AS "companyId", segment_id AS "segmentId",
  period_from AS "periodFrom", period_to AS "periodTo", invoice_type AS "invoiceType", status,
  ${JST_TS('issued_at')} AS "issuedAt", total_amount AS "totalAmount", credit_for AS "creditFor",
  lines, snapshot, source_record_ids AS "sourceRecordIds"`

const PN_COLS = `id, code, company_id AS "companyId", segment_id AS "segmentId",
  period_from AS "periodFrom", period_to AS "periodTo", status, payable_amount AS "payableAmount",
  lines, snapshot, ${JST_TS('voided_at')} AS "voidedAt"`

const RCPT_COLS = `id, invoice_id AS "invoiceId", ${JST_TS('received_at')} AS "receivedAt", amount, method,
  ${JST_TS('voided_at')} AS "voidedAt"`

interface TermRow extends AkebonoConsignmentTermLike {
  taxRateId: string | null
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

export function akebonoBillingRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // ========== 売上明細（F-28） ==========

  app.get('/sales-records', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'sales_records', cols: SR_COLS, orderBy: 'sales_date DESC, id', maxLimit: 20000,
      searchCols: ['code', 'channel', 'sales_date::text'],
    }))
  })

  // 売上の計上。原価・課金区分はサーバーが SKU/商品マスタから解決（モック create と同一の導出）
  app.post('/sales-records', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const companyId = String(body.companyId ?? '').trim()
    const segmentId = String(body.segmentId ?? '').trim()
    const skuId = String(body.skuId ?? '').trim()
    if (!companyId || !segmentId || !skuId) {
      throw err('AKO-SLS-001', '得意先・セグメント・SKU は必須です', 400)
    }
    const salesDate = dateOf(body.salesDate, '売上日')
    const qty = Number(body.qty)
    const unitPrice = Number(body.unitPrice)
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1_000_000 || !Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1e12) {
      throw err('AKO-SLS-001', '数量・単価を正しく入力してください', 400)
    }
    const channel = typeof body.channel === 'string' && body.channel.trim() ? capCp(body.channel.trim(), 100) : null
    const sourceKind = ['manual', 'shipment', 'import', 'monthly_bulk'].includes(String(body.sourceKind)) ? String(body.sourceKind) : 'manual'
    // 追加カスタム項目（F-31）。オブジェクトのみ受理（配列/非オブジェクトは {} 扱い）
    const custom = body.custom && typeof body.custom === 'object' && !Array.isArray(body.custom) ? body.custom : {}
    const { rows: crows } = await pool.query(`SELECT 1 FROM companies WHERE id = $1`, [companyId])
    if (crows.length === 0) throw err('AKO-GEN-002', `得意先が見つかりません（${companyId}）`, 404)
    const { rows: srows } = await pool.query(`SELECT 1 FROM business_segments WHERE id = $1`, [segmentId])
    if (srows.length === 0) throw err('AKO-GEN-002', `事業セグメントが見つかりません（${segmentId}）`, 404)
    // SKU → 原価・課金区分の解決（SKU 原価 → 商品標準原価 / 商品の billingType）
    const { rows: skuRows } = await pool.query<{ costPrice: number | null; stdCost: number | null; billingType: string | null }>(
      `SELECT s.cost_price AS "costPrice", p.standard_cost AS "stdCost", p.billing_type AS "billingType"
       FROM product_skus s LEFT JOIN products p ON p.id = s.product_id WHERE s.id = $1`, [skuId])
    if (skuRows.length === 0) throw err('AKO-GEN-002', `SKU が見つかりません（${skuId}）`, 404)
    const sku = skuRows[0]!
    const id = newId('sr')
    const created = await inTxn(pool, async (db) => {
      const code = await nextDocCode(db, 'SR')
      const { rows } = await db.query(
        `INSERT INTO sales_records (id, code, sales_date, company_id, segment_id, sku_id, qty, unit_price, amount,
           cost_price, channel, billing_type, source_kind, custom)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${SR_COLS}`,
        [id, code, salesDate, companyId, segmentId, skuId, qty, unitPrice, Math.round(qty * unitPrice),
          sku.costPrice ?? sku.stdCost ?? null, channel, sku.billingType, sourceKind, JSON.stringify(custom)])
      return rows[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'sales_records', entityId: id, detail: '売上を計上' })
    return c.json({ data: created }, 201)
  })

  // 赤黒訂正（元明細のマイナス明細を追記。元は不変 = 記録系）
  app.post('/sales-records/:id/correct', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const revId = newId('sr')
    const created = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{
        companyId: string; segmentId: string; skuId: string; qty: number; unitPrice: number; amount: number
        costPrice: number | null; channel: string | null; billingType: string | null
        invoiceId: string | null; correctionOf: string | null
      }>(
        `SELECT company_id AS "companyId", segment_id AS "segmentId", sku_id AS "skuId", qty,
                unit_price AS "unitPrice", amount, cost_price AS "costPrice", channel,
                billing_type AS "billingType", invoice_id AS "invoiceId", correction_of AS "correctionOf"
         FROM sales_records WHERE id = $1 FOR UPDATE`, [id])
      const src = rows[0]
      if (!src) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      if (src.correctionOf) throw err('AKO-SLS-002', '訂正明細は再訂正できません', 409)
      if (src.invoiceId) throw err('AKO-SLS-003', '請求済みの明細は訂正できません（請求側で赤伝を発行してください）', 409)
      // 二重訂正の防止（同一元明細への訂正が既にあれば拒否）
      const { rows: dup } = await db.query(`SELECT 1 FROM sales_records WHERE correction_of = $1 LIMIT 1`, [id])
      if (dup.length > 0) throw err('AKO-SLS-002', 'この明細は既に訂正済みです', 409)
      const code = await nextDocCode(db, 'SR')
      const { rows: out } = await db.query(
        `INSERT INTO sales_records (id, code, sales_date, company_id, segment_id, sku_id, qty, unit_price, amount,
           cost_price, channel, billing_type, source_kind, correction_of)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'manual', $13) RETURNING ${SR_COLS}`,
        [revId, code, todayJst(), src.companyId, src.segmentId, src.skuId, -src.qty, src.unitPrice, -src.amount,
          src.costPrice, src.channel, src.billingType, id])
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'sales_records', entityId: revId, detail: `売上を赤黒訂正（元 ${id}）` })
    return c.json({ data: created }, 201)
  })

  // ========== 請求・入金（F-29-1/2/3） ==========

  app.get('/invoices', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'invoices', cols: INV_COLS, orderBy: 'created_at DESC, id', maxLimit: 5000,
      searchCols: ['code', 'status', 'period_from::text', 'period_to::text'],
    }))
  })

  app.get('/payment-notices', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'payment_notices', cols: PN_COLS, orderBy: 'created_at DESC, id', maxLimit: 5000,
      searchCols: ['code', 'status', 'period_from::text', 'period_to::text'],
    }))
  })

  app.get('/payment-receipts', async (c) => {
    return c.json(await runListQuery(pool, c, {
      table: 'payment_receipts', cols: RCPT_COLS, orderBy: 'received_at DESC, id', maxLimit: 5000,
      searchCols: ['method', 'received_at::text'],
    }))
  })

  async function taxRateValue(db: pg.Pool | pg.PoolClient, id: string | null | undefined): Promise<number> {
    if (!id) return 0
    const { rows } = await db.query<{ rate: number }>(`SELECT rate FROM tax_rates WHERE id = $1`, [id])
    return rows[0]?.rate ?? 0
  }

  /** SKU の表示ラベル（軸値 → コード。請求明細の説明文用 = モック skuLabel 相当） */
  async function skuLabelOf(db: pg.Pool | pg.PoolClient, skuId: string): Promise<string> {
    const { rows } = await db.query<{ code: string; axis1: string | null; axis2: string | null; isDefault: boolean; productName: string | null }>(
      `SELECT s.code, s.axis1_value AS axis1, s.axis2_value AS axis2, s.is_default AS "isDefault", p.name AS "productName"
       FROM product_skus s LEFT JOIN products p ON p.id = s.product_id WHERE s.id = $1`, [skuId])
    const s = rows[0]
    if (!s) return skuId
    if (s.isDefault) return s.productName ?? s.code
    const parts = [s.axis1, s.axis2].filter(Boolean)
    return parts.length > 0 ? parts.join(' / ') : s.code
  }

  // 締め（ドラフト生成・洗い替え冪等）。同一得意先 × 期間の未発行ドラフトは置換
  app.post('/billing/close', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const companyId = String(body.companyId ?? '').trim()
    if (!companyId) throw err('AKO-GEN-001', '得意先を指定してください', 400)
    const periodFrom = dateOf(body.periodFrom, '期間開始')
    const periodTo = dateOf(body.periodTo, '期間終了')
    const id = newId('inv')
    const result = await inTxn(pool, async (db) => {
      // 並行 close の直列化（C-1）。同一キーの draft 一意は 0033 の部分一意 INDEX が最終防衛
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`bill:${companyId}:${periodFrom}:${periodTo}`])
      const { rows } = await db.query<{ id: string; salesDate: string; skuId: string; qty: number; amount: number; taxRateId: string | null }>(
        `SELECT r.id, r.sales_date AS "salesDate", r.sku_id AS "skuId", r.qty, r.amount, p.tax_rate_id AS "taxRateId"
         FROM sales_records r
         LEFT JOIN product_skus s ON s.id = r.sku_id
         LEFT JOIN products p ON p.id = s.product_id
         WHERE r.active AND r.invoice_id IS NULL AND r.company_id = $1
           AND r.sales_date >= $2 AND r.sales_date <= $3
         ORDER BY r.sales_date, r.id`, [companyId, periodFrom, periodTo])
      if (rows.length === 0) throw err('AKO-BIL-001', '対象の未請求売上がありません', 404)
      // 既存の未発行ドラフト（同一得意先 × 期間）を洗い替え（draft は設定系 = 置換可）
      await db.query(
        `DELETE FROM invoices WHERE status = 'draft' AND invoice_type = 'sales'
           AND company_id = $1 AND period_from = $2 AND period_to = $3`, [companyId, periodFrom, periodTo])
      const subtotal = rows.reduce((s, r) => s + r.amount, 0)
      // 税は代表税率で概算（明細ごとの税は本実装で対応 = モックと同一の設計判断）
      const rate = await taxRateValue(db, rows[0]!.taxRateId)
      const tax = calcTax(subtotal, rate, false, 'floor')
      const lines: { id: string; description: string; amount: number }[] = []
      for (const [idx, r] of rows.entries()) {
        lines.push({ id: `${id}-l${idx}`, description: `${r.salesDate} ${await skuLabelOf(db, r.skuId)}（${r.qty}）`, amount: r.amount })
      }
      if (tax > 0) lines.push({ id: `${id}-tax`, description: `消費税（${(rate * 100).toFixed(0)}%）`, amount: tax })
      const code = await nextDocCode(db, 'INV')
      const { rows: out } = await db.query(
        `INSERT INTO invoices (id, code, company_id, segment_id, period_from, period_to, invoice_type, status, total_amount, lines, source_record_ids)
         VALUES ($1, $2, $3, NULL, $4, $5, 'sales', 'draft', $6, $7, $8) RETURNING ${INV_COLS}`,
        [id, code, companyId, periodFrom, periodTo, subtotal + tax, JSON.stringify(lines), JSON.stringify(rows.map(r => r.id))])
      return { invoice: out[0], count: rows.length }
    }).catch((e) => {
      // 0033 の部分一意 INDEX 衝突 = 並行 close の同時 INSERT（advisory lock をすり抜ける経路はないが最終防衛。C-1）
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-GEN-003', '同じ得意先 × 期間の締め処理が同時に実行されました。再度お試しください', 409)
      }
      throw e
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'invoices', entityId: id, detail: `請求締め（${result.count} 件）` })
    return c.json({ data: result }, 201)
  })

  // 請求発行（draft → issued。以後不変。対象売上に invoice_id を張る）
  app.post('/invoices/:id/issue', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{ status: string; sourceRecordIds: string[] }>(
        `SELECT status, source_record_ids AS "sourceRecordIds" FROM invoices WHERE id = $1 FOR UPDATE`, [id])
      if (rows.length === 0) throw err('AKO-GEN-002', '請求が見つかりません', 404)
      if (rows[0]!.status !== 'draft') throw err('AKO-BIL-002', '下書き以外は発行できません', 409)
      const { rows: out } = await db.query(
        `UPDATE invoices SET status = 'issued', issued_at = now(), updated_at = now() WHERE id = $1 RETURNING ${INV_COLS}`, [id])
      // 締め後に他の請求・精算が同じ売上を紐づけた場合は発行を中止（リンクは未請求行のみ + 件数検証 = C-1）
      const { rowCount } = await db.query(
        `UPDATE sales_records SET invoice_id = $1 WHERE id = ANY($2) AND invoice_id IS NULL`,
        [id, rows[0]!.sourceRecordIds])
      if ((rowCount ?? 0) !== rows[0]!.sourceRecordIds.length) {
        throw err('AKO-GEN-003', '対象売上の一部が既に他の請求・精算に紐づいています。締め直してから発行してください', 409)
      }
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'invoices', entityId: id, detail: '請求を発行' })
    return c.json({ data: updated })
  })

  // 赤伝発行（issued → void + マイナス請求を追記。通常請求のみ = 委託マージンは精算やり直しで対応）
  app.post('/invoices/:id/void', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const creditId = newId('inv')
    const created = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{
        status: string; invoiceType: string; companyId: string; segmentId: string | null
        periodFrom: string; periodTo: string; totalAmount: number
        lines: { id: string; description: string; amount: number }[]; sourceRecordIds: string[]
      }>(
        `SELECT status, invoice_type AS "invoiceType", company_id AS "companyId", segment_id AS "segmentId",
                period_from AS "periodFrom", period_to AS "periodTo", total_amount AS "totalAmount",
                lines, source_record_ids AS "sourceRecordIds"
         FROM invoices WHERE id = $1 FOR UPDATE`, [id])
      const inv = rows[0]
      if (!inv) throw err('AKO-GEN-002', '請求が見つかりません', 404)
      if (inv.status !== 'issued') throw err('AKO-BIL-003', '発行済みのみ赤伝を発行できます', 409)
      if (inv.invoiceType !== 'sales') {
        throw err('AKO-BIL-008', '委託マージン請求は単独で赤伝できません（精算の取消フローは今後対応予定。誤った精算は管理者へご相談ください）', 409)
      }
      const code = await nextDocCode(db, 'INV')
      const { rows: out } = await db.query(
        `INSERT INTO invoices (id, code, company_id, segment_id, period_from, period_to, invoice_type, status,
           issued_at, total_amount, credit_for, lines, source_record_ids)
         VALUES ($1, $2, $3, $4, $5, $6, 'sales', 'issued', now(), $7, $8, $9, '[]') RETURNING ${INV_COLS}`,
        [creditId, code, inv.companyId, inv.segmentId, inv.periodFrom, inv.periodTo, -inv.totalAmount, id,
          JSON.stringify(inv.lines.map(l => ({ ...l, id: l.id + '-c', amount: -l.amount })))])
      await db.query(`UPDATE invoices SET status = 'void', updated_at = now() WHERE id = $1`, [id])
      // 対象売上の請求リンクを解除（再請求可能に）
      await db.query(`UPDATE sales_records SET invoice_id = NULL WHERE id = ANY($1)`, [inv.sourceRecordIds])
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'invoices', entityId: creditId, detail: `赤伝を発行（元 ${id}）` })
    return c.json({ data: created }, 201)
  })

  // 入金消込（記録系・追記。全額消込で paid）
  app.post('/payment-receipts', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const invoiceId = String(body.invoiceId ?? '').trim()
    if (!invoiceId) throw err('AKO-GEN-001', '請求を指定してください', 400)
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
      throw err('AKO-BIL-005', '入金額を正しく入力してください', 400)
    }
    const method = capCp(String(body.method ?? '').trim(), 60)
    const id = newId('rcpt')
    const created = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{ status: string; totalAmount: number }>(
        `SELECT status, total_amount AS "totalAmount" FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId])
      if (rows.length === 0) throw err('AKO-GEN-002', '請求が見つかりません', 404)
      // 発行済み（+ 全額消込後の追加入金 = paid）のみ受理。draft は未発行・void/赤伝への入金は
      // 「void → paid」の終端状態破壊になるため拒否（レビュー C-2）
      if (rows[0]!.status !== 'issued' && rows[0]!.status !== 'paid') {
        throw err('AKO-BIL-004', '発行済みの請求にのみ入金を記録できます（下書き・無効の請求は対象外）', 409)
      }
      const { rows: out } = await db.query(
        `INSERT INTO payment_receipts (id, invoice_id, amount, method) VALUES ($1, $2, $3, $4) RETURNING ${RCPT_COLS}`,
        [id, invoiceId, Math.round(amount), method])
      const { rows: sums } = await db.query<{ paid: number | null }>(
        `SELECT SUM(amount) AS paid FROM payment_receipts WHERE invoice_id = $1 AND voided_at IS NULL`, [invoiceId])
      if ((sums[0]?.paid ?? 0) >= rows[0]!.totalAmount) {
        await db.query(`UPDATE invoices SET status = 'paid', updated_at = now() WHERE id = $1`, [invoiceId])
      }
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'create', entity: 'payment_receipts', entityId: id, detail: '入金を記録' })
    return c.json({ data: created }, 201)
  })

  // 入金の取消（レビュー C-2 = 原則9.5）。記録系の追記保護と両立する監査列付き論理取消
  // （voided_at / voided_by = 0033）。有効入金の再集計で請求の paid 判定を戻す（paid → issued）まで 1 Tx
  app.post('/payment-receipts/:id/cancel', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const result = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{ invoiceId: string; voidedAt: string | null }>(
        `SELECT invoice_id AS "invoiceId", voided_at AS "voidedAt" FROM payment_receipts WHERE id = $1 FOR UPDATE`, [id])
      if (rows.length === 0) throw err('AKO-GEN-002', '入金が見つかりません', 404)
      if (rows[0]!.voidedAt) throw err('AKO-BIL-009', 'この入金は既に取消済みです', 409)
      const invoiceId = rows[0]!.invoiceId
      const { rows: invRows } = await db.query<{ status: string; totalAmount: number }>(
        `SELECT status, total_amount AS "totalAmount" FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId])
      const { rows: out } = await db.query(
        `UPDATE payment_receipts SET voided_at = now(), voided_by = $2 WHERE id = $1 RETURNING ${RCPT_COLS}`,
        [id, user.id])
      // 有効入金の再集計。全額を割ったら paid → issued（導出ステータスの再計算 = 記録の巻き戻しではない）
      if (invRows[0]?.status === 'paid') {
        const { rows: sums } = await db.query<{ paid: number | null }>(
          `SELECT SUM(amount) AS paid FROM payment_receipts WHERE invoice_id = $1 AND voided_at IS NULL`, [invoiceId])
        if ((sums[0]?.paid ?? 0) < invRows[0]!.totalAmount) {
          await db.query(`UPDATE invoices SET status = 'issued', updated_at = now() WHERE id = $1`, [invoiceId])
        }
      }
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'payment_receipts', entityId: id, detail: '入金を取消（論理）' })
    return c.json({ data: result })
  })

  // ========== 委託精算（F-29-4） ==========

  async function termOf(db: pg.PoolClient, companyId: string, segmentId: string, role: string): Promise<TermRow | undefined> {
    const { rows } = await db.query<TermRow>(
      `SELECT margin_rate AS "marginRate", payout_method AS "payoutMethod", payout_rate AS "payoutRate",
              tax_rate_id AS "taxRateId", tax_included AS "taxIncluded", rounding
       FROM consignment_terms
       WHERE active AND company_id = $1 AND segment_id = $2 AND role = $3
       ORDER BY valid_from DESC LIMIT 1`, [companyId, segmentId, role])
    return rows[0]
  }

  /**
   * purchase_cost 方式の単価解決（①直近仕入実績 → ② SKU 原価 → ③ 商品標準原価 = モックと同一）。
   * ① は**対象 SKU を含む仕入明細に SQL で絞って最新 1 件**を取る（lines jsonb の @> 包含 = 0034 GIN）。
   * 旧実装は「全 SKU 横断の直近 500 件」を取ってから JS で走査していたため、仕入総数が 500 を
   * 超えると対象 SKU の直近仕入が窓外へ落ち標準原価へ誤フォールバックした（Codex P1-1）。
   * モックの resolveUnitCost（全仕入を走査し対象 SKU の最新 costPrice）と窓に依らず一致する。
   */
  async function resolveUnitCost(db: pg.PoolClient, skuId: string): Promise<number> {
    const { rows: prs } = await db.query<{ lines: { skuId: string; costPrice: number }[] }>(
      `SELECT lines FROM purchase_records
       WHERE lines @> $1::jsonb
       ORDER BY purchase_date DESC, id DESC LIMIT 1`,
      [JSON.stringify([{ skuId }])])
    const hit = prs[0]?.lines.find(l => l.skuId === skuId)
    if (hit) return hit.costPrice
    const { rows } = await db.query<{ costPrice: number | null; stdCost: number | null }>(
      `SELECT s.cost_price AS "costPrice", p.standard_cost AS "stdCost"
       FROM product_skus s LEFT JOIN products p ON p.id = s.product_id WHERE s.id = $1`, [skuId])
    return rows[0]?.costPrice ?? rows[0]?.stdCost ?? 0
  }

  /**
   * 委託精算の締め（冪等）。店舗ごとにマージン請求（Invoice）、作家ごとに支払通知（PaymentNotice）を発行。
   * 発行時点の設定をスナップショット（後の設定変更に影響されない）。対象売上に invoice_id を張り再精算を防ぐ
   */
  app.post('/consignment/close', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const segmentId = String(body.segmentId ?? '').trim()
    const month = String(body.month ?? '').trim()
    if (!segmentId || !MONTH_RE.test(month)) throw err('AKO-GEN-001', 'segmentId と month（YYYY-MM）を指定してください', 400)
    const periodFrom = `${month}-01`
    const periodTo = monthEndOf(month)
    // 精算バッチ id（生成した請求/通知を束ね、取消フローが対象を特定するための id = 0037）
    const settlementId = newId('cst')
    const result = await inTxn(pool, async (db) => {
      // 並行 close の直列化（C-1。同一 業態 × 月 の精算を 1 本化。cancel も同一キーで排他）
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`consign:${segmentId}:${month}`])
      // 対象 = 未精算の店舗売上（店舗ロールの得意先・qty > 0）
      const { rows: stores } = await db.query<{ id: string }>(
        `SELECT id FROM companies WHERE partner_roles @> '"store"'::jsonb OR partner_roles @> '["store"]'::jsonb`)
      const storeIds = new Set(stores.map(s => s.id))
      const { rows: sales } = await db.query<{ id: string; companyId: string; skuId: string; qty: number; amount: number; salesDate: string }>(
        `SELECT id, company_id AS "companyId", sku_id AS "skuId", qty, amount, sales_date AS "salesDate"
         FROM sales_records
         WHERE active AND invoice_id IS NULL AND segment_id = $1
           AND sales_date >= $2 AND sales_date <= $3 AND qty > 0
         ORDER BY sales_date, id`, [segmentId, periodFrom, periodTo])
      const rows = sales.filter(r => storeIds.has(r.companyId))
      if (rows.length === 0) throw err('AKO-BIL-006', '対象の未精算 店舗売上がありません', 404)

      const settleByRecord = new Map<string, string>()
      let invoiceCount = 0
      let noticeCount = 0

      // --- 店舗別マージン請求 ---
      const byStore = new Map<string, typeof rows>()
      for (const r of rows) byStore.set(r.companyId, [...(byStore.get(r.companyId) ?? []), r])
      for (const [storeId, storeRows] of byStore) {
        const storeTerm = await termOf(db, storeId, segmentId, 'store')
        const rate = await taxRateValue(db, storeTerm?.taxRateId)
        const snapshot: AkebonoSettlementSnapshot = buildSettlementSnapshot(storeTerm, undefined, rate)
        const salesTotal = storeRows.reduce((s, r) => s + r.amount, 0)
        const billed = calcStoreMargin(salesTotal, snapshot)
        const tax = calcTax(billed, rate, snapshot.taxIncluded, snapshot.rounding)
        const total = snapshot.taxIncluded ? billed : billed + tax
        const id = newId('inv')
        const code = await nextDocCode(db, 'INV')
        const storeShare = Math.round(salesTotal * (snapshot.marginRate ?? 0))
        const l1desc = `委託売上 ${salesTotal.toLocaleString()} 円 − 店舗取り分 ${((snapshot.marginRate ?? 0) * 100).toFixed(0)}%（${storeShare.toLocaleString()} 円）= 当社請求`
        const lines = snapshot.taxIncluded
          ? [{ id: `${id}-l1`, description: `${l1desc}${tax > 0 ? `（うち消費税 ${tax.toLocaleString()} 円）` : ''}`, amount: billed }]
          : [
              { id: `${id}-l1`, description: l1desc, amount: billed },
              ...(tax > 0 ? [{ id: `${id}-l2`, description: `消費税（${(rate * 100).toFixed(0)}%）`, amount: tax }] : []),
            ]
        await db.query(
          `INSERT INTO invoices (id, code, company_id, segment_id, period_from, period_to, invoice_type, status,
             issued_at, total_amount, lines, snapshot, source_record_ids, settlement_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'consignment_margin', 'issued', now(), $7, $8, $9, $10, $11)`,
          [id, code, storeId, segmentId, periodFrom, periodTo, total, JSON.stringify(lines),
            JSON.stringify(snapshot), JSON.stringify(storeRows.map(r => r.id)), settlementId])
        invoiceCount++
        for (const r of storeRows) settleByRecord.set(r.id, id)
      }

      // --- 作家別支払通知 ---
      const byArtist = new Map<string, typeof rows>()
      for (const r of rows) {
        const { rows: art } = await db.query<{ artistId: string | null }>(
          `SELECT p.default_supplier_company_id AS "artistId"
           FROM product_skus s LEFT JOIN products p ON p.id = s.product_id WHERE s.id = $1`, [r.skuId])
        const artistId = art[0]?.artistId
        if (!artistId) continue
        byArtist.set(artistId, [...(byArtist.get(artistId) ?? []), r])
      }
      for (const [artistId, artistRows] of byArtist) {
        const artistTerm = await termOf(db, artistId, segmentId, 'consignor_artist')
        const rate = await taxRateValue(db, artistTerm?.taxRateId)
        const snapshot = buildSettlementSnapshot(undefined, artistTerm, rate)
        const id = newId('pn')
        const code = await nextDocCode(db, 'PN')
        const lines: { id: string; salesRecordId: string; description: string; amount: number }[] = []
        for (const [idx, r] of artistRows.entries()) {
          // purchase_cost 方式は仕入実績から解決（await のため calcPayoutAmount へは解決済みの値を渡す）
          const unitCost = await resolveUnitCost(db, r.skuId)
          lines.push({
            id: `${id}-${idx}`,
            salesRecordId: r.id,
            description: `${r.salesDate} ${await skuLabelOf(db, r.skuId)}（${r.qty}）`,
            amount: calcPayoutAmount(r, snapshot, () => unitCost),
          })
        }
        const payable = lines.reduce((s, l) => s + l.amount, 0)
        await db.query(
          `INSERT INTO payment_notices (id, code, company_id, segment_id, period_from, period_to, status, payable_amount, lines, snapshot, settlement_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10)`,
          [id, code, artistId, segmentId, periodFrom, periodTo, payable, JSON.stringify(lines), JSON.stringify(snapshot), settlementId])
        noticeCount++
      }

      // 対象売上に精算リンク（各売上をその店舗のマージン請求 id へ。再精算防止 = 冪等）。
      // 抽出後に他の請求・精算が同じ売上を紐づけた場合は全体を中止（未請求行のみ更新 + 件数検証 = C-1）
      for (const [recordId, invoiceId] of settleByRecord) {
        const { rowCount } = await db.query(
          `UPDATE sales_records SET invoice_id = $2 WHERE id = $1 AND invoice_id IS NULL`, [recordId, invoiceId])
        if ((rowCount ?? 0) !== 1) {
          throw err('AKO-GEN-003', '対象売上の一部が既に他の請求・精算に紐づいたため精算を中止しました。最新の状態で再実行してください', 409)
        }
      }
      return { invoices: invoiceCount, notices: noticeCount, settlementId }
    })
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'invoices', entityId: `${segmentId}:${month}`,
      detail: `委託精算（請求 ${result.invoices} 件・支払通知 ${result.notices} 件）`,
    })
    return c.json({ data: result }, 201)
  })

  /**
   * 委託精算の取消（原則9.5 = 記録・確定系にも立ち戻る導線）。対象 = 業態 × 月 の精算バッチ。
   * ①店舗マージン請求（consignment_margin・issued）を void + マイナス請求（赤伝 = credit_for）を追記
   * ②対象売上の精算リンク（invoice_id）を解除（再締め可能に戻す）
   * ③作家支払通知を論理取消（voided_at）= 支払通知に赤伝の器が無いため監査列で無効化（0037）
   * 冪等・二重取消ガード: advisory lock（close と同一キー = close/cancel の排他）で直列化し、
   * issued の consignment_margin 請求が無ければ取消対象なし（既に取消済み = 409 AKO-BIL-010）。
   *
   * **下流確定状態の保護（レビュー MAJOR-1）:** バッチに「有効入金のあるマージン請求（paid/部分入金）」
   * または「確定済み支払通知」が 1 件でも含まれる場合は取消を拒否（AKO-BIL-011）。片側だけ反転すると
   * ①paid マージンは status='issued' 条件から外れ void されず孤児入金が残る ②作家支払通知は期間一括で
   * void され再締めで A 分が消える、という整合破壊を招くため。先に入金取消（AKO-BIL-009）を行えば取消可能。
   */
  app.post('/consignment/cancel', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const segmentId = String(body.segmentId ?? '').trim()
    const month = String(body.month ?? '').trim()
    if (!segmentId || !MONTH_RE.test(month)) throw err('AKO-GEN-001', 'segmentId と month（YYYY-MM）を指定してください', 400)
    const periodFrom = `${month}-01`
    const periodTo = monthEndOf(month)
    const result = await inTxn(pool, async (db) => {
      // close と同一キーで排他（並行 close/cancel の直列化 = 二重取消ガードの基盤）
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`consign:${segmentId}:${month}`])
      // 下流確定状態の保護（MAJOR-1）: 有効入金のあるマージン請求 or 確定済み支払通知があれば拒否。
      // status='paid' の paid マージンも含めて検査する（後続の取消対象は issued のみだが、検査は paid も見る）
      const { rows: blockers } = await db.query<{ paidInvoices: number; confirmedNotices: number }>(
        `SELECT
           (SELECT count(*) FROM invoices i
              WHERE i.invoice_type = 'consignment_margin' AND i.credit_for IS NULL
                AND i.segment_id = $1 AND i.period_from = $2 AND i.period_to = $3
                AND i.status IN ('issued','paid')
                AND EXISTS (SELECT 1 FROM payment_receipts r WHERE r.invoice_id = i.id AND r.voided_at IS NULL))::int AS "paidInvoices",
           (SELECT count(*) FROM payment_notices n
              WHERE n.segment_id = $1 AND n.period_from = $2 AND n.period_to = $3
                AND n.voided_at IS NULL AND n.status IN ('confirmed','paid'))::int AS "confirmedNotices"`,
        [segmentId, periodFrom, periodTo])
      if ((blockers[0]!.paidInvoices > 0) || (blockers[0]!.confirmedNotices > 0)) {
        throw err('AKO-BIL-011',
          '入金済み（部分入金含む）のマージン請求、または確定済みの支払通知が含まれるため取消できません。'
          + '先に入金取消を行ってください（確定済み支払通知がある場合は管理者にご相談ください）', 409)
      }
      // 取消対象 = この業態 × 月 の発行済みマージン請求（バッチ）。無ければ「対象なし/取消済み」= 409
      const { rows: margins } = await db.query<{
        id: string; companyId: string; segmentId: string | null; periodFrom: string; periodTo: string
        totalAmount: number; lines: { id: string; description: string; amount: number }[]
        sourceRecordIds: string[]; settlementId: string | null
      }>(
        `SELECT id, company_id AS "companyId", segment_id AS "segmentId", period_from AS "periodFrom",
                period_to AS "periodTo", total_amount AS "totalAmount", lines,
                source_record_ids AS "sourceRecordIds", settlement_id AS "settlementId"
         FROM invoices
         WHERE invoice_type = 'consignment_margin' AND status = 'issued'
           AND credit_for IS NULL
           AND segment_id = $1 AND period_from = $2 AND period_to = $3
         FOR UPDATE`, [segmentId, periodFrom, periodTo])
      if (margins.length === 0) {
        throw err('AKO-BIL-010', '取消対象の委託精算がありません（未実施、または既に取消済みです）', 409)
      }
      let credited = 0
      let unlinked = 0
      for (const inv of margins) {
        // ① 赤伝（マイナス請求）を追記 + 元請求を void
        const creditId = newId('inv')
        const code = await nextDocCode(db, 'INV')
        await db.query(
          `INSERT INTO invoices (id, code, company_id, segment_id, period_from, period_to, invoice_type, status,
             issued_at, total_amount, credit_for, lines, source_record_ids, settlement_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'consignment_margin', 'issued', now(), $7, $8, $9, '[]', $10)`,
          [creditId, code, inv.companyId, inv.segmentId, inv.periodFrom, inv.periodTo, -inv.totalAmount, inv.id,
            JSON.stringify(inv.lines.map(l => ({ ...l, id: l.id + '-c', amount: -l.amount }))), inv.settlementId])
        await db.query(`UPDATE invoices SET status = 'void', updated_at = now() WHERE id = $1`, [inv.id])
        credited++
        // ② 対象売上の精算リンクを解除（再締め可能に。この請求に紐づく行のみ）
        const { rowCount } = await db.query(
          `UPDATE sales_records SET invoice_id = NULL WHERE invoice_id = $1`, [inv.id])
        unlinked += rowCount ?? 0
      }
      // ③ 作家支払通知を論理取消（このバッチ = 業態 × 月 の未取消通知。settlement_id が NULL の旧精算も期間で拾う）
      const { rowCount: voidedNotices } = await db.query(
        `UPDATE payment_notices SET voided_at = now(), voided_by = $4, updated_at = now()
         WHERE segment_id = $1 AND period_from = $2 AND period_to = $3 AND voided_at IS NULL`,
        [segmentId, periodFrom, periodTo, user.id])
      return { credited, unlinked, voidedNotices: voidedNotices ?? 0 }
    })
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'invoices', entityId: `${segmentId}:${month}`,
      detail: `委託精算を取消（赤伝 ${result.credited} 件・支払通知取消 ${result.voidedNotices} 件・売上リンク解除 ${result.unlinked} 件）`,
    })
    return c.json({ data: result })
  })

  // 支払通知の確定（draft → confirmed。以後不変）
  app.post('/payment-notices/:id/confirm', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{ status: string; voidedAt: string | null }>(
        `SELECT status, voided_at AS "voidedAt" FROM payment_notices WHERE id = $1 FOR UPDATE`, [id])
      if (rows.length === 0) throw err('AKO-GEN-002', '支払通知が見つかりません', 404)
      if (rows[0]!.voidedAt) throw err('AKO-BIL-007', '取消済みの支払通知は確定できません', 409)
      if (rows[0]!.status !== 'draft') throw err('AKO-BIL-007', '下書き以外は確定できません', 409)
      const { rows: out } = await db.query(
        `UPDATE payment_notices SET status = 'confirmed', updated_at = now() WHERE id = $1 RETURNING ${PN_COLS}`, [id])
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'payment_notices', entityId: id, detail: '支払通知を確定' })
    return c.json({ data: updated })
  })

  return app
}
