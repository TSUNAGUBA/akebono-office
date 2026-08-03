-- 0051: Google スプレッドシート取込（データ取込・連携 F-32 の取込元方式に sheets_pull を追加。オペレーター指示 2026-08-03）。
--   取込元 import_sources.method = 'sheets_pull'（config に spreadsheetId/sheetName/headerRow/startColumn を保持）で、
--   Google スプレッドシートの指定範囲を読み取り、既存の項目マッピング（import_mappings）→ 取込実行（import_runs）へ流す。
--
-- OAuth 連携（カレンダー 0009 / GA 0030 と同型・別トークン系）:
--   スプレッドシート取込はテナント（全社）単位の管理者運用のため、**単一接続**（id='default' の 1 行）で保持する。
--   スコープは spreadsheets.readonly（読取） + drive.readonly（ブック一覧）。トークンは AES-256-GCM 暗号化（lib/crypto）。
--   Google 発行物のため喪失時は再連携で回復（バックアップ対象外 = calendar_tokens と同じ設計判断）。
-- 冪等: CREATE TABLE IF NOT EXISTS / DROP CONSTRAINT IF EXISTS → ADD（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

-- import_sources.method に 'sheets_pull' を許容（0035 のインライン CHECK を拡張）。
-- 既存の方式（file_csv/file_fixed/file_json/api_pull）はそのまま有効 = 既存データ非破壊（原則7）。
ALTER TABLE import_sources DROP CONSTRAINT IF EXISTS import_sources_method_check;
ALTER TABLE import_sources ADD CONSTRAINT import_sources_method_check
  CHECK (method IN ('file_csv', 'file_fixed', 'file_json', 'api_pull', 'sheets_pull'));

-- テナント単位の単一接続（id='default'）。GA と異なりリソース（channel）単位ではない = 全社の取込用共通接続。
CREATE TABLE IF NOT EXISTS sheets_tokens (
  id                 text PRIMARY KEY DEFAULT 'default',
  access_token_enc   text NOT NULL,
  refresh_token_enc  text,
  expires_at         timestamptz,
  scope              text NOT NULL DEFAULT '',
  connected_by       text REFERENCES members(id),
  connected_at       timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- OAuth state ノンス（一回性・10 分 TTL。calendar_oauth_states と同型）
CREATE TABLE IF NOT EXISTS sheets_oauth_states (
  nonce       text PRIMARY KEY,
  member_id   text NOT NULL REFERENCES members(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
