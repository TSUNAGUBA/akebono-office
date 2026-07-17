-- 0005: エスカレーション（F-12。シグナル検知 → 起票 → 管理者アクション → ナレッジ還流）
-- 記録系: 起票・解決とも追記/状態遷移のみ（削除しない）。冪等性は dedupe_key + クールダウンで担保
SET search_path TO app_office;

CREATE TABLE escalations (
  id                    text PRIMARY KEY,
  reason                text NOT NULL
    CHECK (reason IN ('issue_reported','stalled_task','overload','low_confidence','overtime_alert')),
  target_member_id      text,
  target_ai_employee_id text,
  context               text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution            jsonb, -- { type, body, resolvedBy, at } | null
  knowledge_reflected   boolean NOT NULL DEFAULT false,
  dedupe_key            text NOT NULL,
  raised_at             text NOT NULL, -- JST ISO
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escalations_status_idx ON escalations (status, raised_at DESC);
CREATE INDEX escalations_dedupe_idx ON escalations (reason, raised_at DESC);
