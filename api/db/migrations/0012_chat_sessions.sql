-- 0012: チャットボットのセッション管理（オペレーター指示 2026-07-17）
-- 会話を DB でセッション管理し、同一セッション内はマルチターンで過去文脈を LLM へ渡す。
-- 過去セッションの呼び出し・続きから再開・新規開始に対応（従来の「セッションローカル」設計判断を置換）。
-- chat_sessions: 設定系（title / updated_at のみ更新）。chat_messages: 記録系（追記のみ = 原則2）
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS chat_sessions (
  id text PRIMARY KEY,
  member_id text NOT NULL REFERENCES members(id),
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_member ON chat_sessions (member_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES chat_sessions(id),
  -- 会話内の表示順（挿入順の単調増加。同一ミリ秒の at では順序が定まらないため）
  seq bigserial,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]',
  suggestions jsonb NOT NULL DEFAULT '[]',
  -- 業務時刻の規約どおり JST ウォールクロックの ISO 文字列（text）
  at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, seq);
