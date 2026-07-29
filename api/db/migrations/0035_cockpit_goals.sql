-- 0035: ダッシュボード・コックピット（F-01 改訂 = cockpit-design.md §2）のデータモデル変更。
-- ① members.segment_ids: 人×事業セグメント紐付け（事業計器の出し分け）。
--    空配列 = 未設定 = 従来どおり業態スイッチャの選択に従う（任意フィールドの追加のみ = 下位互換。原則7。
--    既存行は DEFAULT '[]' で埋まるためデータパッチ不要）
-- ② goals: 目標マスタ（業態売上 / 日報提出率の月次目標。着地予報の基準値。汎用マスタ CRUD = registry 'goals'）
--    初期データは投入しない（0002 の「デモデータは投入しない」原則。goals が空でも予報層は
--    「目標未設定」+ /masters/goals への導線へフォールバックする = cockpit-design §2.2）
SET search_path TO app_office;

ALTER TABLE members ADD COLUMN IF NOT EXISTS segment_ids jsonb NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS goals (
  id            text PRIMARY KEY,
  metric        text NOT NULL CHECK (metric IN ('segment_sales','report_rate')),
  -- metric='segment_sales' のとき対象業態（business_segments 参照だがデモシード互換のため FK なし = 0031 の判断に従う）。
  -- 'report_rate' は NULL（全社）
  segment_id    text,
  -- 月次目標値。segment_sales = 円 / report_rate = %（0-100。値域は registry の zod が担保）
  monthly_value numeric NOT NULL DEFAULT 0 CHECK (monthly_value >= 0),
  note          text NOT NULL DEFAULT '',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
