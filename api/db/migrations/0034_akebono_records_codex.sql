-- 0034: Akebono 記録系の外部ボットレビュー（PR #84 Codex）対応。
--
-- P1-1（委託精算の原価解決）: resolveUnitCost（purchase_cost 方式の作家支払算定）が仕入を
-- 「全 SKU 横断の直近 500 件」だけ取得していたため、仕入総数が 500 を超えると対象 SKU の
-- 直近仕入が窓外に落ち、標準原価フォールバックへ = 作家支払額が誤った。取得を SQL 側で
-- 「対象 skuId を含む明細（lines @> [{"skuId":...}]）の最新 1 件」に絞る是正に伴い、
-- jsonb 包含（@>）を支える GIN インデックスを追加する（本番規模で全 SKU スキャンを避ける）。
-- jsonb_path_ops = @> 専用の軽量 GIN（既定 jsonb_ops より小さく高速。キー存在演算子 ? は不要）。
SET search_path TO app_office;

CREATE INDEX IF NOT EXISTS purchase_records_lines_gin_idx
  ON purchase_records USING gin (lines jsonb_path_ops);
