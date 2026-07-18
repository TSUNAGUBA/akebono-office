/**
 * 検索インデックスの手動回復パス（AI 検索最適化基盤）。
 * 通常はマスタ書込後の自動再生成 + 起動時再生成で追随するため、本エンドポイントは
 * 「イベント経路が欠落した場合の再同期」用（原則6: イベント + 手動回復の両経路）。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { requireAdmin } from '../auth'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { rebuildSearchIndex } from '../lib/search-index'

export function searchRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // 全再生成（管理者のみ・冪等・同期実行 = 完了件数を返す）
  app.post('/reindex', async (c) => {
    const user = requireAdmin(c)
    const result = await rebuildSearchIndex(pool, env)
    await audit(pool, {
      actorId: user.id, action: 'reindex', entity: 'search_docs', entityId: '-',
      detail: `検索インデックスを再生成（${result.docs} 件・更新 ${result.upserted}・削除 ${result.deleted}・埋め込み ${result.embedded}）`,
    })
    return c.json({ data: result })
  })

  return app
}
