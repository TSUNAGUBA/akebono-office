-- バッチ6b: 売上管理（F-15）+ mart ETL 基盤
-- sales_monthly は月次実績データ（SoT）。冪等キー = month × company × project_type の UNIQUE で
-- 管理者の登録/取込を upsert 化する（何度実行しても壊れない = 原則2）。
-- モックの buildSalesMonthly() シードは投入しない（マスタではなく実績データのため。
-- decision_themes 0011 / ai_roles 0015 の「マスタ初期値シード」とは区別する設計判断）。
--
-- fact_sales / mart_load_runs は mart 互換の派生テーブル（オペレーター判断 2026-07-18:
-- akebono-scm-platform の mart へ直接書かず、app_office 内に mart 規約準拠の形で持つ。
-- 将来 mart 本体へ接続する際はテーブルごと移送 / ETL 先の切替のみで済む形にする）。
-- 規約準拠: tenant_key 先頭列 / dim_date_key int (yyyymmdd) / 冪等キー UNIQUE(tenant_key, source_txn_id) /
-- 会計期 fiscal_* は自社 fiscal_start_month から非正規化 / 監査列 load_run_id, created_at。
-- customer_company_id / project_type は dim_party / dim_product 接続前の退化キー（一方向 ETL・逆流禁止）。

CREATE TABLE IF NOT EXISTS sales_monthly (
  id           text PRIMARY KEY,
  month        text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'), -- YYYY-MM
  company_id   text NOT NULL REFERENCES companies(id),
  project_type text NOT NULL
    CHECK (project_type IN ('biz_consulting','sys_consulting','development','operation','internal')),
  amount       bigint NOT NULL CHECK (amount >= 0), -- 売上（円）
  cost         bigint NOT NULL CHECK (cost >= 0),   -- 原価（円）
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, company_id, project_type)
);
CREATE INDEX IF NOT EXISTS idx_sales_monthly_month ON sales_monthly (month);

CREATE TABLE IF NOT EXISTS fact_sales (
  tenant_key          text NOT NULL,
  source_txn_id       text NOT NULL, -- = sales_monthly.id（一方向 ETL の冪等キー）
  dim_date_key        int NOT NULL,  -- yyyymmdd（月次グレインのため月初日）
  customer_company_id text NOT NULL, -- dim_party 接続前の退化キー（companies.id）
  project_type        text NOT NULL, -- dim_product 接続前の退化キー
  amount              bigint NOT NULL,
  cost                bigint NOT NULL,
  margin              bigint NOT NULL, -- amount - cost（ETL が導出）
  fiscal_year         int NOT NULL,    -- 自社 fiscal_start_month から非正規化（開始年の西暦）
  fiscal_quarter      int NOT NULL,
  fiscal_month        int NOT NULL,    -- 会計年度内の月序数（開始月 = 1）
  load_run_id         text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_key, source_txn_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_sales_date ON fact_sales (tenant_key, dim_date_key);

-- ETL 実行の監査（load_run_id の発行元。記録系 = 追記のみ）
CREATE TABLE IF NOT EXISTS mart_load_runs (
  id          text PRIMARY KEY,
  target      text NOT NULL, -- 'fact_sales' 等
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
  rows_loaded int NOT NULL DEFAULT 0,
  message     text NOT NULL DEFAULT '',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
