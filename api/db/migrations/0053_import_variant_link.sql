-- 0053: バリアント軸取込＋マスタ間連携キー（データ取込・連携 F-32。オペレーター指示 2026-08-07）。
--   ① 取込対象に product_variant（商品＋SKU バリアント展開）を追加: グルーピングキー（商品コード）で
--      行を商品へ束ね、SKU コードを固有 ID・バリアント軸1/2 の値列（列名 = 軸ラベル）で SKU を展開する。
--   ② マスタ間連携キー（突合キー lookupField）: マッピング項目ごとに「参照先マスタのどの項目と突合して
--      解決するか」（名称 / SKU コード / JAN / 取引先カスタム項目等）を保持する。
--      lookupField は import_mappings.fields（既存 jsonb）の各要素へ追加するため、テーブル変更は不要
--      （0043 の方式別ロケータと同判断）。既存マッピングは lookupField 無し = 従来の既定解決（原則7）。
-- 冪等: DROP CONSTRAINT IF EXISTS → ADD（0051 の method 拡張と同型。多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

-- import_sources.target_entity に 'product_variant' を許容（0035 のインライン CHECK を拡張）。
-- 既存の対象（product/sku/company/sales_record/inventory）はそのまま有効 = 既存データ非破壊（原則7）。
ALTER TABLE import_sources DROP CONSTRAINT IF EXISTS import_sources_target_entity_check;
ALTER TABLE import_sources ADD CONSTRAINT import_sources_target_entity_check
  CHECK (target_entity IN ('product', 'sku', 'company', 'sales_record', 'inventory', 'product_variant'));
