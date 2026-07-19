-- バッチ7j（オペレーター指示 2026-07-19 #12）: 週次 AI インサイトの永続化。
-- 一度生成したら保管し、再生成されるまでは保存済みの結果を表示する。
-- 導出キャッシュ（SoT は集計元の各テーブル）であり記録系ではない = 再生成で上書き（upsert）してよい。
-- audience = 'company'（全体共通）または 'member:<メンバー id>'（個別ユーザー向け）
CREATE TABLE IF NOT EXISTS weekly_insights (
  id text PRIMARY KEY,
  week_start date NOT NULL,
  audience text NOT NULL,
  -- 集計値（WeeklyMetrics / PersonalWeeklyMetrics。audience により形が異なる）
  metrics jsonb NOT NULL,
  -- 洞察（WeeklyInsight / PersonalWeeklyInsight）
  insight jsonb NOT NULL,
  -- 洞察が LLM 生成か（false = 決定的ヒューリスティック）
  llm boolean NOT NULL DEFAULT false,
  generated_by text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, audience)
);
