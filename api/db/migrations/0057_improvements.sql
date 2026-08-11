-- 0057: 改善要望（F-42・オペレーター指示 2026-08-11）。
-- 各ページから寄せられた改善・改修の要望を記録し、AI が「改修単位（improvement_items）」へ集約する。
--
-- データ 3 分類:
-- - improvement_requests … 記録系（追記のみ・巻き戻さない。SoT）。取消は archived_at（論理削除 = 原則9.5）。
-- - improvement_items    … 要望から導出する集約キャッシュ。ただし status / title / detail は人手で
--                          編集しうる記録系であり、再集約で巻き戻さない（原則2）。取消は archived_at。
--
-- 初期データ: シードしない（akebono_wishes と同方針 = 実データは投稿・集約から育てる。0002 の原則）。
-- FK を張らない判断は 0032 と同じ（参照整合は API 書込パスで担保。item_id / source_request_ids も同様）。
SET search_path TO app_office;

-- 生の改善要望（各ページの「要望を送る」から追記）
CREATE TABLE IF NOT EXISTS improvement_requests (
  id          text PRIMARY KEY,
  member_id   text NOT NULL,
  member_name text NOT NULL DEFAULT '',
  page_path   text NOT NULL DEFAULT '',
  page_label  text NOT NULL DEFAULT '',
  body        text NOT NULL,
  -- 集約先の改修単位 id（NULL = 未集約）
  item_id     text,
  -- 取消（論理削除）時刻。NULL = 有効
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 未集約かつ有効な要望の抽出（集約対象の絞り込み）を効かせる部分索引
CREATE INDEX IF NOT EXISTS improvement_requests_unclustered_idx
  ON improvement_requests (created_at) WHERE item_id IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS improvement_requests_item_idx
  ON improvement_requests (item_id);

-- AI が集約した改修単位（改修 1 件の粒度）
CREATE TABLE IF NOT EXISTS improvement_items (
  id                 text PRIMARY KEY,
  title              text NOT NULL,
  summary            text NOT NULL DEFAULT '',
  detail             text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'triage'
    CHECK (status IN ('triage', 'accepted', 'resolved', 'rejected')),
  page_paths         jsonb NOT NULL DEFAULT '[]',
  source_request_ids jsonb NOT NULL DEFAULT '[]',
  -- 直近の集約が LLM 生成か（false = ヒューリスティック/手動）
  llm                boolean NOT NULL DEFAULT false,
  -- 取消（論理削除）時刻。NULL = 有効
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- 解決済みにした時刻（NULL = 未解決）
  resolved_at        timestamptz
);
CREATE INDEX IF NOT EXISTS improvement_items_status_idx
  ON improvement_items (status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS improvement_items_created_idx
  ON improvement_items (created_at);
