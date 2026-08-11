/**
 * 改善要望（F-42・オペレーター指示 2026-08-11）の API。
 *
 * - 投稿（POST /requests）は認証済み全員が可能（各ページの「要望を送る」）。
 * - 一覧・集約・ステータス管理は canManageImprovements（deny-by-default + 管理者常時可）でガードする。
 *   featureGuard（PATH_FEATURES）には載せない: 投稿と管理で認可が分かれるため、管理系だけを
 *   ルート内ガード（requireManage）で守る（customer-logs の in-route 認可と同方針）。
 * - 集約（POST /generate）は Vertex AI → 決定的ヒューリスティック（shared/domain/improvement）へ
 *   フォールバックし、未集約の要望のみを処理する。判定済み item のステータス・編集は巻き戻さない（原則2）。
 * - 取消（archive / restore）で要望・改修単位を論理削除／復元できる（原則9.5）。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type pg from 'pg'
import {
  buildCodingPrompt,
  buildItemDetail,
  canTransition,
  capCodePoints,
  CLUSTER_LLM_SCHEMA,
  type ClusterOpenItem,
  type ClusterPlan,
  type ClusterRequestInput,
  heuristicClusterRequests,
  IMPROVEMENT_BODY_CAP,
  IMPROVEMENT_DETAIL_CAP,
  IMPROVEMENT_PAGE_LABEL_CAP,
  IMPROVEMENT_PAGE_PATH_CAP,
  IMPROVEMENT_STATUSES,
  IMPROVEMENT_SUMMARY_CAP,
  IMPROVEMENT_TITLE_CAP,
  type ImprovementFilter,
  type ImprovementStatus,
  improvementBodyError,
  improvementPlanError,
  improvementTitleError,
  matchesImprovementFilter,
  normalizeClusterPlan,
  type PromptItemInput,
} from '../../../shared/domain/improvement'
import { canManageImprovements } from '../../../shared/domain/permissions'
import type { AuthUser } from '../auth'
import type { Env } from '../env'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'

// 時刻は JST ウォールクロック文字列で返す（customer-logs / akebono-trade と同一規約。
// フロントの fmtDate は文字列をそのまま表示するため、生 timestamptz（UTC "…Z"）を返すと
// 0〜9 時台の登録が前日表示になる日付ずれ + モードのパリティ崩れになる = CONVENTIONS「時刻の扱い」）
const JST = `AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"'`
const REQ_COLS = `id, member_id AS "memberId", member_name AS "memberName",
  page_path AS "pagePath", page_label AS "pageLabel", body, item_id AS "itemId",
  to_char(archived_at ${JST}) AS "archivedAt", to_char(created_at ${JST}) AS "createdAt"`
const ITEM_COLS = `id, title, summary, detail, status, page_paths AS "pagePaths",
  source_request_ids AS "sourceRequestIds", llm, to_char(archived_at ${JST}) AS "archivedAt",
  to_char(created_at ${JST}) AS "createdAt", to_char(updated_at ${JST}) AS "updatedAt",
  to_char(resolved_at ${JST}) AS "resolvedAt",
  plan_start AS "planStart", plan_end AS "planEnd"`

/** トランザクション補助（akebono-trade と同型 = 原則3） */
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

/**
 * 投稿本文の検証（投稿 API・単体テストから利用）。エラーは AKO-REQ-001（400）へ変換して throw。
 * ページ情報は投稿元の記録であり、上限で切り詰めるのみ（必須ではない）。
 */
export function improvementRequestInputOf(body: Record<string, unknown>): {
  body: string; pagePath: string; pageLabel: string
} {
  const text = String(body.body ?? '').trim()
  const msg = improvementBodyError(text)
  if (msg) throw err('AKO-REQ-001', msg, 400)
  return {
    body: capCodePoints(text, IMPROVEMENT_BODY_CAP),
    pagePath: capCodePoints(String(body.pagePath ?? '').trim(), IMPROVEMENT_PAGE_PATH_CAP),
    pageLabel: capCodePoints(String(body.pageLabel ?? '').trim(), IMPROVEMENT_PAGE_LABEL_CAP),
  }
}

/** 管理ガード（閲覧・集約・ステータス操作）。deny は AKO-PRM-001 403 */
async function requireManage(c: Context, pool: pg.Pool): Promise<AuthUser> {
  const user = c.get('user')
  const rules = await activePermissionRules(pool)
  if (!canManageImprovements(rules, subjectOf(user))) {
    throw err('AKO-PRM-001', '改善要望を閲覧・管理する権限がありません（管理者にお問い合わせください）', 403)
  }
  return user
}

/** LLM 集約（Vertex → 正規化）。無効環境・失敗・空出力は null（呼び出し側でヒューリスティックへ） */
async function llmCluster(
  env: Env, openItems: ClusterOpenItem[], requests: ClusterRequestInput[],
): Promise<ClusterPlan | null> {
  if (!env.vertexProjectId) return null
  const openForPrompt = openItems
    .filter(it => it.status === 'triage')
    .map(it => ({ id: it.id, pagePaths: it.pagePaths }))
  const raw = await generateJson<unknown>(env, {
    system: 'あなたはソフトウェア改善のトリアージ AI です。利用者から寄せられた改善・改修の要望を、'
      + '実際にコード改修する単位（改修単位）へ分解・集約します。関連する要望はまとめ、無関係なものは分けます。'
      + '既存の未判定の改修単位（openItems）に合致する要望は appends でその itemId に割り当て、'
      + '新しい単位は creates に起こします（title=40字以内の見出し・summary=1〜2文・detail=対象ページや'
      + '機能名を含む改修方針のマークダウン）。requestIds には割り当てた要望の id のみを入れ、id を捏造しないこと。',
    prompt: `# 未判定の既存改修単位(openItems)\n${JSON.stringify(openForPrompt, null, 1)}\n\n`
      + `# 未集約の要望(requests)\n${JSON.stringify(requests, null, 1)}`,
    schema: CLUSTER_LLM_SCHEMA,
    maxTokens: 4000,
  })
  return normalizeClusterPlan(raw, requests, openItems)
}

export function improvementsRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // ---- 投稿（各ページから。認証済み全員可） ----
  app.post('/requests', async (c) => {
    const user = c.get('user')
    const input = improvementRequestInputOf(await c.req.json().catch(() => ({})) as Record<string, unknown>)
    const id = newId('imreq')
    const { rows } = await pool.query(
      `INSERT INTO improvement_requests (id, member_id, member_name, page_path, page_label, body)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${REQ_COLS}`,
      [id, user.id, user.name, input.pagePath, input.pageLabel, input.body])
    return c.json({ data: rows[0] }, 201)
  })

  // ---- 要望一覧（管理）。itemId 指定 = その改修単位の元要望 / unclustered=1 = 未集約の有効要望 ----
  app.get('/requests', async (c) => {
    await requireManage(c, pool)
    const itemId = String(c.req.query('itemId') ?? '').trim()
    const unclustered = c.req.query('unclustered') === '1'
    const includeArchived = c.req.query('includeArchived') === '1'
    const where: string[] = []
    const params: unknown[] = []
    if (itemId) { params.push(itemId); where.push(`item_id = $${params.length}`) }
    if (unclustered) where.push('item_id IS NULL')
    if (!includeArchived) where.push('archived_at IS NULL')
    const sql = `SELECT ${REQ_COLS} FROM improvement_requests`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY created_at DESC, id'
    const { rows } = await pool.query(sql, params)
    return c.json({ data: rows })
  })

  // ---- 要望の取消（論理削除）/ 復元。投稿者本人または管理権限者 ----
  app.post('/requests/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rows } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_requests WHERE id = $1`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
    if (rows[0]!.memberId !== user.id) await requireManage(c, pool)
    const { rows: out } = await pool.query(
      `UPDATE improvement_requests SET archived_at = now() WHERE id = $1 RETURNING ${REQ_COLS}`, [id])
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'improvement_requests', entityId: id, detail: '要望を取消' })
    return c.json({ data: out[0] })
  })

  app.post('/requests/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rows } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_requests WHERE id = $1`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
    if (rows[0]!.memberId !== user.id) await requireManage(c, pool)
    const { rows: out } = await pool.query(
      `UPDATE improvement_requests SET archived_at = NULL WHERE id = $1 RETURNING ${REQ_COLS}`, [id])
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'improvement_requests', entityId: id, detail: '要望の取消を戻す' })
    return c.json({ data: out[0] })
  })

  // ---- 改修単位一覧（管理）。filter で 未解決/解決済み/対応可否を絞る ----
  app.get('/items', async (c) => {
    await requireManage(c, pool)
    const includeArchived = c.req.query('includeArchived') === '1'
    const sql = `SELECT ${ITEM_COLS} FROM improvement_items`
      + (includeArchived ? '' : ' WHERE archived_at IS NULL')
      + ' ORDER BY updated_at DESC, id'
    const { rows } = await pool.query(sql)
    const filter = (String(c.req.query('filter') ?? 'all') as ImprovementFilter)
    const data = rows.filter(r => matchesImprovementFilter((r as { status: ImprovementStatus }).status, filter))
    return c.json({ data })
  })

  // ---- AI 集約（生成・再生成）。未集約の要望のみ処理・判定済み item は不変（原則2） ----
  app.post('/generate', async (c) => {
    const user = await requireManage(c, pool)
    // 未集約かつ有効な要望
    const { rows: reqRows } = await pool.query<ClusterRequestInput>(
      `SELECT id, page_path AS "pagePath", page_label AS "pageLabel", body
       FROM improvement_requests WHERE item_id IS NULL AND archived_at IS NULL ORDER BY created_at, id`)
    if (reqRows.length === 0) {
      return c.json({ data: { created: 0, appended: 0, clustered: 0, llm: false } })
    }
    // 追記先候補 = 未判定・有効な改修単位
    const { rows: openRows } = await pool.query<ClusterOpenItem>(
      `SELECT id, status, page_paths AS "pagePaths" FROM improvement_items
       WHERE status = 'triage' AND archived_at IS NULL`)

    const llmPlan = await llmCluster(env, openRows, reqRows)
    const plan = llmPlan ?? heuristicClusterRequests(openRows, reqRows)
    const llm = !!llmPlan
    const reqById = new Map(reqRows.map(r => [r.id, r]))

    const applied = await inTxn(pool, async (db) => {
      let created = 0
      let appended = 0
      let clustered = 0
      // 新規作成: 先に要望を確保（item_id IS NULL のもののみ RETURNING）してから item を作る。
      // 並行 generate でも「実際に確保できた要望」だけを source にするため、孤児 item（他方が確保済みの
      // 要望を指す item）を作らない。確保 0 件なら item を作らない
      for (const cr of plan.creates) {
        const itemId = newId('imp')
        const { rows: claimed } = await db.query<{ id: string }>(
          `UPDATE improvement_requests SET item_id = $1
           WHERE id = ANY($2::text[]) AND item_id IS NULL AND archived_at IS NULL RETURNING id`,
          [itemId, cr.requestIds])
        if (claimed.length === 0) continue
        const claimedIds = claimed.map(r => r.id)
        await db.query(
          `INSERT INTO improvement_items (id, title, summary, detail, status, page_paths, source_request_ids, llm)
           VALUES ($1, $2, $3, $4, 'triage', $5, $6, $7)`,
          [itemId, cr.title, cr.summary, cr.detail, JSON.stringify(cr.pagePaths),
            JSON.stringify(claimedIds), llm])
        created += 1
        clustered += claimedIds.length
      }
      // 既存の未判定 item への追記（判定済みは対象外 = ステータス保護）。llm フラグは item の作成時属性のため
      // 追記では変更しない（mock も更新しない = 両モード一致）
      for (const ap of plan.appends) {
        const { rows: itemRows } = await db.query<{
          detail: string; pagePaths: string[]; sourceRequestIds: string[]
        }>(
          `SELECT detail, page_paths AS "pagePaths", source_request_ids AS "sourceRequestIds"
           FROM improvement_items WHERE id = $1 AND status = 'triage' AND archived_at IS NULL FOR UPDATE`,
          [ap.itemId])
        if (itemRows.length === 0) continue
        const { rows: claimed } = await db.query<{ id: string }>(
          `UPDATE improvement_requests SET item_id = $1
           WHERE id = ANY($2::text[]) AND item_id IS NULL AND archived_at IS NULL RETURNING id`,
          [ap.itemId, ap.requestIds])
        if (claimed.length === 0) continue
        const cur = itemRows[0]!
        const claimedIds = claimed.map(r => r.id)
        const newReqs = claimedIds.map(id => reqById.get(id)).filter((r): r is ClusterRequestInput => !!r)
        const mergedSources = [...new Set([...(cur.sourceRequestIds ?? []), ...claimedIds])]
        const mergedPaths = [...new Set([
          ...(cur.pagePaths ?? []),
          ...newReqs.map(r => r.pagePath.trim()).filter(Boolean),
        ])]
        const appendedDetail = capCodePoints(
          `${cur.detail}\n\n${buildItemDetail(newReqs)}`, IMPROVEMENT_DETAIL_CAP)
        await db.query(
          `UPDATE improvement_items
           SET source_request_ids = $2, page_paths = $3, detail = $4, updated_at = now()
           WHERE id = $1`,
          [ap.itemId, JSON.stringify(mergedSources), JSON.stringify(mergedPaths), appendedDetail])
        appended += 1
        clustered += claimedIds.length
      }
      return { created, appended, clustered, llm }
    })

    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'improvement_items', entityId: 'cluster',
      detail: `AI集約: 新規${applied.created}・追記${applied.appended}・要望${applied.clustered}件（${llm ? 'LLM' : 'heuristic'}）`,
    })
    return c.json({ data: applied })
  })

  // ---- 改修単位の編集（見出し・要約・詳細。渡したキーのみ更新 = 部分更新） ----
  app.post('/items/:id', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const sets: string[] = []
    const params: unknown[] = [id]
    if (Object.hasOwn(body, 'title')) {
      const title = String(body.title ?? '').trim()
      const msg = improvementTitleError(title)
      if (msg) throw err('AKO-REQ-003', msg, 400)
      params.push(capCodePoints(title, IMPROVEMENT_TITLE_CAP)); sets.push(`title = $${params.length}`)
    }
    if (Object.hasOwn(body, 'summary')) {
      params.push(capCodePoints(String(body.summary ?? '').trim(), IMPROVEMENT_SUMMARY_CAP))
      sets.push(`summary = $${params.length}`)
    }
    if (Object.hasOwn(body, 'detail')) {
      params.push(capCodePoints(String(body.detail ?? '').trim(), IMPROVEMENT_DETAIL_CAP))
      sets.push(`detail = $${params.length}`)
    }
    // 対応予定期間（ガント用・任意）。開始/終了はまとめて更新（空文字 = クリア = NULL・単日は終了なし）
    if (Object.hasOwn(body, 'planStart') || Object.hasOwn(body, 'planEnd')) {
      const ps = String(body.planStart ?? '').trim()
      const pe = String(body.planEnd ?? '').trim()
      const msg = improvementPlanError(ps, pe)
      if (msg) throw err('AKO-REQ-007', msg, 400)
      params.push(ps || null); sets.push(`plan_start = $${params.length}`)
      params.push(pe || null); sets.push(`plan_end = $${params.length}`)
    }
    if (sets.length === 0) throw err('AKO-REQ-004', '更新する項目がありません', 400)
    const { rows } = await pool.query(
      `UPDATE improvement_items SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND archived_at IS NULL RETURNING ${ITEM_COLS}`, params)
    if (rows.length === 0) throw err('AKO-REQ-002', '対象の改修単位が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'improvement_items', entityId: id, detail: '改修単位を編集' })
    return c.json({ data: rows[0] })
  })

  // ---- ステータス変更（状態機械で検証。解決 → 対応する等の reopen 可 = 原則9.5） ----
  app.post('/items/:id/status', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const status = String(((await c.req.json().catch(() => ({}))) as { status?: unknown }).status ?? '')
    if (!IMPROVEMENT_STATUSES.includes(status as ImprovementStatus)) {
      throw err('AKO-REQ-005', 'status が不正です', 400)
    }
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{ status: ImprovementStatus }>(
        `SELECT status FROM improvement_items WHERE id = $1 AND archived_at IS NULL FOR UPDATE`, [id])
      if (rows.length === 0) throw err('AKO-REQ-002', '対象の改修単位が見つかりません', 404)
      const from = rows[0]!.status
      const to = status as ImprovementStatus
      // 同一ステータスの再送は no-op（resolved_at・updated_at を無用に上書きしない）
      if (from === to) {
        const { rows: same } = await db.query(`SELECT ${ITEM_COLS} FROM improvement_items WHERE id = $1`, [id])
        return same[0]
      }
      if (!canTransition(from, to)) {
        throw err('AKO-REQ-006', `「${from}」から「${to}」へは変更できません`, 409)
      }
      const resolvedExpr = to === 'resolved' ? 'now()' : 'NULL'
      const { rows: out } = await db.query(
        `UPDATE improvement_items SET status = $2, resolved_at = ${resolvedExpr}, updated_at = now()
         WHERE id = $1 RETURNING ${ITEM_COLS}`, [id, to])
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'improvement_items', entityId: id, detail: `ステータス → ${status}` })
    return c.json({ data: updated })
  })

  // ---- 改修単位の取消（論理削除）/ 復元 ----
  app.post('/items/:id/archive', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const { rows } = await pool.query(
      `UPDATE improvement_items SET archived_at = now(), updated_at = now()
       WHERE id = $1 RETURNING ${ITEM_COLS}`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象の改修単位が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'improvement_items', entityId: id, detail: '改修単位を取消' })
    return c.json({ data: rows[0] })
  })

  app.post('/items/:id/restore', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const { rows } = await pool.query(
      `UPDATE improvement_items SET archived_at = NULL, updated_at = now()
       WHERE id = $1 RETURNING ${ITEM_COLS}`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象の改修単位が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'improvement_items', entityId: id, detail: '改修単位の取消を戻す' })
    return c.json({ data: rows[0] })
  })

  // ---- 改修プロンプト出力（フィルター結果 → コーディング AI エージェント向けプロンプト） ----
  app.post('/prompt', async (c) => {
    await requireManage(c, pool)
    const body = await c.req.json().catch(() => ({})) as { filter?: unknown; includeArchived?: unknown }
    const filter = (String(body.filter ?? 'open') as ImprovementFilter)
    const { rows: itemRows } = await pool.query<{
      id: string; title: string; summary: string; detail: string;
      status: ImprovementStatus; pagePaths: string[]
    }>(
      `SELECT id, title, summary, detail, status, page_paths AS "pagePaths"
       FROM improvement_items WHERE archived_at IS NULL ORDER BY updated_at DESC, id`)
    const matched = itemRows.filter(r => matchesImprovementFilter(r.status, filter))
    // 各改修単位の元要望（有効なもの）を 1 クエリでまとめて取得し JS でグルーピング（N+1 回避）
    const ids = matched.map(m => m.id)
    const byItem = new Map<string, { pageLabel: string; pagePath: string; body: string }[]>()
    if (ids.length > 0) {
      const { rows: reqRows } = await pool.query<{ itemId: string; pageLabel: string; pagePath: string; body: string }>(
        `SELECT item_id AS "itemId", page_label AS "pageLabel", page_path AS "pagePath", body
         FROM improvement_requests WHERE item_id = ANY($1::text[]) AND archived_at IS NULL
         ORDER BY created_at, id`, [ids])
      for (const r of reqRows) {
        const arr = byItem.get(r.itemId)
        const entry = { pageLabel: r.pageLabel, pagePath: r.pagePath, body: r.body }
        if (arr) arr.push(entry)
        else byItem.set(r.itemId, [entry])
      }
    }
    const promptItems: PromptItemInput[] = matched.map(it => ({
      title: it.title, summary: it.summary, detail: it.detail, status: it.status,
      pagePaths: it.pagePaths ?? [], requests: byItem.get(it.id) ?? [],
    }))
    return c.json({ data: { prompt: buildCodingPrompt(promptItems), count: promptItems.length } })
  })

  return app
}
