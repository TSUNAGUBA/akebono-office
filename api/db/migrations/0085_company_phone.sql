-- 0085: 顧客(会社)マスタに代表電話番号（phone）を追加（改修依頼 2026-08-21 第3弾）。
-- 顧客コンテキストの基本情報画面・顧客(会社)マスタ画面で表示・編集でき、
-- AI リサーチ（Web 調査）で情報源から電話番号を取得できた場合は反映（変更前の値は
-- research ノートの payload.before.companyPhone に保存 = 反映取消で復元・原則9.5）。
-- 形式は contacts.phone と同じ自由入力。既定 '' = 既存行のバックフィル不要・
-- 既存データ無変更（原則7）。IF NOT EXISTS で冪等（原則2）
SET search_path TO app_office;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '';
