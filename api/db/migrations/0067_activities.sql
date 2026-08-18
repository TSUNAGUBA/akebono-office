-- 0067: 活動記録 3 種の新設（サポート活動 / 営業活動 / ビジネスパートナー活動。改修依頼 2026-08-18・F-43/F-44/F-45）。
--
-- テーブル分類: **記録系（チーム共有）**。顧客ログ（0044 = 本人所有・本人のみ操作可）と異なり、
--   対応状況をチームで引き継ぐ運用のため **全員が閲覧・登録・編集できる**（訂正履歴は監査ログで残す）。
--   取消は論理削除（active=false）+ 復元（原則2/9.5）。member_id は記録者（表示用）。
-- 可視性: 認証済み全員（機能キー support-activity / sales-activity / partner-activity の権限 deny でのみ制限）。
--   AI 検索インデックス（search_docs）へは供給しない（AI 参照範囲の拡大は別途の設計判断とする = 安全側）。
-- 機密度: C2（取引データ = 顧客・商談・パートナーとのやり取り）。
--
-- データ整合:
--   - company_id は companies マスタへの ID 参照（サポート/営業。コンボボックス新規登録は API 層の
--     resolveCompany = customer_logs と同一規則で名寄せ・新規登録する）。
--   - partner_activities のパートナー・関連企業は自由入力（パートナーは個人名も多く、関連企業は
--     顧客マスタ対象外の企業もあり得るためマスタ参照にしない設計判断）。
--   - related_sales_activity_id は営業活動への任意リンク（「案件化したら商談へリンク」）。FK で実在を担保。
--   - 区分値（種別・優先度・ステータス・フェーズ等）は shared/domain/types.ts のプリセットを
--     アプリ層（shared/domain/activity.ts）で検証する（0065 と同じ方針 = プリセット追加時に migration 不要）。
--
-- 下位互換（原則7）: 新規テーブル追加のみ。既存データ・既存 I/F に影響しない。
SET search_path TO app_office;

-- サポート活動（F-43）: 受付〜解決の記録
CREATE TABLE IF NOT EXISTS support_activities (
  id              text PRIMARY KEY,
  member_id       text NOT NULL REFERENCES members(id),   -- 記録者（表示用。編集は全員可）
  received_date   date NOT NULL,                          -- 受付日（必須）
  received_time   text,                                   -- 受付時刻 HH:MM（任意）
  company_id      text NOT NULL REFERENCES companies(id), -- 顧客(会社)（必須）
  inquirer_name   text NOT NULL DEFAULT '',               -- 問い合わせ者（自由入力・任意）
  target_system   text NOT NULL DEFAULT '',               -- 対象システム（自由入力・任意）
  category        text NOT NULL,                          -- 問い合わせ種別（操作/不具合/設定/データ/要望/その他）
  title           text NOT NULL,                          -- 件名（必須）
  body            text NOT NULL,                          -- 問い合わせ内容（必須）
  priority        text NOT NULL,                          -- 優先度（低/通常/高/緊急）
  status          text NOT NULL,                          -- ステータス（未対応/対応中/顧客確認待ち/保留/解決）
  staff_member_id text NOT NULL REFERENCES members(id),   -- 自社担当者（既定 = ログインユーザー）
  response        text NOT NULL DEFAULT '',               -- 対応内容
  cause           text NOT NULL DEFAULT '',               -- 原因
  resolution      text NOT NULL DEFAULT '',               -- 解決内容
  completed_date  date,                                   -- 完了日（任意）
  completed_time  text,                                   -- 完了時刻 HH:MM（任意。完了日がある場合のみ）
  knowledge_note  text NOT NULL DEFAULT '',               -- 改善・ナレッジのタネ
  active          boolean NOT NULL DEFAULT true,          -- 取消（論理削除）済みは false
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- 一覧は「受付日降順」が主経路。顧客・ステータスは絞り込み用
CREATE INDEX IF NOT EXISTS idx_support_activities_received ON support_activities (received_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_support_activities_company ON support_activities (company_id);
CREATE INDEX IF NOT EXISTS idx_support_activities_status ON support_activities (status);

-- 営業活動（F-44）: 商談の履歴と進捗
CREATE TABLE IF NOT EXISTS sales_activities (
  id                  text PRIMARY KEY,
  member_id           text NOT NULL REFERENCES members(id),   -- 記録者（表示用。編集は全員可）
  company_id          text NOT NULL REFERENCES companies(id), -- 顧客(会社)（必須）
  title               text NOT NULL,                          -- 商談名（必須）
  deal_type           text NOT NULL,                          -- 商談種別（新規/追加/更新）
  staff_member_id     text NOT NULL REFERENCES members(id),   -- 担当者（既定 = ログインユーザー）
  phase               text NOT NULL,                          -- 商談フェーズ（初回/ヒアリング/提案/見積/稟議/受注/失注）
  amount              bigint,                                 -- 商談金額（円・任意）
  probability         integer,                                -- 受注確度（%・0〜100・任意）
  expected_close_date date,                                   -- 受注予定日（任意）
  customer_issue      text NOT NULL DEFAULT '',               -- 顧客課題
  proposal            text NOT NULL DEFAULT '',               -- 提案概要
  next_action         text NOT NULL DEFAULT '',               -- Next Action
  next_action_date    date,                                   -- Next Action日（任意）
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- 一覧は「登録降順」（created_at）。顧客・フェーズは絞り込み用
CREATE INDEX IF NOT EXISTS idx_sales_activities_created ON sales_activities (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_sales_activities_company ON sales_activities (company_id);
CREATE INDEX IF NOT EXISTS idx_sales_activities_phase ON sales_activities (phase);

-- ビジネスパートナー活動（F-45）: パートナー連携のテーマ管理
CREATE TABLE IF NOT EXISTS partner_activities (
  id                        text PRIMARY KEY,
  member_id                 text NOT NULL REFERENCES members(id), -- 記録者（表示用。編集は全員可）
  partner_name              text NOT NULL,                        -- パートナー（自由入力・必須）
  theme                     text NOT NULL,                        -- テーマ名（必須）
  related_company           text NOT NULL DEFAULT '',             -- 関連企業（自由入力・任意）
  activity_type             text NOT NULL,                        -- 活動区分（紹介/共創/案件支援/情報交換/その他）
  status                    text NOT NULL,                        -- ステータス（情報収集/検討/接続予定/進行中/案件化/完了）
  summary                   text NOT NULL DEFAULT '',             -- 概要
  current_state             text NOT NULL DEFAULT '',             -- 現在状況
  next_action               text NOT NULL DEFAULT '',             -- Next Action
  next_action_date          date,                                 -- Next Action日（任意）
  staff_member_id           text NOT NULL REFERENCES members(id), -- 自社担当者（既定 = ログインユーザー）
  related_meeting           text NOT NULL DEFAULT '',             -- 関連MTG（自由入力）
  related_sales_activity_id text REFERENCES sales_activities(id), -- 関連商談（案件化したらリンク・任意）
  memo                      text NOT NULL DEFAULT '',             -- メモ
  active                    boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
-- 一覧は「登録降順」（created_at）。ステータス・関連商談は絞り込み/逆引き用
CREATE INDEX IF NOT EXISTS idx_partner_activities_created ON partner_activities (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_partner_activities_status ON partner_activities (status);
CREATE INDEX IF NOT EXISTS idx_partner_activities_sales ON partner_activities (related_sales_activity_id);
