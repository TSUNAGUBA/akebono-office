-- 0032: Akebono 記録系データの API 永続化（Phase C。オペレーター指示「設定・実データの本実装」第 2 弾）。
-- 対象 = 商品系（products / product_skus / product_images）・伝票系（purchase_orders /
-- production_orders / inbound_plans / inbound_results / purchase_records / outbound_plans /
-- outbound_results）・在庫台帳（inventory_transactions）・売上/請求系（sales_records /
-- invoices / payment_notices / payment_receipts）+ 伝票コード採番（akebono_doc_seqs）。
--
-- データ 3 分類（akebono-menu-design §3.1）:
-- - 設定系（更新可・論理削除）: products / product_skus / product_images
-- - 記録系（追記のみ・訂正は赤黒）: inbound_results / outbound_results / purchase_records /
--   sales_records / inventory_transactions（在庫の SoT・追記のみ）/ payment_receipts
-- - 確定系（発行後不変・訂正は赤伝）: invoices / payment_notices
-- 予定・指示（purchase_orders / production_orders / inbound_plans / outbound_plans）は
-- ステータス遷移のみ（DELETE しない = 取消はステータス。原則9.5）。
--
-- 初期データ: 記録系は**シードしない**（akebono_wishes / sales_monthly / media_articles と同方針 =
-- 実データは登録・取込から育てる。0002 の「デモデータは投入しない」原則）。
-- 各画面は空状態の導線（登録方法の案内）を持つ。
--
-- FK を張らない判断（Phase C 時点の再評価。data-design §1.6 に文書化）:
-- - 参照整合は API 書込パスの存在検証（SKU・倉庫・会社・セグメント）で担保する。
--   物理 FK を張らないのは ①明細（lines jsonb）内参照は FK で表現できず整合手段が二重になる
--   ②記録系の原本は赤黒で不変 = 参照先マスタの物理削除は運用上起きない（論理削除のみ）
--   ③モック期の localStorage データを API へ持ち込む経路が無く、孤児参照の発生源が無い、ため。
-- - 0030/0031 既存テーブルへの FK 後付けも同判断で行わない（segment_id は API 層検証で統一）。
-- - 0031 シードの c-ak-*（デモ取引先）参照（warehouses.company_id / consignment_terms.company_id）は
--   実環境の companies に存在しない。実運用開始時に倉庫・委託条件を実取引先へ付け替える
--   （オペレーター向け手順は implementation-status §38 続き参照）。
SET search_path TO app_office;

-- 取引先の Akebono 拡張（F-30-1。shared/domain/types.ts の Company 拡張に対応する物理列。
-- 追加列のみ = 既存データ後方互換・原則7。partner_roles 空 = customer は ['customer'] 相当の下位互換は
-- アプリ層 partnerRolesOf が担う）
ALTER TABLE companies ADD COLUMN IF NOT EXISTS partner_roles jsonb NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_term_id text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_term_id text;

-- 伝票コード（PREFIX-0001）の採番台帳。単一 UPDATE ... RETURNING で原子的 = 並行採番でも重複しない
CREATE TABLE IF NOT EXISTS akebono_doc_seqs (
  prefix text PRIMARY KEY,
  last   int NOT NULL DEFAULT 0
);

-- ---------- 商品（F-21。設定系） ----------

CREATE TABLE IF NOT EXISTS products (
  id                          text PRIMARY KEY,
  code                        text NOT NULL,
  name                        text NOT NULL,
  segment_id                  text NOT NULL,
  category_id                 text,
  default_supplier_company_id text,
  list_price                  numeric(14,2) NOT NULL DEFAULT 0,
  standard_cost               numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate_id                 text,
  unit_id                     text,
  billing_type                text CHECK (billing_type IN ('one_time','monthly','usage')),
  variant_axis1_label         text,
  variant_axis2_label         text,
  description                 text NOT NULL DEFAULT '',
  active                      boolean NOT NULL DEFAULT true,
  custom                      jsonb NOT NULL DEFAULT '{}',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
-- 商品コード一意は「同一セグメント × 有効行」のみ（論理削除後の再利用可 = モック仕様と同一）
CREATE UNIQUE INDEX IF NOT EXISTS products_segment_code_active_idx
  ON products (segment_id, code) WHERE active;

CREATE TABLE IF NOT EXISTS product_skus (
  id         text PRIMARY KEY,
  product_id text NOT NULL,
  code       text NOT NULL,
  jan_code   text,
  axis1_value text,
  axis2_value text,
  sell_price numeric(14,2), -- null = 商品の list_price を使用
  cost_price numeric(14,2), -- null = 商品の standard_cost を使用
  is_default boolean NOT NULL DEFAULT false, -- 展開なし商品の既定 SKU（商品作成時に自動生成）
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_skus_product_idx ON product_skus (product_id);

-- 商品画像。実体は data URI の TEXT 列（プロフィール画像・業態アイコン 0031 と同じ方式 = 原則3。
-- クライアントが縮小してから送る前提で上限 400,000 文字を API 層で検証。documents の GCS/blob
-- パターンは「原本 10MB の保全」用であり、表示用サムネイルには過剰と判断）
CREATE TABLE IF NOT EXISTS product_images (
  id            text PRIMARY KEY,
  product_id    text NOT NULL,
  sku_id        text,          -- SKU 単位の紐付け（任意。null = 商品共通）
  section_id    text NOT NULL, -- product_image_sections 参照（API 層検証）
  display_order int NOT NULL DEFAULT 1,
  filename      text NOT NULL,
  mime          text NOT NULL,
  data_url      text,          -- data URI（null = 色プレースホルダ描画）
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_images_product_idx ON product_images (product_id);

-- ---------- 伝票系（発注・生産・入荷・仕入・出荷） ----------

-- 発注（F-23）。lines = [{id, skuId, qty, unitPrice}]（camelCase jsonb = フロント型と同形）
CREATE TABLE IF NOT EXISTS purchase_orders (
  id         text PRIMARY KEY,
  code       text NOT NULL,
  company_id text NOT NULL,
  segment_id text NOT NULL,
  status     text NOT NULL DEFAULT 'ordered'
    CHECK (status IN ('draft','ordered','partially_received','closed','canceled')),
  order_date date NOT NULL,
  due_date   date NOT NULL,
  lines      jsonb NOT NULL DEFAULT '[]',
  note       text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 生産指示（F-22）+ 実績（results jsonb・追記のみ = API が追記操作のみ提供）
CREATE TABLE IF NOT EXISTS production_orders (
  id           text PRIMARY KEY,
  code         text NOT NULL,
  sku_id       text NOT NULL,
  qty          int NOT NULL CHECK (qty > 0),
  warehouse_id text NOT NULL,
  due_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'instructed'
    CHECK (status IN ('draft','instructed','in_progress','completed','canceled')),
  results      jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 入荷予定（F-25-1）。lines = [{id, skuId, qty}]
CREATE TABLE IF NOT EXISTS inbound_plans (
  id           text PRIMARY KEY,
  code         text NOT NULL,
  po_id        text,
  warehouse_id text NOT NULL,
  due_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','partial','completed','canceled')),
  lines        jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 入荷実績（F-25-2。記録系・追記のみ）。lines = [{id, planLineId, skuId, qty}]
CREATE TABLE IF NOT EXISTS inbound_results (
  id           text PRIMARY KEY,
  code         text NOT NULL,
  plan_id      text,
  warehouse_id text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  lines        jsonb NOT NULL DEFAULT '[]'
);

-- 仕入計上（F-24。記録系・訂正は赤黒）。lines = [{id, skuId, qty, costPrice}]
CREATE TABLE IF NOT EXISTS purchase_records (
  id                text PRIMARY KEY,
  code              text NOT NULL,
  company_id        text NOT NULL,
  segment_id        text NOT NULL,
  purchase_date     date NOT NULL,
  purchase_type     text NOT NULL CHECK (purchase_type IN ('outright','consignment')),
  inbound_result_id text,
  warehouse_id      text, -- 入荷管理 OFF 経路で入庫した倉庫（訂正時の在庫戻しに使用。ON 経路は null）
  lines             jsonb NOT NULL DEFAULT '[]',
  correction_of     text, -- 赤黒訂正の元伝票
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 出荷指示（F-26-1。取消はステータス = 単独 DELETE 禁止）。lines = [{id, skuId, qty}]
CREATE TABLE IF NOT EXISTS outbound_plans (
  id           text PRIMARY KEY,
  code         text NOT NULL,
  company_id   text NOT NULL,
  warehouse_id text NOT NULL,
  segment_id   text NOT NULL,
  due_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','partial','completed','canceled')),
  lines        jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 出荷実績（F-26-2。記録系・追記のみ）。lines = [{id, planLineId, skuId, qty}]
CREATE TABLE IF NOT EXISTS outbound_results (
  id           text PRIMARY KEY,
  code         text NOT NULL,
  plan_id      text,
  warehouse_id text, -- 直接登録時は必須（指示参照時は plan から解決して保存）
  company_id   text,
  shipped_at   timestamptz NOT NULL DEFAULT now(),
  lines        jsonb NOT NULL DEFAULT '[]'
);

-- 在庫トランザクション（§3.4。在庫の SoT・追記のみ。残高は Σqty で導出）
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id           text PRIMARY KEY,
  sku_id       text NOT NULL,
  warehouse_id text NOT NULL,
  qty          int NOT NULL, -- 増減（+ 入庫 / − 出庫）
  kind         text NOT NULL CHECK (kind IN
    ('inbound','outbound','purchase_in','adjust','transfer_in','transfer_out','production_in','stocktake')),
  reason       text CHECK (reason IS NULL OR reason IN ('defective','lost','found','sample','stocktake','other')),
  ref_type     text NOT NULL,
  ref_line_id  text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
-- 冪等キー（二重生成防止 = モックの post() と同一）。ON CONFLICT DO NOTHING で追記
CREATE UNIQUE INDEX IF NOT EXISTS inventory_transactions_dedup_idx
  ON inventory_transactions (ref_type, ref_line_id, kind);
CREATE INDEX IF NOT EXISTS inventory_transactions_sku_wh_idx
  ON inventory_transactions (sku_id, warehouse_id);

-- ---------- 売上・請求（F-28/F-29） ----------

-- 売上明細（売上の SoT。記録系・訂正は赤黒。F-15 sales_monthly とは別系統 = 明細型）
CREATE TABLE IF NOT EXISTS sales_records (
  id            text PRIMARY KEY,
  code          text NOT NULL,
  sales_date    date NOT NULL,
  company_id    text NOT NULL,
  segment_id    text NOT NULL,
  sku_id        text NOT NULL,
  qty           int NOT NULL,
  unit_price    numeric(14,2) NOT NULL,
  amount        numeric(14,2) NOT NULL,
  cost_price    numeric(14,2),
  channel       text,
  billing_type  text CHECK (billing_type IS NULL OR billing_type IN ('one_time','monthly','usage')),
  source_kind   text NOT NULL DEFAULT 'manual'
    CHECK (source_kind IN ('manual','shipment','import','monthly_bulk')),
  source_ref    text,
  invoice_id    text, -- 請求済みリンク（発行時に張る・赤伝で解除）
  correction_of text, -- 赤黒訂正の元明細
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_records_segment_date_idx ON sales_records (segment_id, sales_date);
CREATE INDEX IF NOT EXISTS sales_records_company_idx ON sales_records (company_id);

-- 請求（確定系。issued 以降は不変・訂正は赤伝）。lines/snapshot/source_record_ids = camelCase jsonb
CREATE TABLE IF NOT EXISTS invoices (
  id               text PRIMARY KEY,
  code             text NOT NULL,
  company_id       text NOT NULL,
  segment_id       text, -- null = 複数セグメント合算（XA-2 例外）
  period_from      date NOT NULL,
  period_to        date NOT NULL,
  invoice_type     text NOT NULL CHECK (invoice_type IN ('sales','consignment_margin')),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','paid','void')),
  issued_at        timestamptz,
  total_amount     numeric(14,2) NOT NULL DEFAULT 0,
  credit_for       text, -- 赤伝の元請求
  lines            jsonb NOT NULL DEFAULT '[]',
  snapshot         jsonb, -- 委託マージン請求時の設定スナップショット（発行時点で凍結）
  source_record_ids jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_company_idx ON invoices (company_id);

-- 支払通知（F-29-4。作家向け。確定系）。lines = [{id, salesRecordId, description, amount}]
CREATE TABLE IF NOT EXISTS payment_notices (
  id             text PRIMARY KEY,
  code           text NOT NULL,
  company_id     text NOT NULL,
  segment_id     text NOT NULL,
  period_from    date NOT NULL,
  period_to      date NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','paid')),
  payable_amount numeric(14,2) NOT NULL DEFAULT 0,
  lines          jsonb NOT NULL DEFAULT '[]',
  snapshot       jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 入金消込（F-29-3。記録系・追記のみ。部分入金可）
CREATE TABLE IF NOT EXISTS payment_receipts (
  id          text PRIMARY KEY,
  invoice_id  text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  method      text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS payment_receipts_invoice_idx ON payment_receipts (invoice_id);
