-- 0087: 営業アプローチリスト（改善要望 2026-08-21・F-53）。
-- 顧客基本情報・顧客属性・顧客コンテキストを基に「アプローチする / している顧客」を 1社1行で管理する。
-- チーム共有（全員が閲覧・登録・編集可）・取消 = 論理削除（active）+ 復元（原則9.5）。
-- 表示に使う基本情報・属性・コンテキスト・活動実績は各 SoT（companies / customer_contexts /
-- customer_logs 等）からのライブ参照とし、本テーブルはアプローチの状態・方針のみを持つ（原則6）。
--
-- 冪等: CREATE TABLE IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS sales_approaches (
  id                text PRIMARY KEY,
  member_id         text NOT NULL REFERENCES members(id),
  company_id        text NOT NULL REFERENCES companies(id),
  status            text NOT NULL,
  priority          text NOT NULL,
  assignee_member_id text NOT NULL REFERENCES members(id),
  next_action       text NOT NULL DEFAULT '',
  next_action_date  date,
  note              text NOT NULL DEFAULT '',
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- 1社1行（取消済みも含めて 1 行 = 復元で重複しない。再登録は取消済み行の復元・編集で行う）
  CONSTRAINT sales_approaches_company_unique UNIQUE (company_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_approaches_status ON sales_approaches (status, priority);
