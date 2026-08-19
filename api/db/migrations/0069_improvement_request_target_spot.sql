-- 0069: 要望（improvement_requests）に「対象箇所」列を追加（改修依頼 2026-08-19 第4弾）。
--   対象ページ（page_path/page_label）に加え、ページ内のどこか（対象箇所）を自由入力で記録できるようにする。
--   投稿時のみ設定（記録として不変 = page_path と同じ扱い）。任意項目。
--
-- 追加列のみ・NOT NULL DEFAULT '' = 既存行は空文字（未入力）で非破壊（原則7）。
-- 冪等: ADD COLUMN IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS target_spot text NOT NULL DEFAULT '';
