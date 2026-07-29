-- 0038: 出荷実績 → 売上自動計上（F-28 連携。Phase D。§39-6 の残課題）。
-- 出荷実績の登録時に、対象明細から売上明細（sales_records）を自動生成する連携の**二重計上防止**を
-- DB レベルで保証する（原則2 冪等性の最終防衛）。
--
-- スキーマ変更なし（sales_records.source_kind は 0032 で 'shipment' を許容済み・source_ref も既存）。
-- 追加するのは冪等ガードの部分一意 INDEX のみ = 既存データ後方互換（原則7）。
--
-- source_ref = 発生元の出荷実績明細行 id（obr:<resultLineId>）。source_kind='shipment' かつ
-- source_ref 非 NULL の行に一意制約を張り、同一出荷明細からの売上を二重に作れないようにする
-- （アプリ層でも 1 トランザクション内で生成するため通常は衝突しないが、リトライ・バグの最終防衛）。
-- 赤黒訂正（correction_of 付き・source_kind='manual'）は source_kind が異なるため対象外 = 正常に追記できる。
SET search_path TO app_office;

CREATE UNIQUE INDEX IF NOT EXISTS sales_records_shipment_source_idx
  ON sales_records (source_ref)
  WHERE source_kind = 'shipment' AND source_ref IS NOT NULL;
