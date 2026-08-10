-- 0056: 構造化フィルタ検索の基盤（オペレーター指示 2026-08-10）。
-- ① 検索正規化関数 akebono_norm(text) = lower(normalize(t, NFKC))
--    大文字小文字・全角半角（全角ASCII→半角・半角カナ→全角カナ〔濁点合成〕）を吸収して部分一致させる。
--    PostgreSQL 16 の normalize(NFKC) は JS の String.normalize('NFKC') と一致する（shared/domain/text-match
--    の normalizeSearch と同一結果 = 両モードで同じヒット挙動）。IMMUTABLE のため関数インデックスにも使える。
-- ② item_settings.filter_visible: 各項目を「検索対象（フィルタ）」として使うかの設定差分（NULL = カタログ既定）。
--    list_visible と同型・追加列のみ = 既存データ後方互換（原則7）。
SET search_path TO app_office;

-- 検索正規化（NFKC 畳み込み + 小文字化）。純関数 = IMMUTABLE・PARALLEL SAFE・NULL 入力は NULL
CREATE OR REPLACE FUNCTION app_office.akebono_norm(t text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  RETURNS NULL ON NULL INPUT
AS $$ SELECT lower(normalize(t, NFKC)) $$;

-- 項目カスタマイズに「検索対象（フィルタ）」フラグを追加（NULL = カタログ既定 filterDefault）
ALTER TABLE item_settings ADD COLUMN IF NOT EXISTS filter_visible boolean;
