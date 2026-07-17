-- 0009: Google カレンダー連携（F-06-8）
-- - calendar_tokens: OAuth トークン（AES-256-GCM で暗号化保管。member 1 行）。
--   SoT 上の注記: トークンは Google 発行物であり、喪失時は再連携で再取得できる（バックアップ対象外の設計判断）
-- - calendar_events: 予定キャッシュ + アプリ発タスク。
--   source='google' は Google が SoT（同期で置換・アプリから編集不可）/ source='app' は本アプリが SoT
SET search_path TO app_office;

CREATE TABLE calendar_tokens (
  member_id         text PRIMARY KEY REFERENCES members(id),
  access_token_enc  text NOT NULL,
  refresh_token_enc text,
  expires_at        timestamptz,
  scope             text NOT NULL DEFAULT '',
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calendar_events (
  id                text PRIMARY KEY,
  member_id         text NOT NULL REFERENCES members(id),
  date              date NOT NULL,
  from_time         text NOT NULL, -- HH:MM
  to_time           text NOT NULL,
  title             text NOT NULL,
  source            text NOT NULL CHECK (source IN ('google','app')),
  google_event_id   text,          -- google 発 = Google のイベント id / app 発 = 反映後に保存
  synced_to_google  boolean NOT NULL DEFAULT false,
  project_id        text,          -- タイトルから推定 or 手動指定（AI ドラフトの工数振り分けに使用）
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_events_member_date_idx ON calendar_events (member_id, date);
-- 同期の冪等 upsert 用（google 発イベントの一意性）
CREATE UNIQUE INDEX calendar_events_google_idx
  ON calendar_events (member_id, google_event_id) WHERE google_event_id IS NOT NULL;
