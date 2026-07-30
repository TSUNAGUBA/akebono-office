-- 0045: 稟議添付の実ファイル保管（監査指摘 2026-07-30 ②）
-- 従来 attachments(jsonb) はファイル名文字列のみで実体が存在しなかった。
-- ai_task_files と同型の bytea 保管（10MB 上限・5 件/申請はアプリ層で強制）で原本を保全する。
-- attachments(jsonb) は表示名一覧として維持（下位互換 = 原則7。旧データは名前のみのまま参照可能）
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS workflow_files (
  id          text PRIMARY KEY,
  request_id  text NOT NULL REFERENCES workflow_requests(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  mime        text NOT NULL,
  size_bytes  int  NOT NULL,
  bytes       bytea NOT NULL,
  uploaded_by text NOT NULL REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_files_request_idx ON workflow_files (request_id, created_at);
