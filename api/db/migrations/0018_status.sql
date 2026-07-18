-- バッチ6c: 提供システム稼働状況（F-11）
-- system_services はマスタ的（components jsonb を持つ・論理削除）。
-- service_incidents は記録系: ライフサイクル状態機械（investigating → identified → monitoring → resolved
-- の正順のみ）+ updates jsonb への追記。status / resolved_at は updates の射影として更新する。
-- uptime_daily は日次集計（SoT はインシデント。shared/domain/uptime の純粋関数で導出し、
-- 非 operational の日のみ格納 = 再計算は窓内 DELETE→INSERT のトランザクションで冪等）。
-- 業務時刻（started_at 等）は JST ISO 文字列（text）= リポジトリ規約。

CREATE TABLE IF NOT EXISTS system_services (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  url         text NOT NULL DEFAULT '',
  components  jsonb NOT NULL DEFAULT '[]', -- [{ id, name }]
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_incidents (
  id          text PRIMARY KEY,
  service_id  text NOT NULL REFERENCES system_services(id),
  title       text NOT NULL,
  impact      text NOT NULL CHECK (impact IN ('minor','major','critical')),
  status      text NOT NULL DEFAULT 'investigating'
    CHECK (status IN ('investigating','identified','monitoring','resolved')),
  updates     jsonb NOT NULL DEFAULT '[]', -- [{ status, body, at }] 追記のみ
  started_at  text NOT NULL,               -- JST ISO
  resolved_at text                         -- JST ISO（未解決は null）
);
CREATE INDEX IF NOT EXISTS idx_service_incidents_service ON service_incidents (service_id, started_at DESC);

CREATE TABLE IF NOT EXISTS uptime_daily (
  service_id   text NOT NULL REFERENCES system_services(id),
  date         date NOT NULL,
  down_minutes int NOT NULL DEFAULT 0 CHECK (down_minutes >= 0 AND down_minutes <= 1440),
  worst_state  text NOT NULL
    CHECK (worst_state IN ('operational','degraded','partial_outage','major_outage','maintenance')),
  UNIQUE (service_id, date)
);

-- 提供サービスのマスタ初期値（mockup シードと同一。新規環境でも手動投入なしで F-11 が動く = 原則1。
-- インシデント・uptime は記録系/導出データのためシードしない = sales_monthly と同方針）
INSERT INTO system_services (id, name, description, url, components) VALUES
  ('svc-01', 'AKEBONO SCM', 'アケボノ商事向け SCM プラットフォーム', 'https://scm.example.com',
   '[{"id":"svc-01-api","name":"API"},{"id":"svc-01-web","name":"管理画面"},{"id":"svc-01-batch","name":"夜間バッチ"},{"id":"svc-01-sync","name":"データ連携"}]'),
  ('svc-02', 'UNDEUX Sales Suite', 'ウンドゥアパレル向け売上分析スイート', 'https://sales.example.com',
   '[{"id":"svc-02-api","name":"API"},{"id":"svc-02-web","name":"分析画面"},{"id":"svc-02-mart","name":"マート再構築"}]'),
  ('svc-03', 'TOKUTAKE AI Platform', 'トクタケ製靴向け AI 分析プラットフォーム', 'https://ai.example.com',
   '[{"id":"svc-03-web","name":"分析画面"},{"id":"svc-03-ai","name":"AI 生成"},{"id":"svc-03-etl","name":"ETL"}]')
ON CONFLICT (id) DO NOTHING;
