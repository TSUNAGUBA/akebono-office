-- 0086: ぽいぽいポスト（改善のタネ）のポスト単位メタ（改善要望 2026-08-21）。
-- 1) origin: 登録経路（'report' = 日報提出時 / 'direct' = ページ・ヘッダーからの直接投稿）。
--    既存行は NULL のまま = 経路不明（バッジ非表示。過去データに事実を作らない = 原則7）。
-- 2) notify_targets: ポスト単位の通知先の上書き（NotifyRecipientTarget[] の jsonb）。
--    NULL = テナント設定（app_configs 'poipoi-notify-recipients'）を使う / 配列 = このポストの宛先（空配列 = 通知しない）。
--    登録後の通知先編集（PUT /v1/notes/:id/notify-targets）で更新する。
--
-- 冪等: ADD COLUMN IF NOT EXISTS（多重適用でも壊れない = 原則2）。既存行は非破壊（原則7）。
SET search_path TO app_office;

ALTER TABLE notes ADD COLUMN IF NOT EXISTS origin text CHECK (origin IN ('report', 'direct'));
ALTER TABLE notes ADD COLUMN IF NOT EXISTS notify_targets jsonb;
