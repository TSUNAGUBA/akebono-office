-- 0060: 外部リンク（external_links）にアイコン画像（data URI）列を追加
--   （改善要望: 設定 > 外部リンクのアイコンをプレビュー選択式にし、画像アップロードでも設定したい）。
--   business_segments.app_icon_image（0031）と同じ設計 = アプリ層の allowlist + 上限で検証し、
--   設定時は icon（lucide キー）より優先して実画像を表示する。
--
-- 追加列は NULL 許容 = 既存の外部リンク（アイコン名のみ）は非破壊（原則7）。SoT は external_links 行。
-- 冪等: ADD COLUMN IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

ALTER TABLE external_links ADD COLUMN IF NOT EXISTS icon_image text;
