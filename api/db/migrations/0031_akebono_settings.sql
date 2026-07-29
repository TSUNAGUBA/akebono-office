-- 0031: Akebono 設定系データの API 永続化（Phase B。オペレーター指示「設定・実データの本実装」第 1 弾）。
-- 対象 = 業態マスタ（business_segments）・Akebono 共通マスタ 8 種・業態×アプリ設定・項目カスタマイズ。
-- 従来はモックコレクション（localStorage・日次リシード）で API モードでも翌日消えていた。
--
-- すべて設定系（更新可・論理削除 or 明示的な差分削除 = 記録系ではない。原則2）。
-- segment/company などモック側エンティティへの参照が残る列は FK を張らない
-- （companies は API 移行済みだが、シードの参照先（c-ak-* = デモ取引先）は実環境に存在しないため。
--  Phase C（記録系移行）で参照整合の引き上げを判断する）。
--
-- 初期データの判断（0002 の「デモデータは投入しない」原則との関係を明記）:
-- - business_segments ほか 8 マスタは**モックシードと同一 id・同一値**を投入する。理由 =
--   ①業態が空だと全 Akebono 画面が業態軸を失う（原則1: 空メニューにしない）
--   ②既存 API 環境の実データ（media_ga_tokens / media_settings）と未移行の記録系
--     （products / salesRecords 等 = Phase C までモック）が seg-01 等の同 id を参照しており、
--     異なる id で始めると既存データが軌道から外れる（下位互換 = 原則7）。
--   名称・構成は設定系のため運用開始時に画面から変更・無効化・追加できる（Phase C 完了後に
--   デモ由来行の整理を案内する）。
-- - akebono_app_configs は投入しない: 行が無い業態は業種プリセットへフォールバックする実装
--   （useAkebonoApps.isAppEnabled）が既定を担う = 空でメニューは欠けない（原則1 はコード側で充足）
-- - item_settings は投入しない: 空 = カタログ既定（差分テーブル）
SET search_path TO app_office;

-- 事業セグメント（業態）。SoT = 本テーブル（モックの businessSegments を移行）
CREATE TABLE IF NOT EXISTS business_segments (
  id                          text PRIMARY KEY,
  name                        text NOT NULL,
  industry_type               text NOT NULL
    CHECK (industry_type IN ('retail','maker','logistics','it_service','other')),
  display_order               int NOT NULL DEFAULT 1,
  -- 業態別アプリの表示・入力既定（F-20 拡張。すべて任意 = 未設定はフォールバック）
  app_name                    text,
  app_icon                    text,
  app_icon_image              text, -- data URI（160px 縮小・上限 400,000 文字 = registry で検証）
  default_unit_id             text, -- units 参照（アプリ層解決）
  default_billing_type        text CHECK (default_billing_type IN ('one_time','monthly','usage')),
  default_variant_axis1_label text,
  default_variant_axis2_label text,
  active                      boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warehouses (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('own','store_deposit','external')),
  company_id    text, -- store_deposit のとき紐付く店舗（companies 参照だがデモシード互換のため FK なし）
  display_order int NOT NULL DEFAULT 1,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS units (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  display_order int NOT NULL DEFAULT 1,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tax_rates (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  rate          numeric(5,4) NOT NULL CHECK (rate >= 0 AND rate <= 1),
  display_order int NOT NULL DEFAULT 1,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_terms (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  closing_day      int NOT NULL CHECK (closing_day BETWEEN 1 AND 31),
  pay_month_offset int NOT NULL DEFAULT 1 CHECK (pay_month_offset BETWEEN 0 AND 3),
  pay_day          int NOT NULL DEFAULT 31 CHECK (pay_day BETWEEN 1 AND 31),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- 委託条件（取引先×セグメント×ロール。店舗 = マージン請求設定 / 作家 = 支払設定）
CREATE TABLE IF NOT EXISTS consignment_terms (
  id               text PRIMARY KEY,
  company_id       text NOT NULL, -- デモシード互換のため FK なし（上記コメント）
  segment_id       text NOT NULL,
  role             text NOT NULL CHECK (role IN ('store','consignor_artist')),
  margin_rate      numeric(5,4) CHECK (margin_rate IS NULL OR (margin_rate >= 0 AND margin_rate <= 1)),
  payout_method    text CHECK (payout_method IN ('sales_rate','purchase_cost')),
  payout_rate      numeric(5,4) CHECK (payout_rate IS NULL OR (payout_rate >= 0 AND payout_rate <= 1)),
  liability_timing text CHECK (liability_timing IN ('on_sale','on_receipt')),
  tax_rate_id      text,
  tax_included     boolean NOT NULL DEFAULT false,
  rounding         text NOT NULL DEFAULT 'floor' CHECK (rounding IN ('floor','ceil','round')),
  valid_from       date NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS variant_axis_templates (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  axis1_label    text NOT NULL,
  axis2_label    text NOT NULL,
  industry_types jsonb NOT NULL DEFAULT '[]',
  display_order  int NOT NULL DEFAULT 1,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_categories (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  parent_id     text, -- 自己参照階層（アプリ層解決。モックと同じく循環ガードなし = 選択 UI が階層提示）
  display_order int NOT NULL DEFAULT 1,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_image_sections (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  is_thumbnail_priority boolean NOT NULL DEFAULT false,
  is_seed               boolean NOT NULL DEFAULT false, -- 既定シード = 無効化不可（AKO-AKB-002）・名称変更可
  display_order         int NOT NULL DEFAULT 1,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- 業態×アプリの使用/不使用・ラベル（複合キー = 汎用マスタ（id 主キー）に合わないため専用テーブル + 専用 API。
-- カタログ（アプリキー・名称・依存）はフロントの静的定義が SoT で、本テーブルは業態ごとの選択だけを持つ）
CREATE TABLE IF NOT EXISTS akebono_app_configs (
  segment_id     text NOT NULL,
  app_key        text NOT NULL,
  enabled        boolean NOT NULL DEFAULT false,
  label_override text,
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('preset','manual')),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, app_key)
);

-- 項目カスタマイズの差分（空 = カタログ既定。カタログはフロント静的 SoT = ITEM_CATALOG）
CREATE TABLE IF NOT EXISTS item_settings (
  id             text PRIMARY KEY,
  app_key        text NOT NULL DEFAULT 'akebono',
  entity         text NOT NULL,
  item_key       text NOT NULL,
  form_visible   boolean,
  form_required  boolean,
  list_visible   boolean,
  display_order  int,
  label_override text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_key, entity, item_key)
);

-- ---------- 初期データ（モックシードと同一 id。冒頭コメントの互換判断） ----------

INSERT INTO business_segments (id, name, industry_type, display_order, app_icon, default_unit_id, default_billing_type, default_variant_axis1_label, default_variant_axis2_label) VALUES
  ('seg-01', '陶磁器委託販売', 'retail', 1, 'Palette', 'unit-02', NULL, NULL, NULL),
  ('seg-02', 'SI 事業', 'it_service', 2, 'Server', 'unit-03', 'one_time', NULL, NULL),
  ('seg-03', 'SaaS 事業', 'it_service', 3, 'Cloud', 'unit-05', 'monthly', NULL, NULL),
  ('seg-04', 'アパレル', 'retail', 4, 'Shirt', 'unit-01', NULL, 'カラー', 'サイズ')
ON CONFLICT (id) DO NOTHING;

INSERT INTO warehouses (id, name, kind, company_id, display_order) VALUES
  ('wh-01', '自社倉庫（本社）', 'own', NULL, 1),
  ('wh-02', '銀座ギャラリー店（預け）', 'store_deposit', 'c-ak-03', 2),
  ('wh-03', '横浜クラフト店（預け）', 'store_deposit', 'c-ak-04', 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO units (id, name, display_order) VALUES
  ('unit-01', '個', 1), ('unit-02', '点', 2), ('unit-03', '式', 3), ('unit-04', '人日', 4), ('unit-05', 'ライセンス', 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO tax_rates (id, name, rate, display_order) VALUES
  ('tax-10', '標準税率（10%）', 0.10, 1), ('tax-08', '軽減税率（8%）', 0.08, 2), ('tax-00', '非課税（0%）', 0, 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO payment_terms (id, name, closing_day, pay_month_offset, pay_day) VALUES
  ('pt-01', '月末締め翌月末払い', 31, 1, 31),
  ('pt-02', '20日締め翌月10日払い', 20, 1, 10)
ON CONFLICT (id) DO NOTHING;

INSERT INTO consignment_terms (id, company_id, segment_id, role, margin_rate, payout_method, payout_rate, liability_timing, tax_rate_id, tax_included, rounding, valid_from) VALUES
  ('ct-01', 'c-ak-03', 'seg-01', 'store', 0.30, NULL, NULL, NULL, 'tax-10', false, 'floor', '2026-01-01'),
  ('ct-02', 'c-ak-04', 'seg-01', 'store', 0.35, NULL, NULL, NULL, 'tax-10', false, 'floor', '2026-01-01'),
  ('ct-03', 'c-ak-01', 'seg-01', 'consignor_artist', NULL, 'sales_rate', 0.60, 'on_sale', 'tax-10', false, 'floor', '2026-01-01'),
  ('ct-04', 'c-ak-02', 'seg-01', 'consignor_artist', NULL, 'sales_rate', 0.55, 'on_sale', 'tax-10', false, 'floor', '2026-01-01')
ON CONFLICT (id) DO NOTHING;

INSERT INTO variant_axis_templates (id, name, axis1_label, axis2_label, industry_types, display_order) VALUES
  ('vat-01', 'アパレル（カラー×サイズ）', 'カラー', 'サイズ', '["retail"]', 1),
  ('vat-02', '食品（容量×味）', '容量', '味', '["maker","other"]', 2),
  ('vat-03', '雑貨（柄×入数）', '柄', '入数', '["retail","other"]', 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO product_categories (id, name, parent_id, display_order) VALUES
  ('pcat-01', '陶磁器', NULL, 1),
  ('pcat-02', '食器', 'pcat-01', 1),
  ('pcat-03', '花器', 'pcat-01', 2),
  ('pcat-04', 'アパレル', NULL, 2),
  ('pcat-05', 'トップス', 'pcat-04', 1),
  ('pcat-06', 'ボトムス', 'pcat-04', 2),
  ('pcat-07', 'サービス', NULL, 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO product_image_sections (id, name, is_thumbnail_priority, is_seed, display_order) VALUES
  ('pis-01', '製品画像', true, true, 1),
  ('pis-02', 'サンプル画像', false, true, 2)
ON CONFLICT (id) DO NOTHING;
