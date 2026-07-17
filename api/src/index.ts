/**
 * エントリポイント（Cloud Run / ローカル共通）。
 * 起動時にマイグレーションを適用してからリッスンする（冪等・advisory lock で多重起動安全）。
 */
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { migrate } from './db/migrate'
import { createPool } from './db/pool'
import { loadEnv } from './env'

const env = loadEnv()
const pool = createPool(env)

if (env.migrateOnStart) {
  await migrate(pool)
}

const app = createApp(env, pool)
const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`akebono-office-api listening on :${info.port} (auth=${env.authMode})`)
})

// Cloud Run の SIGTERM でグレースフルに停止する（処理中リクエストを流し切る）
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0))
    })
  })
}
