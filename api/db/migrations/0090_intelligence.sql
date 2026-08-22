-- 0090: AKEBONO Intelligence の記録系（改善要望 2026-08-22。モック境界の本実装）。
-- インサイト・アクション・分析サイクルの SoT を localStorage（`aki.store.v1.<memberId>`）から
-- サーバーへ移行する（requirements §5 の宣言どおり）。所有モデルはメンバー単位
-- （member_id = 記録の所有者。従来のユーザー別 localStorage と同じ可視性を維持 = 原則7）。
-- サイクルは追記のみの記録系・インサイト/アクションは論理削除（active）+ 復元（原則9.5）。
--
-- 冪等: CREATE TABLE IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

CREATE TABLE IF NOT EXISTS intel_cycles (
  id                  text PRIMARY KEY,
  member_id           text NOT NULL REFERENCES members(id),
  theme               text NOT NULL,
  target_id           text,
  target_name         text NOT NULL DEFAULT '',
  at                  timestamptz NOT NULL DEFAULT now(),
  input_snapshot      jsonb NOT NULL DEFAULT '[]',
  feedback_considered jsonb NOT NULL DEFAULT '[]',
  insight_ids         jsonb NOT NULL DEFAULT '[]',
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intel_insights (
  id                  text PRIMARY KEY,
  member_id           text NOT NULL REFERENCES members(id),
  cycle_id            text NOT NULL REFERENCES intel_cycles(id),
  theme               text NOT NULL,
  target_id           text,
  target_name         text NOT NULL DEFAULT '',
  title               text NOT NULL,
  summary             text NOT NULL DEFAULT '',
  findings            jsonb NOT NULL DEFAULT '[]',
  evidence            jsonb NOT NULL DEFAULT '[]',
  proposals           jsonb NOT NULL DEFAULT '[]',
  confidence          text NOT NULL DEFAULT 'low',
  feedback_considered jsonb NOT NULL DEFAULT '[]',
  -- LLM（Vertex AI）生成か（false = 決定的ヒューリスティックのフォールバック）
  llm                 boolean NOT NULL DEFAULT false,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intel_actions (
  id              text PRIMARY KEY,
  member_id       text NOT NULL REFERENCES members(id),
  insight_id      text REFERENCES intel_insights(id),
  proposal_id     text,
  theme           text NOT NULL,
  target_id       text,
  target_name     text NOT NULL DEFAULT '',
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'planned',
  due_date        date,
  result          text NOT NULL DEFAULT '',
  feedback_rating integer,
  feedback_note   text NOT NULL DEFAULT '',
  feedback_next   text NOT NULL DEFAULT '',
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intel_cycles_member ON intel_cycles (member_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_insights_member ON intel_insights (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_actions_member ON intel_actions (member_id, created_at DESC);
-- FK 参照列（サイクル別・由来インサイト別の参照に備える）
CREATE INDEX IF NOT EXISTS idx_intel_insights_cycle ON intel_insights (cycle_id);
CREATE INDEX IF NOT EXISTS idx_intel_actions_insight ON intel_actions (insight_id);
