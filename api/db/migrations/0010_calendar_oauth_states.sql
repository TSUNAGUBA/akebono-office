-- 0010: OAuth フローの state ノンス（一回性 + 有効期限。レビュー指摘: アカウントリンク CSRF 対策）
-- コールバックで消費（DELETE）し、10 分超の未消費行は次回発行時に掃除する
SET search_path TO app_office;

CREATE TABLE calendar_oauth_states (
  nonce      text PRIMARY KEY,
  member_id  text NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
