/**
 * Hono アプリ組み立て。
 * ルーティング: /healthz（認証なし） / /v1/*（認証必須）
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type pg from 'pg'
import { authMiddleware } from './auth'
import type { Env } from './env'
import { errorResponse } from './lib/errors'
import { attendanceRoutes } from './routes/attendance'
import { configsRoutes } from './routes/configs'
import { escalationsRoutes } from './routes/escalations'
import { leaveRoutes, runPeriodicGrants } from './routes/leave'
import { mastersRoutes } from './routes/masters'
import { notificationsRoutes } from './routes/notifications'
import { reportsRoutes } from './routes/reports'
import { assistRoutes } from './routes/assist'
import { calendarOauthCallback, calendarRoutes } from './routes/calendar'
import { chatbotRoutes } from './routes/chatbot'
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

  // OAuth コールバックはブラウザリダイレクト（認証ヘッダなし）で届くため認証より前に登録する。
  // 本人性は state の HMAC（TOKEN_ENCRYPTION_KEY 署名）で担保する
  app.get('/v1/calendar/oauth/callback', calendarOauthCallback(pool, env))
  app.use('/v1/*', authMiddleware(env, pool))

  // 認証済みユーザー自身の情報（フロントの起動時に呼ぶ）
  app.get('/v1/me', (c) => c.json({ data: c.get('user') }))

  app.route('/v1/attendance', attendanceRoutes(pool))
  app.route('/v1/leave', leaveRoutes(pool))
  app.route('/v1/reports', reportsRoutes(pool))
  app.route('/v1/masters', mastersRoutes(pool))
  app.route('/v1/configs', configsRoutes(pool))
  app.route('/v1/notifications', notificationsRoutes(pool))
  app.route('/v1/escalations', escalationsRoutes(pool))
  app.route('/v1/workflows', workflowsRoutes(pool))
  app.route('/v1/shifts', shiftsRoutes(pool))
  app.route('/v1/task-plans', taskPlansRoutes(pool, env))
  app.route('/v1/assist', assistRoutes(pool, env))
  app.route('/v1/calendar', calendarRoutes(pool, env))
  app.route('/v1/chatbot', chatbotRoutes(pool, env))

  app.notFound(c => c.json({ error: { code: 'AKO-GEN-404', message: 'エンドポイントが見つかりません' } }, 404))

  return app
}
