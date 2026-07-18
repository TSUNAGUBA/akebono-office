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

-- AI の日次報告は 1 社員 1 日 1 件（0001 の human 用インデックスと対の部分一意。
-- 生成 API の ON CONFLICT DO NOTHING と合わせて並行実行でも重複しない = 冪等の DB 保証）
CREATE UNIQUE INDEX IF NOT EXISTS daily_reports_ai_uq ON daily_reports (ai_employee_id, date) WHERE author_kind = 'ai';

-- 初期データ: mockup シード（seed/core.ts）と同一の AI ロール・AI 社員を移行する（0011 の
-- decision_themes と同じ方針 = 新規環境でも F-08 が手動投入なしで動く。原則1）。
-- 既存環境では何もしない（ON CONFLICT DO NOTHING）。status は派生値のため初期は idle。
INSERT INTO ai_roles (id, name, mission, system_prompt, permissions, model_tier) VALUES
  ('r-01', 'リサーチャー', '業界・競合・技術動向の調査と要約', 'あなたは調査専門の AI 社員です。一次情報を優先し、出典を必ず示してください。', '["knowledge:read","web:search"]', 'standard'),
  ('r-02', 'ドキュメンター', '議事録・提案書ドラフト・ナレッジ整備', 'あなたは文書作成専門の AI 社員です。社内テンプレートに従い、簡潔に書いてください。', '["knowledge:read","knowledge:write","documents:write"]', 'standard'),
  ('r-03', 'データアナリスト', '業務データ・スタースキーマの分析と示唆出し', 'あなたはデータ分析専門の AI 社員です。半加法メジャーの時間軸集計に注意してください。', '["mart:read","knowledge:read"]', 'pro'),
  ('r-04', 'QA サポート', '社内からの質問対応と一次切り分け', 'あなたは社内サポートの AI 社員です。わからないことは推測せずエスカレーションしてください。', '["knowledge:read","masters:read"]', 'lite')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ai_employees (id, name, role_id, status, desk_position) VALUES
  ('ai-01', 'アキ', 'r-01', 'idle', '{"x":1,"y":1}'),
  ('ai-02', 'ハル', 'r-02', 'idle', '{"x":2,"y":1}'),
  ('ai-03', 'ソラ', 'r-03', 'idle', '{"x":1,"y":2}'),
  ('ai-04', 'レン', 'r-04', 'idle', '{"x":2,"y":2}'),
  ('ai-05', 'ユキ', 'r-02', 'idle', '{"x":3,"y":1}')
ON CONFLICT (id) DO NOTHING;
