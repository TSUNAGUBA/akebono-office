-- 0063: 要望処理フローの改善（F-42 追補・改善要望 2026-08-17 第 2 弾）。
--   投稿された生要望はまず管理者が一覧で確認・取捨選択し、**採用（adopted）された要望のみが
--   AI 集約の対象**になる（未選別・不採用は集約されない）。生要望へのコメント（やり取り）も追加。
--
-- adoption … 選別状態（pending 未選別 / adopted 採用 / declined 不採用）。遷移自由（原則9.5）。
--   既存データの補正: 集約済み（item_id あり）の要望は「採用相当」へバックフィル（従来フローで
--   集約まで進んだ記録を巻き戻さない = 原則2・7。未集約の既存要望は pending = 新フローで選別する）。
-- improvement_request_comments … 生要望への時系列コメント（記録系・追記のみ。取消は archived_at = 原則9.5）。
--   FK を張らない判断は improvement_requests（0057）と同じ（参照整合は API 書込パスで担保）。
--
-- 冪等: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / バックフィルは条件付き UPDATE
-- （再実行しても既に採用へ補正済みの行は変化しない = 原則2）。
SET search_path TO app_office;

ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS adoption text NOT NULL DEFAULT 'pending'
  CHECK (adoption IN ('pending', 'adopted', 'declined'));

-- 既存の集約済み要望は採用相当（従来フローの記録を保護）
UPDATE improvement_requests SET adoption = 'adopted'
WHERE item_id IS NOT NULL AND adoption = 'pending';

CREATE TABLE IF NOT EXISTS improvement_request_comments (
  id          text PRIMARY KEY,
  -- 紐づく生要望（improvement_requests.id）
  request_id  text NOT NULL,
  member_id   text NOT NULL,
  member_name text NOT NULL DEFAULT '',
  body        text NOT NULL,
  -- 取消（論理削除）時刻。NULL = 有効
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 要望ごとの有効コメントを時系列で引くための索引
CREATE INDEX IF NOT EXISTS improvement_request_comments_request_idx
  ON improvement_request_comments (request_id, created_at) WHERE archived_at IS NULL;
