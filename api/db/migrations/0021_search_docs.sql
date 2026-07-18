-- AI 検索最適化基盤（オペレーター報告 2026-07-18 #3: チャットボット精度）
-- 1) search_docs: マスタ・ナレッジ・関係性を AI が探索・解釈しやすい形へフラット化した派生テーブル。
--    SoT は各マスタ/ナレッジ本体（本テーブルは常に再生成可能なキャッシュ = マスタ更新時に自動更新 +
--    POST /v1/search/reindex の手動回復パス。原則6）。
--    segments は表示項目権限（F-16）を検索結果の描画時に反映するための (entity, field, text) 分解。
--    embedding は Vertex AI 埋め込み（LLM 無効環境は null = 字句検索のみへ縮退）
CREATE TABLE search_docs (
  id              text PRIMARY KEY,
  source_kind     text NOT NULL CHECK (source_kind IN ('company', 'contact', 'industry', 'knowledge', 'project')),
  source_id       text NOT NULL,
  title           text NOT NULL,
  aliases         jsonb NOT NULL DEFAULT '[]',
  body            text NOT NULL,
  segments        jsonb NOT NULL DEFAULT '[]',
  body_hash       text NOT NULL DEFAULT '',
  embedding       jsonb,
  embedding_model text NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id)
);

-- 2) knowledge_files: ナレッジへ添付されたアップロード原本（.md/.txt/.pdf/.docx）。
--    抽出テキストは knowledge_articles.body へ格納（既存スキーマ不変）。原本は監査・再抽出用に保全
CREATE TABLE knowledge_files (
  id           text PRIMARY KEY,
  knowledge_id text NOT NULL REFERENCES knowledge_articles(id),
  filename     text NOT NULL,
  mime         text NOT NULL,
  size_bytes   int NOT NULL,
  bytes        bytea NOT NULL,
  uploaded_by  text NOT NULL REFERENCES members(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_knowledge_files_knowledge ON knowledge_files (knowledge_id);
