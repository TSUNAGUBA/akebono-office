-- 0080: 受付箱・改修案件のステータス管理再編（改修依頼 2026-08-21）。
-- 受付箱（improvement_requests）が一次のライフサイクルを持つ:
--   未確認（unconfirmed = 起票時の初期値）→ 検討中（reviewing）→
--   改善対応（planned = AI 集約の対象）/ 運用対応（operational = 起票者へ運用案内を通知）/
--   継続検討（deferred = 再検討日必須・到来でリマインド）/ 対応見送り（dismissed）。
--   集約済み要望の「改善対応/対応済み」は保存せず集約先 item から導出する（原則6。SoT =
--   shared/domain/improvement.ts の improvementInboxStatusOf）。
--   「解決済み」は resolved_at（解決の記録 = オーバーレイ）で表し、基底ステータスを上書きしない
--   （解決の取消で元の状態へ戻せる = 原則9.5）。
-- 改修案件（improvement_items）は 未対応（todo）→ 対応中（in_progress・担当者アサイン可）→
--   対応済（done）の 3 状態へ再編。値の SoT は shared/domain/improvement.ts。
-- 下位互換（原則7）: 旧語彙（requests: open/resolved/dismissed・items: triage/accepted/operational/
--   deferred/resolved/rejected）はそのまま許容 = 既存行は無変更。表示・遷移判定は shared の
--   読替え関数（improvementInboxStatusOf / improvementItemViewOf）が新語彙へ正規化する
--   （0073 の「保存値不変・ラベルのみ変更」と同方式。データ更新パッチは不要）。
-- 冪等: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT / ADD COLUMN IF NOT EXISTS /
--   CREATE INDEX IF NOT EXISTS（再実行しても既存データは変化しない = 原則2）。
SET search_path TO app_office;

-- 受付箱: ステータス語彙の拡張（旧 3 値 + 新 5 基底値。addressed/解決済みは保存しない = 導出・記録）
ALTER TABLE improvement_requests DROP CONSTRAINT IF EXISTS improvement_requests_status_check;
ALTER TABLE improvement_requests ADD CONSTRAINT improvement_requests_status_check
  CHECK (status IN ('open', 'resolved', 'dismissed', 'unconfirmed', 'reviewing', 'planned', 'operational', 'deferred'));
-- 新規投稿の初期ステータスは「未確認」（既存行の 'open' は読替えで補完 = 原則7）
ALTER TABLE improvement_requests ALTER COLUMN status SET DEFAULT 'unconfirmed';

-- 継続検討の再検討日（deferred への遷移で必須）+ リマインドの直近通知日
-- （多重通知防止。deferred への再遷移で NULL に戻し新しい期日で再通知 = improvement_items 0073 と同型）
ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS revisit_on date;
ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS revisit_notified_on date;
-- 解決済みの記録（起票者確認 or 管理者操作。NULL = 未解決。取消で NULL へ戻す = 原則9.5）
ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

-- 再検討日の到来チェック（runImprovementRevisitReminders の日次スキャン）を効かせる部分索引
CREATE INDEX IF NOT EXISTS improvement_requests_revisit_idx
  ON improvement_requests (revisit_on) WHERE status = 'deferred' AND archived_at IS NULL;

-- 改修案件: 3 状態語彙の追加（旧 7 値は既存データとして受理）+ 担当者（対応中でアサイン可）
ALTER TABLE improvement_items DROP CONSTRAINT IF EXISTS improvement_items_status_check;
ALTER TABLE improvement_items ADD CONSTRAINT improvement_items_status_check
  CHECK (status IN ('todo', 'in_progress', 'done', 'triage', 'accepted', 'operational', 'deferred', 'resolved', 'rejected'));
-- 新規作成（AI 集約）の初期ステータスは「未対応」（既存行の 'triage' は読替えで未対応扱い = 原則7）
ALTER TABLE improvement_items ALTER COLUMN status SET DEFAULT 'todo';
ALTER TABLE improvement_items ADD COLUMN IF NOT EXISTS assignee_member_id text;
ALTER TABLE improvement_items ADD COLUMN IF NOT EXISTS assignee_name text NOT NULL DEFAULT '';
