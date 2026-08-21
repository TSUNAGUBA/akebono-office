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
  buildUnclusterNoteBody,
  canTransition,
  capCodePoints,
  CLUSTER_LLM_SCHEMA,
  type ClusterOpenItem,
  type ClusterPlan,
  type ClusterRequestInput,
  heuristicClusterRequests,
  IMPROVEMENT_BODY_CAP,
  IMPROVEMENT_DETAIL_CAP,
  IMPROVEMENT_NOTE_CAP,
  IMPROVEMENT_PAGE_LABEL_CAP,
  IMPROVEMENT_PAGE_PATH_CAP,
  IMPROVEMENT_TARGET_SPOT_CAP,
  IMPROVEMENT_STATUSES,
  IMPROVEMENT_SUMMARY_CAP,
  IMPROVEMENT_COMMENT_CAP,
  IMPROVEMENT_REQUEST_ADOPTIONS,
  IMPROVEMENT_REQUEST_STATUSES,
  IMPROVEMENT_TITLE_CAP,
  type ImprovementFilter,
  type ImprovementNoteKind,
  type ImprovementRequestAdoption,
  type ImprovementRequestImage,
  type ImprovementRequestStatus,
  type ImprovementRequestTag,
  type ImprovementStatus,
  improvementAdoptionError,
  improvementBodyError,
  improvementCommentError,
  improvementImagesError,
  improvementEditChangedLabel,
  improvementLinksError,
  improvementNoteError,
  improvementPlanError,
  improvementRequestEditFields,
  improvementRevisitError,
  improvementTitleError,
  improvementUnclusterError,
  matchesImprovementFilter,
  normalizeClusterPlan,
  normalizeImprovementImages,
  normalizeImprovementLinks,
  normalizeImprovementPagePath,
  normalizeImprovementTags,
  type PromptItemInput,
} from '../../../shared/domain/improvement'
import { todayJst } from '../../../shared/domain/jst'
import { canManageImprovements } from '../../../shared/domain/permissions'
import type { AuthUser } from '../auth'
import type { Env } from '../env'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { notifyAdmins } from '../lib/notify'

// 時刻は JST ウォールクロック文字列で返す（customer-logs / akebono-trade と同一規約。
// フロントの fmtDate は文字列をそのまま表示するため、生 timestamptz（UTC "…Z"）を返すと
// 0〜9 時台の登録が前日表示になる日付ずれ + モードのパリティ崩れになる = CONVENTIONS「時刻の扱い」）
const JST = `AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"'`
/**
 * 要望列（withImages=false は images を空配列で返す = 全件一覧の転送量削減。
 * 添付画像の data URI は 1 件最大 400,000 字のため、全件 GET に含めると応答が肥大する。
 * 画像の実体は itemId 指定の GET（ドロワーの遅延ロード）でのみ返す）
 */
const reqColsOf = (withImages: boolean): string => `id, member_id AS "memberId", member_name AS "memberName",
  page_path AS "pagePath", page_label AS "pageLabel", target_spot AS "targetSpot", body, status, adoption, tags, links,
  ${withImages ? 'images' : `'[]'::jsonb AS images`}, item_id AS "itemId",
  excluded_item_ids AS "excludedItemIds",
  to_char(archived_at ${JST}) AS "archivedAt", to_char(edited_at ${JST}) AS "editedAt",
  to_char(created_at ${JST}) AS "createdAt"`
const ITEM_COLS = `id, title, summary, detail, status, page_paths AS "pagePaths",
  source_request_ids AS "sourceRequestIds", llm, to_char(archived_at ${JST}) AS "archivedAt",
  to_char(created_at ${JST}) AS "createdAt", to_char(updated_at ${JST}) AS "updatedAt",
  to_char(resolved_at ${JST}) AS "resolvedAt",
  plan_start AS "planStart", plan_end AS "planEnd", revisit_on::text AS "revisitOn"`
const NOTE_COLS = `id, item_id AS "itemId", member_id AS "memberId", member_name AS "memberName",
  body, kind, to_char(archived_at ${JST}) AS "archivedAt", to_char(created_at ${JST}) AS "createdAt"`
const COMMENT_COLS = `id, request_id AS "requestId", member_id AS "memberId", member_name AS "memberName",
  body, to_char(archived_at ${JST}) AS "archivedAt", to_char(created_at ${JST}) AS "createdAt"`

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
 * 投稿本文の検証（投稿 API・単体テストから利用）。エラーは AKO-REQ-001（本文）/
 * AKO-REQ-009（リンク）/ AKO-REQ-010（画像）の 400 へ変換して throw。
 * ページ情報は投稿元の記録であり、上限で切り詰めるのみ（必須ではない）。
 * リンク・画像は任意の添付（正規化 + 件数/形式/上限を shared 検証 = mock と両モード parity）。
 * タグ（壁打ち/お任せ = F-42-17）は allowlist 正規化のみ（未知値は落とす = エラーにしない）。
 */
export function improvementRequestInputOf(body: Record<string, unknown>): {
  body: string; pagePath: string; pageLabel: string; targetSpot: string; links: string[]
  images: ImprovementRequestImage[]; tags: ImprovementRequestTag[]
} {
  const text = String(body.body ?? '').trim()
  const msg = improvementBodyError(text)
  if (msg) throw err('AKO-REQ-001', msg, 400)
  const links = normalizeImprovementLinks(body.links)
  const linksMsg = improvementLinksError(links)
  if (linksMsg) throw err('AKO-REQ-009', linksMsg, 400)
  const images = normalizeImprovementImages(body.images)
  const imagesMsg = improvementImagesError(images)
  if (imagesMsg) throw err('AKO-REQ-010', imagesMsg, 400)
  return {
    body: capCodePoints(text, IMPROVEMENT_BODY_CAP),
    // アプリ内パスのみ保持（'//host' 等は '' へ = 対象ページリンク化 F-42-20 に伴う防御。R1 監査 MAJOR-1）
    pagePath: capCodePoints(normalizeImprovementPagePath(body.pagePath), IMPROVEMENT_PAGE_PATH_CAP),
    pageLabel: capCodePoints(String(body.pageLabel ?? '').trim(), IMPROVEMENT_PAGE_LABEL_CAP),
    // 対象箇所（ページ内のどこか = 自由入力・任意。改修依頼 2026-08-19 第4弾）
    targetSpot: capCodePoints(String(body.targetSpot ?? '').trim(), IMPROVEMENT_TARGET_SPOT_CAP),
    links,
    images,
    tags: normalizeImprovementTags(body.tags),
  }
}

/** 管理ガード（閲覧・集約・ステータス操作）。deny は AKO-PRM-001 403 */
async function requireManage(c: Context, pool: pg.Pool): Promise<AuthUser> {
  const user = c.get('user')
  if (!(await canManage(pool, user))) {
    throw err('AKO-PRM-001', '改善要望を閲覧・管理する権限がありません（管理者にお問い合わせください）', 403)
  }
  return user
}

/** 管理権限の判定のみ（throw しない版。本人操作との複合ガードで使う） */
async function canManage(pool: pg.Pool, user: AuthUser): Promise<boolean> {
  const rules = await activePermissionRules(pool)
  return canManageImprovements(rules, subjectOf(user))
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
      + '機能名を含む改修方針のマークダウン）。requestIds には割り当てた要望の id のみを入れ、id を捏造しないこと。'
      + 'excludeItemIds を持つ要望は「集約の解除」でその改修単位から外されたものです。そこに含まれる itemId へは割り当てないこと。',
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
    // RETURNING は画像実体を含めない（クライアントは id しか読まず、アップロードした data URI をそのまま
    // 返すのは転送量の無駄 = 一覧 GET と同じ姿勢。実体は itemId 指定 GET でのみ返す）
    const { rows } = await pool.query(
      `INSERT INTO improvement_requests (id, member_id, member_name, page_path, page_label, target_spot, body, tags, links, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${reqColsOf(false)}`,
      [id, user.id, user.name, input.pagePath, input.pageLabel, input.targetSpot, input.body,
        JSON.stringify(input.tags), JSON.stringify(input.links), JSON.stringify(input.images)])
    return c.json({ data: rows[0] }, 201)
  })

  // ---- 要望一覧。認証済み全員が閲覧できる（改修依頼 2026-08-19 第4弾: 全要望を閲覧可）。
  // ただし取消済み（includeArchived）は管理権限者のみ = 一般利用者には有効な要望のみ返す。
  // itemId 指定 = その改修単位の元要望 / unclustered=1 = 未集約の有効要望 ----
  app.get('/requests', async (c) => {
    const user = c.get('user')
    const rules = await activePermissionRules(pool)
    const canManage = canManageImprovements(rules, subjectOf(user))
    const itemId = String(c.req.query('itemId') ?? '').trim()
    const unclustered = c.req.query('unclustered') === '1'
    // 取消済みの閲覧は管理権限者のみ（一般利用者は archived_at IS NULL 固定 = 有効な全要望）
    const includeArchived = canManage && c.req.query('includeArchived') === '1'
    const where: string[] = []
    const params: unknown[] = []
    if (itemId) { params.push(itemId); where.push(`item_id = $${params.length}`) }
    if (unclustered) where.push('item_id IS NULL')
    if (canManage) {
      if (!includeArchived) where.push('archived_at IS NULL')
    } else {
      // 一般利用者: 有効な全要望 + 自分の取消済み（自分の取消は本人が復元できる = 原則9.5）。他者の取消済みは非表示
      params.push(user.id)
      where.push(`(archived_at IS NULL OR member_id = $${params.length})`)
    }
    // 画像の実体は絞り込み指定時のみ（itemId = 改修単位ドロワー / unclustered=1 = 生要望ドロワーの遅延ロード。
    // 全件一覧は '[]' = 転送量削減。レビュー指摘 2026-08-17）
    const sql = `SELECT ${reqColsOf(Boolean(itemId) || unclustered)} FROM improvement_requests`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY created_at DESC, id'
    const { rows } = await pool.query(sql, params)
    // 選別（adoption）・集約解除履歴（excludedItemIds）は管理系のトリアージ状態のため一般利用者へは返さない
    // （UI でも管理者のみ表示 = 情報開示の一貫性。R1 監査反映・改修依頼 2026-08-19 第4弾）。
    // 要望本文・投稿者・要望ステータス（open/resolved/dismissed）は全員可（受付箱・要望カンバンで参照）。
    if (!canManage) {
      for (const r of rows as Record<string, unknown>[]) { delete r.adoption; delete r.excludedItemIds }
    }
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
      `UPDATE improvement_requests SET archived_at = now() WHERE id = $1 RETURNING ${reqColsOf(false)}`, [id])
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
      `UPDATE improvement_requests SET archived_at = NULL WHERE id = $1 RETURNING ${reqColsOf(false)}`, [id])
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'improvement_requests', entityId: id, detail: '要望の取消を戻す' })
    return c.json({ data: out[0] })
  })

  // ---- 要望本文の編集（投稿者本人または管理権限者。改修依頼 2026-08-18） ----
  // 編集は上書きだが edited_at を記録して「編集済み」を明示（再編集で戻せる = 原則9.5）。
  // 取消済みは編集不可（先に復元する = 論理削除の状態保護）。集約済みは編集可
  // （改修プロンプトは再生成時に現行本文を読むため、明確化の編集が反映される）
  app.post('/requests/:id/edit', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    // 本文・タグ・リンク・画像を投稿時と同一ルールで検証する（shared = mock とパリティ。
    // 改修依頼 2026-08-19: 登録時の項目をすべて編集可能に。全項目の置き換え = 現行値を初期表示して送る前提）
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const parsed = improvementRequestEditFields(raw)
    if (!parsed.ok) throw err(parsed.error.code, parsed.error.message, 400)
    const fields = parsed.value
    // 権限確認を先に行う（mock と同一の判定順 = 権限の無い第三者へ取消状態を漏らさない。member_id は不変のため tx 外で可）
    const { rows: reqRows } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_requests WHERE id = $1`, [id])
    if (reqRows.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
    if (reqRows[0]!.memberId !== user.id) await requireManage(c, pool)
    // 変更前本文の捕捉 → 上書き → 監査記録を同一トランザクション（FOR UPDATE 直列化）で原子的に行う:
    // 並行編集でも各監査行が「直前の本文」を正しく残し（レビュー R4）、取消との競合も締め出す。
    // 記録系（原則2）の本文上書きでは監査記録の全文保存が復元可能性の担保 = 主フローの一部のため、
    // 非ブロッキングの audit() ではなく tx 内 INSERT を使う（失敗 = ROLLBACK で本文を失わない）
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: prev } = await client.query<{ body: string; archivedAt: string | null }>(
        `SELECT body, to_char(archived_at ${JST}) AS "archivedAt"
         FROM improvement_requests WHERE id = $1 FOR UPDATE`, [id])
      if (prev.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
      if (prev[0]!.archivedAt) throw err('AKO-REQ-015', '取消済みの要望は編集できません（先に復元してください）', 409)
      // 部分更新: リクエストに実在した項目のみ SET する（未指定の tags/links/images は現行値を保持 =
      // CLAUDE.md の部分更新の鉄則。UI は常に全項目を送るため実質は全項目編集）。body・edited_at は常に更新。
      // 単一行の応答は images の実体も返す（'[]' で伏せると、応答をキャッシュへマージする
      // クライアントが添付を消してしまう = 保存データを正しく表現する。レビュー R14）
      const sets = ['body = $2', 'edited_at = now()']
      const params: unknown[] = [id, fields.body]
      if (fields.tags !== undefined) { params.push(JSON.stringify(fields.tags)); sets.push(`tags = $${params.length}`) }
      if (fields.links !== undefined) { params.push(JSON.stringify(fields.links)); sets.push(`links = $${params.length}`) }
      if (fields.images !== undefined) { params.push(JSON.stringify(fields.images)); sets.push(`images = $${params.length}`) }
      const { rows } = await client.query(
        `UPDATE improvement_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING ${reqColsOf(true)}`, params)
      // 監査記録は「変更した項目」も残す（添付の変更を後から追える = 監査証跡。本文は復元可能なよう全文保存。
      // 画像実体は data URI で肥大するため detail には残さない = 添付の取消導線は「再編集」〔原則9.5〕が担う）。
      // 変更項目ラベルは shared 純関数で mock と共有（原則3。文言・順序のズレを作らない）
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1, 'update', 'improvement_requests', $2, $3)`,
        [user.id, id, `要望を編集（変更項目: ${improvementEditChangedLabel(fields)}／変更前本文: ${prev[0]!.body}）`])
      await client.query('COMMIT')
      return c.json({ data: rows[0] })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })

  // ---- 要望の選別（採用/不採用。管理）。採用のみ AI 集約対象（改善要望 2026-08-17 第 2 弾） ----
  app.post('/requests/:id/adoption', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const adoption = String(((await c.req.json().catch(() => ({}))) as { adoption?: unknown }).adoption ?? '')
    if (!IMPROVEMENT_REQUEST_ADOPTIONS.includes(adoption as ImprovementRequestAdoption)) {
      throw err('AKO-REQ-012', 'adoption が不正です（pending / adopted / declined）', 400)
    }
    // 集約済み（item_id あり）の要望は選別対象外（改修単位へ取り込み済みの記録を巻き戻さない = 原則2。
    // 対象から外すときは「集約の解除」（/uncluster = F-42-19）または要望の取消 = archive を使う）。
    // 取消済み（archived_at あり）も対象外（UI は取消済みに選別操作を出さない。一括選別の
    // 古い選択が取消直後の行を黙って書き換えない = レビュー指摘 2026-08-18。先に復元する）
    const { rows } = await pool.query(
      `UPDATE improvement_requests SET adoption = $2
       WHERE id = $1 AND item_id IS NULL AND archived_at IS NULL RETURNING ${reqColsOf(false)}`, [id, adoption])
    if (rows.length === 0) {
      // 理由の特定は共有ガード（存在 → 取消済み → 集約済み = mock・一括仕分けと同一判定 = 原則6）。
      // archived_at は他ルート同様 to_char（生 timestamptz は Date で返り型宣言と食い違う）
      const { rows: exists } = await pool.query<{ itemId: string | null; archivedAt: string | null }>(
        `SELECT item_id AS "itemId", to_char(archived_at ${JST}) AS "archivedAt" FROM improvement_requests WHERE id = $1`, [id])
      const guard = improvementAdoptionError(exists[0])
        // UPDATE と SELECT の間に状態が戻った極小の競合窓: 変更は適用されていないため conflict として返す
        // （019 = 取消済みとは別コード。復元では直らない一時競合のため再読み込みを案内 = レビュー R3）
        ?? { code: 'AKO-REQ-020', message: '要望の状態が変わったため選別を変更できませんでした（再読み込みしてください）' }
      throw err(guard.code, guard.message, guard.code === 'AKO-REQ-002' ? 404 : 409)
    }
    await audit(pool, { actorId: user.id, action: 'update', entity: 'improvement_requests', entityId: id, detail: `要望の選別 → ${adoption}` })
    return c.json({ data: rows[0] })
  })

  // ---- 集約の解除（F-42-19・改修依頼 2026-08-18。管理）。要望を改修単位から外し、
  //      「採用済み（集約待ち）」へ戻す = 再度 AI 集約の対象にする（取消 archive と違い要望は生きたまま）。
  //      item のステータス・本文には触れない（人手の記録は不変 = 原則2。表示・プロンプトの元要望は
  //      request.item_id が SoT のため解除だけで外れる）。source_request_ids のトレースも除去して整合（原則6） ----
  app.post('/requests/:id/uncluster', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const updated = await inTxn(pool, async (db) => {
      // ロック順を generate の追記（item → request）と揃える（逆順 = デッドロック窓 → 生の 500。レビュー R13）:
      // 無ロックで対象 item を先読み → item をロック → request をロックし、間に item_id が
      // 変わっていないか再検証する（変わっていれば競合 409 = 再読み込みを案内）
      const { rows: peek } = await db.query<{ itemId: string | null }>(
        `SELECT item_id AS "itemId" FROM improvement_requests WHERE id = $1`, [id])
      if (peek.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
      const peekItemId = peek[0]!.itemId
      let lockedItem: { status: ImprovementStatus; archivedAt: string | null } | null = null
      if (peekItemId) {
        const { rows: itemRows } = await db.query<{ status: ImprovementStatus; archivedAt: string | null }>(
          `SELECT status, to_char(archived_at ${JST}) AS "archivedAt"
           FROM improvement_items WHERE id = $1 FOR UPDATE`, [peekItemId])
        lockedItem = itemRows[0] ?? null
      }
      const { rows } = await db.query<{ itemId: string | null; archivedAt: string | null; body: string }>(
        `SELECT item_id AS "itemId", to_char(archived_at ${JST}) AS "archivedAt", body
         FROM improvement_requests WHERE id = $1 FOR UPDATE`, [id])
      // 要望側のガード（存在/未集約/取消済み）→ 競合（020）→ item 側のガード（取消済み = 022・
      // 決着済み = 021。item 情報は peekItemId のものと確定した後に適用する）の順で判定
      const requestGuard = improvementUnclusterError(rows[0])
      if (requestGuard) throw err(requestGuard.code, requestGuard.message, requestGuard.code === 'AKO-REQ-002' ? 404 : 409)
      const itemId = rows[0]!.itemId!
      if (itemId !== peekItemId) {
        throw err('AKO-REQ-020', '要望の状態が変わったため集約を解除できませんでした（再読み込みしてください）', 409)
      }
      const guard = improvementUnclusterError(rows[0], lockedItem)
      if (guard) throw err(guard.code, guard.message, 409)
      // 解除後は採用済みへ明示的に戻す（旧データ = adoption 未定義でも clusterTargetRequests の対象になる）。
      // excluded_item_ids へ元 item を追記（解除の履歴 = 蓄積・クリアしない）: 次回以降の集約で
      // そこへは再追記しない（同じ単位への往復 + detail 重複・「対象外」メモとの矛盾を防ぐ = レビュー R6。
      // 同一 item は履歴に一度外れると戻れないため重複追記は起きないが、@> ガードで冪等にする）
      const { rows: out } = await db.query(
        `UPDATE improvement_requests SET item_id = NULL, adoption = 'adopted',
           excluded_item_ids = CASE WHEN excluded_item_ids @> to_jsonb($2::text)
             THEN excluded_item_ids ELSE excluded_item_ids || to_jsonb($2::text) END
         WHERE id = $1 RETURNING ${reqColsOf(false)}`, [id, itemId])
      await db.query(
        `UPDATE improvement_items SET source_request_ids = (
           SELECT COALESCE(jsonb_agg(x), '[]'::jsonb)
           FROM jsonb_array_elements_text(source_request_ids) AS t(x) WHERE x <> $2
         ), updated_at = now() WHERE id = $1`, [itemId, id])
      // 元 item の detail（人手編集されうる = 原則2で書き換えない）には解除した要望の記載が残るため、
      // 「対象から外れた」修正メモを残す（buildCodingPrompt の担当者メモに載り、旧記載の再実装を防ぐ =
      // プロンプト整合の担保 = 主フローの一部。文言は shared 共有 = mock と同一。レビュー R4）
      await db.query(
        `INSERT INTO improvement_notes (id, item_id, member_id, member_name, body, kind)
         VALUES ($1, $2, $3, $4, $5, 'note')`,
        [newId('imnote'), itemId, user.id, user.name, buildUnclusterNoteBody(rows[0]!.body)])
      return out[0]
    })
    await audit(pool, { actorId: user.id, action: 'update', entity: 'improvement_requests', entityId: id, detail: '集約を解除（再度 AI 集約の対象へ）' })
    return c.json({ data: updated })
  })

  // ---- 生要望へのコメント（やり取り。記録系・追記のみ = 改善要望 2026-08-17 第 2 弾） ----
  // 一覧: requestId 指定でその要望のコメント / 未指定は全件（管理ページの一括ロード用）。既定は有効のみ
  app.get('/request-comments', async (c) => {
    await requireManage(c, pool)
    const requestId = String(c.req.query('requestId') ?? '').trim()
    const includeArchived = c.req.query('includeArchived') === '1'
    const where: string[] = []
    const params: unknown[] = []
    if (requestId) { params.push(requestId); where.push(`request_id = $${params.length}`) }
    if (!includeArchived) where.push('archived_at IS NULL')
    const sql = `SELECT ${COMMENT_COLS} FROM improvement_request_comments`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY created_at, id' // 時系列（古い順）
    const { rows } = await pool.query(sql, params)
    return c.json({ data: rows })
  })

  // 追加: 管理権限者 or 投稿者本人（採用/不採用の検討・確認事項のやり取りを時系列で残す）
  app.post('/requests/:id/comments', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const text = String(((await c.req.json().catch(() => ({}))) as { body?: unknown }).body ?? '').trim()
    const msg = improvementCommentError(text)
    if (msg) throw err('AKO-REQ-014', msg, 400)
    const { rows: reqRows } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_requests WHERE id = $1 AND archived_at IS NULL`, [id])
    if (reqRows.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
    if (reqRows[0]!.memberId !== user.id) await requireManage(c, pool)
    const commentId = newId('imcmt')
    const { rows } = await pool.query(
      `INSERT INTO improvement_request_comments (id, request_id, member_id, member_name, body)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COMMENT_COLS}`,
      [commentId, id, user.id, user.name, capCodePoints(text, IMPROVEMENT_COMMENT_CAP)])
    await audit(pool, { actorId: user.id, action: 'create', entity: 'improvement_request_comments', entityId: commentId, detail: '要望へコメント' })
    return c.json({ data: rows[0] }, 201)
  })

  // コメントの取消（論理削除）/ 復元。記入者本人または管理権限者（原則9.5）
  app.post('/request-comments/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rows } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_request_comments WHERE id = $1`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象のコメントが見つかりません', 404)
    if (rows[0]!.memberId !== user.id) await requireManage(c, pool)
    const { rows: out } = await pool.query(
      `UPDATE improvement_request_comments SET archived_at = now() WHERE id = $1 RETURNING ${COMMENT_COLS}`, [id])
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'improvement_request_comments', entityId: id, detail: 'コメントを取消' })
    return c.json({ data: out[0] })
  })

  app.post('/request-comments/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rows } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_request_comments WHERE id = $1`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象のコメントが見つかりません', 404)
    if (rows[0]!.memberId !== user.id) await requireManage(c, pool)
    const { rows: out } = await pool.query(
      `UPDATE improvement_request_comments SET archived_at = NULL WHERE id = $1 RETURNING ${COMMENT_COLS}`, [id])
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'improvement_request_comments', entityId: id, detail: 'コメントの取消を戻す' })
    return c.json({ data: out[0] })
  })

  // ---- 要望ステータス変更（管理）。要望 1 件ずつの対応状況タグ（open/resolved/dismissed。遷移自由 = 原則9.5） ----
  // 要望ステータス変更。管理者 = 任意の遷移 / 起票者本人 = 自分の要望の resolved ⇄ open のみ
  // （改善要望 2026-08-21: 「運用対応」になった要望を起票者が「解決済み」へ移す運用。open へ戻せる =
  //   誤操作の取消フロー = 原則9.5。dismissed の付与・解除は従来どおり管理者のみ）
  app.post('/requests/:id/status', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const status = String(((await c.req.json().catch(() => ({}))) as { status?: unknown }).status ?? '')
    if (!IMPROVEMENT_REQUEST_STATUSES.includes(status as ImprovementRequestStatus)) {
      throw err('AKO-REQ-011', 'status が不正です（open / resolved / dismissed）', 400)
    }
    if (!(await canManage(pool, user))) {
      const { rows: own } = await pool.query<{ memberId: string }>(
        `SELECT member_id AS "memberId" FROM improvement_requests WHERE id = $1`, [id])
      if (own.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
      if (own[0]!.memberId !== user.id || (status !== 'resolved' && status !== 'open')) {
        throw err('AKO-PRM-001', 'この操作の権限がありません（自分の要望の解決済み/未対応の切替のみ可能です）', 403)
      }
    }
    const { rows } = await pool.query(
      `UPDATE improvement_requests SET status = $2 WHERE id = $1 RETURNING ${reqColsOf(false)}`, [id, status])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'improvement_requests', entityId: id, detail: `要望ステータス → ${status}` })
    return c.json({ data: rows[0] })
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

  // ---- AI 集約（生成・再生成）。**採用（adopted）済み**かつ未集約の要望のみ処理・判定済み item は不変（原則2）。
  //      未選別・不採用の要望は集約されない（管理者の取捨選択が先 = 改善要望 2026-08-17 第 2 弾） ----
  app.post('/generate', async (c) => {
    const user = await requireManage(c, pool)
    // 採用済み・未集約かつ有効な要望（excluded_item_ids = 「集約の解除」の履歴 = そこへは再追記しない）
    const { rows: reqRows } = await pool.query<ClusterRequestInput>(
      `SELECT id, page_path AS "pagePath", page_label AS "pageLabel", body,
         excluded_item_ids AS "excludeItemIds"
       FROM improvement_requests
       WHERE item_id IS NULL AND archived_at IS NULL AND adoption = 'adopted' ORDER BY created_at, id`)
    if (reqRows.length === 0) {
      return c.json({ data: { created: 0, appended: 0, clustered: 0, llm: false } })
    }
    // 追記先候補 = 未判定・有効な改修単位。ORDER BY で追記先の選択を決定的にする
    // （解除 → 再集約で同一ページの triage item が複数できるのは通常ケース。無順序だと追記先が
    // 実行ごとに揺れ、mock の挿入順（作成順）ともずれる = 原則6。レビュー R12）
    const { rows: openRows } = await pool.query<ClusterOpenItem>(
      `SELECT id, status, page_paths AS "pagePaths" FROM improvement_items
       WHERE status = 'triage' AND archived_at IS NULL ORDER BY created_at, id`)

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
        // excluded_item_ids（解除の履歴）は集約後もクリアしない（過去に外した単位へ戻さない = レビュー R6）。
        // 新規 item の id は採番直後 = どの要望の履歴にも入り得ないため、ここに除外の SQL 検証は不要
        // （必要なのは既存 item へ戻す appends 側のみ = レビュー R13/R14）
        const { rows: claimed } = await db.query<{ id: string }>(
          `UPDATE improvement_requests SET item_id = $1
           WHERE id = ANY($2::text[]) AND item_id IS NULL AND archived_at IS NULL AND adoption = 'adopted' RETURNING id`,
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
        // NOT @> = 除外の SQL 側最終防衛（creates と同じ = プラン snapshot と claim の間の競合対策。レビュー R13）
        const { rows: claimed } = await db.query<{ id: string }>(
          `UPDATE improvement_requests SET item_id = $1
           WHERE id = ANY($2::text[]) AND item_id IS NULL AND archived_at IS NULL AND adoption = 'adopted'
             AND NOT excluded_item_ids @> to_jsonb($1::text) RETURNING id`,
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

  // ---- ステータス変更（状態機械で検証。解決 → 改善対応等の reopen 可 = 原則9.5）。
  //      継続検討（deferred）への遷移は再検討日（revisitOn）が必須（改修依頼 2026-08-20）。
  //      deferred 以外への遷移では revisit_on を保持する（クリアしない = 履歴保全） ----
  app.post('/items/:id/status', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { status?: unknown; revisitOn?: unknown }
    const status = String(body.status ?? '')
    if (!IMPROVEMENT_STATUSES.includes(status as ImprovementStatus)) {
      throw err('AKO-REQ-005', 'status が不正です', 400)
    }
    const to = status as ImprovementStatus
    // 再検討日は deferred のときだけ読む（deferred 以外の遷移で誤送信されても保存値を汚さない）
    const revisitOn = to === 'deferred' ? String(body.revisitOn ?? '').trim() : ''
    const revisitMsg = improvementRevisitError(to, revisitOn)
    if (revisitMsg) throw err('AKO-REQ-023', revisitMsg, 400)
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{ status: ImprovementStatus }>(
        `SELECT status FROM improvement_items WHERE id = $1 AND archived_at IS NULL FOR UPDATE`, [id])
      if (rows.length === 0) throw err('AKO-REQ-002', '対象の改修単位が見つかりません', 404)
      const from = rows[0]!.status
      // 同一ステータスの再送は no-op（resolved_at・updated_at を無用に上書きしない）。
      // 例外: deferred → deferred は再検討日の変更（リスケジュール）として受理し、
      // 通知マーカーもリセットする（新しい期日で再通知 = 原則9.5 の選び直し導線）
      if (from === to && to !== 'deferred') {
        const { rows: same } = await db.query(`SELECT ${ITEM_COLS} FROM improvement_items WHERE id = $1`, [id])
        return same[0]
      }
      if (from !== to && !canTransition(from, to)) {
        throw err('AKO-REQ-006', `「${from}」から「${to}」へは変更できません`, 409)
      }
      if (to === 'deferred') {
        const { rows: out } = await db.query(
          `UPDATE improvement_items
           SET status = $2, revisit_on = $3::date, revisit_notified_on = NULL, resolved_at = NULL, updated_at = now()
           WHERE id = $1 RETURNING ${ITEM_COLS}`, [id, to, revisitOn])
        return out[0]
      }
      const resolvedExpr = to === 'resolved' ? 'now()' : 'NULL'
      const { rows: out } = await db.query(
        `UPDATE improvement_items SET status = $2, resolved_at = ${resolvedExpr}, updated_at = now()
         WHERE id = $1 RETURNING ${ITEM_COLS}`, [id, to])
      return out[0]
    })
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'improvement_items', entityId: id,
      detail: `ステータス → ${status}${to === 'deferred' ? `（再検討日 ${revisitOn}）` : ''}`,
    })
    return c.json({ data: updated })
  })

  // ---- 改修単位のメモ（時系列・記録系・追記のみ）。一覧・追加・取消/復元 ----
  // 一覧: itemId 指定でその改修単位のメモ / 未指定は全件（管理ページの一括ロード用）。既定は有効メモのみ
  app.get('/notes', async (c) => {
    await requireManage(c, pool)
    const itemId = String(c.req.query('itemId') ?? '').trim()
    const includeArchived = c.req.query('includeArchived') === '1'
    const where: string[] = []
    const params: unknown[] = []
    if (itemId) { params.push(itemId); where.push(`item_id = $${params.length}`) }
    if (!includeArchived) where.push('archived_at IS NULL')
    const sql = `SELECT ${NOTE_COLS} FROM improvement_notes`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY created_at, id' // 時系列（古い順）
    const { rows } = await pool.query(sql, params)
    return c.json({ data: rows })
  })

  // 追加: 対応方針の検討過程・保留/見送り理由を時系列で残す（kind=note 既定 / reject=「対応見送り」の理由）
  app.post('/items/:id/notes', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { body?: unknown; kind?: unknown }
    const text = String(body.body ?? '').trim()
    const msg = improvementNoteError(text)
    if (msg) throw err('AKO-REQ-008', msg, 400)
    const kind: ImprovementNoteKind = body.kind === 'reject' ? 'reject' : 'note'
    // 紐づけ先の改修単位が存在し有効であること（取消済み item にはメモを付けない）
    const { rows: itemRows } = await pool.query(
      `SELECT 1 FROM improvement_items WHERE id = $1 AND archived_at IS NULL`, [id])
    if (itemRows.length === 0) throw err('AKO-REQ-002', '対象の改修単位が見つかりません', 404)
    const noteId = newId('imnote')
    const { rows } = await pool.query(
      `INSERT INTO improvement_notes (id, item_id, member_id, member_name, body, kind)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${NOTE_COLS}`,
      [noteId, id, user.id, user.name, capCodePoints(text, IMPROVEMENT_NOTE_CAP), kind])
    await audit(pool, { actorId: user.id, action: 'create', entity: 'improvement_notes', entityId: noteId, detail: `メモ追加（${kind}）` })
    return c.json({ data: rows[0] }, 201)
  })

  // メモの取消（論理削除）/ 復元。記入者本人または管理権限者（原則9.5）
  app.post('/notes/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rows } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_notes WHERE id = $1`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象のメモが見つかりません', 404)
    if (rows[0]!.memberId !== user.id) await requireManage(c, pool)
    const { rows: out } = await pool.query(
      `UPDATE improvement_notes SET archived_at = now() WHERE id = $1 RETURNING ${NOTE_COLS}`, [id])
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'improvement_notes', entityId: id, detail: 'メモを取消' })
    return c.json({ data: out[0] })
  })

  app.post('/notes/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rows } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_notes WHERE id = $1`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象のメモが見つかりません', 404)
    if (rows[0]!.memberId !== user.id) await requireManage(c, pool)
    const { rows: out } = await pool.query(
      `UPDATE improvement_notes SET archived_at = NULL WHERE id = $1 RETURNING ${NOTE_COLS}`, [id])
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'improvement_notes', entityId: id, detail: 'メモの取消を戻す' })
    return c.json({ data: out[0] })
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
    // 既定 = accepted（改修依頼 2026-08-18: プロンプト出力の対象は「改善対応」のみ。未判定は含めない。
    // filter パラメータ自体は下位互換のため維持 = 呼び出し側 UI は常に accepted を送る）
    const filter = (String(body.filter ?? 'accepted') as ImprovementFilter)
    const { rows: itemRows } = await pool.query<{
      id: string; title: string; summary: string; detail: string;
      status: ImprovementStatus; pagePaths: string[]
    }>(
      `SELECT id, title, summary, detail, status, page_paths AS "pagePaths"
       FROM improvement_items WHERE archived_at IS NULL ORDER BY updated_at DESC, id`)
    const matched = itemRows.filter(r => matchesImprovementFilter(r.status, filter))
    // 各改修単位の元要望（有効なもの）を 1 クエリでまとめて取得し JS でグルーピング（N+1 回避）
    const ids = matched.map(m => m.id)
    const byItem = new Map<string, PromptItemInput['requests']>()
    const notesByItem = new Map<string, { body: string; kind: ImprovementNoteKind }[]>()
    if (ids.length > 0) {
      const { rows: reqRows } = await pool.query<{
        id: string; itemId: string; pageLabel: string; pagePath: string; body: string
        status: ImprovementRequestStatus; links: string[]; imageCount: number; createdAt: string
      }>(
        // createdAt を SELECT に加える（改修依頼 2026-08-19 第4弾: 要望とコメントをプロンプトで時系列統合）
        `SELECT id, item_id AS "itemId", page_label AS "pageLabel", page_path AS "pagePath", body,
           status, links, jsonb_array_length(images) AS "imageCount", to_char(created_at ${JST}) AS "createdAt"
         FROM improvement_requests WHERE item_id = ANY($1::text[]) AND archived_at IS NULL
         ORDER BY created_at, id`, [ids])
      // 受付箱で記録した要望への時系列コメント（有効・古い順）を要望 id ごとに束ねる（本文＋投稿時刻）。
      // 要望本文と混ぜて createdAt 昇順に並べ替えるため、コメントも createdAt を持たせる（改修依頼 2026-08-19 第4弾）
      const reqIds = reqRows.map(r => r.id)
      const commentsByReq = new Map<string, { body: string; createdAt: string }[]>()
      if (reqIds.length > 0) {
        const { rows: commentRows } = await pool.query<{ requestId: string; body: string; createdAt: string }>(
          `SELECT request_id AS "requestId", body, to_char(created_at ${JST}) AS "createdAt"
           FROM improvement_request_comments
           WHERE request_id = ANY($1::text[]) AND archived_at IS NULL ORDER BY created_at, id`, [reqIds])
        for (const cm of commentRows) {
          const arr = commentsByReq.get(cm.requestId)
          const entry = { body: cm.body, createdAt: cm.createdAt }
          if (arr) arr.push(entry)
          else commentsByReq.set(cm.requestId, [entry])
        }
      }
      for (const r of reqRows) {
        const arr = byItem.get(r.itemId)
        const entry = {
          pageLabel: r.pageLabel, pagePath: r.pagePath, body: r.body,
          // 要望単位のステータスを加味（open 以外は【対応済み】【見送り】で明記 = プロンプト再生成に反映）
          status: r.status, links: r.links ?? [], imageCount: Number(r.imageCount ?? 0),
          createdAt: r.createdAt, comments: commentsByReq.get(r.id) ?? [],
        }
        if (arr) arr.push(entry)
        else byItem.set(r.itemId, [entry])
      }
      // 時系列メモ（有効・古い順）を改修単位ごとに束ねる（プロンプトに加味 = 原則3）
      const { rows: noteRows } = await pool.query<{ itemId: string; body: string; kind: ImprovementNoteKind }>(
        `SELECT item_id AS "itemId", body, kind FROM improvement_notes
         WHERE item_id = ANY($1::text[]) AND archived_at IS NULL ORDER BY created_at, id`, [ids])
      for (const n of noteRows) {
        const arr = notesByItem.get(n.itemId)
        const entry = { body: n.body, kind: n.kind }
        if (arr) arr.push(entry)
        else notesByItem.set(n.itemId, [entry])
      }
    }
    const promptItems: PromptItemInput[] = matched.map(it => ({
      title: it.title, summary: it.summary, detail: it.detail, status: it.status,
      pagePaths: it.pagePaths ?? [], requests: byItem.get(it.id) ?? [],
      notes: notesByItem.get(it.id) ?? [],
    }))
    return c.json({ data: { prompt: buildCodingPrompt(promptItems), count: promptItems.length } })
  })

  return app
}

/**
 * 継続検討（deferred）の再検討日リマインド（改修依頼 2026-08-20）。日次ジョブから呼ぶ想定
 * （app.ts の /jobs/* と同型の配線はナビゲーターが統合。単体でも冪等に再実行できる = 原則2）。
 * - 対象: status='deferred'・有効・revisit_on が今日（JST）以前の改修単位。
 * - 通知: 管理者全員へ kind='reminder'（notifyAdmins = 非ブロッキング。原則4）。
 *   リンクは改修案件タブ + 対象ドロワーのディープリンク（/improvements?tab=items&open=<id>）。
 * - 多重通知防止: 通知後に revisit_notified_on = today を記録し、同じ再検討日では再通知しない
 *   （revisit_notified_on < revisit_on の行だけ対象 = deferred へ再遷移して期日を更新すると
 *   マーカーが NULL に戻り、新しい期日で再度通知される）。
 * - 1 件の失敗は他の件へ波及させない（できたところまで進めて件数を報告 = 原則4）。
 */
export async function runImprovementRevisitReminders(pool: pg.Pool): Promise<{ notified: number }> {
  // 完全同時の重複起動での二重通知を防ぐ（report-reminders と同型の advisory lock = レビュー R2。
  // 取れなければ他プロセスが実行中 = このランは何もしない。取得済みのときだけ解放する）
  let lockClient: pg.PoolClient | null = null
  let locked = false
  try {
    lockClient = await pool.connect()
    const lockQ = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('jobs:improvement-revisit-reminders')) AS locked`)
    locked = Boolean(lockQ.rows[0]?.locked)
    if (!locked) return { notified: 0 }
    return await runImprovementRevisitRemindersLocked(pool)
  } finally {
    if (lockClient) {
      try {
        if (locked) await lockClient.query(`SELECT pg_advisory_unlock(hashtext('jobs:improvement-revisit-reminders'))`)
        lockClient.release()
      } catch (e) {
        // unlock 失敗時はプールへ戻すとロックが残留するため、接続ごと破棄して確実に解放する
        lockClient.release(e as Error)
      }
    }
  }
}

async function runImprovementRevisitRemindersLocked(pool: pg.Pool): Promise<{ notified: number }> {
  const today = todayJst()
  const { rows } = await pool.query<{ id: string; title: string; revisitOn: string }>(
    `SELECT id, title, revisit_on::text AS "revisitOn" FROM improvement_items
     WHERE status = 'deferred' AND archived_at IS NULL
       AND revisit_on IS NOT NULL AND revisit_on <= $1::date
       AND (revisit_notified_on IS NULL OR revisit_notified_on < revisit_on)
     ORDER BY revisit_on, id`, [today])
  let notified = 0
  for (const it of rows) {
    try {
      await notifyAdmins(pool, 'reminder', '継続検討の再検討日です',
        `継続検討の再検討日です: ${it.title}（再検討日 ${it.revisitOn}）`,
        `/improvements?tab=items&open=${it.id}`)
      // 通知マーカーは通知の後に記録（先に記録して通知に失敗すると永久に黙る方向の事故を避ける。
      // notifyAdmins は非ブロッキングのため、最悪でも「翌日以降に再通知されない」側に倒れる）
      await pool.query(`UPDATE improvement_items SET revisit_notified_on = $2::date WHERE id = $1`, [it.id, today])
      notified += 1
    } catch (e) {
      console.warn('improvement revisit reminder failed (non-blocking):', (e as Error).message)
    }
  }
  return { notified }
}
