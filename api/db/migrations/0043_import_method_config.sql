-- 0043: データ取込の方式別設定（F-32。オペレーター指示 2026-07-30 ②）
--   取込元へ方式別の接続/解析設定（CSV ヘッダ有無・区切り / API エンドポイント・認証 / JSON ルートパス）を
--   保持する config jsonb を追加する。列追加のみ = 既存データ後方互換（原則7）。
--   マッピングの方式別ロケータ（CSV 列番号・固定長バイト範囲・JSON キー）は import_mappings.fields（既存 jsonb）
--   の各要素へ追加するため、テーブル変更は不要。
SET search_path TO app_office;

ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}';
