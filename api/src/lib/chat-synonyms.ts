/**
 * チャットボット同義語辞書（オペレーター指示 2026-08-05: フィードバック還元ループ）。
 * トレーナーが登録した「ユーザーの言い回し（term）→ 話題判定の正規語（canonical）」を
 * buildContext の話題コーパスへ追補し、精密ブロックの語彙ギャップ（例:「休み」で勤怠ブロックが
 * 発火しない）を運用で埋める。質問文自体は変更しない（LLM へ渡る質問は原文のまま）。
 * キャッシュはプロセスローカル短期 TTL（permissions.ts の activePermissionRules と同じ設計判断 =
 * Cloud Run 複数インスタンスでは TTL 経過での追随を許容）。
 */
import type pg from 'pg'

export interface ChatSynonym {
  id: string
  term: string
  canonical: string
  note: string
  active: boolean
}

const SYNONYM_COLS = `id, term, canonical, note, active`

let cache: { at: number; rows: ChatSynonym[] } | null = null
const CACHE_TTL_MS = 10_000

export function clearChatSynonymCache(): void {
  cache = null
}

/** 有効な同義語（トレーナー管理の小規模テーブル = 全件ロード。上限は安全弁） */
export async function activeChatSynonyms(pool: pg.Pool): Promise<ChatSynonym[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows
  const { rows } = await pool.query<ChatSynonym>(
    `SELECT ${SYNONYM_COLS} FROM chat_synonyms WHERE active = true ORDER BY id LIMIT 500`)
  cache = { at: Date.now(), rows }
  return rows
}
