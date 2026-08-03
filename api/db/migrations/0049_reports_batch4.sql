-- 0049: 日報・週報の項目拡張 + 通知種別に poipoi 追加（オペレーター指示 2026-08-03）。
--   1. daily_reports: 本日の課題の種別（issue_category）を追加。
--   2. weekly_reports: うまくいったこと・続けたいこと（good_points）、チーム共有事項の種別・自由入力
--      （team_share_kind / team_share_note）を追加。
--   3. notifications: ぽいぽいポスト原文の通知（kind='poipoi'）を許可する。
-- すべて既存データに影響しない後方互換な追加（既定値 '' / CHECK 拡張のみ = 原則7）。冪等（IF NOT EXISTS / DROP IF EXISTS）。
SET search_path TO app_office;

-- ---------- 1. 本日の課題の種別（DAILY_ISSUE_CATEGORY_PRESETS のいずれか。空 = 未選択） ----------
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS issue_category text NOT NULL DEFAULT '';

-- ---------- 2. 週報の新規項目 ----------
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS good_points     text NOT NULL DEFAULT '';
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS team_share_kind text NOT NULL DEFAULT '';
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS team_share_note text NOT NULL DEFAULT '';

-- ---------- 3. 通知種別に 'poipoi' を追加（既存 CHECK を張り替え。冪等 = 先に DROP IF EXISTS） ----------
-- 0003 の inline CHECK は自動命名 notifications_kind_check。名前を明示して張り替える。
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD  CONSTRAINT notifications_kind_check
  CHECK (kind IN ('approval','comment','reminder','ai_report','system','escalation','poipoi'));
