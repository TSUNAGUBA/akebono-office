-- バッチ6a 追補: AI 日次報告の並行重複防止 + AI ロール/社員の初期データ投入。
-- 0015（AI カンパニーの表定義）とは別ファイルに分ける（マイグレーションは append-only =
-- 適用済みファイルを改変しない。中間版 0015 を当てた環境でも本ファイルで確実に反映される）。

-- AI の日次報告は 1 社員 1 日 1 件（0001 の human 用インデックスと対の部分一意。
-- 生成 API の ON CONFLICT DO NOTHING と合わせて並行実行でも重複しない = 冪等の DB 保証）
CREATE UNIQUE INDEX IF NOT EXISTS daily_reports_ai_uq ON daily_reports (ai_employee_id, date) WHERE author_kind = 'ai';

-- 初期データ: mockup シード（seed/core.ts）と同一の AI ロール・AI 社員を移行する（0011 の
-- decision_themes と同じ方針 = 新規環境でも F-08 が手動投入なしで動く。原則1）。
-- 既存環境では何もしない（ON CONFLICT DO NOTHING）。status は派生値のため初期は idle。
INSERT INTO ai_roles (id, name, mission, system_prompt, permissions, model_tier) VALUES
  ('r-01', 'リサーチャー', '業界・競合・技術動向の調査と要約', 'あなたは調査専門の AI 社員です。一次情報を優先し、出典を必ず示してください。', '["knowledge:read","web:search"]', 'standard'),
  ('r-02', 'ドキュメンター', '議事録・提案書ドラフト・ナレッジ整備', 'あなたは文書作成専門の AI 社員です。社内テンプレートに従い、簡潔に書いてください。', '["knowledge:read","knowledge:write","documents:write"]', 'standard'),
  ('r-03', 'データアナリスト', '業務データ・スタースキーマの分析と示唆出し', 'あなたはデータ分析専門の AI 社員です。半加法メジャーの時間軸集計に注意してください。', '["mart:read","knowledge:read"]', 'pro'),
  ('r-04', 'QA サポート', '社内からの質問対応と一次切り分け', 'あなたは社内サポートの AI 社員です。わからないことは推測せずエスカレーションしてください。', '["knowledge:read","masters:read"]', 'lite')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ai_employees (id, name, role_id, status, desk_position) VALUES
  ('ai-01', 'アキ', 'r-01', 'idle', '{"x":1,"y":1}'),
  ('ai-02', 'ハル', 'r-02', 'idle', '{"x":2,"y":1}'),
  ('ai-03', 'ソラ', 'r-03', 'idle', '{"x":1,"y":2}'),
  ('ai-04', 'レン', 'r-04', 'idle', '{"x":2,"y":2}'),
  ('ai-05', 'ユキ', 'r-02', 'idle', '{"x":3,"y":1}')
ON CONFLICT (id) DO NOTHING;
