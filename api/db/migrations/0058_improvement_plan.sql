-- 0058: 改修単位の対応予定期間（F-42 追補・オペレーター指示 2026-08-11）。
-- 各改修案件に対応予定の開始日・終了日を任意で登録できるようにし、ガントチャートで可視化する。
-- 追加列のみ（既存データ後方互換 = 原則7。既存 item は NULL = 予定未定）。日付型で TZ 非依存。
SET search_path TO app_office;

ALTER TABLE improvement_items ADD COLUMN IF NOT EXISTS plan_start date;
ALTER TABLE improvement_items ADD COLUMN IF NOT EXISTS plan_end date;

-- 予定期間で絞るガント表示のための索引（予定ありの有効な案件）
CREATE INDEX IF NOT EXISTS improvement_items_plan_idx
  ON improvement_items (plan_start) WHERE plan_start IS NOT NULL AND archived_at IS NULL;
