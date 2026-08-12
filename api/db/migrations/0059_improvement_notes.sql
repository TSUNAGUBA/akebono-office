-- 0059: 改修単位の時系列メモ（F-42 追補・オペレーター指示 2026-08-12）。
-- 各改修案件に、改修方針の検討過程・保留理由・「対応しない」の判断理由などを 1 件ずつ時系列で残せるようにする。
-- メモは AI 改修プロンプト生成時にも加味される（buildCodingPrompt）。
--
-- 記録系（追記のみ・巻き戻さない）。取消は archived_at（論理削除 = 原則9.5）。
-- FK を張らない判断は improvement_requests（0057）と同じ（参照整合は API 書込パスで担保）。
-- 初期データはシードしない（0057 と同方針）。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS improvement_notes (
  id          text PRIMARY KEY,
  -- 紐づく改修単位（improvement_items.id）
  item_id     text NOT NULL,
  member_id   text NOT NULL,
  member_name text NOT NULL DEFAULT '',
  body        text NOT NULL,
  -- 種別: note = 一般メモ / reject = 「対応しない」判断の理由
  kind        text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'reject')),
  -- 取消（論理削除）時刻。NULL = 有効
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 改修単位ごとの有効メモを時系列で引くための索引
CREATE INDEX IF NOT EXISTS improvement_notes_item_idx
  ON improvement_notes (item_id, created_at) WHERE archived_at IS NULL;
