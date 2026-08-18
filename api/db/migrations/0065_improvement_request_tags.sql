-- 0065: 要望（improvement_requests）の任意タグ + 集約解除の除外元（F-42-17/19・改修依頼 2026-08-18）。
-- tags … 投稿時に「壁打ち」（brainstorm = 壁打ちを経て案件化したい意思表示）「お任せ」（entrust = 受け取った
--   内容を開発側の解釈で進めてよい）を任意で複数付与できる。値の allowlist は
--   shared/domain/improvement.ts の normalizeImprovementTags（API 書込パスで正規化 = 0057 と同じ
--   「FK/CHECK ではなくアプリ層で担保」の方針）。既存データは '[]' = タグ無し（下位互換 = 原則7）。
-- excluded_item_ids … 「集約の解除」（POST /requests/:id/uncluster）で外した改修単位 id の履歴（jsonb 配列）。
--   次回以降の AI 集約でこれらの item へは再追記しない（解除した要望が同じ単位へ戻り detail が
--   重複する + 元 item に残した「対象外」メモと矛盾する再流入を防ぐ。履歴は蓄積 = クリアしない
--   ため二重解除でも過去の item へ戻らない）。'[]' = 制約なし（既存データ互換 = 原則7）。
-- 冪等: ADD COLUMN IF NOT EXISTS（再実行しても既存データは変化しない = 原則2）。
SET search_path TO app_office;

ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]';
ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS excluded_item_ids jsonb NOT NULL DEFAULT '[]';
