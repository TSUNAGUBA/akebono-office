/**
 * 改善要望（F-42・オペレーター指示 2026-08-11 → ステータス管理の再編 = 改修依頼 2026-08-21）の API。
 *
 * - 投稿（POST /requests）は認証済み全員が可能（各ページの「要望を送る」）。初期ステータスは「未確認」。
 * - 受付箱のステータス（未確認 → 検討中 → 改善対応/運用対応/継続検討/対応見送り）は管理権限者が
 *   遷移させる（POST /requests/:id/status）。運用対応は運用案内コメント必須 + 起票者へ自動通知。
 *   継続検討は再検討日必須 + 到来で管理者へリマインド（runImprovementRevisitReminders）。
 *   解決済みは resolved_at の記録（POST /requests/:id/resolve。起票者本人 or 管理権限者）。
 * - 一覧・集約・ステータス管理は canManageImprovements（deny-by-default + 管理者常時可）でガードする。
 *   featureGuard（PATH_FEATURES）には載せない: 投稿と管理で認可が分かれるため、管理系だけを
 *   ルート内ガード（requireManage）で守る（customer-logs の in-route 認可と同方針）。
 * - 集約（POST /generate）は Vertex AI → 決定的ヒューリスティック（shared/domain/improvement）へ
 *   フォールバックし、**「改善対応」の未集約要望のみ**を処理する。着手済み item は巻き戻さない（原則2）。
 * - 改修案件は 未対応 → 対応中（担当者アサイン可）→ 対応済 の 3 状態（POST /items/:id/status）。
 *   対応済への遷移で、紐づく要望の起票者へ「対応済み」を通知する（起票者確認 → 解決済みの導線）。
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
  IMPROVEMENT_INBOX_BASES,
  IMPROVEMENT_INBOX_STATUS_META,
  IMPROVEMENT_ITEM_VIEWS,
  IMPROVEMENT_ITEM_STATUS_META,
  IMPROVEMENT_SUMMARY_CAP,
  IMPROVEMENT_COMMENT_CAP,
  IMPROVEMENT_TITLE_CAP,
  type ImprovementFilter,
  type ImprovementInboxBase,
  type ImprovementItemView,
  type ImprovementNoteKind,
  type ImprovementRequestImage,
  type ImprovementRequestStatus,
  type ImprovementRequestTag,
  type ImprovementStatus,
  improvementBodyError,
  improvementCommentError,
  improvementImagesError,
  improvementEditChangedLabel,
  improvementInboxStatusError,
  improvementItemViewOf,
  improvementLinksError,
  improvementNoteError,
  improvementPlanError,
  improvementRequestEditFields,
  improvementResolveError,
  improvementRevisitError,
  improvementTitleError,
  improvementUnclusterError,
  isClusterAppendTarget,
  operationalNoteBody,
  operationalNoteCapError,
  matchesImprovementFilter,
  normalizeImprovementFilter,
  normalizeClusterPlan,
  normalizeImprovementImages,
  normalizeImprovementLinks,
  normalizeImprovementPagePath,
  normalizeImprovementTags,
  type PromptItemInput,
} from '../../../shared/domain/improvement'
import {
  assessRelatedDocs,
  heuristicAssessRequest,
  IMPROVEMENT_ASSESS_LLM_SCHEMA,
  normalizeAssessment,
} from '../../../shared/domain/improvement-assess'
import { nowJstIso, todayJst } from '../../../shared/domain/jst'
import { canManageImprovements } from '../../../shared/domain/permissions'
import type { AuthUser } from '../auth'
import type { Env } from '../env'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { notify, notifyAdmins } from '../lib/notify'

// 時刻は JST ウォールクロック文字列で返す（customer-logs / akebono-trade と同一規約。
// フロントの fmtDate は文字列をそのまま表示するため、生 timestamptz（UTC "…Z"）を返すと
// 0〜9 時台の登録が前日表示になる日付ずれ + モードのパリティ崩れになる = CONVENTIONS「時刻の扱い」）
const JST = `AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"'`
/**
 * 要望列（withImages=false は images を空配列で返す = 全件一覧の転送量削減。
 * 添付画像の data URI は 1 件最大 400,000 字のため、全件 GET に含めると応答が肥大する。
 * 画像の実体は itemId 指定の GET（ドロワーの遅延ロード）でのみ返す）。
 * p = テーブル別名の接頭辞（'r.' 等）: GET 一覧は items と JOIN して linkedItemStatus（集約先 item の
 * ステータス = 受付箱表示ステータスの導出材料）を返すため、列名を修飾できるようにする（RETURNING は p=''）。
 */
const reqColsOf = (withImages: boolean, p = ''): string => `${p}id, ${p}member_id AS "memberId", ${p}member_name AS "memberName",
  ${p}page_path AS "pagePath", ${p}page_label AS "pageLabel", ${p}target_spot AS "targetSpot", ${p}body, ${p}status, ${p}adoption, ${p}tags, ${p}links,
  ${withImages ? `${p}images` : `'[]'::jsonb AS images`}, ${p}item_id AS "itemId",
  ${p}excluded_item_ids AS "excludedItemIds", ${p}ai_assessment AS "aiAssessment",
  ${p}revisit_on::text AS "revisitOn", to_char(${p}resolved_at ${JST}) AS "resolvedAt",
  to_char(${p}archived_at ${JST}) AS "archivedAt", to_char(${p}edited_at ${JST}) AS "editedAt",
  to_char(${p}created_at ${JST}) AS "createdAt"`
const ITEM_COLS = `id, title, summary, detail, status, page_paths AS "pagePaths",
  source_request_ids AS "sourceRequestIds", llm, to_char(archived_at ${JST}) AS "archivedAt",
  to_char(created_at ${JST}) AS "createdAt", to_char(updated_at ${JST}) AS "updatedAt",
  to_char(resolved_at ${JST}) AS "resolvedAt",
  assignee_member_id AS "assigneeMemberId", assignee_name AS "assigneeName",
  plan_start AS "planStart", plan_end AS "planEnd", revisit_on::text AS "revisitOn"`
const NOTE_COLS = `id, item_id AS "itemId", member_id AS "memberId", member_name AS "memberName",
  body, kind, to_char(archived_at ${JST}) AS "archivedAt", to_char(created_at ${JST}) AS "createdAt"`
const COMMENT_COLS = `id, request_id AS "requestId", member_id AS "memberId", member_name AS "memberName",
  body, kind, to_char(archived_at ${JST}) AS "archivedAt", to_char(created_at ${JST}) AS "createdAt"`

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

/** 本人 or 管理の複合ガード。戻り値 = 管理権限の有無（単一行応答の絞り込み〔stripTriageFields〕に使う） */
async function requireOwnerOrManage(pool: pg.Pool, user: AuthUser, ownerId: string): Promise<boolean> {
  const manage = await canManage(pool, user)
  if (ownerId !== user.id && !manage) {
    throw err('AKO-PRM-001', '改善要望を閲覧・管理する権限がありません（管理者にお問い合わせください）', 403)
  }
  return manage
}

/**
 * 管理系のトリアージ状態（旧・選別 adoption / 集約解除履歴 excludedItemIds / AI 判定 aiAssessment）を
 * 非管理者への応答から剥がす。一覧 GET と同一の情報開示方針（R1 監査）を、投稿者本人が呼べる
 * 単一行エンドポイント（投稿 201 / edit / archive / restore / resolve の RETURNING）にも適用する =
 * 一覧で伏せた情報が本人操作の応答から漏れない（R1 レビュー 2026-08-21）。
 * 例外: 旧データ（status='open'）の adoption は残す。旧行の表示ステータスは adoption から導出する
 * （improvementInboxStatusOf の読替え = 原則7）ため、剥がすと同じ要望が閲覧者・モードで別ステータスに
 * 見える（例: 旧・不採用の要望が起票者にだけ「未確認」）。新モデルでは選別相当の判断
 * （改善対応/対応見送り）は基底ステータスとして全員公開のため、旧行の adoption 開示は方針と矛盾しない
 * （R2 レビュー 2026-08-21）
 */
function stripTriageFields<T>(row: T, manage: boolean): T {
  if (row && !manage) {
    const r = row as Record<string, unknown>
    if (r.status !== 'open') delete r.adoption
    delete r.excludedItemIds; delete r.aiAssessment
  }
  return row
}

/** LLM 集約（Vertex → 正規化）。無効環境・失敗・空出力は null（呼び出し側でヒューリスティックへ） */
async function llmCluster(
  env: Env, openItems: ClusterOpenItem[], requests: ClusterRequestInput[],
): Promise<ClusterPlan | null> {
  if (!env.vertexProjectId) return null
  const openForPrompt = openItems
    .filter(it => isClusterAppendTarget(it.status))
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
    return c.json({ data: stripTriageFields(rows[0], await canManage(pool, user)) }, 201)
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
    if (itemId) { params.push(itemId); where.push(`r.item_id = $${params.length}`) }
    if (unclustered) where.push('r.item_id IS NULL')
    if (canManage) {
      if (!includeArchived) where.push('r.archived_at IS NULL')
    } else {
      // 一般利用者: 有効な全要望 + 自分の取消済み（自分の取消は本人が復元できる = 原則9.5）。他者の取消済みは非表示
      params.push(user.id)
      where.push(`(r.archived_at IS NULL OR r.member_id = $${params.length})`)
    }
    // 画像の実体は絞り込み指定時のみ（itemId = 改修単位ドロワー / unclustered=1 = 生要望ドロワーの遅延ロード。
    // 全件一覧は '[]' = 転送量削減。レビュー指摘 2026-08-17）。
    // linkedItemStatus = 集約先 item の保存ステータス（LEFT JOIN。未集約は NULL）: 受付箱の表示ステータス
    // 「改善対応/対応済み」は item から導出するため（improvementInboxStatusOf = 原則6）、改修案件を取得できない
    // 一般利用者にも導出材料をここで返す（自分の要望が対応済みになったことを判別し「解決済み」へ移せる）
    const sql = `SELECT ${reqColsOf(Boolean(itemId) || unclustered, 'r.')}, i.status AS "linkedItemStatus"
       FROM improvement_requests r LEFT JOIN improvement_items i ON i.id = r.item_id`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY r.created_at DESC, r.id'
    const { rows } = await pool.query(sql, params)
    // 管理系のトリアージ状態は一般利用者へは返さない（stripTriageFields = 単一行応答と同一方針・同一実装 =
    // 原則3。旧データ〔status='open'〕の adoption は表示ステータスの導出材料のため残す = 原則7）。
    // 要望本文・投稿者・受付箱ステータス（status/resolvedAt/linkedItemStatus）は全員可（受付箱・カンバンで参照）。
    for (const r of rows) stripTriageFields(r, canManage)
    return c.json({ data: rows })
  })

  // ---- 要望の取消（論理削除）/ 復元。投稿者本人または管理権限者 ----
  app.post('/requests/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rows } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_requests WHERE id = $1`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
    const manage = await requireOwnerOrManage(pool, user, rows[0]!.memberId)
    const { rows: out } = await pool.query(
      `UPDATE improvement_requests SET archived_at = now() WHERE id = $1 RETURNING ${reqColsOf(false)}`, [id])
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'improvement_requests', entityId: id, detail: '要望を取消' })
    return c.json({ data: stripTriageFields(out[0], manage) })
  })

  app.post('/requests/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rows } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_requests WHERE id = $1`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
    const manage = await requireOwnerOrManage(pool, user, rows[0]!.memberId)
    const { rows: out } = await pool.query(
      `UPDATE improvement_requests SET archived_at = NULL WHERE id = $1 RETURNING ${reqColsOf(false)}`, [id])
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'improvement_requests', entityId: id, detail: '要望の取消を戻す' })
    return c.json({ data: stripTriageFields(out[0], manage) })
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
    const manage = await requireOwnerOrManage(pool, user, reqRows[0]!.memberId)
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
      // 対象箇所（改修依頼 2026-08-21: 受付箱の詳細で編集可能に。'' = クリア）
      if (fields.targetSpot !== undefined) { params.push(fields.targetSpot); sets.push(`target_spot = $${params.length}`) }
      const { rows } = await client.query(
        `UPDATE improvement_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING ${reqColsOf(true)}`, params)
      // 監査記録は「変更した項目」も残す（添付の変更を後から追える = 監査証跡。本文は復元可能なよう全文保存。
      // 画像実体は data URI で肥大するため detail には残さない = 添付の取消導線は「再編集」〔原則9.5〕が担う）。
      // 変更項目ラベルは shared 純関数で mock と共有（原則3。文言・順序のズレを作らない）
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1, 'update', 'improvement_requests', $2, $3)`,
        [user.id, id, `要望を編集（変更項目: ${improvementEditChangedLabel(fields)}／変更前本文: ${prev[0]!.body}）`])
      await client.query('COMMIT')
      return c.json({ data: stripTriageFields(rows[0], manage) })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })

  // ---- 受付箱ステータスの変更（管理。改修依頼 2026-08-21: 選別〔採用/不採用〕を置き換える一次フロー） ----
  // 未確認 → 検討中 → 改善対応/運用対応/継続検討/対応見送り（遷移は IMPROVEMENT_INBOX_NEXT = 原則9.5 の
  // 戻り遷移込み）。運用対応は運用案内（note）必須 = コメントへ記録 + 起票者へ全文通知。
  // 継続検討は再検討日（revisitOn）必須 = 到来で管理者リマインド。集約済み・解決済みは変更不可（連動/記録保護）
  app.post('/requests/:id/status', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { status?: unknown; revisitOn?: unknown; note?: unknown }
    const status = String(body.status ?? '')
    if (!(IMPROVEMENT_INBOX_BASES as readonly string[]).includes(status)) {
      throw err('AKO-REQ-011', 'status が不正です（unconfirmed / reviewing / planned / operational / deferred / dismissed）', 400)
    }
    const to = status as ImprovementInboxBase
    // 再検討日は deferred のときだけ読む（他遷移での誤送信で保存値を汚さない）
    const revisitOn = to === 'deferred' ? String(body.revisitOn ?? '').trim() : ''
    const revisitMsg = improvementRevisitError(to, revisitOn)
    if (revisitMsg) throw err('AKO-REQ-023', revisitMsg, 400)
    // 運用案内コメントは operational のときだけ読む（誤送信でコメントを汚さない）。
    // 検証・本文組み立ては shared の共通関数（mock と同一挙動 = 原則6）
    const opsNote = to === 'operational' ? String(body.note ?? '').trim() : ''
    if (to === 'operational' && !opsNote) {
      throw err('AKO-REQ-024', '運用対応にする場合は、運用対応方法の案内（note）を記載してください', 400)
    }
    const opsNoteBody = to === 'operational' ? operationalNoteBody(opsNote) : ''
    if (to === 'operational') {
      const capMsg = operationalNoteCapError(opsNote)
      if (capMsg) throw err('AKO-REQ-008', capMsg, 400)
    }
    // 実際に遷移した（= operational ならコメントを記録した）ときだけ Tx 後の起票者通知を行う
    // （同一ステータス再送の no-op で運用案内が再通知されない = 原則2）
    let transitioned = false
    let authorId = ''
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{
        memberId: string; status: ImprovementRequestStatus
        adoption: 'pending' | 'adopted' | 'declined' | null
        itemId: string | null; resolvedAt: string | null; archivedAt: string | null
      }>(
        `SELECT member_id AS "memberId", status, adoption, item_id AS "itemId",
           to_char(resolved_at ${JST}) AS "resolvedAt", to_char(archived_at ${JST}) AS "archivedAt"
         FROM improvement_requests WHERE id = $1 FOR UPDATE`, [id])
      // ガードは共有関数（存在 → 取消済み → 集約済み → 解決済み → 遷移検証 = mock と同一判定・原則6）
      const cur = rows[0]
      const guard = improvementInboxStatusError(cur, to)
      if (guard) throw err(guard.code, guard.message, guard.code === 'AKO-REQ-002' ? 404 : 409)
      authorId = cur!.memberId
      // 同一ステータスの再送は no-op（updated_at 系の無用な上書きなし）。
      // 例外: deferred → deferred は再検討日の変更（リスケジュール）として受理し、
      // 通知マーカーもリセットする（新しい期日で再通知 = 原則9.5 の選び直し導線）
      if (cur!.status === to && to !== 'deferred') {
        const { rows: same } = await db.query(
          `SELECT ${reqColsOf(false, 'r.')}, i.status AS "linkedItemStatus"
           FROM improvement_requests r LEFT JOIN improvement_items i ON i.id = r.item_id WHERE r.id = $1`, [id])
        return same[0]
      }
      transitioned = true
      if (to === 'deferred') {
        const { rows: out } = await db.query(
          `UPDATE improvement_requests
           SET status = $2, revisit_on = $3::date, revisit_notified_on = NULL WHERE id = $1
           RETURNING ${reqColsOf(false)}`, [id, to, revisitOn])
        return out[0]
      }
      // 運用案内はコメント（時系列・記録系）へ記録してからステータス変更（同一 Tx = 原子。
      // コメントだけ残って遷移しない/その逆、を作らない。本文は通知と同一 = 記録と通知の乖離を作らない）
      if (to === 'operational') {
        // kind='ops' = 運用案内の自動記録（起票者本人へ開示する行の判別キー = 0083。手動コメントは 'comment'）
        await db.query(
          `INSERT INTO improvement_request_comments (id, request_id, member_id, member_name, body, kind)
           VALUES ($1, $2, $3, $4, $5, 'ops')`,
          [newId('imcmt'), id, user.id, user.name, opsNoteBody])
      }
      const { rows: out } = await db.query(
        `UPDATE improvement_requests SET status = $2 WHERE id = $1 RETURNING ${reqColsOf(false)}`, [id, to])
      return out[0]
    })
    // 監査ログは実遷移時のみ（no-op 再送で「変更」の監査行を積まない）
    if (transitioned) {
      await audit(pool, {
        actorId: user.id, action: 'update', entity: 'improvement_requests', entityId: id,
        detail: `受付箱ステータス → ${IMPROVEMENT_INBOX_STATUS_META[to].label}${to === 'deferred' ? `（再検討日 ${revisitOn}）` : ''}`,
      })
    }
    // 運用対応: 起票者へ運用案内を全文通知（改修依頼 2026-08-21。起票者はこれを確認して自分の要望を
    // 「解決済み」へ移す。主フロー成立後の補助処理 = 非ブロッキング〔原則4〕。リンクは要望詳細のディープリンク）
    if (to === 'operational' && transitioned && authorId) {
      try {
        await notify(pool, authorId, 'system', '改善要望が「運用対応」になりました', opsNoteBody, `/improvements?req=${id}`)
      } catch (e) {
        console.warn('operational notify failed (non-blocking):', (e as Error).message)
      }
    }
    return c.json({ data: updated })
  })

  // ---- 解決済みの記録（resolve）/ 取消（unresolve）。起票者本人または管理権限者 ----
  // 解決済みは基底ステータスを上書きしない記録（resolved_at）: 運用対応（案内を確認した）または
  // 対応済み（改修完了を確認した）の要望のみ解決済みにでき、取消で元の表示へ戻る（原則9.5）
  app.post('/requests/:id/resolve', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const resolved = Boolean(((await c.req.json().catch(() => ({}))) as { resolved?: unknown }).resolved ?? true)
    const { rows: own } = await pool.query<{ memberId: string }>(
      `SELECT member_id AS "memberId" FROM improvement_requests WHERE id = $1`, [id])
    // 存在しない id も本人以外は一律 403 側へ倒さない: まず存在で 404（管理者・本人とも同じ挙動 =
    // 要望 id は全員閲覧可のため存在オラクルにならない。改修依頼 2026-08-19 第4弾で全要望が閲覧可）
    if (own.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
    const manage = await requireOwnerOrManage(pool, user, own[0]!.memberId)
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{
        status: ImprovementRequestStatus
        adoption: 'pending' | 'adopted' | 'declined' | null
        itemId: string | null
        resolvedAt: string | null; archivedAt: string | null; linkedItemStatus: ImprovementStatus | null
      }>(
        `SELECT r.status, r.adoption, r.item_id AS "itemId", to_char(r.resolved_at ${JST}) AS "resolvedAt",
           to_char(r.archived_at ${JST}) AS "archivedAt", i.status AS "linkedItemStatus"
         FROM improvement_requests r LEFT JOIN improvement_items i ON i.id = r.item_id
         WHERE r.id = $1 FOR UPDATE OF r`, [id])
      const cur = rows[0]
      if (!cur) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
      if (resolved) {
        const guard = improvementResolveError(cur, cur.linkedItemStatus)
        if (guard) throw err(guard.code, guard.message, guard.code === 'AKO-REQ-002' ? 404 : 409)
        const { rows: out } = await db.query(
          `UPDATE improvement_requests SET resolved_at = COALESCE(resolved_at, now()) WHERE id = $1
           RETURNING ${reqColsOf(false)}`, [id])
        return out[0]
      }
      // 解決の取消: resolved_at を NULL へ。旧データ（status='resolved' が解決を表す行）は基底へ書き戻す
      // （集約済み = planned〔表示は item から導出〕/ 未集約 = reviewing〔検討中へ戻して人手判断〕= 原則7/9.5）
      if (cur.archivedAt) throw err('AKO-REQ-019', '取消済みの要望は変更できません（先に復元してください）', 409)
      const legacyResolved = cur.status === 'resolved'
      const { rows: out } = await db.query(
        `UPDATE improvement_requests SET resolved_at = NULL${legacyResolved ? `, status = $2` : ''}
         WHERE id = $1 RETURNING ${reqColsOf(false)}`,
        legacyResolved ? [id, cur.itemId ? 'planned' : 'reviewing'] : [id])
      return out[0]
    })
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'improvement_requests', entityId: id,
      detail: resolved ? '要望を解決済みに記録' : '要望の解決済みを取消',
    })
    return c.json({ data: stripTriageFields(updated, manage) })
  })

  // ---- AI 判定（管理。改修依頼 2026-08-21）。ナレッジベース（shared/domain/kb = アプリ仕様・
  //      運用/操作マニュアル）を RAG に「既存機能で対応可 / 運用の工夫で対応可 / 改修が必要」を判定し、
  //      根拠・参照ドキュメント・推奨アクションを保管する（生成→保管→再判定で上書き）。
  //      Vertex AI → 決定的ヒューリスティック（heuristicAssessRequest = mock と同一ロジック）へ
  //      フォールバック（原則4/6） ----
  app.post('/requests/:id/assess', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const { rows } = await pool.query<{
      body: string; pageLabel: string; targetSpot: string; archivedAt: string | null
    }>(
      `SELECT body, page_label AS "pageLabel", target_spot AS "targetSpot",
         to_char(archived_at ${JST}) AS "archivedAt"
       FROM improvement_requests WHERE id = $1`, [id])
    if (rows.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
    if (rows[0]!.archivedAt) throw err('AKO-REQ-019', '取消済みの要望は AI 判定できません（先に復元してください）', 409)
    const input = { body: rows[0]!.body, pageLabel: rows[0]!.pageLabel, targetSpot: rows[0]!.targetSpot }
    // 関連ドキュメントの選定は決定的（mock と同一の kbFindRelated）。LLM には上位ドキュメントの本文を渡す
    const docs = assessRelatedDocs(input)
    let result: { verdict: 'existing' | 'workaround' | 'improvement' | 'unknown'; reason: string; docIds: string[] } | null = null
    let llm = false
    if (env.vertexProjectId) {
      const raw = await generateJson<unknown>(env, {
        system: 'あなたは社内業務アプリ「AKEBONO Home」の改善要望トリアージ AI です。利用者の要望を、'
          + '提示されたアプリの公式マニュアル・仕様と照合し、次のいずれかで判定します: '
          + 'existing = 既存機能に備わっており、案内すれば要望を満たせる / '
          + 'workaround = 使い方の工夫・運用で要望を叶えられる / '
          + 'improvement = 既存機能では叶えられず、コード改修が必要 / '
          + 'unknown = 判定材料が不足（要望が曖昧・ドキュメントに手掛かりなし）。'
          + 'reason には判定の根拠を日本語で簡潔に書くこと（該当するマニュアルの記載内容と操作方法、'
          + 'または既存機能で不足する点。起票者・管理者がそのまま読める文章で）。'
          + 'docIds には根拠に使ったドキュメントの id のみを入れ、id を捏造しないこと。',
        prompt: `# 要望\n対象ページ: ${input.pageLabel || '（不明）'}${input.targetSpot ? ` / 対象箇所: ${input.targetSpot}` : ''}\n${capCodePoints(input.body, IMPROVEMENT_BODY_CAP)}\n\n`
          + `# アプリの公式マニュアル・仕様（関連ドキュメント）\n${docs.length > 0
            ? docs.map(d => `## ${d.doc.id}: ${d.doc.title}\n${capCodePoints(d.doc.body, 2000)}`).join('\n\n')
            : '（関連するドキュメントは見つかりませんでした = 既存機能に手掛かりが無い可能性が高い）'}`,
        schema: IMPROVEMENT_ASSESS_LLM_SCHEMA,
        maxTokens: 2000,
      })
      result = normalizeAssessment(raw)
      llm = result !== null
    }
    result ??= heuristicAssessRequest(input)
    const assessment = { ...result, llm, assessedAt: nowJstIso() }
    const { rows: out } = await pool.query(
      `UPDATE improvement_requests SET ai_assessment = $2 WHERE id = $1 RETURNING ${reqColsOf(false)}`,
      [id, JSON.stringify(assessment)])
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'improvement_requests', entityId: id,
      detail: `AI 判定 → ${assessment.verdict}（${llm ? 'LLM' : 'heuristic'}）`,
    })
    return c.json({ data: out[0] })
  })

  // ---- 集約の解除（F-42-19・改修依頼 2026-08-18 → ステータス再編 2026-08-21。管理）。要望を改修単位から外し、
  //      「改善対応（集約待ち）」へ戻す = 再度 AI 集約の対象にする（取消 archive と違い要望は生きたまま）。
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
      const { rows } = await db.query<{
        itemId: string | null; archivedAt: string | null; body: string
        status: ImprovementRequestStatus | null; resolvedAt: string | null
      }>(
        `SELECT item_id AS "itemId", to_char(archived_at ${JST}) AS "archivedAt", body,
           status, to_char(resolved_at ${JST}) AS "resolvedAt"
         FROM improvement_requests WHERE id = $1 FOR UPDATE`, [id])
      // 要望側のガード（存在/未集約/取消済み/解決済み）→ 競合（020）→ item 側のガード（取消済み = 022・
      // 決着済み = 021。item 情報は peekItemId のものと確定した後に適用する）の順で判定
      const requestGuard = improvementUnclusterError(rows[0])
      if (requestGuard) throw err(requestGuard.code, requestGuard.message, requestGuard.code === 'AKO-REQ-002' ? 404 : 409)
      const itemId = rows[0]!.itemId!
      if (itemId !== peekItemId) {
        throw err('AKO-REQ-020', '要望の状態が変わったため集約を解除できませんでした（再読み込みしてください）', 409)
      }
      const guard = improvementUnclusterError(rows[0], lockedItem)
      if (guard) throw err(guard.code, guard.message, 409)
      // 解除後は「改善対応（集約待ち）」へ明示的に戻す（status='planned' を保存 = 旧データの
      // adoption 読替えに依存せず clusterTargetRequests の対象になる。改修依頼 2026-08-21）。
      // excluded_item_ids へ元 item を追記（解除の履歴 = 蓄積・クリアしない）: 次回以降の集約で
      // そこへは再追記しない（同じ単位への往復 + detail 重複・「対象外」メモとの矛盾を防ぐ = レビュー R6。
      // 同一 item は履歴に一度外れると戻れないため重複追記は起きないが、@> ガードで冪等にする）
      const { rows: out } = await db.query(
        `UPDATE improvement_requests SET item_id = NULL, status = 'planned',
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
  // 一覧: requestId 指定でその要望のコメント / 未指定は全件（管理ページの一括ロード用）。既定は有効のみ。
  // 非管理者は「自分の要望」+ requestId 指定に限り、運用案内（kind='ops' = operational 遷移の自動記録で、
  // 起票者へ通知した本文と同一）だけを取得できる（R2 監査 2026-08-21: 運用案内の本人到達を system 通知
  // だけに依存させない = 通知を OFF にしていても要望ドロワーで案内を読める。判別は kind = 0083・R3 監査:
  // 管理者が「運用案内: 」で始まる手動コメント〔草稿のコピペ等〕を書いても本人へ漏れない。
  // 管理検討のコメント〔kind='comment'〕は従来どおり管理権限者のみ = 情報開示方針は不変）
  app.get('/request-comments', async (c) => {
    const user = c.get('user')
    const manage = await canManage(pool, user)
    const requestId = String(c.req.query('requestId') ?? '').trim()
    const includeArchived = manage && c.req.query('includeArchived') === '1'
    const where: string[] = []
    const params: unknown[] = []
    if (!manage) {
      if (!requestId) {
        throw err('AKO-PRM-001', '改善要望を閲覧・管理する権限がありません（管理者にお問い合わせください）', 403)
      }
      const { rows: own } = await pool.query<{ memberId: string }>(
        `SELECT member_id AS "memberId" FROM improvement_requests WHERE id = $1`, [requestId])
      if (own.length === 0) throw err('AKO-REQ-002', '対象の要望が見つかりません', 404)
      if (own[0]!.memberId !== user.id) {
        throw err('AKO-PRM-001', '改善要望を閲覧・管理する権限がありません（管理者にお問い合わせください）', 403)
      }
      where.push(`kind = 'ops'`)
    }
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

  // ---- 改修単位一覧（管理）。filter で 未完了/未対応/対応中/対応済 を絞る ----
  app.get('/items', async (c) => {
    await requireManage(c, pool)
    const includeArchived = c.req.query('includeArchived') === '1'
    const sql = `SELECT ${ITEM_COLS} FROM improvement_items`
      + (includeArchived ? '' : ' WHERE archived_at IS NULL')
      + ' ORDER BY updated_at DESC, id'
    const { rows } = await pool.query(sql)
    // 旧語彙のフィルター値は正規化して受理（下位互換 = 原則7。R2 レビュー: 旧値が常に 0 件になるのを防ぐ）
    const filter = normalizeImprovementFilter(String(c.req.query('filter') ?? 'all'))
    const data = rows.filter(r => matchesImprovementFilter((r as { status: ImprovementStatus }).status, filter))
    return c.json({ data })
  })

  // ---- AI 集約（生成・再生成）。**「改善対応（planned）」**かつ未集約の要望のみ処理・
  //      着手済み item は不変（原則2）。未確認・検討中・運用対応・継続検討・対応見送りの要望は
  //      集約されない（改修依頼 2026-08-21: 集約対象は「改善対応」ステータスのみ） ----
  app.post('/generate', async (c) => {
    const user = await requireManage(c, pool)
    // 改善対応・未集約かつ有効な要望（excluded_item_ids = 「集約の解除」の履歴 = そこへは再追記しない）。
    // 条件は shared clusterTargetRequests（improvementInboxStatusOf = 'planned'）の SQL 表現:
    // 新語彙 status='planned' / 旧データは status='open' AND adoption='adopted'（読替え = 原則7）。
    // resolved_at IS NULL は resolver の「解決済み優先」と同じ判定（planned からは解決できないため通常は常に NULL）
    const { rows: reqRows } = await pool.query<ClusterRequestInput>(
      `SELECT id, page_path AS "pagePath", page_label AS "pageLabel", body,
         excluded_item_ids AS "excludeItemIds"
       FROM improvement_requests
       WHERE item_id IS NULL AND archived_at IS NULL AND resolved_at IS NULL
         AND (status = 'planned' OR (status = 'open' AND adoption = 'adopted'))
       ORDER BY created_at, id`)
    if (reqRows.length === 0) {
      return c.json({ data: { created: 0, appended: 0, clustered: 0, llm: false } })
    }
    // 追記先候補 = 未対応（todo。旧 triage/accepted/deferred の読替え含む = isClusterAppendTarget の
    // SQL 表現）・有効な改修単位。ORDER BY で追記先の選択を決定的にする
    // （解除 → 再集約で同一ページの未対応 item が複数できるのは通常ケース。無順序だと追記先が
    // 実行ごとに揺れ、mock の挿入順（作成順）ともずれる = 原則6。レビュー R12）
    const { rows: openRows } = await pool.query<ClusterOpenItem>(
      `SELECT id, status, page_paths AS "pagePaths" FROM improvement_items
       WHERE status IN ('todo', 'triage', 'accepted', 'deferred') AND archived_at IS NULL ORDER BY created_at, id`)

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
           WHERE id = ANY($2::text[]) AND item_id IS NULL AND archived_at IS NULL AND resolved_at IS NULL
             AND (status = 'planned' OR (status = 'open' AND adoption = 'adopted')) RETURNING id`,
          [itemId, cr.requestIds])
        if (claimed.length === 0) continue
        const claimedIds = claimed.map(r => r.id)
        await db.query(
          `INSERT INTO improvement_items (id, title, summary, detail, status, page_paths, source_request_ids, llm)
           VALUES ($1, $2, $3, $4, 'todo', $5, $6, $7)`,
          [itemId, cr.title, cr.summary, cr.detail, JSON.stringify(cr.pagePaths),
            JSON.stringify(claimedIds), llm])
        created += 1
        clustered += claimedIds.length
      }
      // 既存の未対応 item への追記（着手済み・決着済みは対象外 = ステータス保護）。llm フラグは item の
      // 作成時属性のため追記では変更しない（mock も更新しない = 両モード一致）
      for (const ap of plan.appends) {
        const { rows: itemRows } = await db.query<{
          detail: string; pagePaths: string[]; sourceRequestIds: string[]
        }>(
          `SELECT detail, page_paths AS "pagePaths", source_request_ids AS "sourceRequestIds"
           FROM improvement_items
           WHERE id = $1 AND status IN ('todo', 'triage', 'accepted', 'deferred') AND archived_at IS NULL FOR UPDATE`,
          [ap.itemId])
        if (itemRows.length === 0) continue
        // NOT @> = 除外の SQL 側最終防衛（creates と同じ = プラン snapshot と claim の間の競合対策。レビュー R13）
        const { rows: claimed } = await db.query<{ id: string }>(
          `UPDATE improvement_requests SET item_id = $1
           WHERE id = ANY($2::text[]) AND item_id IS NULL AND archived_at IS NULL AND resolved_at IS NULL
             AND (status = 'planned' OR (status = 'open' AND adoption = 'adopted'))
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
    // 担当者の変更・解除（改修依頼 2026-08-21。対応中への遷移時のアサインとは別に、いつでも変更できる = 原則9.5。
    // '' = 解除。名前はスナップショット保存 = 閲覧時のマスタ参照を避ける）
    const contentSetCount = sets.length // 担当者以外の編集項目数（監査 detail の分岐用）
    let assigneeNote = ''
    if (Object.hasOwn(body, 'assigneeMemberId')) {
      const mid = String(body.assigneeMemberId ?? '').trim()
      if (!mid) {
        params.push(null); sets.push(`assignee_member_id = $${params.length}`)
        params.push(''); sets.push(`assignee_name = $${params.length}`)
        assigneeNote = '担当者: 解除'
      } else {
        const { rows: mem } = await pool.query<{ name: string }>(
          `SELECT name FROM members WHERE id = $1 AND active = true`, [mid])
        if (mem.length === 0) throw err('AKO-REQ-027', '担当者が見つかりません（有効なメンバーを指定してください）', 400)
        params.push(mid); sets.push(`assignee_member_id = $${params.length}`)
        params.push(mem[0]!.name); sets.push(`assignee_name = $${params.length}`)
        assigneeNote = `担当者: ${mem[0]!.name}`
      }
    }
    if (sets.length === 0) throw err('AKO-REQ-004', '更新する項目がありません', 400)
    const { rows } = await pool.query(
      `UPDATE improvement_items SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1 AND archived_at IS NULL RETURNING ${ITEM_COLS}`, params)
    if (rows.length === 0) throw err('AKO-REQ-002', '対象の改修単位が見つかりません', 404)
    // 監査 detail: 担当者のみの更新は「担当者を変更」= status ルートの担当者分岐と同型（誰に変わったかを
    // 監査から追える。編集と同時の場合は編集の detail に付記 = R2 レビュー 2026-08-21）
    const detail = assigneeNote && contentSetCount === 0
      ? `担当者を変更（${assigneeNote}）`
      : `改修単位を編集${assigneeNote ? `（${assigneeNote}）` : ''}`
    await audit(pool, { actorId: user.id, action: 'update', entity: 'improvement_items', entityId: id, detail })
    return c.json({ data: rows[0] })
  })

  // ---- 改修案件のステータス変更（3 状態機械で検証。対応済 → 対応中の reopen 可 = 原則9.5）。
  //      対応中（in_progress）への遷移では担当者（assigneeMemberId）をアサインできる（改修依頼 2026-08-21。
  //      任意 = 未指定は現状維持・'' = 解除）。対応済（done）への遷移で、紐づく要望の起票者へ
  //      「対応済み」を通知する（起票者は内容を確認して要望を「解決済み」へ移す = 非ブロッキング・原則4） ----
  app.post('/items/:id/status', async (c) => {
    const user = await requireManage(c, pool)
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { status?: unknown; assigneeMemberId?: unknown }
    const status = String(body.status ?? '')
    if (!(IMPROVEMENT_ITEM_VIEWS as readonly string[]).includes(status)) {
      throw err('AKO-REQ-005', 'status が不正です（todo / in_progress / done）', 400)
    }
    const to = status as ImprovementItemView
    // 担当者のアサイン（対応中への遷移時のみ読む = 他遷移での誤送信で担当者を汚さない。
    // キー実在時のみ更新 = 部分更新の鉄則。'' = 解除）
    const hasAssignee = to === 'in_progress' && Object.hasOwn(body, 'assigneeMemberId') && body.assigneeMemberId !== undefined
    const assigneeId = hasAssignee ? String(body.assigneeMemberId ?? '').trim() : ''
    let assigneeName = ''
    if (hasAssignee && assigneeId) {
      const { rows: mem } = await pool.query<{ name: string }>(
        `SELECT name FROM members WHERE id = $1 AND active = true`, [assigneeId])
      if (mem.length === 0) throw err('AKO-REQ-027', '担当者が見つかりません（有効なメンバーを指定してください）', 400)
      assigneeName = mem[0]!.name
    }
    // 実際に遷移したときだけ Tx 後の監査・起票者通知を行う（no-op 再送で再通知しない = 原則2）
    let transitioned = false
    const updated = await inTxn(pool, async (db) => {
      const { rows } = await db.query<{ status: ImprovementStatus }>(
        `SELECT status FROM improvement_items WHERE id = $1 AND archived_at IS NULL FOR UPDATE`, [id])
      if (rows.length === 0) throw err('AKO-REQ-002', '対象の改修案件が見つかりません', 404)
      const fromRaw = rows[0]!.status
      const from = improvementItemViewOf(fromRaw) // 旧語彙は 3 状態へ正規化して判定（原則7）
      // 同一ステータス（正規化後）の再送は no-op（resolved_at・updated_at を無用に上書きしない。
      // 保存値も旧語彙のまま維持 = 表示は同じで書換え不要）。ただし担当者アサイン付きの再送は
      // 担当者だけ更新する（対応中のまま担当者を差し替える導線 = 原則9.5）
      if (from === to && !hasAssignee) {
        const { rows: same } = await db.query(`SELECT ${ITEM_COLS} FROM improvement_items WHERE id = $1`, [id])
        return same[0]
      }
      if (from !== to && !canTransition(fromRaw, to)) {
        throw err('AKO-REQ-006', `「${IMPROVEMENT_ITEM_STATUS_META[from].label}」から「${IMPROVEMENT_ITEM_STATUS_META[to].label}」へは変更できません`, 409)
      }
      transitioned = from !== to
      const sets = ['status = $2', 'updated_at = now()']
      const params: unknown[] = [id, to]
      // 対応済 = resolved_at を記録 / それ以外へ = クリア（reopen で完了時刻が残らない）
      sets.push(`resolved_at = ${to === 'done' ? 'now()' : 'NULL'}`)
      if (hasAssignee) {
        params.push(assigneeId || null); sets.push(`assignee_member_id = $${params.length}`)
        params.push(assigneeName); sets.push(`assignee_name = $${params.length}`)
      }
      const { rows: out } = await db.query(
        `UPDATE improvement_items SET ${sets.join(', ')} WHERE id = $1 RETURNING ${ITEM_COLS}`, params)
      return out[0]
    })
    // 監査ログは実変更時のみ（担当者のみの更新も記録する。遷移なし = 「ステータス →」と書かない =
    // 監査証跡に無かった遷移を残さない。R1 監査 2026-08-21）
    if (transitioned || hasAssignee) {
      const assigneeNote = hasAssignee ? `担当者: ${assigneeName || '解除'}` : ''
      await audit(pool, {
        actorId: user.id, action: 'update', entity: 'improvement_items', entityId: id,
        detail: transitioned
          ? `ステータス → ${IMPROVEMENT_ITEM_STATUS_META[to].label}${assigneeNote ? `（${assigneeNote}）` : ''}`
          : `担当者を変更（${assigneeNote}）`,
      })
    }
    // 対応済: 紐づく要望の起票者へ「対応済み」を通知する（改修依頼 2026-08-21: 要望の「対応済み」は
    // 改修案件のステータスに連動 = 起票者はこれを確認して「解決済み」へ移す。要望 1 件ごとに
    // 当該要望の詳細ディープリンク〔?req=〕付きで通知。主フロー成立後の補助処理 = 非ブロッキング〔原則4〕）
    if (to === 'done' && transitioned) {
      try {
        const { rows: reqs } = await pool.query<{ id: string; memberId: string }>(
          `SELECT id, member_id AS "memberId" FROM improvement_requests
           WHERE item_id = $1 AND archived_at IS NULL AND member_id IS NOT NULL`, [id])
        for (const r of reqs) {
          await notify(pool, r.memberId, 'system', '改善要望が「対応済み」になりました',
            '要望への対応が完了しました。内容をご確認のうえ、問題なければ要望を「解決済み」にしてください。',
            `/improvements?req=${r.id}`)
        }
      } catch (e) {
        console.warn('item done notify failed (non-blocking):', (e as Error).message)
      }
    }
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
    // 既定 = todo（改修依頼 2026-08-21: プロンプト出力の対象は「未対応」= 実施決定・未着手の案件のみ。
    // 旧語彙 triage/accepted/deferred も未対応へ正規化されて対象になる = 原則7。
    // filter パラメータ自体は下位互換のため維持 = 呼び出し側 UI は常に todo を送る）
    // 旧語彙のフィルター値は正規化して受理（下位互換 = 原則7。R2 レビュー: 旧値が常に 0 件になるのを防ぐ）
    const filter = normalizeImprovementFilter(String(body.filter ?? 'todo'))
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
        id: string; itemId: string; pageLabel: string; pagePath: string; targetSpot: string; body: string
        status: ImprovementRequestStatus; resolvedAt: string | null
        links: string[]; imageCount: number; createdAt: string
      }>(
        // createdAt を SELECT に加える（改修依頼 2026-08-19 第4弾: 要望とコメントをプロンプトで時系列統合）。
        // target_spot（対象箇所）・resolved_at（解決済み注記の判定）も加える（改修依頼 2026-08-21）
        `SELECT id, item_id AS "itemId", page_label AS "pageLabel", page_path AS "pagePath",
           target_spot AS "targetSpot", body,
           status, to_char(resolved_at ${JST}) AS "resolvedAt",
           links, jsonb_array_length(images) AS "imageCount", to_char(created_at ${JST}) AS "createdAt"
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
          pageLabel: r.pageLabel, pagePath: r.pagePath, targetSpot: r.targetSpot, body: r.body,
          // 受付箱ステータスを加味（解決済み・対応見送りは【解決済み】【対応見送り】で明記 = 再生成に反映）
          status: r.status, resolvedAt: r.resolvedAt,
          links: r.links ?? [], imageCount: Number(r.imageCount ?? 0),
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
 * 継続検討（deferred）の再検討日リマインド（改修依頼 2026-08-20 → 受付箱へ移管 2026-08-21）。
 * 日次ジョブ（/jobs/improvement-revisit-reminders）から呼ぶ。冪等に再実行できる（原則2）。
 * - 対象: **受付箱の要望**（status='deferred'・有効・revisit_on が今日〔JST〕以前）+
 *   **旧データの改修単位**（同条件。継続検討は受付箱へ移管したが、旧 deferred item のリマインドは
 *   期日どおり届け続ける = 原則7。item 側は新規に deferred へ遷移しないため自然に減衰する）。
 * - 通知: 管理者全員へ kind='reminder'（notifyAdmins = 非ブロッキング。原則4）。
 *   リンクは要望詳細（/improvements?req=<id>）/ 旧 item は改修案件ドロワー（/improvements?tab=items&open=<id>）。
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
  let notified = 0
  // 受付箱の要望（継続検討 = 改修依頼 2026-08-21 の一次フロー）。本文の先頭を件名に使う
  const { rows: reqRows } = await pool.query<{ id: string; body: string; revisitOn: string }>(
    `SELECT id, body, revisit_on::text AS "revisitOn" FROM improvement_requests
     WHERE status = 'deferred' AND archived_at IS NULL
       AND revisit_on IS NOT NULL AND revisit_on <= $1::date
       AND (revisit_notified_on IS NULL OR revisit_notified_on < revisit_on)
     ORDER BY revisit_on, id`, [today])
  for (const r of reqRows) {
    try {
      const head = capCodePoints(r.body.trim().replace(/\s*\n\s*/g, ' '), 60)
      await notifyAdmins(pool, 'reminder', '継続検討の再検討日です',
        `継続検討の再検討日です: ${head}（再検討日 ${r.revisitOn}）`,
        `/improvements?req=${r.id}`)
      // 通知マーカーは通知の後に記録（先に記録して通知に失敗すると永久に黙る方向の事故を避ける。
      // notifyAdmins は非ブロッキングのため、最悪でも「翌日以降に再通知されない」側に倒れる）
      await pool.query(`UPDATE improvement_requests SET revisit_notified_on = $2::date WHERE id = $1`, [r.id, today])
      notified += 1
    } catch (e) {
      console.warn('improvement revisit reminder failed (non-blocking):', (e as Error).message)
    }
  }
  // 旧データの改修単位（〜2026-08-20 に deferred となった item。原則7 = 期日どおり届け続ける）
  const { rows } = await pool.query<{ id: string; title: string; revisitOn: string }>(
    `SELECT id, title, revisit_on::text AS "revisitOn" FROM improvement_items
     WHERE status = 'deferred' AND archived_at IS NULL
       AND revisit_on IS NOT NULL AND revisit_on <= $1::date
       AND (revisit_notified_on IS NULL OR revisit_notified_on < revisit_on)
     ORDER BY revisit_on, id`, [today])
  for (const it of rows) {
    try {
      await notifyAdmins(pool, 'reminder', '継続検討の再検討日です',
        `継続検討の再検討日です: ${it.title}（再検討日 ${it.revisitOn}）`,
        `/improvements?tab=items&open=${it.id}`)
      await pool.query(`UPDATE improvement_items SET revisit_notified_on = $2::date WHERE id = $1`, [it.id, today])
      notified += 1
    } catch (e) {
      console.warn('improvement revisit reminder failed (non-blocking):', (e as Error).message)
    }
  }
  return { notified }
}
