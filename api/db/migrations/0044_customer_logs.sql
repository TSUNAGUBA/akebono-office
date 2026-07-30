-- 0044: 顧客ログ（顧客とのやり取りの記録。オペレーター指示 2026-07-30）。
-- 「いつ（何月何日・時刻は任意）どの顧客（会社/人）とどんな会話をしたか」を本人が記録し、AI の参照対象とする。
--
-- テーブル分類: **記録系（追記のみ・訂正は本人編集 + 監査ログ・取消は論理削除/復元 = 原則2/9.5）**。
--   日報・タスク計画と同じ「本人所有・本人のみ操作可」パターン（api/src/routes/task-plans.ts 参照）。
-- 可視性（F-16）: 本人の記録は常に参照可。他メンバーの記録は権限表
--   （resource='customer-log', field='member:<id>' の allow = 許可制・既定 deny = canViewMemberCustomerLog）
--   で参照可。機能自体は既定 allow（誰でも自分のログは記録・参照できる）。
--   AI 参照は本人スコープ（search-index の owner 限定 = 他メンバーのログを AI 文脈に供給しない安全側の既定）。
-- 機密度: C2（取引データ = 顧客とのやり取り）。
--
-- データ整合: company_id/contact_id は app_office のマスタへの ID 参照（記録系の紐付け）。
--   contact が company に属することは API 層で検証する（FK では表現できないため）。
--
-- 下位互換（原則7）: 新規テーブル追加 + search_docs.source_kind の許容値へ 'customer-log' 追加のみ。
--   既存データ・既存 I/F に影響しない。permission_rules はシードしない（既定 deny = コードレベルの許可制）。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS customer_logs (
  id          text PRIMARY KEY,
  member_id   text NOT NULL REFERENCES members(id),   -- 記録者（所有者）
  log_date    date NOT NULL,                          -- 何月何日（必須）
  log_time    text,                                   -- 時刻 HH:MM（任意・null 可）
  company_id  text NOT NULL REFERENCES companies(id), -- 顧客(会社)（必須）
  contact_id  text REFERENCES contacts(id),           -- 顧客(人)（任意。company_id に属する contact）
  title       text NOT NULL DEFAULT '',               -- 件名（任意。空なら会社名から導出表示）
  body        text NOT NULL,                          -- 会話内容（必須）
  active      boolean NOT NULL DEFAULT true,          -- 取消（論理削除）済みは false
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- 一覧は「本人 × 日付降順」が主経路（member_id 前方 + log_date DESC）。company/contact は逆引き用
CREATE INDEX IF NOT EXISTS idx_customer_logs_member ON customer_logs (member_id, log_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_customer_logs_company ON customer_logs (company_id);
CREATE INDEX IF NOT EXISTS idx_customer_logs_contact ON customer_logs (contact_id);

-- search_docs.source_kind の許容値へ 'customer-log' を追加（0021/0023/0027 と同じ CHECK 差し替え）。
-- owner_member_id 列（0023）・links 列（0024）は既存 = 追加不要
ALTER TABLE search_docs DROP CONSTRAINT search_docs_source_kind_check;
ALTER TABLE search_docs ADD CONSTRAINT search_docs_source_kind_check
  CHECK (source_kind IN ('company', 'contact', 'industry', 'knowledge', 'project', 'note', 'document', 'customer-log'));
