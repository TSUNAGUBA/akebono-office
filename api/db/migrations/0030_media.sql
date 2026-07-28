-- 0030: メディア分析（F-40）の本実装。GA OAuth 連携・メディア設定・記事インベントリ・
-- AI 記事生成・AI インサイトの各テーブル。
--
-- segment_id について（全テーブル共通の設計判断）:
--   事業セグメント（業態）はモック側エンティティ（businessSegments = 未移行コレクション）で
--   DB にマスタが存在しないため、FK は張らず text で保持する。セグメントの SoT がモック側にある間は
--   参照整合性はアプリ層（フロントのセグメント選択 UI）が担う。businessSegments を API 移行した時点で
--   FK 追加のマイグレーションを行う。
--
-- テーブル分類（原則2: 記録系は保護・設定系は更新・導出系は再生成可）:
--   media_settings          設定系（segment 1:1 の upsert。再実行で壊れない）
--   media_ga_tokens         設定系（GA OAuth トークン = Google 発行物。喪失時は再連携で回復 = バックアップ対象外）
--   media_oauth_states      一時データ（state ノンス。一回性 + 10 分 TTL。calendar_oauth_states と同型）
--   media_metrics_cache     導出キャッシュ（SoT は GA。TTL 付きで再取得可 = 記録系ではない。GA クォータ対策）
--   media_articles          設定系/資産（サイトのコンテンツ資産インベントリ。論理削除で取消可 = 原則9.5）
--   media_article_briefs    記録系（生成依頼の記録 = 追記のみ）
--   media_generated_articles 生成物（論理削除で取消・復元 = 原則9.5）
--   media_insights          導出キャッシュ（weekly_insights 0026 と同型。生成 → 保管 → 再生成で upsert 上書き）
--
-- 実データ方針: 記事インベントリ・生成物はシードしない（akebono_wishes / sales_monthly と同方針。
-- 架空記事で実 GA 分析を汚染しない）。API モードの初期インベントリは記事採用・手動登録で育つ。
SET search_path TO app_office;

-- セグメントごとのメディア設定（GA 接続状態は media_ga_tokens が SoT。ここは AI 分析設定のみ）
CREATE TABLE IF NOT EXISTS media_settings (
  id              text PRIMARY KEY,
  segment_id      text NOT NULL UNIQUE,
  site_name       text NOT NULL DEFAULT '',
  site_url        text NOT NULL DEFAULT '',
  analysis_goal   text NOT NULL DEFAULT 'awareness'
    CHECK (analysis_goal IN ('awareness','leadgen','nurturing','conversion','branding','retention')),
  target_audience text NOT NULL DEFAULT '',
  default_tone    text NOT NULL DEFAULT 'formal'
    CHECK (default_tone IN ('formal','friendly','expert','casual','storytelling')),
  keywords        jsonb NOT NULL DEFAULT '[]',
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- GA OAuth トークン（segment 単位 = メディアは業態の資産。per-member にしない設計判断:
-- 誰が連携しても業態のメディア分析は全員が同じ GA プロパティを見る。connected_by で連携者を記録する）。
-- property_id が NULL の間は「トークンあり・プロパティ未選択」の中間状態（status.needsProperty）
CREATE TABLE IF NOT EXISTS media_ga_tokens (
  segment_id        text PRIMARY KEY,
  property_id       text,          -- 'properties/123' 形式（Admin API の name をそのまま保持）
  property_name     text,
  access_token_enc  text NOT NULL, -- AES-256-GCM（lib/crypto）。クライアントへ出さない
  refresh_token_enc text,
  expires_at        timestamptz,
  scope             text NOT NULL DEFAULT '',
  connected_by      text NOT NULL REFERENCES members(id),
  connected_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- OAuth state ノンス（一回性 + 10 分 TTL。0010 calendar_oauth_states + segment_id）
CREATE TABLE IF NOT EXISTS media_oauth_states (
  nonce      text PRIMARY KEY,
  member_id  text NOT NULL REFERENCES members(id),
  segment_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- GA 集計の短期キャッシュ（TTL 30 分・force で再取得可）。SoT は GA 側 = 導出キャッシュであり
-- 記録系ではない（原則2 に抵触しない）。cache_key 例: 'metrics:28' / 'monthly:6'
CREATE TABLE IF NOT EXISTS media_metrics_cache (
  segment_id text NOT NULL,
  cache_key  text NOT NULL,
  payload    jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, cache_key)
);

-- サイトのコンテンツ資産（記事インベントリ）。GA の pagePath → セクション対応と記事数の SoT。
-- 集計値（PV 等）は持たない = GA が SoT。論理削除（active=false）で取消・復元できる（原則9.5）
CREATE TABLE IF NOT EXISTS media_articles (
  id                   text PRIMARY KEY,
  segment_id           text NOT NULL,
  path                 text NOT NULL,
  title                text NOT NULL,
  section              text NOT NULL,
  published_at         date NOT NULL,
  word_count           int NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  status               text NOT NULL DEFAULT 'published' CHECK (status IN ('published','draft')),
  origin               text NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed','generated')),
  generated_article_id text,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_articles_segment ON media_articles (segment_id);

-- 記事生成の依頼（記録系 = 追記のみ。生成物と 1:1）
CREATE TABLE IF NOT EXISTS media_article_briefs (
  id              text PRIMARY KEY,
  segment_id      text NOT NULL,
  topic           text NOT NULL DEFAULT '',
  keyword         text NOT NULL DEFAULT '',
  purpose         text NOT NULL CHECK (purpose IN ('awareness','leadgen','nurturing','conversion','seo','branding')),
  quality         text NOT NULL CHECK (quality IN ('draft','standard','premium')),
  tone            text NOT NULL CHECK (tone IN ('formal','friendly','expert','casual','storytelling')),
  audience        text NOT NULL DEFAULT '',
  from_insight_id text,
  created_by      text NOT NULL REFERENCES members(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 生成された記事（ドラフト）。payload = GeneratedArticleDraft（title/outline/body 等）を jsonb で保持。
-- llm = Vertex AI 生成か（false = 決定的フォールバック）。採用でインベントリ化し、論理削除で取消・復元
CREATE TABLE IF NOT EXISTS media_generated_articles (
  id                 text PRIMARY KEY,
  segment_id         text NOT NULL,
  brief_id           text NOT NULL REFERENCES media_article_briefs(id),
  payload            jsonb NOT NULL,
  llm                boolean NOT NULL DEFAULT false,
  adopted_article_id text,
  active             boolean NOT NULL DEFAULT true,
  created_by         text NOT NULL REFERENCES members(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_generated_segment ON media_generated_articles (segment_id);

-- メディア AI インサイト（weekly_insights 0026 の形を踏襲）。セグメント × scope で 1 レコード = upsert。
-- scope='media' は GA メトリクス由来 / scope='integrated' は業務 × メディアの統合メトリクス由来
CREATE TABLE IF NOT EXISTS media_insights (
  id           text PRIMARY KEY,
  segment_id   text NOT NULL,
  scope        text NOT NULL CHECK (scope IN ('media','integrated')),
  period_key   text NOT NULL,
  metrics      jsonb NOT NULL,
  insight      jsonb NOT NULL,
  llm          boolean NOT NULL DEFAULT false,
  generated_by text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (segment_id, scope)
);
