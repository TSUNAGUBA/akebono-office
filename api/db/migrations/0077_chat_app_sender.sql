-- 0077: 通知の AKEBONO HOME 名義化（オペレーター指示 2026-08-20: Slack / Google Chat の通知 DM を
--       本人名義ではなくアプリ「AKEBONO HOME」名義で送る）。
--
-- 方式変更: 個人 OAuth トークン（user token）による本人名義送信 → テナント単位の資格情報
-- （Slack Bot Token / Google Chat アプリのサービスアカウント。いずれも Secret Manager 経由の env）
-- によるアプリ名義送信へ。user_chat_links は「宛先解決のキャッシュ」へ役割を縮小する。
--
-- - dm_target: 解決済みの DM 宛先（Slack = DM チャンネル id（D…）/ Google Chat = スペース名（spaces/…））。
--   空 = 未解決。連携時に解決して保存し、送信時に空なら自己修復（解決して UPDATE）する。
-- - external_user_id の意味は維持: Slack = ユーザー id（U…。旧行と互換）/
--   Google = users/{...} に渡す識別子（旧行 = id_token の sub / 新行 = members.email。どちらも有効）。
--
-- データパッチ（原則7: 方式変更に伴う既存データの扱いを migration 内で完結・文書化）:
-- - 個人 OAuth トークンは廃止のため消去する（失効トークンの保持は漏えいリスクのみで復元価値なし。
--   行自体は保持して連携状態を守る = 原則2。宛先は送信時にテナント資格情報で自己修復する —
--   Slack は再操作不要・Google Chat は DM スペース自動作成が通らない環境では「アプリへ一度 DM」を
--   エラーメッセージで案内する = deploy-guide §1-12 トラブルシュート）
-- - status='reauth_required'（個人トークンの失効概念）は 'connected' へ戻す（新方式に失効概念はない。
--   認証エラーはテナント資格情報の不備 = 管理者側の問題であり、ユーザー行の状態にしない）
-- - chat_oauth_states（OAuth state ノンス）は使用停止。テーブルは破壊しない（残置。行は最大 10 分で陳腐化する
--   一時データのみ）
--
-- 冪等（IF NOT EXISTS / WHERE ガード。原則2）。
SET search_path TO app_office;

ALTER TABLE user_chat_links ADD COLUMN IF NOT EXISTS dm_target text NOT NULL DEFAULT '';

UPDATE user_chat_links
   SET access_token_enc = '', refresh_token_enc = '', expires_at = NULL,
       status = 'connected', updated_at = now()
 WHERE access_token_enc <> '' OR refresh_token_enc <> ''
    OR expires_at IS NOT NULL OR status <> 'connected';

-- OAuth フロー廃止に伴い、消費者のいなくなった state ノンスを掃除する（一回性ノンスに復元価値なし。
-- テーブル自体は残置 = 破壊しない）
DELETE FROM chat_oauth_states;
