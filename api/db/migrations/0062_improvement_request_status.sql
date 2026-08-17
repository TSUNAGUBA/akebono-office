-- 0062: 要望（improvement_requests）単位のステータス（F-42 追補・改善要望 2026-08-17）。
--   改修単位（improvement_items.status）が「改修 1 件」の進捗を表すのに対し、本列は元となった
--   要望 1 件ずつの対応状況（open 未対応 / resolved 対応済み / dismissed 見送り）を表す。
--   改修プロンプトの再生成時に加味され、【対応済み】【見送り】が明記される（buildCodingPrompt）。
--
-- 追加列のみ・NOT NULL DEFAULT 'open' = 既存行は「未対応」として非破壊（原則7）。
-- 冪等: ADD COLUMN IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'resolved', 'dismissed'));
