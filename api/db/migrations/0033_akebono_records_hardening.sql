-- 0033: Akebono 記録系の堅牢化（Phase C レビュー 1 巡目 C-1 / C-2 対応）。
--
-- C-1（並行性）: /billing/close の check-then-act（既存 draft の洗い替え → INSERT）が並行実行で
-- 同一 得意先 × 期間 の draft を 2 枚作れた（双方 issue で二重請求）。部分一意 INDEX で
-- 「同一キーの未発行ドラフトは常に 1 枚」を DB 制約として保証する（アプリ側は 23505 を
-- 409（同時実行）へ変換 + advisory lock で通常経路を直列化）。
-- ※ 在庫の直列化（pg_advisory_xact_lock）・精算のリンク件数検証はアプリ側（akebono-trade / billing）。
SET search_path TO app_office;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_draft_key_idx
  ON invoices (company_id, period_from, period_to, invoice_type) WHERE status = 'draft';

-- C-2（取消可能性 = 原則9.5）: 入金消込の取消。記録系（追記のみ）の巻き戻し禁止と両立させるため
-- 物理削除ではなく監査列付きの論理取消（voided_at / voided_by）。有効入金 = voided_at IS NULL。
-- 取消時に請求の paid 判定を再計算する（akebono-billing.ts の 1 トランザクション）
ALTER TABLE payment_receipts ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE payment_receipts ADD COLUMN IF NOT EXISTS voided_by text;
