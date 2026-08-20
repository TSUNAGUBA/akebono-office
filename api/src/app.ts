/**
 * Hono アプリ組み立て。
 * ルーティング: /healthz（認証なし） / /v1/*（認証必須）
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import type pg from 'pg'
import { authMiddleware } from './auth'
import type { Env } from './env'
import { audit } from './lib/audit'
import { errorResponse } from './lib/errors'
import { featureGuard } from './lib/permissions'
import { aiCompanyRoutes } from './routes/ai-company'
import { akebonoRoutes } from './routes/akebono'
import { akebonoBillingRoutes } from './routes/akebono-billing'
import { akebonoDashboardRoutes } from './routes/akebono-dashboard'
import { akebonoImportsRoutes } from './routes/akebono-imports'
import { sheetsOauthCallback, sheetsRoutes } from './routes/sheets'
import { akebonoTradeRoutes } from './routes/akebono-trade'
import { partnerActivitiesRoutes, salesActivitiesRoutes, supportActivitiesRoutes } from './routes/activities'
import { attendanceRoutes } from './routes/attendance'
import { configsRoutes } from './routes/configs'
import { customerContextsRoutes } from './routes/customer-contexts'
import { customerLogsRoutes } from './routes/customer-logs'
import { escalationsRoutes } from './routes/escalations'
import { holidaysRoutes } from './routes/holidays'
import { improvementsRoutes, runImprovementRevisitReminders } from './routes/improvements'
import { knowledgeRoutes } from './routes/knowledge'
import { leaveRoutes, runPeriodicGrants } from './routes/leave'
import { notesRoutes } from './routes/notes'
import { searchRoutes } from './routes/search'
import { mastersRoutes } from './routes/masters'
import { notificationsRoutes } from './routes/notifications'
import { reportsRoutes, runReportReminders } from './routes/reports'
import { notificationChannelsRoutes } from './routes/notification-channels'
import { runSalesEtl, salesRoutes } from './routes/sales'
import { runUptimeRollup, statusRoutes } from './routes/status'
import { assistRoutes } from './routes/assist'
import { calendarOauthCallback, calendarRoutes } from './routes/calendar'
import { mediaOauthCallback, mediaRoutes } from './routes/media'
import { chatbotRoutes } from './routes/chatbot'
import { decisionsRoutes } from './routes/decisions'
import { documentsRoutes } from './routes/documents'
import { shiftsRoutes } from './routes/shifts'
import { taskPlansRoutes } from './routes/task-plans'
import { workflowsRoutes } from './routes/workflows'
import { err } from './lib/errors'

export function createApp(env: Env, pool: pg.Pool): Hono {
  const app = new Hono()

  app.onError((e, c) => errorResponse(c, e))

  if (env.corsOrigins.length > 0) {
    app.use('/v1/*', cors({
      origin: env.corsOrigins,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'x-dev-member-id'],
      maxAge: 3600,
    }))
  }

  // リクエストボディの総量制限（添付 = 10MB × 5 件の base64 ≒ 70MB を許容し、それ以上は 413。
  // cors の後段に置く = 413 応答にも CORS ヘッダが付き、フロントがエラーメッセージを読める）
  app.use('/v1/*', bodyLimit({
    maxSize: 80 * 1024 * 1024,
    onError: c => c.json({ error: { code: 'AKO-GEN-004', message: 'リクエストが大きすぎます（添付は 10MB × 5 件までにしてください）' } }, 413),
  }))

  // ヘルスチェック（Cloud Run の起動プローブ・監視用。DB 死活も返すが 200 は維持 = 非ブロッキング）
  app.get('/healthz', async (c) => {
    let db = 'ok'
    try {
      await pool.query('SELECT 1')
    } catch {
      db = 'error'
    }
    return c.json({ status: 'ok', db })
  })

  // バッチジョブ（Cloud Scheduler → OIDC ではなく共有鍵。CRON_SECRET 未設定時は無効 = 手動実行のみ）
  app.post('/jobs/periodic-leave-grants', async (c) => {
    const secret = process.env.CRON_SECRET ?? ''
    if (!secret || c.req.header('x-cron-key') !== secret) {
      throw err('AKO-AUTH-001', 'ジョブ実行キーが無効です', 401)
    }
    const result = await runPeriodicGrants(pool, null)
    return c.json({ data: result })
  })

  // mart ETL の日次バッチ（Cloud Scheduler → 共有鍵。周期有給付与と同型）
  app.post('/jobs/sales-mart-etl', async (c) => {
    const secret = process.env.CRON_SECRET ?? ''
    if (!secret || c.req.header('x-cron-key') !== secret) {
      throw err('AKO-AUTH-001', 'ジョブ実行キーが無効です', 401)
    }
    const result = await runSalesEtl(pool)
    return c.json({ data: result })
  })

  // 稼働状況 uptime の日次ロールアップ（Cloud Scheduler → 共有鍵。未解決インシデントの停止時間を進める）
  app.post('/jobs/uptime-rollup', async (c) => {
    const secret = process.env.CRON_SECRET ?? ''
    if (!secret || c.req.header('x-cron-key') !== secret) {
      throw err('AKO-AUTH-001', 'ジョブ実行キーが無効です', 401)
    }
    const result = await runUptimeRollup(pool)
    return c.json({ data: result })
  })

  // 日報の自動リマインド（Cloud Scheduler → 共有鍵。改修依頼 2026-08-20。設定時刻・日次1回の判定はジョブ内部 =
  // 任意の周期で安全・冪等。設定 = configs 'report-reminder'）
  app.post('/jobs/report-reminders', async (c) => {
    const secret = process.env.CRON_SECRET ?? ''
    if (!secret || c.req.header('x-cron-key') !== secret) {
      throw err('AKO-AUTH-001', 'ジョブ実行キーが無効です', 401)
    }
    const result = await runReportReminders(pool)
    return c.json({ data: result })
  })

  // 改修案件「継続検討」の再検討日リマインド（Cloud Scheduler 日次 → 共有鍵。改修依頼 2026-08-20。
  // 通知済みマーカー revisit_notified_on で多重通知を防止 = 冪等）
  app.post('/jobs/improvement-revisit-reminders', async (c) => {
    const secret = process.env.CRON_SECRET ?? ''
    if (!secret || c.req.header('x-cron-key') !== secret) {
      throw err('AKO-AUTH-001', 'ジョブ実行キーが無効です', 401)
    }
    const result = await runImprovementRevisitReminders(pool)
    return c.json({ data: result })
  })

  // OAuth コールバックはブラウザリダイレクト（認証ヘッダなし）で届くため認証より前に登録する。
  // 本人性は DB 保存の state ノンス（一回性・10 分 TTL）+ id_token の email と members.email の突合で担保する
  app.get('/v1/calendar/oauth/callback', calendarOauthCallback(pool, env))
  app.get('/v1/media/oauth/callback', mediaOauthCallback(pool, env))
  app.get('/v1/akebono/sheets/oauth/callback', sheetsOauthCallback(pool, env))
  // 個人別チャット連携（Slack / Google Chat）の OAuth コールバックは AKEBONO Home 名義化（0077）で廃止
  // （連携 = 認証後の POST /v1/notification-channels/:service/link による宛先解決へ）
  app.use('/v1/*', authMiddleware(env, pool))
  // 機能単位の権限ガード（F-16。認証の後段。/v1/masters・/v1/configs はデータ面のため対象外 = lib/permissions 参照）
  app.use('/v1/*', featureGuard(pool))

  // 認証済みユーザー自身の情報（フロントの起動時に呼ぶ）。
  // prefs = 本人の UI 設定（user_preferences。端末間で同期する個人設定。現状 currentSegmentId）。
  // app_configs（テナント全体）と別に per-user で保管する（0039）。
  app.get('/v1/me', async (c) => {
    const user = c.get('user')
    const { rows } = await pool.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM user_preferences WHERE member_id = $1', [user.id])
    return c.json({ data: { ...user, prefs: Object.fromEntries(rows.map(r => [r.key, r.value])) } })
  })

  // 本人の UI 設定の保存（端末間同期。現在の業態など）。本人のみ・upsert = 冪等（原則2）。
  // 監査ログは記録しない: per-user の UI 選択状態は高頻度・非セキュリティで、記録すると監査ログを汚す
  // （app_configs = 管理者のテナント設定は監査対象だが、本エンドポイントは性質が異なる）。
  app.put('/v1/me/preferences/:key', async (c) => {
    const user = c.get('user')
    const key = c.req.param('key')
    // キー形式は app_configs（configs.ts）と同一の allowlist（任意キーの持込・インジェクション防止）
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) {
      throw err('AKO-GEN-001', '設定キーの形式が不正です', 400)
    }
    const body = await c.req.json().catch(() => undefined) as { value?: unknown } | undefined
    if (body === undefined || !('value' in body)) {
      throw err('AKO-GEN-001', '設定値（value）を指定してください', 400)
    }
    // per-user 設定は軽量に保つ。value は実バイト 4KB 上限（巨大 payload 防止）。
    // body.value は JSON 由来のため JSON.stringify は必ず文字列を返す（undefined 分岐は不要）
    const serialized = JSON.stringify(body.value)
    if (Buffer.byteLength(serialized, 'utf8') > 4096) {
      throw err('AKO-GEN-001', '設定値が大きすぎます', 400)
    }
    // 新規キーは 1 ユーザーあたり上限（既存キーの更新は常に可）= 行数の暴走防止（原則2）。
    // 既存キーは EXISTS が真で WHERE を通過 → upsert。上限超過の新規キーのみ 0 行 = 拒否。
    const { rowCount } = await pool.query(
      `INSERT INTO user_preferences (member_id, key, value)
       SELECT $1, $2, $3
       WHERE (SELECT count(*) FROM user_preferences WHERE member_id = $1) < 100
          OR EXISTS (SELECT 1 FROM user_preferences WHERE member_id = $1 AND key = $2)
       ON CONFLICT (member_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [user.id, key, serialized])
    if (rowCount === 0) throw err('AKO-GEN-001', '設定項目が多すぎます', 400)
    return c.json({ data: { key, value: body.value } })
  })

  // プロフィール更新（本人のみ。バッチ5e: アイコン画像の登録・削除）
  app.put('/v1/me/profile', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { avatar?: unknown }
    if (typeof body.avatar !== 'string') {
      throw err('AKO-GEN-001', 'avatar を指定してください（空文字 = 画像を削除）', 400)
    }
    const avatar = body.avatar
    // サブタイプ allowlist + base64 必須（SVG 等のスクリプト混入可能な形式・任意テキストの持込を拒否。
    // クライアントは canvas.toDataURL('image/jpeg') で生成するため常にこの形式に一致する）
    if (avatar !== '' && !/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
      throw err('AKO-GEN-001', 'avatar は data:image/png・jpeg・webp の base64 形式で指定してください', 400)
    }
    if (avatar.length > 300_000) {
      throw err('AKO-GEN-001', '画像が大きすぎます（縮小して再度お試しください）', 400)
    }
    await pool.query('UPDATE members SET avatar = $2, updated_at = now() WHERE id = $1', [user.id, avatar])
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'members', entityId: user.id,
      detail: avatar ? 'プロフィール画像を更新' : 'プロフィール画像を削除',
    })
    return c.json({ data: { ...user, avatar } })
  })

  app.route('/v1/attendance', attendanceRoutes(pool))
  app.route('/v1/leave', leaveRoutes(pool))
  app.route('/v1/reports', reportsRoutes(pool, env))
  app.route('/v1/masters', mastersRoutes(pool, env))
  app.route('/v1/configs', configsRoutes(pool))
  app.route('/v1/notifications', notificationsRoutes(pool))
  // 個人別マルチチャネル通知連携（Slack / Google Chat。改修依頼 2026-08-20。マウントで外部配信も有効化）
  app.route('/v1/notification-channels', notificationChannelsRoutes(pool, env))
  app.route('/v1/escalations', escalationsRoutes(pool, env))
  app.route('/v1/workflows', workflowsRoutes(pool))
  app.route('/v1/shifts', shiftsRoutes(pool))
  app.route('/v1/task-plans', taskPlansRoutes(pool, env))
  app.route('/v1/assist', assistRoutes(pool, env))
  app.route('/v1/calendar', calendarRoutes(pool, env))
  app.route('/v1/chatbot', chatbotRoutes(pool, env))
  app.route('/v1/ai-company', aiCompanyRoutes(pool, env))
  app.route('/v1/decisions', decisionsRoutes(pool))
  app.route('/v1/sales', salesRoutes(pool))
  app.route('/v1/status', statusRoutes(pool))
  app.route('/v1/akebono', akebonoRoutes(pool))
  // Phase C（0032）: 記録系。同一 /v1/akebono 配下に取引系・売上/請求系を追加マウント
  app.route('/v1/akebono', akebonoTradeRoutes(pool))
  app.route('/v1/akebono', akebonoBillingRoutes(pool))
  // Phase D（0035-0038）: データ取込（F-32）・ダッシュボード AI レポート保管（F-41）を同配下へ追加マウント
  app.route('/v1/akebono', akebonoImportsRoutes(pool, env))
  app.route('/v1/akebono', sheetsRoutes(pool, env))
  app.route('/v1/akebono', akebonoDashboardRoutes(pool, env))
  app.route('/v1/holidays', holidaysRoutes(pool))
  app.route('/v1/search', searchRoutes(pool, env))
  app.route('/v1/notes', notesRoutes(pool, env))
  app.route('/v1/customer-logs', customerLogsRoutes(pool, env))
  // 顧客コンテキスト（定性情報 + メモ + AI リサーチ。改修依頼 2026-08-20）
  app.route('/v1/customer-contexts', customerContextsRoutes(pool, env))
  // 活動記録 3 種（0067）: サポート/営業/ビジネスパートナー活動（チーム共有の記録系。改修依頼 2026-08-18）
  app.route('/v1/support-activities', supportActivitiesRoutes(pool))
  app.route('/v1/sales-activities', salesActivitiesRoutes(pool, env))
  app.route('/v1/partner-activities', partnerActivitiesRoutes(pool, env))
  app.route('/v1/knowledge', knowledgeRoutes(pool, env))
  app.route('/v1/documents', documentsRoutes(pool, env))
  app.route('/v1/media', mediaRoutes(pool, env))
  // F-42（0057）: 改善要望。投稿は全員可・管理系はルート内で canManageImprovements ガード（featureGuard 非対象）
  app.route('/v1/improvements', improvementsRoutes(pool, env))

  app.notFound(c => c.json({ error: { code: 'AKO-GEN-404', message: 'エンドポイントが見つかりません' } }, 404))

  return app
}
