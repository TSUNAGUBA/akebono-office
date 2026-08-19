-- 0072: 月報（改修依頼 2026-08-19 第4弾。週報と同型で新設）。
--   1. monthly_reports テーブル新設（weekly_reports と同一構成 + 0049 の拡張列。期間キーは month_start）。
--   2. report_reads.report_kind の CHECK に 'monthly' を追加（既読管理を月報へ拡張）。
-- 追加のみ・既存データ非破壊（原則7）。冪等（IF NOT EXISTS / DROP IF EXISTS）。
SET search_path TO app_office;

-- ---------- 1. 月報（週報 weekly_reports と同一構成。week_start → month_start） ----------
CREATE TABLE IF NOT EXISTS monthly_reports (
  id              text PRIMARY KEY,
  member_id       text NOT NULL REFERENCES members(id),
  month_start     date NOT NULL,                        -- 対象月の初日（YYYY-MM-01）
  goal_review     text NOT NULL DEFAULT '',
  main_work       text NOT NULL DEFAULT '',
  issues          text NOT NULL DEFAULT '',
  next_week       text NOT NULL DEFAULT '',             -- 来月の最重要テーマ（週報と共通の列名）
  good_points     text NOT NULL DEFAULT '',
  team_share_kind text NOT NULL DEFAULT '',
  team_share_note text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  submitted_at    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monthly_reports_uq UNIQUE (member_id, month_start)
);

-- ---------- 2. 既読管理を月報へ拡張（report_kind の CHECK を張り替え。冪等 = 先に DROP IF EXISTS） ----------
-- 0047 の inline CHECK は自動命名 report_reads_report_kind_check。名前を明示して張り替える（0049 と同型）。
ALTER TABLE report_reads DROP CONSTRAINT IF EXISTS report_reads_report_kind_check;
ALTER TABLE report_reads ADD  CONSTRAINT report_reads_report_kind_check
  CHECK (report_kind IN ('daily','weekly','monthly'));
