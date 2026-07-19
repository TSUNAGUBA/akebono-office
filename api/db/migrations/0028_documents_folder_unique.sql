-- 有効なフォルダの同名重複を DB レベルで禁止（並行作成/改名の TOCTOU 対策。バッチ7l R1 ニット2）。
-- parent_id NULL = ルート直下も 1 つの名前空間として扱う。
-- 0027 への追記ではなく別番号にする理由: マイグレーションランナーはファイル名単位の適用済み管理のため、
-- 0027 適用済みの環境に追記しても反映されない（R2 ニット1）
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_folder_name
  ON documents (COALESCE(parent_id, ''), name) WHERE kind = 'folder' AND active;
