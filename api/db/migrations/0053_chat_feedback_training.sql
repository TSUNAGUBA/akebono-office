-- 0053: チャットボット観測・フィードバック基盤 + トレーナー運用（オペレーター指示 2026-08-05）。
-- 背景: 「データがあるのに回答できない」事象の診断と改善ループのため、
--   (1) chat_messages へ生成診断（diag）と応答種別（kind: ai/fallback）を追加（偽装フォールバックの可視化）
--   (2) chat_feedback: 質問者の good/bad フィードバック（1 メッセージ × 1 人。上書き・本人削除可 = 原則9.5）
--   (3) chat_sessions.trainer_shared: トレーナーへの回答本文共有の明示同意（既定 false・いつでも取消可）
--   (4) chat_synonyms: 同義語辞書（フィードバック還元ループ。話題判定の語彙ギャップを運用で埋める）
--
-- テーブル分類: chat_feedback / chat_synonyms / trainer_shared = 設定系（上書き・取消可）。
--   chat_messages への列追加は今後の追記時のみ書込。既存行は NULL のまま = 「種別不明（旧データ）」として
--   表示は従来どおり = データパッチ不要（下位互換 = 原則7）。
-- 可視性: chat_feedback はフィードバックした本人 + トレーナー（canTrainChatbot = 許可制）。
--   トレーナーへは質問文 + 診断メタデータのみを既定開示し、回答本文は trainer_shared = true の
--   セッションに限る（5 層権限モデルをチャットログ経由で迂回させないためのガード）。
SET search_path TO app_office;

-- (1) 応答の診断スナップショット（発火ブロック・検索ヒット数・ツール呼出・confidence・トークン実測等）
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS diag jsonb;
-- 応答種別: 'ai' = LLM 応答 / 'fallback' = 決定的定型応答（AI 回答ではない）。NULL = 旧データ（種別不明）
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind text CHECK (kind IS NULL OR kind IN ('ai', 'fallback'));

-- (2) フィードバック（good/bad + 任意コメント。1 メッセージ × 1 人 = upsert・本人 DELETE = 取消フロー）
CREATE TABLE IF NOT EXISTS chat_feedback (
  id          text PRIMARY KEY,
  message_id  text NOT NULL REFERENCES chat_messages(id),
  session_id  text NOT NULL REFERENCES chat_sessions(id),
  member_id   text NOT NULL REFERENCES members(id),
  rating      text NOT NULL CHECK (rating IN ('good', 'bad')),
  comment     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, member_id)
);
-- トレーナー一覧は「評価 × 新しい順」が主経路
CREATE INDEX IF NOT EXISTS idx_chat_feedback_rating ON chat_feedback (rating, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_feedback_session ON chat_feedback (session_id);

-- (3) トレーナー共有の明示同意（セッション単位。shared_at は直近の共有時刻 = 監査用）
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS trainer_shared boolean NOT NULL DEFAULT false;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS trainer_shared_at timestamptz;

-- (4) 同義語辞書（term = ユーザーの言い回し / canonical = 話題判定へ追補する正規語。
--     論理無効化（active = false）= 取消可能（原則9.5）。ハード削除は提供しない）
CREATE TABLE IF NOT EXISTS chat_synonyms (
  id          text PRIMARY KEY,
  term        text NOT NULL,
  canonical   text NOT NULL,
  note        text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_by  text REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (term, canonical)
);
