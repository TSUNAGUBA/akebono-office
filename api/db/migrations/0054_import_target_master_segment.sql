-- 0054: 取込元の事業セグメント属性＋共通マスタ取込（データ取込・連携 F-32。オペレーター指示 2026-08-09）。
--   ① 事業セグメントを「取込元の属性」へ移動: 各マッピング行の列取込ではなく、取込元（import_sources）に
--      segment_id を持たせ、配下の全マッピング定義（版）で共通の値として反映する。
--      既存取込元は NULL = 従来どおり（マッピングに segmentId 列があればそれで解決 = 下位互換・原則7。
--      既存データの一括更新パッチは不要 = NULL のまま従来動作を維持するため）。
--   ② 共通マスタ管理（/akebono/masters）の外部データ取込: target_entity に master_*（8 マスタ =
--      事業セグメント/倉庫/商品カテゴリ/単位/税区分/回収支払条件/バリアント軸テンプレート/画像セクション）を
--      許容する。対象項目カタログは shared/domain/import-master.ts（SoT）。
--      委託条件（consignment_terms）は複合キー＋精算設定のため対象外（カタログの設計判断コメント参照）。
-- FK を張らない判断は 0035 と同じ（data-design §1.6 = 参照整合は API 書込パスの検証で担保。
-- セグメントは論理削除のみ = 物理削除で孤児参照が生じる経路が無い）。
-- 冪等: ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS → ADD（0051・0053 と同型 = 原則2）。
SET search_path TO app_office;

-- ① 取込元の事業セグメント（NULL = 未設定 = 従来のマッピング列解決へフォールバック）
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS segment_id text;

-- ② target_entity に master_* を許容（0053 の CHECK を拡張。既存対象はそのまま有効 = 既存データ非破壊）
ALTER TABLE import_sources DROP CONSTRAINT IF EXISTS import_sources_target_entity_check;
ALTER TABLE import_sources ADD CONSTRAINT import_sources_target_entity_check
  CHECK (target_entity IN ('product', 'sku', 'company', 'sales_record', 'inventory', 'product_variant',
    'master_segment', 'master_warehouse', 'master_category', 'master_unit', 'master_tax_rate',
    'master_payment_term', 'master_axis_template', 'master_image_section'));
