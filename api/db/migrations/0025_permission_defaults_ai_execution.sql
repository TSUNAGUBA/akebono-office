-- バッチ7f（オペレーター指示 2026-07-19 #7）
SET search_path TO app_office;

-- 1) 権限の運用デフォルト（F-16）。
--    経営情報（売上管理・意思決定支援）と管理 UI（マスタメンテナンス・設定）を一般/人事ロールから制限する。
--    * 一般（member）: 売上・意思決定・マスタ・設定 を deny
--    * 人事（hr）: 売上・意思決定 を deny（マスタ・設定は労務運用で使用するため未設定 = allow）
--    * 管理者（admin）: 未設定（全 allow）
--    マスタ・設定の deny は管理 UI（メニュー/ページ）の非表示のみに効く（/v1/masters・/v1/configs の
--    参照 API はデータ面のため機能ガード対象外 = 参照データ供給は全ロールで維持。F-16 設計どおり）。
--    個別の例外は権限設定画面で member/title レイヤの allow を追加して上書きできる。
--    冪等・状態保護（原則2）: 有効なルールが 1 件でも存在する環境（運用設定済み）には投入しない
INSERT INTO permission_rules (id, subject_kind, subject_id, resource, field, effect)
SELECT v.id, 'role', v.subject_id, v.resource, NULL, 'deny'
FROM (VALUES
  ('pr-def-01', 'member', 'sales'),
  ('pr-def-02', 'member', 'decision'),
  ('pr-def-03', 'member', 'masters'),
  ('pr-def-04', 'member', 'settings'),
  ('pr-def-05', 'hr', 'sales'),
  ('pr-def-06', 'hr', 'decision')
) AS v(id, subject_id, resource)
WHERE NOT EXISTS (SELECT 1 FROM permission_rules WHERE active);

-- 2) AI タスクの実遂行化: ステップ実行の成果物（[{step, title, body, at}]。追記のみ）
ALTER TABLE ai_tasks ADD COLUMN outputs jsonb NOT NULL DEFAULT '[]';

-- 3) 依頼者への質問（人間のアクションが必要な箇所で AI が確認を求める。記録系 = 追記 + 回答で確定）
CREATE TABLE IF NOT EXISTS ai_task_questions (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES ai_tasks(id),
  step_index int NOT NULL DEFAULT -1,
  question text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered')),
  answer text,
  answered_by text REFERENCES members(id),
  asked_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ai_task_questions_task ON ai_task_questions (task_id);

-- 4) 依頼・回答の添付（フリーテキストと合わせた画像/ドキュメントのインプット。note_files と同型の原本保全）
CREATE TABLE IF NOT EXISTS ai_task_files (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES ai_tasks(id),
  question_id text REFERENCES ai_task_questions(id),
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes int NOT NULL,
  bytes bytea NOT NULL,
  extracted_text text,
  uploaded_by text NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_task_files_task ON ai_task_files (task_id);
