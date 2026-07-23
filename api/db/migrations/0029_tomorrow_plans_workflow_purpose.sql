-- オペレーター指示 2026-07-22
-- daily_reports.tomorrow_plans: 明日の予定（構造化・最大 3 件 = TomorrowPlan[]）。
--   旧来の tomorrow（自由記述）は互換表示用に保持する（原則7 = 既存データを壊さない）
-- workflow_requests.purpose / content: 稟議の本文を「目的」「内容」に分割。
--   旧来の body は互換表示用に保持する（既存申請は body を本文として表示）
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS tomorrow_plans jsonb NOT NULL DEFAULT '[]';
ALTER TABLE workflow_requests ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT '';
ALTER TABLE workflow_requests ADD COLUMN IF NOT EXISTS content text NOT NULL DEFAULT '';
