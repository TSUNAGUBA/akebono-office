-- 0088: メディア分析の AI 週次レポートと改善施策（改善要望 2026-08-21・F-55/F-56）。
-- 1) media_weekly_reports: チャンネル × 週開始（月曜）で一意の AI 週次レポート。
--    content jsonb = エグゼクティブサマリー / 重要な変化 / 原因仮説 / コンテンツ評価 / 推奨アクション
--    （推奨アクションの判断〔実行する / 継続検討 / 対象外〕もこの jsonb に記録する）。
--    生成は決定的ヒューリスティック（shared/domain/media-weekly-report）・生成済みは再生成しない（原則2）。
-- 2) media_measures: 改善施策（「実行する」と判断した推奨アクション or 手動起票）。
--    施策 + 効果検証（verification jsonb）を 1 行で管理。取消 = 論理削除（active）+ 復元（原則9.5）。
--    (source_report_id, source_action_index) の一意制約で同一アクションの二重起票を防ぐ（冪等 = 原則2）。
--
-- 冪等: CREATE TABLE IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS media_weekly_reports (
  id           text PRIMARY KEY,
  channel_id   text NOT NULL REFERENCES media_channels(id) ON DELETE CASCADE,
  week_start   date NOT NULL,
  period_from  date NOT NULL,
  period_to    date NOT NULL,
  content      jsonb NOT NULL,
  llm          boolean NOT NULL DEFAULT false,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_media_weekly_reports_list
  ON media_weekly_reports (channel_id, week_start DESC);

CREATE TABLE IF NOT EXISTS media_measures (
  id                  text PRIMARY KEY,
  channel_id          text NOT NULL REFERENCES media_channels(id) ON DELETE CASCADE,
  member_id           text NOT NULL REFERENCES members(id),
  name                text NOT NULL,
  background          text NOT NULL DEFAULT '',
  content             text NOT NULL DEFAULT '',
  target              text NOT NULL DEFAULT '',
  expected_change     text NOT NULL DEFAULT '',
  assignee_member_id  text NOT NULL REFERENCES members(id),
  due_date            date,
  status              text NOT NULL,
  source_report_id    text REFERENCES media_weekly_reports(id) ON DELETE SET NULL,
  source_action_index integer,
  source_label        text NOT NULL DEFAULT '',
  verification        jsonb NOT NULL DEFAULT '{}',
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- 同一レポートの同一アクションからの二重起票を防ぐ（NULL は手動起票のため対象外 = 部分一意）
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_measures_source_unique
  ON media_measures (source_report_id, source_action_index)
  WHERE source_report_id IS NOT NULL AND source_action_index IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_measures_list
  ON media_measures (channel_id, status, created_at DESC);
