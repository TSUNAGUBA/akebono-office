/**
 * 売上管理 API（F-15）+ mart ETL（バッチ6b）。
 * - sales_monthly が SoT（月次実績。冪等キー = month × company × project_type の UNIQUE upsert）
 * - 参照は認証済み全員（機能ガード 'sales' = F-16 が前段）。表示射影（会計年度集計・KPI）は
 *   shared/domain/fiscal の純粋関数をフロントと共有し、クライアント側で行う
 * - 登録/取込は管理者のみ（最大 500 件/回の一括 upsert）
 * - mart ETL: sales_monthly → fact_sales（app_office 内の mart 互換テーブル。オペレーター判断
 *   2026-07-18）への一方向 ETL（逆流禁止）。冪等キー UNIQUE(tenant_key, source_txn_id)・
 *   監査は mart_load_runs（load_run_id 発行元・追記のみ）。実行は管理者の手動 API と
 *   /jobs/sales-mart-etl（Cloud Scheduler・CRON_SECRET。周期有給付与と同型 = 原則3）の両方
 * エラー: AKO-SAL-001（入力不正）/ 002（顧客(会社)が未登録）/ 003（取込件数の範囲外）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import {
  DEFAULT_FISCAL_START_MONTH, fiscalMonthNoOf, fiscalQuarterOf, fiscalYearOf,
} from '../../../shared/domain/fiscal'
import { PROJECT_TYPES } from '../../../shared/domain/types'
import { requireAdmin } from '../auth'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const PROJECT_TYPE_SET = new Set<string>(PROJECT_TYPES)
const MAX_UPSERT_ROWS = 500
/** 金額の上限（1,000 兆円。bigint オーバーフローによる生 500 を防ぎ AKO-SAL-001 で返すための番兵） */
const MAX_AMOUNT_YEN = 1_000_000_000_000_000

/**
 * mart 互換テーブルのテナントキー（akebono-scm-platform の mart へ接続する際に
 * 実テナントキーへ揃える前提の定数。data-design.md §2 参照）
 */
export const MART_TENANT_KEY = 'akebono'

const SALES_COLS = `id, month, company_id AS "companyId", project_type AS "projectType",
  amount::float8 AS amount, cost::float8 AS cost`

/** 自社（kind='self'）の会計年度開始月（未設定は 4 月。フロント useSales と同じ解釈） */
export async function selfFiscalStartMonth(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ m: number | null }>(
    `SELECT fiscal_start_month AS m FROM companies
     WHERE kind = 'self' AND active = true ORDER BY id LIMIT 1`)
  return rows[0]?.m ?? DEFAULT_FISCAL_START_MONTH
}

interface SalesRowInput {
  month: string
  companyId: string
  projectType: string
  amount: number
  cost: number
}

/** 取込行の検証（形式エラーは行番号付きで返す = 取込ミスの特定を容易に） */
function parseRows(raw: unknown): SalesRowInput[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_UPSERT_ROWS) {
    throw err('AKO-SAL-003', `rows は 1〜${MAX_UPSERT_ROWS} 件の配列で指定してください`, 400)
  }
  return raw.map((r, i) => {
    const row = (r ?? {}) as Record<string, unknown>
    const month = String(row.month ?? '')
    const companyId = String(row.companyId ?? '')
    const projectType = String(row.projectType ?? '')
    const amount = Number(row.amount)
    const cost = Number(row.cost)
    const at = `rows[${i}]`
    if (!MONTH_RE.test(month)) throw err('AKO-SAL-001', `${at}: month は YYYY-MM 形式で指定してください`, 400)
    if (!companyId) throw err('AKO-SAL-001', `${at}: companyId を指定してください`, 400)
    if (!PROJECT_TYPE_SET.has(projectType)) throw err('AKO-SAL-001', `${at}: projectType が不正です`, 400)
    if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(cost) || cost < 0) {
      throw err('AKO-SAL-001', `${at}: amount / cost は 0 以上の数値で指定してください`, 400)
    }
    if (amount > MAX_AMOUNT_YEN || cost > MAX_AMOUNT_YEN) {
      throw err('AKO-SAL-001', `${at}: amount / cost が上限（${MAX_AMOUNT_YEN.toLocaleString('ja-JP')} 円）を超えています`, 400)
    }
    return { month, companyId, projectType, amount: Math.round(amount), cost: Math.round(cost) }
  })
}

/**
 * mart ETL 本体（sales_monthly → fact_sales の一方向・冪等）。
 * 会計期の非正規化は shared/domain/fiscal をフロントと共有（二重実装を作らない = 原則3）。
 * 手動 API と /jobs の両方から呼ばれる。
 */
export async function runSalesEtl(pool: pg.Pool): Promise<{ runId: string; loaded: number }> {
  const runId = newId('lr')
  await pool.query(`INSERT INTO mart_load_runs (id, target) VALUES ($1, 'fact_sales')`, [runId])
  try {
    const fsm = await selfFiscalStartMonth(pool)
    const { rows } = await pool.query<{
      id: string; month: string; companyId: string; projectType: string; amount: string; cost: string
    }>(`SELECT id, month, company_id AS "companyId", project_type AS "projectType",
          amount::text AS amount, cost::text AS cost
        FROM sales_monthly ORDER BY id`)
    const cols = {
      ids: [] as string[], dateKeys: [] as number[], companyIds: [] as string[],
      types: [] as string[], amounts: [] as string[], costs: [] as string[], margins: [] as string[],
      fys: [] as number[], fqs: [] as number[], fms: [] as number[],
    }
    for (const r of rows) {
      cols.ids.push(r.id)
      cols.dateKeys.push(Number(`${r.month.replace('-', '')}01`)) // 月次グレイン = 月初日の yyyymmdd
      cols.companyIds.push(r.companyId)
      cols.types.push(r.projectType)
      cols.amounts.push(r.amount)
      cols.costs.push(r.cost)
      cols.margins.push(String(BigInt(r.amount) - BigInt(r.cost)))
      cols.fys.push(fiscalYearOf(r.month, fsm))
      cols.fqs.push(fiscalQuarterOf(r.month, fsm))
      cols.fms.push(fiscalMonthNoOf(r.month, fsm))
    }
    if (rows.length > 0) {
      await pool.query(
        `INSERT INTO fact_sales (tenant_key, source_txn_id, dim_date_key, customer_company_id,
           project_type, amount, cost, margin, fiscal_year, fiscal_quarter, fiscal_month, load_run_id)
         SELECT $1, t.sid, t.dk, t.cid, t.pt, t.am, t.co, t.mg, t.fy, t.fq, t.fm, $12
         FROM unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::bigint[], $7::bigint[],
                     $8::bigint[], $9::int[], $10::int[], $11::int[])
              AS t(sid, dk, cid, pt, am, co, mg, fy, fq, fm)
         ON CONFLICT (tenant_key, source_txn_id) DO UPDATE SET
           dim_date_key = EXCLUDED.dim_date_key,
           customer_company_id = EXCLUDED.customer_company_id,
           project_type = EXCLUDED.project_type,
           amount = EXCLUDED.amount,
           cost = EXCLUDED.cost,
           margin = EXCLUDED.margin,
           fiscal_year = EXCLUDED.fiscal_year,
           fiscal_quarter = EXCLUDED.fiscal_quarter,
           fiscal_month = EXCLUDED.fiscal_month,
           load_run_id = EXCLUDED.load_run_id`,
        [MART_TENANT_KEY, cols.ids, cols.dateKeys, cols.companyIds, cols.types,
          cols.amounts, cols.costs, cols.margins, cols.fys, cols.fqs, cols.fms, runId])
    }
    await pool.query(
      `UPDATE mart_load_runs SET status = 'done', rows_loaded = $2, finished_at = now() WHERE id = $1`,
      [runId, rows.length])
    return { runId, loaded: rows.length }
  } catch (e) {
    // 実行記録の更新失敗で元エラーを飲み込まない
    await pool.query(
      `UPDATE mart_load_runs SET status = 'error', message = $2, finished_at = now() WHERE id = $1`,
      [runId, (e as Error).message]).catch(() => {})
    throw e
  }
}

export function salesRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 月次売上の一覧（表示射影はクライアント側の共有ロジック。実績データは全期間で高々数千行）
  app.get('/', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${SALES_COLS} FROM sales_monthly ORDER BY month, company_id, project_type LIMIT 10000`)
    return c.json({ data: rows })
  })

  // 月次実績の登録/取込（管理者のみ・一括 upsert = 冪等。単票登録も rows 1 件で共用）
  app.post('/', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as { rows?: unknown }
    const rows = parseRows(body.rows)
    // 顧客(会社)の存在チェック（過去実績の登録を妨げないため active は問わない）
    const companyIds = [...new Set(rows.map(r => r.companyId))]
    const { rows: found } = await pool.query<{ id: string }>(
      `SELECT id FROM companies WHERE id = ANY($1)`, [companyIds])
    const known = new Set(found.map(f => f.id))
    const missing = companyIds.filter(id => !known.has(id))
    if (missing.length > 0) {
      throw err('AKO-SAL-002', `顧客(会社)が未登録です: ${missing.slice(0, 5).join(', ')}`, 400)
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const r of rows) {
        await client.query(
          `INSERT INTO sales_monthly (id, month, company_id, project_type, amount, cost)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (month, company_id, project_type)
           DO UPDATE SET amount = EXCLUDED.amount, cost = EXCLUDED.cost, updated_at = now()`,
          [newId('sm'), r.month, r.companyId, r.projectType, r.amount, r.cost])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    await audit(pool, {
      actorId: user.id, action: 'upsert', entity: 'sales_monthly', entityId: rows[0]?.month ?? '',
      detail: `月次売上を ${rows.length} 件登録/更新`,
    })
    return c.json({ data: { upserted: rows.length } }, 201)
  })

  // mart ETL の手動実行（管理者のみ。Cloud Scheduler 経路は /jobs/sales-mart-etl）
  app.post('/etl/run', async (c) => {
    const user = requireAdmin(c)
    const result = await runSalesEtl(pool)
    // 実行者の追跡（mart_load_runs に actor 列を持たないための補完。非ブロッキング）
    await audit(pool, {
      actorId: user.id, action: 'run', entity: 'mart_load_runs', entityId: result.runId,
      detail: `売上 mart ETL を手動実行（${result.loaded} 件）`,
    })
    return c.json({ data: result })
  })

  // ETL 実行履歴（管理者のみ。運用時の確認用。表示規約どおり JST 文字列で返す）
  app.get('/etl/runs', async (c) => {
    requireAdmin(c)
    const { rows } = await pool.query(
      `SELECT id, target, status, rows_loaded AS "rowsLoaded", message,
              to_char(started_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "startedAt",
              to_char(finished_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "finishedAt"
       FROM mart_load_runs ORDER BY started_at DESC LIMIT 20`)
    return c.json({ data: rows })
  })

  return app
}
