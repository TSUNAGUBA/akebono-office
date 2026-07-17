/**
 * PostgreSQL 接続プール。
 * - date 型は 'YYYY-MM-DD' 文字列で受け取る（shared/domain の日付キー運用と一致させる）
 * - search_path は app_office（マイグレーションで作成）
 */
import pg from 'pg'
import type { Env } from '../env'

// OID 1082 = date。Date オブジェクト化せず文字列のまま返す（TZ ずれ防止）
pg.types.setTypeParser(1082, (v: string) => v)
// OID 1700 = numeric。数値として返す（日数・工数は小数を含む）
pg.types.setTypeParser(1700, (v: string) => Number(v))

export function createPool(env: Env): pg.Pool {
  const ssl = env.dbSsl === 'disable'
    ? undefined
    : env.dbSsl === 'verify'
      ? { ca: env.dbSslCa, rejectUnauthorized: true }
      : { rejectUnauthorized: false } // require: 暗号化のみ（検証なし。本番は verify を推奨）
  const pool = new pg.Pool({
    connectionString: env.databaseUrl,
    ssl,
    max: Number(process.env.DB_POOL_MAX ?? 5), // Cloud Run はインスタンス並行数と掛け算になるため控えめに
    options: '-c search_path=app_office',
  })
  return pool
}
