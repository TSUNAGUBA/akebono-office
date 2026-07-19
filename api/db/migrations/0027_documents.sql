-- ドキュメント管理 F-09-3 本実装（バッチ7l・オペレーター指示 2026-07-19 #14）
-- documents: フォルダ・ファイルのメタデータ（SoT）。ファイル実体の SoT は
--   Cloud Storage（STORAGE_BUCKET 設定時。storage='gcs'・storage_path = オブジェクトパス）または
--   document_blobs（bytea フォールバック = ローカル/CI/未設定環境。storage='db'）。
--   extracted_text は検索・AI 文脈供給用の派生キャッシュ（原本から再抽出可能・上限 20,000cp）
CREATE TABLE IF NOT EXISTS documents (
  id             text PRIMARY KEY,
  parent_id      text,
  kind           text NOT NULL CHECK (kind IN ('folder', 'file')),
  name           text NOT NULL,
  tags           jsonb NOT NULL DEFAULT '[]',
  summary        text NOT NULL DEFAULT '',
  mime           text NOT NULL DEFAULT '',
  size_bytes     bigint,
  storage        text NOT NULL DEFAULT 'none' CHECK (storage IN ('none', 'gcs', 'db')),
  storage_path   text NOT NULL DEFAULT '',
  source         text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'drive')),
  drive_file_id  text NOT NULL DEFAULT '',
  drive_web_link text NOT NULL DEFAULT '',
  extracted_text text NOT NULL DEFAULT '',
  active         boolean NOT NULL DEFAULT true,
  updated_by     text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents (parent_id);

-- bytea フォールバック保管（STORAGE_BUCKET 未設定環境。knowledge_files と同型のパターン）
CREATE TABLE IF NOT EXISTS document_blobs (
  document_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  bytes       bytea NOT NULL
);

-- search_docs へ 'document' ソースを追加（0023 の note 追加と同じ手順で CHECK を更新）
ALTER TABLE search_docs DROP CONSTRAINT search_docs_source_kind_check;
ALTER TABLE search_docs ADD CONSTRAINT search_docs_source_kind_check
  CHECK (source_kind IN ('company', 'contact', 'industry', 'knowledge', 'project', 'note', 'document'));
