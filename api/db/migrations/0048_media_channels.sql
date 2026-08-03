-- 0048: メディア分析を「事業セグメント（業態）と 1:1 結合」から「独立したメディアチャンネル +
-- 任意の Akebono 業務アプリ（業態）連携」へ移行する（オペレーター指示 2026-08-03）。
--
-- 背景: 0030 ではメディア分析は business_segments と 1:1 で、全データが segment_id で keying されていた。
--   本移行で「メディアチャンネル（media_channels）」を独立エンティティにし、任意で業態と連携できるようにする。
--   連携は必須でない（segment_id = NULL の単体チャンネルも、分析・記事生成・単体 AI インサイトが動く）。
--   業務 × メディアの統合 PDCA（integrated insight = 売上 × 流入）は連携済み（segment_id あり）でのみ利用可能。
--
-- 設計判断（低リスク・データ移動最小化）:
--   **channel.id = 旧 segment_id の値そのもの**にする。これにより child テーブル（media_ga_tokens 等）の
--   既存 segment_id 値が、列名を channel_id へ RENAME しただけでそのまま有効な channel_id として機能する
--   = child 行の UPDATE（値の書き換え）が一切不要。旧 media_settings 1 行につき channel を 1 件 backfill し、
--   channel.segment_id = 旧 segment_id（= 連携済みチャンネル）として下位互換を担保する（原則7）。
--
-- SoT の維持: GA 接続状態の SoT は media_ga_tokens のまま（media_channels には GA 系列を置かない）。
--   site_name / site_url / AI 分析設定（analysis_goal・target_audience・default_tone・keywords）は
--   旧 media_settings から media_channels へ移設する。
--
-- 冪等性: 全操作を IF NOT EXISTS / IF EXISTS / information_schema ガードで保護（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

-- ---------- 1. media_channels（旧 media_settings を置換・拡張。設定系 = upsert） ----------
-- segment_id は NULLABLE（NULL = 業態未連携の単体チャンネル）。business_segments への FK は張らない
-- （0030 の設計判断を踏襲: segment の SoT が確定するまで text 保持・参照整合はアプリ層）。
CREATE TABLE IF NOT EXISTS media_channels (
  id              text PRIMARY KEY,
  name            text NOT NULL DEFAULT '',   -- チャンネル表示名（必須。空は backfill/API で補完）
  segment_id      text,                        -- 連携先 Akebono 業務アプリ（業態）。NULL = 単体
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
CREATE INDEX IF NOT EXISTS idx_media_channels_segment ON media_channels (segment_id);

-- ---------- 2. backfill: 旧 media_settings → media_channels（channel.id = 旧 segment_id） ----------
-- name = coalesce(nullif(site_name,''), business_segments.name, '無題メディア')。
-- ON CONFLICT DO NOTHING で冪等（再適用しても既存チャンネルを上書きしない = 記録保護）。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'app_office' AND table_name = 'media_settings'
  ) THEN
    INSERT INTO media_channels
      (id, name, segment_id, site_name, site_url, analysis_goal, target_audience, default_tone, keywords, active, created_at, updated_at)
    SELECT
      s.segment_id,
      COALESCE(NULLIF(s.site_name, ''), b.name, '無題メディア'),
      s.segment_id,                       -- 連携済み（既存は全て業態 1:1 だった）
      s.site_name, s.site_url, s.analysis_goal, s.target_audience, s.default_tone,
      s.keywords, s.active, s.created_at, s.updated_at
    FROM media_settings s
    LEFT JOIN business_segments b ON b.id = s.segment_id
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- ---------- 2b. 孤児 backfill: 設定行を持たない業態の子行を救済（レビュー m-1） ----------
-- 旧コードでは GA 連携（media_ga_tokens）・記事登録（media_articles 等）は media_settings 行の存在を要求しない。
-- そのため「GA 連携済みだが設定未保存」等の業態があると、RENAME 後の子行（channel_id = 旧 segment_id）に
-- 対応する media_channels 行が無く UI から不可視になる。子テーブルに現れる segment_id のうち未 backfill のものから
-- チャンネルを補完する（この時点では子テーブルはまだ segment_id 列。RENAME は次ステップ）。
-- media_oauth_states は一時的（TTL）のため対象外。name は業態名 or '無題メディア'。
-- 冪等性: 子テーブルの segment_id 列が存在する場合のみ実行する（step 3 の RENAME 済み = 再適用時はスキップ）。
-- 6 テーブルは step 3 で一括 RENAME されるため、代表 1 列（media_metrics_cache.segment_id）の存在で判定して足りる。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app_office' AND table_name = 'media_metrics_cache' AND column_name = 'segment_id'
  ) THEN
    INSERT INTO media_channels (id, name, segment_id, active)
    SELECT sid, COALESCE(b.name, '無題メディア'), sid, true
    FROM (
      SELECT DISTINCT segment_id AS sid FROM media_ga_tokens
      UNION SELECT DISTINCT segment_id FROM media_articles
      UNION SELECT DISTINCT segment_id FROM media_article_briefs
      UNION SELECT DISTINCT segment_id FROM media_generated_articles
      UNION SELECT DISTINCT segment_id FROM media_insights
      UNION SELECT DISTINCT segment_id FROM media_metrics_cache
    ) src
    LEFT JOIN business_segments b ON b.id = src.sid
    WHERE src.sid IS NOT NULL AND src.sid <> ''
      AND NOT EXISTS (SELECT 1 FROM media_channels mc WHERE mc.id = src.sid)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- ---------- 3. child テーブルの segment_id → channel_id（RENAME COLUMN。値は不変 = 行の UPDATE 不要） ----------
-- 各テーブルを information_schema ガードで冪等に RENAME する。制約名（PK/UNIQUE）は列名変更に自動追随する
-- （ON CONFLICT の列推論は列名で解決するため、制約名を変えなくても新コードは動く）。索引名は命名整合のため rename する。
DO $$
BEGIN
  -- media_ga_tokens（PK: segment_id → channel_id）
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='app_office' AND table_name='media_ga_tokens' AND column_name='segment_id') THEN
    ALTER TABLE media_ga_tokens RENAME COLUMN segment_id TO channel_id;
  END IF;

  -- media_oauth_states（state ノンス。segment_id → channel_id）
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='app_office' AND table_name='media_oauth_states' AND column_name='segment_id') THEN
    ALTER TABLE media_oauth_states RENAME COLUMN segment_id TO channel_id;
  END IF;

  -- media_metrics_cache（PK: (segment_id, cache_key) → (channel_id, cache_key)）
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='app_office' AND table_name='media_metrics_cache' AND column_name='segment_id') THEN
    ALTER TABLE media_metrics_cache RENAME COLUMN segment_id TO channel_id;
  END IF;

  -- media_articles（segment_id → channel_id + 部分一意 (segment_id, path)）
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='app_office' AND table_name='media_articles' AND column_name='segment_id') THEN
    ALTER TABLE media_articles RENAME COLUMN segment_id TO channel_id;
  END IF;

  -- media_article_briefs（記録系。segment_id → channel_id）
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='app_office' AND table_name='media_article_briefs' AND column_name='segment_id') THEN
    ALTER TABLE media_article_briefs RENAME COLUMN segment_id TO channel_id;
  END IF;

  -- media_generated_articles（生成物。segment_id → channel_id）
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='app_office' AND table_name='media_generated_articles' AND column_name='segment_id') THEN
    ALTER TABLE media_generated_articles RENAME COLUMN segment_id TO channel_id;
  END IF;

  -- media_insights（導出キャッシュ。UNIQUE (segment_id, scope) → (channel_id, scope)）
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='app_office' AND table_name='media_insights' AND column_name='segment_id') THEN
    ALTER TABLE media_insights RENAME COLUMN segment_id TO channel_id;
  END IF;
END $$;

-- 索引の命名整合（列は追随済み。名前だけ segment → channel に揃える。存在時のみ）
ALTER INDEX IF EXISTS idx_media_articles_segment RENAME TO idx_media_articles_channel;
ALTER INDEX IF EXISTS media_articles_segment_path_active_idx RENAME TO media_articles_channel_path_active_idx;
ALTER INDEX IF EXISTS idx_media_generated_segment RENAME TO idx_media_generated_channel;

-- ---------- 4. 旧 media_settings を破棄（データは media_channels へ移設済み） ----------
DROP TABLE IF EXISTS media_settings;

-- ---------- 5. media_external_articles（外部で投稿した記事原文の保管。AI 分析の材料） ----------
-- 外部で投稿した記事の原文を保管し、media インサイト生成の材料に使う（新機能）。
-- 論理削除（active=false）で取消・復元できる（原則9.5）。
CREATE TABLE IF NOT EXISTS media_external_articles (
  id           text PRIMARY KEY,
  channel_id   text NOT NULL,
  title        text NOT NULL,               -- 必須
  url          text NOT NULL DEFAULT '',    -- 任意（投稿先 URL）
  source       text NOT NULL DEFAULT '',    -- 任意（媒体名など）
  published_at date,                          -- 任意（YYYY-MM-DD）
  body         text NOT NULL DEFAULT '',    -- 原文（AI 分析に使う）
  notes        text NOT NULL DEFAULT '',    -- 任意メモ
  created_by   text NOT NULL REFERENCES members(id),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_external_articles_channel ON media_external_articles (channel_id);
