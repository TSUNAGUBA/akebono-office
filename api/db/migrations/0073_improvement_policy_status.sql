-- 0073: 改修単位（improvement_items）のステータスを「対応方針」語彙へ再編（改修依頼 2026-08-20）。
-- 「運用対応（operational）」「継続検討（deferred）」を追加する。値の SoT は
-- shared/domain/improvement.ts（IMPROVEMENT_STATUSES / IMPROVEMENT_STATUS_NEXT）で、
-- DB は CHECK の許容値を追随させる（0068 の CHECK を差し替え）。
-- あわせて継続検討の再検討日（revisit_on）と、その通知の多重送信防止マーカー
-- （revisit_notified_on = 直近通知日。runImprovementRevisitReminders が通知後に today で更新）を追加する。
-- 下位互換（原則7）: 既存の 5 値はそのまま許容 = 既存行は無変更（accepted/rejected は**ラベルのみ**
-- 「改善対応」「対応見送り」へ変更 = 表示側 IMPROVEMENT_STATUS_META の話で、保存値は変わらない）。
-- 冪等: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT / ADD COLUMN IF NOT EXISTS
-- （再実行しても既存データは変化しない = 原則2）。
SET search_path TO app_office;

ALTER TABLE improvement_items DROP CONSTRAINT IF EXISTS improvement_items_status_check;
ALTER TABLE improvement_items ADD CONSTRAINT improvement_items_status_check
  CHECK (status IN ('triage', 'accepted', 'in_progress', 'operational', 'deferred', 'resolved', 'rejected'));

-- 継続検討の再検討日（deferred への遷移で必須。deferred 以外への遷移でもクリアしない = 履歴保全）
ALTER TABLE improvement_items ADD COLUMN IF NOT EXISTS revisit_on date;
-- 再検討日リマインドの直近通知日（多重通知防止。deferred への遷移で NULL に戻す = 新しい期日で再通知）
ALTER TABLE improvement_items ADD COLUMN IF NOT EXISTS revisit_notified_on date;

-- 再検討日の到来チェック（runImprovementRevisitReminders の日次スキャン）を効かせる部分索引
CREATE INDEX IF NOT EXISTS improvement_items_revisit_idx
  ON improvement_items (revisit_on) WHERE status = 'deferred' AND archived_at IS NULL;
