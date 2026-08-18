-- 0064: 要望（improvement_requests）本文の編集（F-42 追補・改修依頼 2026-08-18）。
--   登録済みの生要望の本文を編集できるようにする（誤記修正・内容の明確化）。編集は上書きだが、
--   edited_at を記録して「編集済み」を明示する（取消可能性 = 再編集で上書きできる = 原則9.5）。
--
-- 追加列のみ・NULL 許容 = 既存行は「未編集」として非破壊（原則7）。
-- 冪等: ADD COLUMN IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS edited_at timestamptz;
