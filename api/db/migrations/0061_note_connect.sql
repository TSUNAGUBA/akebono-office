-- 0061: note（note.com）連携（F-40 メディア分析の拡張。オペレーター指示 2026-08-12）。
-- 「記事を note へ下書き投稿 → 公開後の反応（スキ・コメント）を収集 → AI フィードバック → 次の記事へ」の
-- PDCA ループをメディアチャンネル単位で回す。
--
-- 設計判断（.ai-native/outputs/phase7/implementation-status.md §76 に詳細）:
--   - note に公式 API はなく**非公式エンドポイント**を利用する（仕様変更リスクあり）。アプリからの操作は
--     「下書き作成まで」に限定し、**公開は必ず人間が note の管理画面で行う**（誤公開の取り消し不能を作らない = 原則9.5）。
--   - 反応収集は公開エンドポイント（/api/v2/creators/{urlname}/contents）が主経路 = セッション Cookie なしでも動く。
--     Cookie（_note_session_v5）は下書きプッシュにのみ必要（AES-256-GCM で暗号化保存 = media_ga_tokens と同型）。
--
-- SoT 宣言（原則6）:
--   - 記事原稿（note_posts.title/body）の SoT = 本アプリ（下書きプッシュで note 側へ反映する一方向）
--   - 公開状態・反応数（スキ・コメント）の SoT = note。note_metrics はその日次スナップショット（記録系 = 追記保護）、
--     note_posts.status/published_at は note から同期される導出値
--   - AI フィードバックの保管は media_insights（scope='note'）を再利用（原則3。導出キャッシュ = 再生成で上書き）
--
-- 冪等性（原則2）: スナップショットは (channel_id, note_key, snapshot_date) で当日行のみ upsert 更新。
--   過去日の行には決して触れない（再実行で履歴が巻き戻らない）。
SET search_path TO app_office;

-- ---------- 1. note_connections（チャンネル × note アカウント連携。設定系 = upsert） ----------
-- urlname = note のクリエイター ID（note.com/{urlname}）。反応収集はこれだけで動く。
-- session_cookie_enc = _note_session_v5 の暗号化値（空 = 未設定 = 下書きプッシュ不可。収集は可）。
CREATE TABLE IF NOT EXISTS note_connections (
  channel_id         text PRIMARY KEY,
  urlname            text NOT NULL,
  session_cookie_enc text NOT NULL DEFAULT '',
  connected_by       text NOT NULL REFERENCES members(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------- 2. note_posts（note へ投稿する記事原稿。SoT = 本アプリ） ----------
-- status: local_draft（ローカル下書き）→ pushed（note の下書きへ送信済み）→ published（note で公開を検知）。
-- note_key / note_draft_id は push 時に note が採番する識別子。published への遷移は同期（/note/sync）が行う。
-- generated_article_id = AI 記事生成（media_generated_articles）から取り込んだ場合のトレーサビリティ。
-- 論理削除（active=false）で取消・復元できる（原則9.5）。
CREATE TABLE IF NOT EXISTS note_posts (
  id                   text PRIMARY KEY,
  channel_id           text NOT NULL,
  generated_article_id text,
  title                text NOT NULL,
  body                 text NOT NULL DEFAULT '',   -- マークダウン（記事生成と同じサブセット）
  status               text NOT NULL DEFAULT 'local_draft'
    CHECK (status IN ('local_draft','pushed','published')),
  note_key             text NOT NULL DEFAULT '',   -- note 記事キー（URL の n/{key}）
  note_draft_id        text NOT NULL DEFAULT '',   -- note 下書き ID（再プッシュ = 同じ下書きの更新に使う）
  note_url             text NOT NULL DEFAULT '',
  pushed_at            timestamptz,
  published_at         date,
  created_by           text NOT NULL REFERENCES members(id),
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_note_posts_channel ON note_posts (channel_id);

-- ---------- 3. note_metrics（反応の日次スナップショット。記録系 = 追記保護） ----------
-- note の公開記事一覧から取得したスキ数・コメント数を 1 日 1 行で記録する。
-- 同日の再同期は当日行の更新のみ（UNIQUE + upsert = 冪等）。過去日は不変。
-- view_count は note のダッシュボード API（要 Cookie）からの取得値。取れない環境では NULL（欠測 ≠ 0）。
CREATE TABLE IF NOT EXISTS note_metrics (
  id            text PRIMARY KEY,
  channel_id    text NOT NULL,
  note_key      text NOT NULL,
  snapshot_date date NOT NULL,
  title         text NOT NULL DEFAULT '',
  like_count    integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  view_count    integer,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, note_key, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_note_metrics_channel_date ON note_metrics (channel_id, snapshot_date);

-- ---------- 4. media_insights.scope へ 'note' を追加（AI フィードバックの保管先を再利用 = 原則3） ----------
-- 0030 の CHECK (scope IN ('media','integrated')) を広げる。既存値はすべて新制約を満たす（下位互換 = 原則7）。
-- 冪等性: DROP IF EXISTS → ADD。制約名は 0030 の無名 CHECK に PostgreSQL が付ける既定名。
ALTER TABLE media_insights DROP CONSTRAINT IF EXISTS media_insights_scope_check;
ALTER TABLE media_insights ADD CONSTRAINT media_insights_scope_check
  CHECK (scope IN ('media','integrated','note'));
