-- 0076: 顧客コンテキスト（改修依頼 2026-08-20: トップ層メニュー「顧客コンテキスト」）。
--
-- テーブル分類:
--   - customer_contexts: **設定系（チーム共有）**。顧客(会社)ごとの定性情報（ビジョン・経営課題・補足メモ）を
--     1社1行（company_id UNIQUE）で保持し、全員が閲覧・上書き更新できる（upsert）。更新履歴は監査ログ +
--     AI リサーチ反映時の research ノート（下記）が担う。updated_by_* は最終更新者のスナップショット。
--   - customer_context_notes: **記録系（チーム共有）**。顧客に紐づく時系列メモ（Memo）。追記のみ・編集なし。
--     取消は論理取消（archived_at に取消日時をセット。NULL = 有効）+ 復元（原則2/9.5）。
--     kind='research' は AI リサーチ反映の自動追記で、payload に採用ソース一覧と**反映前の定性情報**
--     （before）を保存する =「反映を取り消す」の復元元。反映取消はノートを archive せず
--     payload.revertedAt の追記で表す（監査可能な取消 = 原則9.5）。
-- 可視性: 認証済み全員（機能キー customer-context の権限 deny でのみ制限 = PATH_FEATURES）。
-- 機密度: C3 相当（経営課題・戦略メモ = 顧客の内部情報）。AI 検索インデックス（search_docs）へは
--   供給しない（0067/0074 と同じ安全側の設計判断）。
--
-- データ整合:
--   - company_id は companies への FK（UNIQUE = 1社1行）。ON DELETE は既定（NO ACTION = 物理削除拒否）。
--     会社は論理削除（active=false）運用で物理削除経路が無く、記録保護のため CASCADE は採用しない
--     （0074 と同じ設計判断）。
--   - 定量情報（案件件数・活動件数等）は保存しない。SoT は各記録系テーブルで、画面がライブ導出する。
--   - payload（jsonb）の形は shared/domain/types.ts の CustomerContextNotePayload が SoT。
--
-- 下位互換（原則7）: 新テーブルの追加のみ・既存データ非破壊（データ更新パッチ不要）。
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

-- 顧客コンテキスト（定性情報。1社1行の upsert）
CREATE TABLE IF NOT EXISTS customer_contexts (
  id                   text PRIMARY KEY,
  company_id           text NOT NULL UNIQUE REFERENCES companies(id), -- 顧客(会社)。1社1行
  vision               text NOT NULL DEFAULT '',                      -- ビジョン
  challenges           text NOT NULL DEFAULT '',                      -- 経営課題（改行区切りの箇条書き可）
  strategy_notes       text NOT NULL DEFAULT '',                      -- 補足メモ（戦略メモ等）
  updated_by_member_id text NOT NULL DEFAULT '',                      -- 最終更新者（Member 参照）
  updated_by_name      text NOT NULL DEFAULT '',                      -- 最終更新者名スナップショット（表示用）
  active               boolean NOT NULL DEFAULT true,                 -- 将来の論理削除用（現行 UI は常に true）
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- 顧客コンテキストメモ（時系列メモ + AI リサーチの自動追記）
CREATE TABLE IF NOT EXISTS customer_context_notes (
  id          text PRIMARY KEY,
  company_id  text NOT NULL REFERENCES companies(id),                 -- 対象の顧客(会社)
  member_id   text NOT NULL REFERENCES members(id),                   -- 記録者（表示用。取消は全員可）
  member_name text NOT NULL DEFAULT '',                               -- 記録者名スナップショット（表示用）
  kind        text NOT NULL DEFAULT 'note' CHECK (kind IN ('note','research')),
  body        text NOT NULL,                                          -- メモ本文（必須）
  payload     jsonb,                                                  -- research: { sources, before, revertedAt? }
  archived_at timestamptz,                                            -- 取消（論理削除）日時。NULL = 有効
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 一覧は「会社内の新しい順」が主経路（20件/ページ）
CREATE INDEX IF NOT EXISTS idx_customer_context_notes_company ON customer_context_notes (company_id, created_at DESC);
