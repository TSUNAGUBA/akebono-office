-- 0083: 生要望コメントの種別（kind）。運用案内（/requests/:id/status の operational 遷移で自動記録）と
-- 手動コメントを区別する = 起票者本人への開示（R2 監査で追加した運用案内の本人取得）を kind='ops' に
-- 限定し、管理者が「運用案内: 」で始まる手動コメント（既存案内をコピーした改訂草稿の検討など）を
-- 書いても本人へ漏れない（R3 監査 2026-08-21 = 接頭辞照合の開示境界を厳密化）。
-- 既定 'comment' = 既存行は全て手動コメント扱い（運用案内の自動記録は本改修（0080）で新設のため、
-- 旧データに ops 相当の行は存在しない = バックフィル不要・既存行無変更 = 原則7）。
-- IF NOT EXISTS で冪等（原則2）
SET search_path TO app_office;

ALTER TABLE improvement_request_comments
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'comment'
  CHECK (kind IN ('ops', 'comment'));
