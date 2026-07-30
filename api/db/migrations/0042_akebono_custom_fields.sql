-- 0042: Akebono 業務アプリの追加カスタム項目の保存列（F-31 汎用化。オペレーター指示 2026-07-30 ①）
--   項目カスタマイズを全アプリへ広げるため、各アプリのレコードへ custom jsonb を追加する。
--   既定は '{}'。列追加のみ = 既存データ後方互換（原則7）。products は 0032 で既に custom を持つ。
--   各アプリの API 経路が custom を SELECT/INSERT へ反映するのは段階適用（本マイグレーションは保存先の用意）。
SET search_path TO app_office;

ALTER TABLE product_skus            ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE purchase_orders         ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE production_orders       ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE inbound_results         ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE purchase_records        ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE outbound_results        ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE inventory_transactions  ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sales_records           ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE invoices                ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
