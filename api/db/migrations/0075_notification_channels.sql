-- 0075: 個人別マルチチャネル通知連携（Slack / Google Chat。改修依頼 2026-08-20）。
--
-- - user_chat_links: ユーザーごとの外部チャット連携トークン（機密度 C3 相当）。
--   トークンは AES-256-GCM（lib/crypto encryptSecret）で暗号化保管し、クライアントへは一切出さない。
--   SoT 上の注記: トークンは Slack / Google の発行物であり、喪失時（鍵ローテーション含む）は
--   再連携で再取得できる（バックアップ対象外の設計判断 = calendar_tokens 0009 と同型）。
--   status: 'connected' → 配信時に 401 等の失効を検知すると 'reauth_required' へ遷移し、
--   アプリ内通知で再連携を催促する（再連携で 'connected' へ戻る）。
--   取消フロー（原則9.5）: 連携解除 = 行の物理削除。再連携でいつでも復元できるため論理削除にしない
--   （失効トークンを保持し続ける方が漏えいリスク）。
-- - chat_oauth_states: OAuth state ノンス（アカウントリンク CSRF 対策）。一回性 = 消費時に DELETE、
--   10 分 TTL は SELECT（消費）時に判定する（calendar_oauth_states と同型 = 原則3）。
-- - 通知マトリクス（通知種別 × チャネルの ON/OFF）は新テーブルを作らず、既存の user_preferences
--   （0039 = per-user 設定の SoT）キー 'notificationChannels' に JSON で保存する（設計判断:
--   1 ユーザー 1 値の軽量な設定系データであり、既存の 4KB/100 キー制限内に収まる。原則3）。
--
-- 追加のみ・既存データ非破壊（原則7）。冪等（IF NOT EXISTS。原則2）。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS user_chat_links (
  member_id         text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  service           text NOT NULL CHECK (service IN ('slack','google_chat')),
  external_user_id  text NOT NULL DEFAULT '',   -- Slack = authed_user.id（DM 宛先）/ Google = id_token の sub
  display_name      text NOT NULL DEFAULT '',   -- 連携済みアカウント名（UI 表示用。Slack = チーム/ユーザー名・Google = メール）
  access_token_enc  text NOT NULL DEFAULT '',   -- AES-256-GCM 暗号化（平文は保存しない）
  refresh_token_enc text NOT NULL DEFAULT '',   -- Google のみ（Slack のユーザートークンは無期限 = 空）
  status            text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','reauth_required')),
  expires_at        timestamptz,                -- アクセストークンの期限（Slack は NULL = 無期限）
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, service)
);

CREATE TABLE IF NOT EXISTS chat_oauth_states (
  state      text PRIMARY KEY,
  member_id  text NOT NULL,
  service    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
