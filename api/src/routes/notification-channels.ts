/**
 * 個人別マルチチャネル通知連携 API（Slack / Google Chat。改修依頼 2026-08-20）。mockup useNotificationChannels の API 版。
 *
 * AKEBONO HOME 名義化（オペレーター指示 2026-08-20）で個人 OAuth を廃止し、テナント資格情報による
 * アプリ名義送信へ切替（0077。旧方式の設計判断は 0075 時点の本ファイル履歴を参照）:
 * - 送信名義はアプリ「AKEBONO HOME」。Slack = Bot Token（SLACK_BOT_TOKEN）/
 *   Google Chat = Chat アプリのサービスアカウント（GOOGLE_CHAT_SA_KEY）。いずれも Secret Manager 経由の
 *   env で、ユーザーごとのトークン保管（旧 access_token_enc / refresh_token_enc）は行わない。
 * - 連携 = OAuth 同意ではなく**宛先解決**（POST /:service/link・1 クリック）。members.email を SoT に
 *   Slack は users.lookupByEmail → conversations.open、Google Chat は spaces.findDirectMessage →
 *   spaces.setup（いずれも lib/chat-dm.ts = 配信エンジンと共用。原則3）で DM 宛先を解決し
 *   user_chat_links（宛先キャッシュ）へ upsert する。誤リンク防止はメール突合そのもの（他人の宛先には
 *   解決し得ない）。state ノンス・コールバックは廃止（chat_oauth_states は残置・使用停止）。
 * - 通知マトリクスは user_preferences キー 'notificationChannels'（0039 基盤）へ保存（新テーブル不要）。
 * - 連携解除は行の物理削除（取消フロー = 原則9.5。再連携 = 1 クリックでいつでも復元できる）。
 *   テナント資格情報の revoke は行わない（他ユーザーの配信で共用しているため）。
 * - 配信エンジン（lib/notify.ts）の外部配信は本ルートのマウント時に configureExternalDispatch で有効化。
 * - 旧方式互換（原則7）: 旧 SPA キャッシュが呼ぶ POST /:service/oauth/url は 409（AKO-NCH-006）で
 *   再読み込みを案内する。/oauth/callback ルートは撤去（app.ts）。
 *
 * エラー: AKO-NCH-001 連携未設定 / 002 不正なサービス指定 / 003 未連携 /
 *         004 テスト送信失敗 / 005 マトリクス不正 / 006 旧方式互換（要再読み込み）/
 *         007 連携（宛先解決）失敗
 */
import { Hono } from 'hono'
import type pg from 'pg'
import {
  CHANNEL_META, CHAT_SERVICES, type ChatLinkStatus, type ChatService,
  NOTIFICATION_CHANNELS_PREF_KEY, parseNotificationMatrix, serializeNotificationMatrix,
} from '../../../shared/domain/notification-channels'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import {
  GOOGLE_CHAT_APP_SCOPE, googleChatFindOrCreateDm, slackResolveDm,
} from '../lib/chat-dm'
import { err } from '../lib/errors'
import { saAccessToken } from '../lib/google-sa'
import { configureExternalDispatch, deliverToService, type FailureDetailSink } from '../lib/notify'

/** :service パラメータの検証（allowlist 外は 400） */
function serviceOf(v: string): ChatService {
  if (v === 'slack' || v === 'google_chat') return v
  throw err('AKO-NCH-002', '連携先サービスの指定が不正です（slack / google_chat）', 400)
}

/** サービスごとの連携可否（テナント資格情報が投入済みか） */
function serviceEnabled(env: Env, service: ChatService): boolean {
  return service === 'slack' ? Boolean(env.slackBotToken) : Boolean(env.googleChatSaKey)
}

function requireEnabled(env: Env, service: ChatService): void {
  if (!serviceEnabled(env, service)) {
    throw err('AKO-NCH-001',
      `${CHANNEL_META[service].label} 連携が未設定です（管理者が通知アプリ「AKEBONO HOME」を設定すると利用できます）`, 400)
  }
}

/**
 * 宛先解決の失敗を利用者向けエラーへ写像する（詳細はオペレーター診断用にそのまま併記）。
 * guidance = fail 時に添えるユーザー操作の案内（Google Chat の DM 未作成フォールバック等）
 */
function linkError(
  label: string,
  step: { kind: 'retry' } | { kind: 'auth'; detail?: string } | { kind: 'fail'; detail: string },
  guidance = '',
): Error {
  if (step.kind === 'retry') {
    return err('AKO-NCH-007', `${label} との通信が混み合っています。時間をおいて再試行してください`, 502)
  }
  if (step.kind === 'auth') {
    const base = `${label} の送信用資格情報が無効です。管理者に確認を依頼してください`
    return err('AKO-NCH-007', step.detail ? `${base}（詳細: ${step.detail}）` : base, 502)
  }
  return err('AKO-NCH-007', `${label} の宛先を確認できませんでした。${guidance}（詳細: ${step.detail}）`, 400)
}

/** 連携行の upsert（再連携 = 宛先の上書き。旧方式のトークン残骸は消す = 0077 パッチと同じ扱い。冪等 = 原則2） */
async function upsertLink(
  pool: pg.Pool,
  memberId: string,
  service: ChatService,
  t: { externalUserId: string; displayName: string; dmTarget: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO user_chat_links (member_id, service, external_user_id, display_name, dm_target, status)
     VALUES ($1, $2, $3, $4, $5, 'connected')
     ON CONFLICT (member_id, service) DO UPDATE SET
       external_user_id = EXCLUDED.external_user_id,
       display_name = EXCLUDED.display_name,
       dm_target = EXCLUDED.dm_target,
       access_token_enc = '', refresh_token_enc = '', expires_at = NULL,
       status = 'connected', updated_at = now()`,
    [memberId, service, t.externalUserId, t.displayName, t.dmTarget])
}

export function notificationChannelsRoutes(pool: pg.Pool, env: Env): Hono {
  // 配信エンジン（lib/notify.ts）の外部配信をマウント時に有効化する
  configureExternalDispatch(pool, env)
  const app = new Hono()

  // 自分の連携状態 + 通知マトリクス（connected = 行があること）
  app.get('/', async (c) => {
    const user = c.get('user')
    const { rows } = await pool.query<{ service: ChatService; displayName: string; status: ChatLinkStatus }>(
      `SELECT service, display_name AS "displayName", status
       FROM user_chat_links WHERE member_id = $1`, [user.id])
    const { rows: prefRows } = await pool.query<{ value: unknown }>(
      `SELECT value FROM user_preferences WHERE member_id = $1 AND key = $2`,
      [user.id, NOTIFICATION_CHANNELS_PREF_KEY])
    const services = Object.fromEntries(CHAT_SERVICES.map((service) => {
      const row = rows.find(r => r.service === service)
      return [service, {
        enabled: serviceEnabled(env, service),
        connected: Boolean(row),
        status: row?.status ?? null,
        displayName: row?.displayName ?? '',
      }]
    }))
    return c.json({ data: { services, matrix: parseNotificationMatrix(prefRows[0]?.value) } })
  })

  // 通知マトリクスの保存（parse → 最小形へ正規化して user_preferences へ upsert。
  // 0039 の per-user 設定基盤と同一の upsert SQL = 4KB / 100 キー制限も同一（原則3））
  app.put('/matrix', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { matrix?: unknown }
    if (!body.matrix || typeof body.matrix !== 'object' || Array.isArray(body.matrix)) {
      throw err('AKO-NCH-005', '通知マトリクス（matrix）をオブジェクトで指定してください', 400)
    }
    const matrix = serializeNotificationMatrix(parseNotificationMatrix(body.matrix))
    const serialized = JSON.stringify(matrix)
    if (Buffer.byteLength(serialized, 'utf8') > 4096) {
      throw err('AKO-NCH-005', '設定値が大きすぎます', 400)
    }
    const { rowCount } = await pool.query(
      `INSERT INTO user_preferences (member_id, key, value)
       SELECT $1, $2, $3
       WHERE (SELECT count(*) FROM user_preferences WHERE member_id = $1) < 100
          OR EXISTS (SELECT 1 FROM user_preferences WHERE member_id = $1 AND key = $2)
       ON CONFLICT (member_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [user.id, NOTIFICATION_CHANNELS_PREF_KEY, serialized])
    if (rowCount === 0) throw err('AKO-NCH-005', '設定項目が多すぎます', 400)
    return c.json({ data: { matrix } })
  })

  // 連携（宛先解決。members.email を SoT にアプリと本人の DM を解決して保存する = 1 クリックで完結）
  app.post('/:service/link', async (c) => {
    const service = serviceOf(c.req.param('service'))
    requireEnabled(env, service)
    const user = c.get('user')
    const label = CHANNEL_META[service].label
    const { rows: memberRows } = await pool.query<{ email: string }>(
      `SELECT lower(email) AS email FROM members WHERE id = $1 AND active = true`, [user.id])
    const email = memberRows[0]?.email ?? ''
    if (!email) {
      throw err('AKO-NCH-007',
        'メールアドレスが未登録のため連携できません。管理者にメンバーマスタでの登録を依頼してください', 400)
    }
    let resolved: { externalUserId: string; displayName: string; dmTarget: string }
    if (service === 'slack') {
      const r = await slackResolveDm(env.slackBotToken ?? '', { email })
      if (r.kind !== 'ok') throw linkError(label, r)
      resolved = { externalUserId: r.value.userId, displayName: r.value.displayName, dmTarget: r.value.dmChannel }
    } else {
      const tokenResult = await saAccessToken(env.googleChatSaKey ?? '', GOOGLE_CHAT_APP_SCOPE)
      if (tokenResult.kind !== 'ok') throw linkError(label, tokenResult.kind === 'retry' ? { kind: 'retry' } : tokenResult)
      const r = await googleChatFindOrCreateDm(tokenResult.token, `users/${email}`)
      // DM スペースの作成（spaces.setup）が環境の制約で通らない場合に備え、確実に機能する
      // フォールバック（ユーザーがアプリへ一度 DM → 既存スペースとして解決できる）を案内する（監査 R1 MAJOR-2）
      if (r.kind !== 'ok') {
        throw linkError(label, r,
          'Google Chat で「AKEBONO HOME」アプリを検索して一度メッセージを送ってから、もう一度連携をお試しください')
      }
      resolved = { externalUserId: email, displayName: email, dmTarget: r.value }
    }
    await upsertLink(pool, user.id, service, resolved)
    await audit(pool, {
      actorId: user.id, action: 'connect', entity: 'user_chat_links', entityId: `${user.id}:${service}`,
      detail: `${label} 連携（${resolved.displayName}・AKEBONO HOME 名義）`,
    })
    return c.json({ data: { service, displayName: resolved.displayName } })
  })

  // 旧方式（個人 OAuth）の互換シム: 方式変更を跨いだ旧 SPA キャッシュへ再読み込みを案内する（原則7）
  app.post('/:service/oauth/url', (c) => {
    serviceOf(c.req.param('service'))
    throw err('AKO-NCH-006',
      '連携方式が新しくなりました。画面を再読み込みしてから、もう一度「連携する」を実行してください', 409)
  })

  // 連携解除（取消フロー = 原則9.5: 行の物理削除。再連携 = 1 クリックでいつでも復元できる）
  app.post('/:service/disconnect', async (c) => {
    const service = serviceOf(c.req.param('service'))
    const user = c.get('user')
    await pool.query(
      `DELETE FROM user_chat_links WHERE member_id = $1 AND service = $2`, [user.id, service])
    await audit(pool, {
      actorId: user.id, action: 'disconnect', entity: 'user_chat_links', entityId: `${user.id}:${service}`,
      detail: `${CHANNEL_META[service].label} 連携を解除`,
    })
    return c.json({ data: { ok: true } })
  })

  // テスト送信（AKEBONO HOME 名義で自分宛に実送信。連携カードの「テスト送信」= 主要操作のフィードバック）
  app.post('/:service/test', async (c) => {
    const service = serviceOf(c.req.param('service'))
    const user = c.get('user')
    const label = CHANNEL_META[service].label
    // 失敗ステップ・上流応答を診断用に受け取る（デプロイ障害対応 2026-08-20。テスト送信のみ = 配信経路は不変）
    const sink: FailureDetailSink = {}
    const result = await deliverToService(pool, env, user.id, service,
      `【テスト送信】AKEBONO Office の通知連携テストです（${user.name}）。この通知が届いていれば設定は完了です。`, sink)
    if (result === 'not_connected') {
      throw err('AKO-NCH-003', `${label} が未連携です。連携してからテスト送信してください`, 400)
    }
    if (result === 'auth') {
      const base = `${label} の送信用資格情報が無効です。管理者に確認を依頼してください`
      throw err('AKO-NCH-004', sink.detail ? `${base}（詳細: ${sink.detail}）` : base, 502)
    }
    if (result === 'fail') {
      const hint = service === 'google_chat'
        ? `${label} へのテスト送信に失敗しました。Google Chat API の有効化と Chat アプリ（AKEBONO HOME）の構成を確認してください。DM スペース未作成が原因の場合は、Google Chat で「AKEBONO HOME」アプリへ一度メッセージを送ってから再試行すると解決できます`
        : `${label} へのテスト送信に失敗しました。時間をおいて再試行してください`
      throw err('AKO-NCH-004', sink.detail ? `${hint}（詳細: ${sink.detail}）` : hint, 502)
    }
    return c.json({ data: { ok: true } })
  })

  return app
}
