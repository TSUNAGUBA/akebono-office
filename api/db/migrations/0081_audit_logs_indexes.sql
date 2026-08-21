-- 0081: 監査ログの参照インデックス（設定画面の監査ログタブ = サーバーページング + フィルタ対応。改修 2026-08-21）。
-- GET /v1/configs/audit-logs の ORDER BY id DESC + 期間絞り込み（at）・操作ユーザー絞り込み（actor_id）を想定した
-- 参照専用インデックス。entity 系は既存の audit_logs_entity_idx（0001）が担う。
-- IF NOT EXISTS で冪等・既存データ非破壊（インデックス追加のみ = 原則2/7）
SET search_path TO app_office;

CREATE INDEX IF NOT EXISTS audit_logs_at_idx ON audit_logs (at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_id);
