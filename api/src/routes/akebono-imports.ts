/**
 * AKEBONO データ取込・連携 API（F-32。Phase D = 0035）。
 * 取込元（import_sources = 設定系・論理削除で取消）・項目マッピング（import_mappings = 設定系/版管理・
 * 新版追記で旧版は superseded）・取込実行履歴（import_runs = 記録系・追記のみ）を永続化する。
 *
 * - 認可: 参照は認証済み全員（akebono featureGuard の配下）・**書込は管理者のみ**（取込設定は
 *   マスタ運用 = 設定画面の管理者ゲートと一致。imports 画面は管理者専用）。発行・取消は監査ログ。
 * - 取消可能性（原則9.5）: 取込元 = 論理削除 + 復元。マッピング = 新版で上書き（旧版は履歴に残る）。
 *   実行履歴 = 記録系のため訂正しない（監査性。誤登録は新しい実行で上書きされる運用）。
 * - 取込実行（run）: 本フェーズは**取込設定・実行履歴の永続化**が目的（localStorage 依存の解消）。
 *   ステージング → 検証 → 反映の各カウント・隔離行はサーバーが決定的にシミュレートして記録する
 *   （モック useAkebonoImports.runImport と同位置づけ。実ファイル取込・パース・SSRF 対策付き API 接続は
 *   F-32 の後続スコープ = implementation-status §40 残課題）。
 * - エラーコード: AKO-IMP-001（取込元名未入力）/ AKO-IMP-002（有効マッピングなし）/
 *   AKO-IMP-003（マッピング項目なし）。台帳 = api-design §4。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { requireAdmin } from '../auth'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { capCp } from '../lib/text'
import { normalizeFieldLocators, normalizeImportSourceConfig } from '../../../shared/domain/import-parse'
import { nextDocCode } from './akebono-trade'

// 単体テストの後方互換 import 名（実体は shared = フロント/API 共有 = 原則3）
export { normalizeImportSourceConfig as normalizeSourceConfig } from '../../../shared/domain/import-parse'

const IMPORT_METHODS = ['file_csv', 'file_fixed', 'file_json', 'api_pull']
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

/**
 * 取込実行のシミュレート（決定的）。取込元の実行回数から staged/failed を導く（モックの irange と同位置づけ
 * だが決定的 = テスト可能）。マスタ未登録の隔離行を failed>0 のとき 1 件混ぜる（原則4 のエラー行隔離）。
 */
export function simulateRun(runIndex: number): {
  counts: { staged: number; applied: number; skipped: number; failed: number }
  errors: { rowNo: number; rawText: string; message: string }[]
} {
  const staged = 10 + (runIndex * 7) % 21
  const failed = runIndex % 3
  const applied = staged - failed
  const errors = failed > 0
    ? [{ rowNo: 3, rawText: '（サンプル）マスタ未登録の商品コードを含む行', message: '商品コードがマスタ未登録のため隔離（AKO-IMP-010）' }]
    : []
  return { counts: { staged, applied, skipped: 0, failed }, errors }
}

async function requireSource(db: pg.Pool | pg.PoolClient, id: string): Promise<void> {
  const { rows } = await db.query(`SELECT 1 FROM import_sources WHERE id = $1`, [id])
  if (rows.length === 0) throw err('AKO-GEN-002', '取込元が見つかりません', 404)
}

export function akebonoImportsRoutes(pool: pg.Pool): Hono {
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

  // ---------- 取込実行（記録系・追記。決定的シミュレート） ----------

  app.post('/import-runs', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const sourceId = String(body.sourceId ?? '').trim()
    if (!sourceId) throw err('AKO-GEN-001', '取込元を指定してください', 400)
    await requireSource(pool, sourceId)
    const { rows: mrows } = await pool.query<{ version: number }>(
      `SELECT version FROM import_mappings WHERE source_id = $1 AND status = 'active'`, [sourceId])
    if (mrows.length === 0) {
      throw err('AKO-IMP-002', '有効なマッピング定義がありません（先にマッピングを保存してください）', 409)
    }
    const id = newId('impr')
    const created = await inTxn(pool, async (db) => {
      const { rows: crows } = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM import_runs WHERE source_id = $1`, [sourceId])
      const { counts, errors } = simulateRun(crows[0]!.count)
      const code = await nextDocCode(db, 'RUN')
      const { rows } = await db.query(
        `INSERT INTO import_runs (id, code, source_id, mapping_version, started_at, finished_at, status, counts, errors)
         VALUES ($1, $2, $3, $4, now(), now(), 'applied', $5, $6) RETURNING ${RUN_COLS}`,
        [id, code, sourceId, mrows[0]!.version, JSON.stringify(counts), JSON.stringify(errors)])
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
