-- 0050: 顧客ログの「議事録メモ」（minutes_memo）を廃止する（オペレーター指示 2026-08-03）。
--   顧客ログは担当者メモ（body）に一本化し、議事録メモの入力・保管を排除する。
--
-- 【下位互換・データ保護の注意（原則7）】本カラムの DROP は既存の議事録メモ本文を破棄する破壊的変更です。
--   議事録メモは 0047（2026-07-31）で追加された比較的新しい項目で、担当者メモ（body）とは別に保持されていました。
--   オペレーターの明示的な廃止指示に基づく削除であり、必要な内容は担当者メモ（body）へ集約する運用とします。
--   （保全が必要な場合は本マイグレーション適用前に customer_logs.minutes_memo をバックアップしてください）
-- 冪等: DROP COLUMN IF EXISTS（再適用・未適用いずれでも安全 = 原則2）。
SET search_path TO app_office;

ALTER TABLE customer_logs DROP COLUMN IF EXISTS minutes_memo;
