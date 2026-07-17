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
import { leaveRoutes } from './routes/leave'
import { mastersRoutes } from './routes/masters'
import { reportsRoutes } from './routes/reports'

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

  app.use('/v1/*', authMiddleware(env, pool))

  // 認証済みユーザー自身の情報（フロントの起動時に呼ぶ）
  app.get('/v1/me', (c) => c.json({ data: c.get('user') }))

  app.route('/v1/attendance', attendanceRoutes(pool))
  app.route('/v1/leave', leaveRoutes(pool))
  app.route('/v1/reports', reportsRoutes(pool))
  app.route('/v1/masters', mastersRoutes(pool))
  app.route('/v1/configs', configsRoutes(pool))

  app.notFound(c => c.json({ error: { code: 'AKO-GEN-404', message: 'エンドポイントが見つかりません' } }, 404))

  return app
}
