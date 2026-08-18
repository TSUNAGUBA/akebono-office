-- 0068: 改修単位（improvement_items）のステータスに「対応中（in_progress）」を追加（改修依頼 2026-08-18）。
-- カンバンの「対応する」と「解決済み」の間に置く着手済み状態。値の SoT は
-- shared/domain/improvement.ts（IMPROVEMENT_STATUSES / IMPROVEMENT_STATUS_NEXT）で、
-- DB は CHECK の許容値を追随させる（0057 のインライン CHECK を差し替え）。
-- 下位互換（原則7）: 既存の 4 値はそのまま許容 = 既存行の変更なし。
-- 冪等: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT（再実行しても既存データは変化しない = 原則2）。
SET search_path TO app_office;

ALTER TABLE improvement_items DROP CONSTRAINT IF EXISTS improvement_items_status_check;
ALTER TABLE improvement_items ADD CONSTRAINT improvement_items_status_check
  CHECK (status IN ('triage', 'accepted', 'in_progress', 'resolved', 'rejected'));
