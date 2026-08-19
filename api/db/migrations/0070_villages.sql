-- 0070: 事業区分（Village）マスタ（改修依頼 2026-08-19 第4弾）。
--   社内事業の区分を表す最小マスタ（name + display_order + active）。活動記録の最上段で参照し、
--   フォームの自由入力で新規登録もできる（会社/担当と同じ「照合 → なければ作成」パターン）。
--   マスタメンテナンス（/masters/villages）からも新規登録・編集できる（industries と同型）。
--
-- 冪等: CREATE TABLE IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS villages (
  id text PRIMARY KEY,
  name text NOT NULL,
  display_order integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
