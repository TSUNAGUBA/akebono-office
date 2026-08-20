/**
 * 通知の発行（補助処理・非ブロッキング: 失敗しても主フローを止めない。開発原則4）
 * home useNotifications.notify / notifyAdmins の API 版。
 *
 * 個人別マルチチャネル通知連携（改修依頼 2026-08-20）で配信エンジンを拡張。
 * AKEBONO Home 名義化（オペレーター指示 2026-08-20）で外部送信をテナント資格情報へ切替。シグネチャは不変:
 * - チャネル判定: 宛先ユーザーの通知マトリクス（user_preferences 'notificationChannels'。
 *   純ロジックは shared/domain/notification-channels.ts が SoT）を参照する。
 *   in_app が OFF の種別はアプリ内通知（INSERT）をスキップ。
 *   **fail-open / fail-closed の設計判断:** マトリクス取得に失敗した場合、アプリ内通知は送る
 *   （fail-open。承認依頼等の取りこぼしによる業務遅延の方が実害が大きい）。外部チャネルは
 *   送らない（fail-closed。設定不明のまま外部サービスへ送る誤送信を作らない）。
 * - 外部配信（Slack / Google Chat の DM）は fire-and-forget（void + catch）。外部 API の失敗・
 *   遅延・リトライは主フロー（INSERT・呼び出し元のレスポンス）へ一切影響しない。
 *   送信名義はアプリ「AKEBONO Home」（Slack = Bot Token / Google Chat = Chat アプリの
 *   サービスアカウント。プリミティブは lib/chat-dm.ts）。個人 OAuth トークンは 0077 で廃止。
 * - 宛先（user_chat_links.dm_target: Slack = DM チャンネル / Google Chat = スペース名）は連携時に
 *   解決済み。空の行（0075 時代の旧行）は送信時に解決して UPDATE する自己修復で新方式へ移行し、
 *   宛先の陳腐化（channel_not_found / スペース 404）も一度だけ再解決して回復する。
 * - リトライ: HTTP 5xx / 429（Slack の ratelimited 含む）は指数バックオフ（1s→2s→4s・計 3 回)。
 * - 認証エラー（invalid_auth / SA 鍵無効等）は**テナント資格情報の不備 = 管理者側の問題**。
 *   ユーザー行の状態遷移（旧 reauth_required）や本人への再連携催促は行わない（本人には直せないため）。
 *   ログ + テスト送信の診断詳細（FailureDetailSink）で運用者が検知する。
 * - 有効化: 外部配信は configureExternalDispatch(pool, env)（routes/notification-channels.ts の
 *   ルートファクトリがマウント時に登録）後に動く。fire-and-forget は呼び出し元の db ハンドル
 *   （トランザクション中の PoolClient = 応答後に解放され得る）を使わず、登録された Pool を使う。
 * - リアルタイム配信（SSE/WebSocket）は導入しない設計判断: クライアントは既存の 60 秒ポーリング
 *   （home useNotifications）を維持し、即時性は外部チャネル（Slack / Google Chat の DM）が担う。
 */
import type pg from 'pg'
import { nowJstIso } from '../../../shared/domain/jst'
import type { NotificationKind } from '../../../shared/domain/types'
import {
  channelEnabled, type ChatService, enabledExternalServices,
  NOTIFICATION_CHANNELS_PREF_KEY, type NotificationMatrix, parseNotificationMatrix,
} from '../../../shared/domain/notification-channels'
import type { Env } from '../env'
import {
  GOOGLE_CHAT_APP_SCOPE, googleChatFindOrCreateDm, googleChatPostDm,
  slackPostDm, slackResolveDm, type StepResult,
} from './chat-dm'
import { saAccessToken } from './google-sa'
import { newId } from './ids'

// ---------- 外部配信コンテキスト（notification-channels ルートのマウント時に登録） ----------

let dispatchCtx: { pool: pg.Pool; env: Env } | null = null

/**
 * 外部チャット配信を有効化する（routes/notification-channels.ts のルートファクトリが呼ぶ）。
 * 未登録の間は従来どおりアプリ内通知のみ（マトリクスの in_app 判定は登録前でも有効）。
 */
export function configureExternalDispatch(pool: pg.Pool, env: Env): void {
  dispatchCtx = { pool, env }
}

export async function notify(
  db: pg.Pool | pg.PoolClient,
  memberId: string,
  kind: NotificationKind,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  // 宛先ユーザーの通知マトリクス（取得失敗 = null → in_app へ送る fail-open / 外部へは送らない fail-closed）
  let matrix: NotificationMatrix | null = null
  try {
    const { rows } = await db.query<{ value: unknown }>(
      `SELECT value FROM user_preferences WHERE member_id = $1 AND key = $2`,
      [memberId, NOTIFICATION_CHANNELS_PREF_KEY])
    matrix = parseNotificationMatrix(rows[0]?.value) // 行なし = {} = 全セル既定値（in_app のみ ON）
  } catch (e) {
    console.warn('notify: matrix load failed (fail-open to in_app):', (e as Error).message)
  }
  if (!matrix || channelEnabled(matrix, kind, 'in_app')) {
    try {
      await db.query(
        `INSERT INTO notifications (id, member_id, kind, title, body, link, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId('nt'), memberId, kind, title, body, link, nowJstIso()],
      )
    } catch (e) {
      console.warn('notify failed (non-blocking):', (e as Error).message)
    }
  }
  // 外部配信は fire-and-forget（登録済み Pool を使用。呼び出し元の db が PoolClient でも安全）
  const ctx = dispatchCtx
  if (matrix && ctx) {
    const services = enabledExternalServices(matrix, kind)
    if (services.length > 0) {
      void dispatchExternal(ctx, memberId, services, title, body, link)
        .catch(e => console.warn('notify external dispatch failed (non-blocking):', (e as Error).message))
    }
  }
}

/** 管理者全員へ通知する（home と同一: role='admin' の在籍者） */
export async function notifyAdmins(
  db: pg.Pool | pg.PoolClient,
  kind: NotificationKind,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM members WHERE active = true AND role = 'admin'`)
    for (const m of rows) {
      await notify(db, m.id, kind, title, body, link)
    }
  } catch (e) {
    console.warn('notifyAdmins failed (non-blocking):', (e as Error).message)
  }
}

// ---------- 外部配信エンジン ----------

interface ChatLinkRow {
  service: ChatService
  /** Slack = ユーザー id（U…）/ Google = users/{...} の識別子（旧行 = sub / 新行 = email）。空 = 未解決 */
  externalUserId: string
  /** 解決済みの DM 宛先（Slack = チャンネル id / Google = スペース名）。空 = 送信時に自己修復 */
  dmTarget: string
  status: string
  /** 宛先解決（メール突合）用の members.email */
  email: string
}

const LINK_COLS = `l.service, l.external_user_id AS "externalUserId", l.dm_target AS "dmTarget",
  l.status, lower(m.email) AS email`
const LINK_FROM = `FROM user_chat_links l JOIN members m ON m.id = l.member_id`

/** 1 回の送信試行の結果。retry = 一時障害（5xx/429/タイムアウト）/ auth = テナント資格情報の不備 */
type DeliveryResult = 'ok' | 'auth' | 'retry' | 'fail'

/**
 * 失敗詳細の受け皿（テスト送信の診断用 = デプロイ障害対応 2026-08-20）。
 * どのステップが何の応答で失敗したかを 1 行で記録し、テスト送信のエラーメッセージへ併記して
 * オペレーターが自己診断できるようにする（バックグラウンド配信では未使用 = 挙動不変）
 */
export interface FailureDetailSink { detail?: string }

/**
 * 指数バックオフの待ち時間列（1s→2s→4s。既定 3 回）。純関数（単体テスト対象）。
 */
export function backoffDelays(retries = 3): number[] {
  return Array.from({ length: retries }, (_, i) => 1000 * 2 ** i)
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** chat-dm の StepResult を DeliveryResult へ写像する（fail / auth の診断詳細は sink へ） */
function stepToDelivery(step: StepResult<unknown>, sink?: FailureDetailSink): DeliveryResult {
  if (step.kind === 'ok') return 'ok'
  if (step.kind !== 'retry' && sink && !sink.detail && step.detail) sink.detail = step.detail
  return step.kind === 'fail' ? 'fail' : step.kind === 'auth' ? 'auth' : 'retry'
}

/** 有効チャネルへ順次配信する（1 チャネルの失敗が他チャネルを止めないよう結果は個別処理） */
async function dispatchExternal(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  services: ChatService[],
  title: string,
  body: string,
  link: string,
): Promise<void> {
  const text = externalMessageText(ctx.env, title, body, link)
  const { rows } = await ctx.pool.query<ChatLinkRow>(
    `SELECT ${LINK_COLS} ${LINK_FROM} WHERE l.member_id = $1`, [memberId])
  for (const service of services) {
    const linkRow = rows.find(r => r.service === service)
    // 未連携（行なし）はスキップ。status は判定に使わない（旧方式の 'reauth_required' が
    // ローリングデプロイの重なり窓で書かれても配信を止めない = レビュー R1 m-1。成功時に自己修復）
    if (!linkRow) continue
    await deliverViaLink(ctx, memberId, linkRow, text)
  }
}

/** 外部チャットへ送る本文（リンクはフロントのハッシュルートを絶対 URL 化して添える） */
function externalMessageText(env: Env, title: string, body: string, link: string): string {
  const frontOrigin = env.corsOrigins[0] ?? ''
  const url = link && frontOrigin ? `\n${frontOrigin}/#${link}` : ''
  return `【${title}】\n${body}${url}`
}

/**
 * 1 リンクへの配信（リトライ込み）。deliverToService（テスト送信）とも共用（原則3）。
 * 戻り値は最終結果（retry を使い切った場合は 'fail'）。
 */
async function deliverViaLink(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  link: ChatLinkRow,
  text: string,
  sink?: FailureDetailSink,
): Promise<Exclude<DeliveryResult, 'retry'>> {
  // バックグラウンド配信（sink 未指定）でも失敗の一次原因をログへ残す（レビュー R1 m-2 = 可観測性）
  const detailSink: FailureDetailSink = sink ?? {}
  const attempt = (): Promise<DeliveryResult> => link.service === 'slack'
    ? sendSlackDm(ctx, memberId, link, text, detailSink)
    : sendGoogleChatDm(ctx, memberId, link, text, detailSink)
  let result = await attempt()
  for (const delay of backoffDelays()) {
    if (result !== 'retry') break
    await wait(delay)
    result = await attempt()
  }
  const final: Exclude<DeliveryResult, 'retry'> = result === 'retry' ? 'fail' : result
  // 再試行上限で fail に確定した場合も診断詳細を残す（レビュー R1。即時 fail は各送信関数が記録済み）
  if (result === 'retry' && !detailSink.detail) detailSink.detail = '再試行上限に到達（持続的な 5xx / 429 / タイムアウト）'
  // 認証エラー = テナント資格情報（Bot Token / SA 鍵）の不備。ユーザー操作では直らないため
  // 本人向けの状態遷移・催促はせず、運用ログ + テスト送信の診断で検知する
  const suffix = detailSink.detail ? ` (${detailSink.detail})` : ''
  if (final === 'auth') console.warn(`notify: external delivery auth failed (tenant credential): ${link.service}${suffix}`)
  if (final === 'fail') console.warn(`notify: external delivery failed: ${link.service} member=${memberId}${suffix}`)
  // 配信成功した行の旧 status（'reauth_required' = ローリングデプロイの重なり窓で旧コードが書いた値）を
  // 'connected' へ自己修復する（レビュー R1 m-1。冪等 WHERE ガード）
  if (final === 'ok' && link.status !== 'connected') {
    try {
      await ctx.pool.query(
        `UPDATE user_chat_links SET status = 'connected', updated_at = now()
          WHERE member_id = $1 AND service = $2 AND status <> 'connected'`, [memberId, link.service])
      link.status = 'connected'
    } catch (e) {
      console.warn('notify: status heal failed (non-blocking):', (e as Error).message)
    }
  }
  return final
}

/**
 * テスト送信等の単発配信（POST /v1/notification-channels/:service/test が利用）。
 * not_connected = 行なし（送信は行わない）。
 */
export async function deliverToService(
  pool: pg.Pool,
  env: Env,
  memberId: string,
  service: ChatService,
  text: string,
  sink?: FailureDetailSink,
): Promise<'ok' | 'auth' | 'fail' | 'not_connected'> {
  const { rows } = await pool.query<ChatLinkRow>(
    `SELECT ${LINK_COLS} ${LINK_FROM} WHERE l.member_id = $1 AND l.service = $2`, [memberId, service])
  const link = rows[0]
  if (!link) return 'not_connected'
  return deliverViaLink({ pool, env }, memberId, link, text, sink)
}

/** 解決済み宛先の保存（自己修復。display_name は解決で得られたときのみ更新 = 既存表示名を保護） */
async function persistDmTarget(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  link: ChatLinkRow,
  resolved: { externalUserId: string; dmTarget: string; displayName: string },
): Promise<void> {
  try {
    await ctx.pool.query(
      `UPDATE user_chat_links
          SET external_user_id = $3, dm_target = $4,
              display_name = CASE WHEN $5 <> '' THEN $5 ELSE display_name END,
              updated_at = now()
        WHERE member_id = $1 AND service = $2`,
      [memberId, link.service, resolved.externalUserId, resolved.dmTarget, resolved.displayName])
  } catch (e) {
    console.warn('notify: persist dm target failed (non-blocking):', (e as Error).message)
  }
  link.externalUserId = resolved.externalUserId
  link.dmTarget = resolved.dmTarget
}

// ---------- Slack（Bot Token 方式: AKEBONO Home 名義で DM へ投稿） ----------

/**
 * Slack の宛先解決 + 保存（自己修復の共通経路）。保存済み userId が陳腐化していた場合
 * （ユーザー再作成等で user_not_found）は現在の members.email で 1 回だけ再解決する（監査 R1 MINOR-2）
 */
async function resolveSlackDmForRow(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  link: ChatLinkRow,
  botToken: string,
): Promise<StepResult<string>> {
  let resolved = await slackResolveDm(botToken, { email: link.email, userId: link.externalUserId || undefined })
  if (resolved.kind === 'fail' && link.externalUserId && /users?_not_found/.test(resolved.detail)) {
    resolved = await slackResolveDm(botToken, { email: link.email })
  }
  if (resolved.kind !== 'ok') return resolved
  await persistDmTarget(ctx, memberId, link, {
    externalUserId: resolved.value.userId, dmTarget: resolved.value.dmChannel, displayName: resolved.value.displayName,
  })
  return { kind: 'ok', value: resolved.value.dmChannel }
}

async function sendSlackDm(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  link: ChatLinkRow,
  text: string,
  sink?: FailureDetailSink,
): Promise<DeliveryResult> {
  const botToken = ctx.env.slackBotToken
  if (!botToken) {
    if (sink && !sink.detail) sink.detail = 'SLACK_BOT_TOKEN が未設定です（管理者設定）'
    return 'fail'
  }
  // 宛先（DM チャンネル）の確保。未解決の旧行（0075 時代）はここで自己修復して新方式へ移行する
  let target = link.dmTarget
  let freshlyResolved = false
  if (!target) {
    const resolved = await resolveSlackDmForRow(ctx, memberId, link, botToken)
    if (resolved.kind !== 'ok') return stepToDelivery(resolved, sink)
    target = resolved.value
    freshlyResolved = true
  }
  const posted = await slackPostDm(botToken, target, text)
  // キャッシュ宛先の陳腐化（channel_not_found）は一度だけ再解決して再送する
  if (!freshlyResolved && posted.kind === 'fail' && posted.detail.includes('channel_not_found')) {
    const resolved = await resolveSlackDmForRow(ctx, memberId, link, botToken)
    if (resolved.kind !== 'ok') return stepToDelivery(resolved, sink)
    return stepToDelivery(await slackPostDm(botToken, resolved.value, text), sink)
  }
  return stepToDelivery(posted, sink)
}

// ---------- Google Chat（Chat アプリ方式: AKEBONO Home 名義で DM スペースへ投稿） ----------

/**
 * Google Chat の users/{...} 識別子。旧行（0075 の sub）はそのまま有効。email ベースの行は
 * 保存値ではなく**現在の** members.email を使う（改姓等でメールが変わっても自己修復が働く =
 * レビュー R1 m-5）
 */
function chatUserRef(link: ChatLinkRow): string {
  const id = link.externalUserId
  return `users/${id && !id.includes('@') ? id : link.email}`
}

/** Google Chat の宛先解決 + 保存（自己修復の共通経路） */
async function resolveChatSpaceForRow(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  link: ChatLinkRow,
  token: string,
): Promise<StepResult<string>> {
  const userRef = chatUserRef(link)
  const resolved = await googleChatFindOrCreateDm(token, userRef)
  if (resolved.kind !== 'ok') return resolved
  await persistDmTarget(ctx, memberId, link, {
    externalUserId: userRef.slice('users/'.length), dmTarget: resolved.value, displayName: '',
  })
  return resolved
}

async function sendGoogleChatDm(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  link: ChatLinkRow,
  text: string,
  sink?: FailureDetailSink,
): Promise<DeliveryResult> {
  const saKey = ctx.env.googleChatSaKey
  if (!saKey) {
    if (sink && !sink.detail) sink.detail = 'GOOGLE_CHAT_SA_KEY が未設定です（管理者設定）'
    return 'fail'
  }
  const tokenResult = await saAccessToken(saKey, GOOGLE_CHAT_APP_SCOPE)
  if (tokenResult.kind !== 'ok') {
    // retry = トークンエンドポイントの一時障害（バックオフ対象）/ auth = 鍵不備・交換拒否（診断詳細つき）
    if (tokenResult.kind === 'auth' && sink && !sink.detail) sink.detail = tokenResult.detail
    return tokenResult.kind
  }
  const token = tokenResult.token
  // 宛先（DM スペース）の確保。旧行（users/{sub}）も新行（users/{email}）もそのまま解決できる
  let space = link.dmTarget
  let freshlyResolved = false
  if (!space) {
    const resolved = await resolveChatSpaceForRow(ctx, memberId, link, token)
    if (resolved.kind !== 'ok') return stepToDelivery(resolved, sink)
    space = resolved.value
    freshlyResolved = true
  }
  const posted = await googleChatPostDm(token, space, text)
  // キャッシュ宛先の陳腐化（スペース削除 = 404）は一度だけ再解決して再送する
  if (!freshlyResolved && posted.kind === 'fail' && posted.detail.includes('HTTP 404')) {
    const resolved = await resolveChatSpaceForRow(ctx, memberId, link, token)
    if (resolved.kind !== 'ok') return stepToDelivery(resolved, sink)
    return stepToDelivery(await googleChatPostDm(token, resolved.value, text), sink)
  }
  return stepToDelivery(posted, sink)
}
