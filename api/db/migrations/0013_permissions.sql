-- 0013: 権限制御基盤（F-16・オペレーター指示 2026-07-17）
-- ロール/役職に対する権限層と個人に対する権限層（member > title > role の優先で解決）。
-- resource = 機能キー or マスタエンティティキー、field = NULL（機能全体）/ 項目名（表示項目レベル）。
-- 既存のロールガードは緩められない「制限レイヤ」（設計: shared/domain/permissions.ts 参照）。
-- 設定系マスタ（論理削除 active）。変更は管理者のみ・監査ログ記録（汎用マスタ基盤に乗せる）
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS permission_rules (
  id text PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('role', 'title', 'member')),
  subject_id text NOT NULL,
  resource text NOT NULL,
  field text,
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permission_rules_resource ON permission_rules (resource) WHERE active;
