-- 0047: 日報・週報の既読管理 + 顧客ログの項目拡張（オペレーター指示 2026-07-31）。
--
-- (1) report_reads: 「全員の日報」「全員の週報」の既読/未読の可視化（SoT = 本テーブル）。
--   テーブル分類: **閲覧状態（記録系の業務データではない）**。閲覧者 × 対象レポートごとに 1 行。
--   read_at は初回既読時刻を保持（再読・再実行で更新しない = ON CONFLICT DO NOTHING = 原則2）。
--   「未読に戻す」は行の物理削除（業務記録ではない閲覧状態のため、監査ログなしの取消で足りる = 原則9.5）。
--   report_id は daily_reports / weekly_reports の 2 親を report_kind で切り替えて指すため FK は張らない
--   （参照整合は API 層が対象の存在・参照可否を検証してから INSERT する）。
--
-- (2) customer_logs の項目拡張:
--   - end_time: 終了時刻（任意。log_time = 開始時刻がある場合のみ・開始より後 = API 層検証）
--   - tags: 属性タグ（商談/取材/イベント等。プリセット + 自由入力 = shared CUSTOMER_LOG_TAG_PRESETS）
--   - staff_member_id: 自社の担当者（既定 = 記録者。既存行は member_id で埋める = 原則7 のデータ更新パッチ）
--   - minutes_memo: 議事録メモ（旧「会話内容」body は「担当者メモ」として継続 = 既存データ無変更で下位互換）
--
-- 下位互換（原則7）: 追加列のみ・既存列の意味変更なし。既存データは
--   「開始時刻 = 旧時刻 / タグなし / 自社担当者 = 記録者 / 議事録メモ = 空」として自然に読める。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS report_reads (
  member_id   text NOT NULL REFERENCES members(id), -- 閲覧者（既読を付けた本人）
  report_kind text NOT NULL CHECK (report_kind IN ('daily', 'weekly')),
  report_id   text NOT NULL,                        -- daily_reports.id / weekly_reports.id（kind で切替）
  read_at     timestamptz NOT NULL DEFAULT now(),   -- 初回既読時刻（再読で更新しない）
  PRIMARY KEY (member_id, report_kind, report_id)
);
-- 一覧は「本人 × 種別」で対象期間のレポート id 群と突き合わせる（PK 前方一致で足りるが明示）
CREATE INDEX IF NOT EXISTS idx_report_reads_member_kind ON report_reads (member_id, report_kind);

ALTER TABLE customer_logs ADD COLUMN IF NOT EXISTS end_time text;
ALTER TABLE customer_logs ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE customer_logs ADD COLUMN IF NOT EXISTS staff_member_id text REFERENCES members(id);
ALTER TABLE customer_logs ADD COLUMN IF NOT EXISTS minutes_memo text NOT NULL DEFAULT '';

-- 既存行の自社担当者を記録者で埋める（既定 = ログインユーザー（記録者）の遡及適用。冪等）
UPDATE customer_logs SET staff_member_id = member_id WHERE staff_member_id IS NULL;
ALTER TABLE customer_logs ALTER COLUMN staff_member_id SET NOT NULL;
