-- 0036: セグメント別 / 会社全体ダッシュボードの AI レポート・インサイト（F-41）の API 永続化（Phase D）。
-- 従来 localStorage 保管（dashboardInsights = API モードでは日次リシードで消える既知の制約。
-- 「レポート保管 = ローカル」バッジで明示していた）を、media_insights（0030）/ weekly_insights（0026）と
-- 同型の**導出キャッシュ upsert テーブル**へ移行する。これで「レポート保管 = ローカル」バッジを撤去できる。
--
-- テーブル分類: **導出キャッシュ**（記録系ではない = 原則2 に抵触しない）。
--   SoT は集計材料（sales_records = 売上軸 + GA = メディア軸。/v1/media/integrated のサーバー組み立て）。
--   生成 → 保管 → 再生成で upsert 上書き（週次/メディアインサイトと同思想）。復元不要（再生成で作り直せる）。
--
-- scope='segment'（業態単位・segment_id 参照）/ 'company'（会社全体）。
-- company は segment を持たないため segment_id = '' の番兵で表現し、UNIQUE(scope, segment_id) を
-- そのまま ON CONFLICT ターゲットにできるようにする（media_insights の UNIQUE(segment_id, scope) と同型。
-- NULL 混在の部分 UNIQUE を避け、単純な ON CONFLICT (scope, segment_id) で upsert する設計判断）。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS dashboard_insights (
  id           text PRIMARY KEY,
  scope        text NOT NULL CHECK (scope IN ('segment','company')),
  -- 'segment' = 対象業態 id / 'company' = '' の番兵（NULL を使わず ON CONFLICT を単純化）
  segment_id   text NOT NULL DEFAULT '',
  period_key   text NOT NULL,
  metrics      jsonb NOT NULL,
  insight      jsonb NOT NULL,
  llm          boolean NOT NULL DEFAULT false,
  generated_by text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, segment_id)
);
