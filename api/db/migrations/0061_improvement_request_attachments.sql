-- 0061: 改善要望への URL リンク・画像添付（F-42 追補・改善要望 2026-08-17）。
--   要望の記載に URL リンク（複数）と画像（複数）を添付できるようにする。
--   参照時はリンク = 別タブで開く / 画像 = 押下で拡大表示（フロント）。
--
-- links  … 添付 URL の配列（jsonb。例: ["https://..."]）
-- images … 添付画像の配列（jsonb。例: [{"filename":"a.png","mime":"image/png","dataUrl":"data:image/png;base64,..."}]）
--          data URI は商品画像（0032 product_images.data_url）と同じ扱い = アプリ層の allowlist + 上限で検証。
--
-- 追加列のみ・NOT NULL DEFAULT '[]' = 既存行は「添付なし」として非破壊（原則7）。
-- 冪等: ADD COLUMN IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]';
ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]';
