-- バッチ6a: AI ネイティブカンパニー（F-08）
-- AI ロール / AI 社員は汎用マスタ基盤（管理者のみ変更・論理削除）。
-- ai_employees.status はタスク状態からの派生値（SoT: ai_tasks → サーバーが同期）。
-- ai_tasks は状態機械（proposed → in_progress → done / blocked / cancelled）、
-- ai_activity_logs は追記のみ（記録系・巻き戻し禁止 = 原則2）。
-- AI の日次報告は既存 daily_reports（author_kind='ai'）を再利用する。

CREATE TABLE IF NOT EXISTS ai_roles (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  mission       text NOT NULL DEFAULT '',
  system_prompt text NOT NULL DEFAULT '',
  permissions   jsonb NOT NULL DEFAULT '[]',
  model_tier    text NOT NULL DEFAULT 'standard' CHECK (model_tier IN ('lite','standard','pro')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_employees (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  role_id       text NOT NULL REFERENCES ai_roles(id),
  status        text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','working','waiting_approval')),
  desk_position jsonb NOT NULL DEFAULT '{"x":1,"y":1}',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_tasks (
  id             text PRIMARY KEY,
  ai_employee_id text NOT NULL REFERENCES ai_employees(id),
  requester_id   text NOT NULL REFERENCES members(id),
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  decomposition  jsonb NOT NULL DEFAULT '[]', -- [{ title, done }]
  status         text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','approved','in_progress','blocked','done','cancelled')),
  due_date       date,
  confidence     text NOT NULL DEFAULT 'mid' CHECK (confidence IN ('high','mid','low')),
  created_at     text NOT NULL, -- JST ISO（mock 互換）
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_employee ON ai_tasks (ai_employee_id, status);

CREATE TABLE IF NOT EXISTS ai_activity_logs (
  id             text PRIMARY KEY,
  ai_employee_id text NOT NULL REFERENCES ai_employees(id),
  task_id        text,
  kind           text NOT NULL CHECK (kind IN ('plan','execute','report','escalate','chat')),
  summary        text NOT NULL DEFAULT '',
  tokens         int NOT NULL DEFAULT 0,
  cost_usd       numeric NOT NULL DEFAULT 0,
  at             text NOT NULL -- JST ISO
);
CREATE INDEX IF NOT EXISTS idx_ai_activity_logs_at ON ai_activity_logs (at DESC);

-- 日次報告の並行重複防止（部分一意インデックス）と AI ロール/社員のシードは 0016 で追補する
-- （マイグレーションは append-only = 適用済みファイルを改変しない）。
