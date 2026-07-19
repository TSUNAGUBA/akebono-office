-- バッチ7c（オペレーター指示 2026-07-19 #4）
-- 1) 業務種別マスタ（ぽいぽいメモ・議事録の任意分類。マスタ管理対象）
CREATE TABLE work_categories (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  display_order int NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 2) ノート（ぽいぽいメモ = 本人メモ / 議事録 = 全員参照）。記録系 = 追記のみ。
--    プロジェクト・顧客・業務種別は任意の紐付け
CREATE TABLE notes (
  id               text PRIMARY KEY,
  member_id        text NOT NULL REFERENCES members(id),
  kind             text NOT NULL CHECK (kind IN ('poipoi', 'minutes')),
  title            text NOT NULL,
  body             text NOT NULL,
  project_id       text REFERENCES projects(id),
  company_id       text REFERENCES companies(id),
  work_category_id text REFERENCES work_categories(id),
  source           text NOT NULL DEFAULT 'text' CHECK (source IN ('text', 'upload')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notes_member_kind ON notes (member_id, kind, created_at);
CREATE INDEX idx_notes_kind ON notes (kind, created_at);

-- 3) ノート添付原本（knowledge_files と同型 = 監査・再抽出用）
CREATE TABLE note_files (
  id          text PRIMARY KEY,
  note_id     text NOT NULL REFERENCES notes(id),
  filename    text NOT NULL,
  mime        text NOT NULL,
  size_bytes  int NOT NULL,
  bytes       bytea NOT NULL,
  uploaded_by text NOT NULL REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_note_files_note ON note_files (note_id);

-- 4) 検索ドキュメントの所有者スコープ（NULL = 全員参照可。poipoi メモは本人のみ = C3）
ALTER TABLE search_docs ADD COLUMN owner_member_id text;

-- 5) search_docs.source_kind の許容値へ 'note' を追加（0021 の CHECK 制約を差し替え）
ALTER TABLE search_docs DROP CONSTRAINT search_docs_source_kind_check;
ALTER TABLE search_docs ADD CONSTRAINT search_docs_source_kind_check
  CHECK (source_kind IN ('company', 'contact', 'industry', 'knowledge', 'project', 'note'));
