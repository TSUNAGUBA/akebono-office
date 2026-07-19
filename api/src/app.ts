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
import { attendanceRoutes } from './routes/attendance'
import { configsRoutes } from './routes/configs'
import { escalationsRoutes } from './routes/escalations'
import { holidaysRoutes } from './routes/holidays'
import { knowledgeRoutes } from './routes/knowledge'
import { leaveRoutes, runPeriodicGrants } from './routes/leave'
import { notesRoutes } from './routes/notes'
import { searchRoutes } from './routes/search'
import { mastersRoutes } from './routes/masters'
import { notificationsRoutes } from './routes/notifications'
import { reportsRoutes } from './routes/reports'
import { runSalesEtl, salesRoutes } from './routes/sales'
import { runUptimeRollup, statusRoutes } from './routes/status'
import { assistRoutes } from './routes/assist'
import { calendarOauthCallback, calendarRoutes } from './routes/calendar'
import { chatbotRoutes } from './routes/chatbot'
import { decisionsRoutes } from './routes/decisions'
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

  // OAuth コールバックはブラウザリダイレクト（認証ヘッダなし）で届くため認証より前に登録する。
  // 本人性は DB 保存の state ノンス（一回性・10 分 TTL）+ id_token の email と members.email の突合で担保する
  app.get('/v1/calendar/oauth/callback', calendarOauthCallback(pool, env))
  app.use('/v1/*', authMiddleware(env, pool))
  // 機能単位の権限ガード（F-16。認証の後段。/v1/masters・/v1/configs はデータ面のため対象外 = lib/permissions 参照）
  app.use('/v1/*', featureGuard(pool))

  // 認証済みユーザー自身の情報（フロントの起動時に呼ぶ）
  app.get('/v1/me', (c) => c.json({ data: c.get('user') }))

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
  app.route('/v1/reports', reportsRoutes(pool))
  app.route('/v1/masters', mastersRoutes(pool, env))
  app.route('/v1/configs', configsRoutes(pool))
  app.route('/v1/notifications', notificationsRoutes(pool))
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
  app.route('/v1/holidays', holidaysRoutes(pool))
  app.route('/v1/search', searchRoutes(pool, env))
  app.route('/v1/notes', notesRoutes(pool, env))
  app.route('/v1/knowledge', knowledgeRoutes(pool, env))

  app.notFound(c => c.json({ error: { code: 'AKO-GEN-404', message: 'エンドポイントが見つかりません' } }, 404))

  return app
}
