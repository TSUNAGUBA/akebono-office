-- 0008: AI業務アシスタント（F-14）+ 日報 AI アシスト（F-06-7）
-- - task_plans: タスク計画（前日計画 → AI コメント → 当日結果記録）。
--   結果記録済み（status='done'）は編集・削除不可（記録系保護 = 原則2）
--   ※2026-07-21 更新: done も本人による訂正可（本文編集・結果の再記録・削除・後追い AI コメント）へ緩和。
--     記録系保護は「巻き戻し防止」から「監査ログ付き訂正」へ緩和（初回記録日時 result_at は保持）。
--     アプリ層ポリシー（task-plans.ts）で制御。本 SQL はスキーマ変更なし（適用済みのため不変）。
-- - assist_logs: 日報アシストのヒアリング回答・ぽいぽいメモ（追記のみの蓄積ログ）
SET search_path TO app_office;

CREATE TABLE task_plans (
  id                text PRIMARY KEY,
  member_id         text NOT NULL REFERENCES members(id),
  date              date NOT NULL, -- 実施予定日
  calendar_event_id text,          -- 紐付くカレンダー予定（NULL = 手動追加。カレンダー連携バッチで使用）
  title             text NOT NULL,
  purpose           text NOT NULL DEFAULT '',
  done_criteria     text NOT NULL DEFAULT '',
  approach          text NOT NULL DEFAULT '',
  ai_comment        text NOT NULL DEFAULT '',
  ai_comment_at     text,          -- JST ISO
  status            text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done')),
  outcome           text NOT NULL DEFAULT '',
  reflection        text NOT NULL DEFAULT '',
  result_at         text,          -- JST ISO（記録確定時刻）
  created_at        text NOT NULL, -- JST ISO（mock 互換）
  updated_at        text NOT NULL
);
CREATE INDEX task_plans_member_date_idx ON task_plans (member_id, date);
CREATE INDEX task_plans_date_idx ON task_plans (date);

CREATE TABLE assist_logs (
  id                text PRIMARY KEY,
  member_id         text NOT NULL REFERENCES members(id),
  date              date NOT NULL, -- 記録対象日（過去日の日報作成にも対応）
  kind              text NOT NULL CHECK (kind IN ('qa','memo')),
  calendar_event_id text,
  question          text NOT NULL DEFAULT '',
  answer            text NOT NULL,
  at                text NOT NULL  -- JST ISO
);
CREATE INDEX assist_logs_member_date_idx ON assist_logs (member_id, date);
