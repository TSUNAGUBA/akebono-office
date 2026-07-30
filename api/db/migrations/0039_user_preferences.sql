-- 0039: ユーザー単位の UI 設定（端末間で同期する個人設定）。
-- オペレーター指示 2026-07-30:「どの端末からログインしても同じ状態で閲覧できるように DB へ永続化する」。
--
-- 背景: これまで「現在の業態（currentSegment）」は端末ローカル（localStorage = ako.currentSegment.v1）
--   にのみ保存しており、端末を変えると先頭業態へ戻っていた（implementation-status §40-5 の設計判断を本指示で上書き）。
--   カレンダー同期対象の選択（0022 = calendar_tokens.selected_calendar_ids）と同じく「per-user の選択状態を
--   サーバー保管して端末間同期する」方針へ揃える。
--
-- テーブル分類: **設定系（per-user）**。app_configs（0001 = テナント全体の key-value 設定）の
--   ユーザースコープ版（原則3 = 既存パターンの再利用）。SoT は本テーブル。
--   value は jsonb（現状 currentSegmentId = 文字列。将来の個人 UI 設定も同型で追加できる）。
--   非破壊: 保存済みの業態 id が無効化・削除されても、アプリ層 resolveDefaultSegmentId が
--   先頭業態へフォールバックするため情報損失はない（原則2）。
--
-- 下位互換（原則7）: 新規テーブルの追加のみ。既存データ・既存 I/F に影響しない。シードしない
--   （個人の選択状態 = 未設定時はアプリ既定へフォールバック）。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS user_preferences (
  member_id  text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- (member_id, key) の複合 PK。member_id 前方一致で「本人の全設定」を引ける（/v1/me の prefs 組み立て）
  PRIMARY KEY (member_id, key)
);
