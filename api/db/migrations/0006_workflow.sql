-- 0006: ワークフロー・稟議（F-07）
-- - workflow_routes: 職務権限マトリクス（区分×金額帯 → 承認ステップ）。マスタ（設定変更可・論理削除）
-- - workflow_requests: 申請（記録系。routeSnapshot を凍結保存し経路変更の影響を受けない）
-- - approval_logs: 承認証跡（追記のみ・巻き戻さない）
-- - delegate_settings: 代理承認（本人がセルフサービスで設定）
SET search_path TO app_office;

CREATE TABLE workflow_routes (
  id         text PRIMARY KEY,
  category   text NOT NULL
    CHECK (category IN ('purchase','contract','expense','hiring','trip','other')),
  min_amount numeric NOT NULL DEFAULT 0,
  max_amount numeric, -- NULL = 上限なし
  steps      jsonb NOT NULL DEFAULT '[]', -- [{ order, approverRole, approverMemberId, mode }]
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_requests (
  id             text PRIMARY KEY, -- 決裁番号 WF-xxxx
  category       text NOT NULL
    CHECK (category IN ('purchase','contract','expense','hiring','trip','other')),
  title          text NOT NULL,
  amount         numeric NOT NULL DEFAULT 0,
  body           text NOT NULL DEFAULT '',
  attachments    jsonb NOT NULL DEFAULT '[]',
  requester_id   text NOT NULL REFERENCES members(id),
  status         text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','in_review','approved','rejected','remanded','withdrawn')),
  current_step   int NOT NULL DEFAULT 0,
  route_snapshot jsonb NOT NULL DEFAULT '[]',
  created_at     text NOT NULL, -- JST ISO
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_requests_requester_idx ON workflow_requests (requester_id, created_at DESC);
CREATE INDEX workflow_requests_status_idx ON workflow_requests (status);

CREATE TABLE approval_logs (
  id              text PRIMARY KEY,
  request_id      text NOT NULL REFERENCES workflow_requests(id),
  step            int NOT NULL,
  actor_id        text NOT NULL,
  delegate_for_id text,
  action          text NOT NULL CHECK (action IN ('submit','approve','reject','remand','withdraw')),
  comment         text NOT NULL DEFAULT '',
  at              text NOT NULL, -- JST ISO
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_logs_request_idx ON approval_logs (request_id, at);

CREATE TABLE delegate_settings (
  id                 text PRIMARY KEY,
  member_id          text NOT NULL REFERENCES members(id),
  delegate_member_id text NOT NULL REFERENCES members(id),
  from_date          date NOT NULL,
  to_date            date NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delegate_settings_member_idx ON delegate_settings (member_id, active);

-- 職務権限マトリクスの初期経路（mockup シードと同一）。再実行安全・編集済みを上書きしない
INSERT INTO workflow_routes (id, category, min_amount, max_amount, steps) VALUES
  ('wr-01', 'purchase', 0, 100000,
   '[{"order":1,"approverRole":"manager","approverMemberId":null,"mode":"serial"}]'),
  ('wr-02', 'purchase', 100000, 1000000,
   '[{"order":1,"approverRole":"manager","approverMemberId":null,"mode":"serial"},{"order":2,"approverRole":"director","approverMemberId":null,"mode":"serial"}]'),
  ('wr-03', 'purchase', 1000000, NULL,
   '[{"order":1,"approverRole":"manager","approverMemberId":null,"mode":"serial"},{"order":2,"approverRole":"director","approverMemberId":null,"mode":"serial"},{"order":3,"approverRole":"president","approverMemberId":null,"mode":"serial"}]')
ON CONFLICT (id) DO NOTHING;
