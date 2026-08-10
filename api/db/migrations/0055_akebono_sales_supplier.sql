-- 0055: 売上明細に仕入先（作家）スナップショット列を追加（改修提案 P3。オペレーター指示 2026-08-10）。
--
-- 目的: 委託精算の作家帰属・作家別分析を、商品の default_supplier_company_id を後日変更しても
-- 揺らがないように、**計上時点の供給元（作家）** を売上明細へ凍結保存する。
-- 従来は精算・分析とも「商品の現在の既定仕入先」を都度解決していたため、供給元を付け替えると
-- 過去売上の作家帰属が遡って変わっていた（データフロー整合性 = 原則6・下位互換 = 原則7 の観点で改善）。
--
-- 設計判断:
-- - 追加列のみ・NULL 許容 = 既存行は無改変で後方互換（原則7）。バックフィルはしない
--   （過去行の「当時の供給元」は原本が無いため復元不能。NULL のままライブ解決へ委ねるのが正）。
-- - NULL 行（既存行・供給元未設定の商品）の精算/分析は、商品の現在の default_supplier_company_id へ
--   COALESCE でフォールバックする（アプリ/API 層で解決）。挙動は従来と同一 = 無移行で壊れない。
-- - FK は張らない（0032 の設計判断を踏襲: companies への参照整合は API 書込パスの存在検証で担保）。
SET search_path TO app_office;

ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS supplier_company_id text;

-- 作家別分析・精算の作家別集約で使う（company_id と別軸のロールアップ）
CREATE INDEX IF NOT EXISTS sales_records_supplier_idx ON sales_records (supplier_company_id);
