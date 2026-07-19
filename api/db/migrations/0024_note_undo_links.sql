-- バッチ7d（オペレーター指示 2026-07-19 #5）
-- 1) ノートの取消（論理削除）: 誤操作アップロード・誤登録を取り消すフロー。
--    記録系だが「取消」は監査ログ付きの論理削除として許容（本アプリ共通原則: 操作の取消可能性）
ALTER TABLE notes ADD COLUMN active boolean NOT NULL DEFAULT true;

-- 2) 検索ドキュメントの紐付け（AI 文脈の混入防止）: ノートの顧客/プロジェクト紐付けを保持し、
--    質問が特定の顧客・プロジェクトに解決されたとき、別の対象に紐付くノートを文脈から除外する
ALTER TABLE search_docs ADD COLUMN links jsonb NOT NULL DEFAULT '{}';
