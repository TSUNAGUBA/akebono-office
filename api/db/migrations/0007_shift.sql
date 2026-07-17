-- 0007: シフト表（F-05）
-- - shift_periods: 募集期間（状態機械 draft→open→closed→adjusting→published の正順のみ）
-- - shift_wishes: 出勤希望（設定系。同一日への再提出は上書き = UNIQUE upsert）
-- - shift_assignments: 割当（調整中のみ変更可。確定後変更は本人合意 consent_at を記録）
-- - shift_demands: 日別必要人数（日別 1 スロットの簡易モデル = UNIQUE (period_id, date)）
SET search_path TO app_office;

CREATE TABLE shift_periods (
  id            text PRIMARY KEY,
  label         text NOT NULL,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  wish_deadline date NOT NULL,
  status        text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','open','closed','adjusting','published')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shift_periods_status_idx ON shift_periods (status, start_date DESC);

CREATE TABLE shift_wishes (
  id         text PRIMARY KEY,
  period_id  text NOT NULL REFERENCES shift_periods(id),
  member_id  text NOT NULL REFERENCES members(id),
  date       date NOT NULL,
  wish       text NOT NULL CHECK (wish IN ('want','ng','either')),
  from_time  text, -- HH:MM（want のみ）
  to_time    text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_id, member_id, date)
);

CREATE TABLE shift_assignments (
  id         text PRIMARY KEY,
  period_id  text NOT NULL REFERENCES shift_periods(id),
  member_id  text NOT NULL REFERENCES members(id),
  date       date NOT NULL,
  from_time  text NOT NULL, -- HH:MM
  to_time    text NOT NULL,
  status     text NOT NULL DEFAULT 'tentative'
    CHECK (status IN ('tentative','confirmed','change_requested')),
  consent_at text, -- JST ISO（本人合意の記録）
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_id, member_id, date)
);
CREATE INDEX shift_assignments_member_idx ON shift_assignments (member_id, date);

CREATE TABLE shift_demands (
  id         text PRIMARY KEY,
  period_id  text NOT NULL REFERENCES shift_periods(id),
  date       date NOT NULL,
  from_time  text NOT NULL,
  to_time    text NOT NULL,
  required   integer NOT NULL CHECK (required > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_id, date)
);
