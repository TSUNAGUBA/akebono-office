-- 0082: AI ナレッジベース（アプリ仕様・運用/操作マニュアル）の RAG 化 + 受付箱の AI 判定（改修依頼 2026-08-21）。
-- - ナレッジベースの SoT はコード内モジュール shared/domain/kb（KB_DOCS。API バンドル・モックと共有 =
--   両モード同一知識・二重管理回避の設計判断。KB_DOCUMENT_FORMAT のメタは型として保持）。
--   search_docs へ source_kind='manual' で索引し、AI チャットボットの検索リトリーバル・app_manual ツールが
--   参照する（SoT → キャッシュの一方向 = 原則6。rebuildSearchIndex が常に全再生成できる）。
-- - 受付箱の AI 判定（ai_assessment）: 要望ごとに「既存機能で対応可 / 運用の工夫で対応可 / 改修が必要」の
--   判定・根拠・参照 doc を保管する（生成→保管→再判定で上書き。形式は shared/domain/improvement.ts の
--   ImprovementRequestAssessment。NULL = 未判定）。
-- 冪等: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT / ADD COLUMN IF NOT EXISTS
-- （再実行しても既存データは変化しない = 原則2。追加列は NULL = 既存行は未判定で非破壊 = 原則7）。
SET search_path TO app_office;

-- search_docs にマニュアル（manual）を追加（0021 → 0023/0024/0027/0044 の CHECK 差し替えと同方式）
ALTER TABLE search_docs DROP CONSTRAINT IF EXISTS search_docs_source_kind_check;
ALTER TABLE search_docs ADD CONSTRAINT search_docs_source_kind_check
  CHECK (source_kind IN ('company', 'contact', 'industry', 'knowledge', 'project', 'note', 'document', 'customer-log', 'manual'));

-- 受付箱の AI 判定（jsonb。NULL = 未判定）
ALTER TABLE improvement_requests ADD COLUMN IF NOT EXISTS ai_assessment jsonb;
