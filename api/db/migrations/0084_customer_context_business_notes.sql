-- 0084: 顧客コンテキストの定性情報に「事業メモ」（business_notes）を追加（改修依頼 2026-08-21）。
-- 昨季売上高・社員数・店舗数・配送センター（自社/他社・地域）等の事業に関する事実を扱うフリーテキスト。
-- AI リサーチ（Web 調査）の構築・反映でも該当情報があれば本項目へ反映される。
-- 既定 '' = 既存行のバックフィル不要・既存データ無変更（原則7）。IF NOT EXISTS で冪等（原則2）
SET search_path TO app_office;

ALTER TABLE customer_contexts
  ADD COLUMN IF NOT EXISTS business_notes text NOT NULL DEFAULT '';
