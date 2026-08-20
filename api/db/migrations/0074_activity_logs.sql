-- 0074: 営業活動・ビジネスパートナー活動を「案件ヘッダー + 活動ログ」構造へ再編（改修依頼 2026-08-20）。
--
-- テーブル分類: **記録系（チーム共有）**。0067 の活動記録と同じく、対応状況をチームで引き継ぐ運用のため
--   **全員が閲覧・登録・編集できる**（訂正履歴は監査ログで残す）。取消は論理削除（active=false）+ 復元（原則2/9.5）。
--   member_id は記録者（表示用）。member_name は表示用スナップショット。
-- 可視性: 認証済み全員（機能キー sales-activity / partner-activity の権限 deny でのみ制限 = 親案件と同一）。
--   AI 検索インデックス（search_docs）へは供給しない（0067 と同じ安全側の設計判断）。
-- 機密度: C2（取引データ = 顧客・商談・パートナーとのやり取り）。
--
-- データ整合:
--   - activity_id は親案件（sales_activities / partner_activities）への FK。ON DELETE は既定（NO ACTION =
--     物理削除を拒否）とする。親は論理削除（active=false）運用で物理削除経路が無く、記録保護のため
--     CASCADE は採用しない設計判断（誤った物理削除でログが道連れにならない）。
--   - 区分値（活動種別 = 訪問/電話/Web会議/メール/その他）は shared/domain/types.ts の ACTIVITY_LOG_KINDS を
--     アプリ層（shared/domain/activity.ts の activityLogError）で検証する（プリセット追加時に migration 不要）。
--   - ai_digest は活動ログの時系列集約（導出キャッシュ。「生成→保管→再生成で上書き」）。SoT はログで、
--     ai_digest はログから常に再生成できる（NULL = 未生成）。
--
-- 下位互換（原則7）: 既存の sales_activities / partner_activities 行はそのまま「案件ヘッダー」として再解釈する
--   （列の追加のみ・NULL 許容 or 既定値あり = 既存行は非破壊・データ更新パッチ不要）。
--   partner_activities.initiatives（取組内容）は新設列（既定 ''）。「概要」→「背景・目的」は表示ラベルのみの
--   変更で列名 summary は維持する。
-- 冪等: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

-- 営業活動の活動ログ
CREATE TABLE IF NOT EXISTS sales_activity_logs (
  id               text PRIMARY KEY,
  activity_id      text NOT NULL REFERENCES sales_activities(id), -- 親案件（営業活動）
  member_id        text NOT NULL REFERENCES members(id),          -- 記録者（表示用。編集は全員可）
  member_name      text NOT NULL DEFAULT '',                      -- 記録者名スナップショット（表示用）
  logged_on        date NOT NULL,                                 -- 活動日（必須）
  kind             text NOT NULL,                                 -- 活動種別（訪問/電話/Web会議/メール/その他）
  title            text NOT NULL,                                 -- 件名（必須）
  body             text NOT NULL DEFAULT '',                      -- 内容
  next_action      text NOT NULL DEFAULT '',                      -- Next Action
  next_action_date date,                                          -- Next Action日（任意）
  links            jsonb NOT NULL DEFAULT '[]'::jsonb,            -- 参考リンク URL 配列
  active           boolean NOT NULL DEFAULT true,                 -- 取消（論理削除）済みは false
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- 一覧は「案件内の活動日降順・登録降順」が主経路（20件/ページのサーバーページング）
CREATE INDEX IF NOT EXISTS idx_sales_activity_logs_activity ON sales_activity_logs (activity_id, logged_on DESC, created_at DESC);

-- ビジネスパートナー活動の活動ログ（営業側と同一構造 = 内部処理は資源名パラメタ化で共通実装・原則3）
CREATE TABLE IF NOT EXISTS partner_activity_logs (
  id               text PRIMARY KEY,
  activity_id      text NOT NULL REFERENCES partner_activities(id), -- 親案件（ビジネスパートナー活動）
  member_id        text NOT NULL REFERENCES members(id),            -- 記録者（表示用。編集は全員可）
  member_name      text NOT NULL DEFAULT '',                        -- 記録者名スナップショット（表示用）
  logged_on        date NOT NULL,                                   -- 活動日（必須）
  kind             text NOT NULL,                                   -- 活動種別（訪問/電話/Web会議/メール/その他）
  title            text NOT NULL,                                   -- 件名（必須）
  body             text NOT NULL DEFAULT '',                        -- 内容
  next_action      text NOT NULL DEFAULT '',                        -- Next Action
  next_action_date date,                                            -- Next Action日（任意）
  links            jsonb NOT NULL DEFAULT '[]'::jsonb,              -- 参考リンク URL 配列
  active           boolean NOT NULL DEFAULT true,                   -- 取消（論理削除）済みは false
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_activity_logs_activity ON partner_activity_logs (activity_id, logged_on DESC, created_at DESC);

-- 案件ヘッダーへの追加列（追加列のみ・NULL 許容 or 既定値あり = 既存行は非破壊・原則7）
-- ai_digest: 活動ログの AI集約（jsonb: { summary, highlights?, generatedAt, logCount, llm }。NULL = 未生成）
ALTER TABLE sales_activities ADD COLUMN IF NOT EXISTS ai_digest jsonb;
ALTER TABLE partner_activities ADD COLUMN IF NOT EXISTS ai_digest jsonb;
-- BP のみ: 取組内容（改修依頼 2026-08-20。「背景・目的」= 旧「概要」= summary 列はラベル変更のみ）
ALTER TABLE partner_activities ADD COLUMN IF NOT EXISTS initiatives text NOT NULL DEFAULT '';
