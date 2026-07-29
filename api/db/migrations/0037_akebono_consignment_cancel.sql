-- 0037: 委託精算の取消フロー（Phase D。原則9.5 = 記録・確定系にも「立ち戻る」導線を用意する宿題）。
-- Phase C（§39-6）で残課題として明記した「委託精算（マージン請求 + 支払通知の組）の取消」を実装する。
--
-- 追加のみ = 既存データ後方互換（原則7）。挙動: 精算締め（consignment/close）が生成した
--   マージン請求（invoices.invoice_type='consignment_margin'）と支払通知（payment_notices）を
--   1 つの精算バッチ（settlement_id）として束ね、取消時にバッチ単位で赤伝/論理取消する。
--
-- - settlement_id: 精算締めが採番するバッチ id。close が生成した請求/通知に付与し、cancel の対象特定に使う
--   （既存行は NULL = Phase C までの精算はバッチ id なし。cancel は「issued の consignment_margin 請求」を
--    期間で特定する経路も併用するため、settlement_id が NULL の旧精算も期間指定で取消できる）。
-- - payment_notices.voided_at / voided_by: 支払通知の**論理取消**の監査列（payment_receipts 0033 と同型）。
--   支払通知には赤伝の器（credit_for）が無いため、voided_at で論理取消する（confirmNotice は取消済みを拒否）。
--   有効な支払通知は voided_at IS NULL のもの。
SET search_path TO app_office;

ALTER TABLE invoices        ADD COLUMN IF NOT EXISTS settlement_id text;
ALTER TABLE payment_notices ADD COLUMN IF NOT EXISTS settlement_id text;
ALTER TABLE payment_notices ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE payment_notices ADD COLUMN IF NOT EXISTS voided_by text;

-- 期間 × 種別での取消対象特定を効率化（consignment_margin 請求のバッチ取得）
CREATE INDEX IF NOT EXISTS invoices_consignment_period_idx
  ON invoices (segment_id, period_from, period_to) WHERE invoice_type = 'consignment_margin';
