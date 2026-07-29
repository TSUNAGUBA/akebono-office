-- 0035: データ取込・連携（F-32）の API 永続化（Phase D。オペレーター指示「設定・実データの本実装」第 3 弾 = 最終フェーズ）。
-- 従来 localStorage + 日次リシードのモックコレクション（importSources / importMappings / importRuns）を
-- API（PostgreSQL）へ移行し、API モードで「翌日消える取込設定・実行履歴」を解消する。
--
-- データ 3 分類（akebono-menu-design §3.1 と同基準）:
-- - 設定系（更新可・論理削除で取消 = 原則9.5）: import_sources（取込元）
-- - 設定系/版管理（追記で新版・旧版は superseded = 上書きせず履歴を残す）: import_mappings（項目マッピング）
-- - 記録系（追記のみ・訂正しない = 実行履歴の監査性）: import_runs（取込実行履歴）
-- SoT は本テーブル群（取込設定・実行履歴の正）。
--
-- 実データ方針: **シードしない**（akebono_wishes / sales_records / media_articles と同方針 =
-- 架空の取込元・実行履歴でオペレーターを誤誘導しない）。画面は空状態の導線を持つ。
--
-- FK を張らない判断（0032 と同判断・data-design §1.6）: import_mappings.source_id /
-- import_runs.source_id の参照整合は API 書込パスの存在検証（requireSource）で担保する。
-- 取込元は論理削除（active=false）のみ = 物理削除で孤児参照が生じる経路が無い。
--
-- 取込実行（run）の位置づけ: 本フェーズは**取込設定・実行履歴の永続化**が目的（localStorage 依存の解消）。
-- ステージング → 検証 → 反映の各カウント・隔離行はサーバーが決定的にシミュレートして記録する
-- （モック useAkebonoImports.runImport と同じ位置づけ。実ファイル取込・パース・SSRF 対策付き API 接続の
-- 本実装は F-32 の後続スコープ = implementation-status §40 残課題に明記）。
SET search_path TO app_office;

-- 取込元（設定系・CRUD・論理削除で取消 = 原則9.5）。
-- method = 取込方式 / encoding = 応答/ファイルの文字コード / target_entity = 反映先エンティティ
CREATE TABLE IF NOT EXISTS import_sources (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  method        text NOT NULL CHECK (method IN ('file_csv','file_fixed','file_json','api_pull')),
  encoding      text NOT NULL DEFAULT 'utf8' CHECK (encoding IN ('utf8','sjis')),
  target_entity text NOT NULL CHECK (target_entity IN ('product','sku','company','sales_record','inventory')),
  schedule      text NOT NULL DEFAULT 'manual' CHECK (schedule IN ('manual','daily')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 項目マッピング（設定系・版管理）。新版を追記し既存 active は superseded へ = 上書きせず履歴を残す
-- （AI 候補 + 人が確定の想定。fields = { id, sourceField, targetItemKey, transform }[] を jsonb で保持）。
-- 取込元ごとに version は連番・(source_id, version) 一意。有効版は取込元あたり 1 つ（部分一意 INDEX）
CREATE TABLE IF NOT EXISTS import_mappings (
  id         text PRIMARY KEY,
  source_id  text NOT NULL,
  version    int NOT NULL CHECK (version > 0),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','superseded')),
  fields     jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version)
);
-- 有効なマッピング版は取込元あたり最大 1（saveMapping は「旧版を superseded → 新版を active」の順で
-- 更新するため文単位検査でも衝突しない。並行 saveMapping の二重 active を防ぐ最終防衛 = C-1 と同思想）
CREATE UNIQUE INDEX IF NOT EXISTS import_mappings_active_idx
  ON import_mappings (source_id) WHERE status = 'active';

-- 取込実行履歴（記録系・追記のみ）。counts = { staged, applied, skipped, failed }・
-- errors = { rowNo, rawText, message }[] を jsonb で保持。訂正・削除はしない（監査性）
CREATE TABLE IF NOT EXISTS import_runs (
  id             text PRIMARY KEY,
  code           text NOT NULL,
  source_id      text NOT NULL,
  mapping_version int NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  status         text NOT NULL CHECK (status IN ('staged','validated','applied','failed','reverted')),
  counts         jsonb NOT NULL DEFAULT '{}',
  errors         jsonb NOT NULL DEFAULT '[]',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_runs_source_started_idx ON import_runs (source_id, started_at DESC);
