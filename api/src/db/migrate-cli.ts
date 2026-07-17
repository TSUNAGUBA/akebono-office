/** マイグレーション CLI（npm run db:migrate）。DATABASE_URL の DB へ適用して終了する */
import { loadEnv } from '../env'
import { createPool } from './pool'
import { migrate } from './migrate'

const env = loadEnv()
const pool = createPool(env)
try {
  await migrate(pool)
  console.log('migrate: 完了')
} finally {
  await pool.end()
}
