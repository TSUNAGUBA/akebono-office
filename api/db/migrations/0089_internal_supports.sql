-- 0089: 社内サポート活動（改善要望 2026-08-22・F-57）。
-- 社内メンバーどうしのフォローアップ（業務支援・技術支援・教育等）を時系列で記録する。
-- チーム共有（全員が閲覧・登録・編集可）・取消 = 論理削除（active）+ 復元（原則9.5）。
-- 記録は AKEBONO Intelligence の AI 分析（ナレッジカテゴリ「社内サポート」）の材料になる。
--
-- 冪等: CREATE TABLE IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS internal_supports (
  id                  text PRIMARY KEY,
  member_id           text NOT NULL REFERENCES members(id),
  activity_date       date NOT NULL,
  activity_time       text,
  performer_member_id text NOT NULL REFERENCES members(id),
  target_member_id    text NOT NULL REFERENCES members(id),
  task_description    text NOT NULL,
  method              text NOT NULL,
  feedback            text NOT NULL DEFAULT '',
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_internal_supports_date ON internal_supports (activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_internal_supports_target ON internal_supports (target_member_id);
