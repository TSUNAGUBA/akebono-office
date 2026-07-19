-- バッチ7b（オペレーター指示 2026-07-19 #3）
-- 1) カレンダー同期対象の選択: 従来は primary（マイカレンダー）固定だった同期対象を
--    ユーザーが選択できるようにする。既定 ["primary"] = 従来挙動のまま（下位互換 = 原則7）
ALTER TABLE calendar_tokens ADD COLUMN selected_calendar_ids jsonb NOT NULL DEFAULT '["primary"]';

-- 2) AI 社員間の依頼・連携（マネージャーロール）: 追加列のみでスキーマ互換を維持。
--    requester_ai_employee_id = 依頼元 AI 社員（人間からの直接依頼は NULL）
--    parent_task_id = 連携元（親）タスク（マネージャーのタスクから分担された子タスクが持つ）
ALTER TABLE ai_tasks ADD COLUMN requester_ai_employee_id text REFERENCES ai_employees(id);
ALTER TABLE ai_tasks ADD COLUMN parent_task_id text REFERENCES ai_tasks(id);
CREATE INDEX idx_ai_tasks_parent ON ai_tasks (parent_task_id);
