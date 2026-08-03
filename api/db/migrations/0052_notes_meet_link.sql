-- 0052: 議事録（notes.kind='minutes'）に Google Meet の AI メモ/録画（Drive ファイル）リンクを追加
--   （オペレーター指示 2026-08-03 ③b）。Google カレンダー連携（0009 の calendar_tokens・drive.readonly
--   スコープ）を共用して Drive 上の Meet 生成物を選び、議事録へ関連付ける。
--
-- 追加列はすべて NULL 許容 = 既存の議事録・ぽいぽいポストは非破壊（原則7）。SoT は notes 行。
-- ファイル実体は Drive 側（Google が SoT）。ここでは参照（id/名称/webViewLink）のみ保持し複製しない。
-- 冪等: ADD COLUMN IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

ALTER TABLE notes ADD COLUMN IF NOT EXISTS meet_file_id   text;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS meet_file_name text;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS meet_web_link  text;
