/**
 * SQL マイグレーションランナー（冪等・多重起動安全）
 * - db/migrations/*.sql をファイル名昇順に適用し、適用済みは schema_migrations で管理
 * - pg_advisory_lock で直列化（Cloud Run の複数インスタンス同時起動でも二重適用しない）
 * - 各ファイルはトランザクション内で適用（途中失敗時はそのファイルごとロールバック）
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

const MIGRATION_LOCK_KEY = 0x414b4542 // 'AKEB'

/** ビルド後（dist/db/migrations）と開発時（../../db/migrations）の両配置を解決する */
function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/index.js（bundle）からは ./db/migrations、src からは ../../db/migrations
  return here.endsWith('dist') ? join(here, 'db/migrations') : join(here, '../../db/migrations')
}

export async function migrate(pool: pg.Pool, log: (msg: string) => void = console.log): Promise<void> {
  const dir = migrationsDir()
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS app_office;
      CREATE TABLE IF NOT EXISTS app_office.schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)
    const { rows } = await client.query<{ name: string }>('SELECT name FROM app_office.schema_migrations')
    const applied = new Set(rows.map(r => r.name))
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = await readFile(join(dir, file), 'utf8')
      log(`migrate: applying ${file}`)
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO app_office.schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw new Error(`マイグレーション ${file} の適用に失敗: ${(e as Error).message}`)
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {})
    client.release()
  }
}
