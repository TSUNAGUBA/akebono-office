-- 0079: ビジネスパートナー活動に Next Action メモを追加（改善要望 2026-08-21）。
-- BP のみの項目（営業活動には追加しない = 要望範囲。currentState 等の BP 固有フィールドの前例に整合）。
-- 既存行は空文字既定（原則7 = 下位互換）
SET search_path TO app_office;

ALTER TABLE partner_activities ADD COLUMN IF NOT EXISTS next_action_note text NOT NULL DEFAULT '';
