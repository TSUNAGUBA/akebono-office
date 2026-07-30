-- 0046: データ取込（F-32）の実取込に伴う冪等ガード（監査指摘 2026-07-30 ①）。
-- 取込実行が実データ（sales_records / inventory_transactions）を書くようになるため、
-- 同一ファイルの再実行で売上が二重計上されない最終防衛を DB レベルで張る（原則2）。
--
-- source_ref = 行フィンガープリント（import:<sourceId>:<sha256 の先頭>）。同一取込元の同一内容行は
-- 再実行で衝突 → ON CONFLICT DO NOTHING → skipped として集計される（アプリ層と二重の防衛）。
-- 在庫は既存の UNIQUE(ref_type, ref_line_id, kind)（0032）を ref_line_id = フィンガープリントで再利用
-- するため追加変更なし。スキーマは INDEX 追加のみ = 既存データ後方互換（原則7）。
SET search_path TO app_office;

CREATE UNIQUE INDEX IF NOT EXISTS sales_records_import_source_idx
  ON sales_records (source_ref)
  WHERE source_kind = 'import' AND source_ref IS NOT NULL;
