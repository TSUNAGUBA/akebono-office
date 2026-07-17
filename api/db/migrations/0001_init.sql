-- 0001: app_office スキーマ初期化（本実装バッチ1: 勤怠・休暇・日報・マスタ・設定）
-- 設計 SoT: .ai-native/outputs/phase5/data-design.md / 型 SoT: shared/domain/types.ts
-- 方針:
--   * id は text（プレフィックス付き。モックのシード id と互換）
--   * 業務日付は date 型（アプリ層では 'YYYY-MM-DD' 文字列として扱う）
--   * 業務時刻（打刻・提出時刻等）は JST ウォールクロックの ISO 文字列（text）。
--     shared/domain の純粋関数（壁時計計算）と同一解釈を保つための設計判断
--   * マスタ系は論理削除（active boolean）。記録系は追記のみ
--   * 監査列 created_at/updated_at は timestamptz（システム時刻）

CREATE SCHEMA IF NOT EXISTS app_office;
SET search_path TO app_office;

-- ---------- マスタ系 ----------

CREATE TABLE departments (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  parent_id     text REFERENCES departments(id),
  manager_id    text,
  description   text NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 1,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attendance_rules (
  id                     text PRIMARY KEY,
  name                   text NOT NULL,
  applies_to             jsonb NOT NULL DEFAULT '[]',
  default_for            jsonb NOT NULL DEFAULT '[]',
  work_start             text NOT NULL DEFAULT '09:00',
  work_end               text NOT NULL DEFAULT '18:00',
  break_minutes          integer NOT NULL DEFAULT 60,
  flex                   jsonb,
  closing_day            integer NOT NULL DEFAULT 31,
  legal_holiday_weekday  integer NOT NULL DEFAULT 0,
  active                 boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id                         text PRIMARY KEY,
  name                       text NOT NULL,
  email                      text NOT NULL DEFAULT '',
  employment_type            text NOT NULL DEFAULT 'employee'
    CHECK (employment_type IN ('director','employee','contract','parttime','outsource')),
  department_id              text NOT NULL DEFAULT '' ,
  title                      text NOT NULL DEFAULT '',
  role                       text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','hr','member')),
  hire_date                  date,
  weekly_days                numeric NOT NULL DEFAULT 5,
  weekly_hours               numeric NOT NULL DEFAULT 40,
  punch_required             boolean NOT NULL DEFAULT true,
  google_calendar_connected  boolean NOT NULL DEFAULT false,
  attendance_rule_id         text REFERENCES attendance_rules(id),
  birth_date                 date,
  active                     boolean NOT NULL DEFAULT true,
  custom                     jsonb NOT NULL DEFAULT '{}',
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX members_email_uq ON members (lower(email)) WHERE email <> '';

CREATE TABLE leave_types (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  grant_method  text NOT NULL DEFAULT 'manual' CHECK (grant_method IN ('periodic','manual')),
  expiry_months integer,
  is_statutory  boolean NOT NULL DEFAULT false,
  description   text NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 1,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE industries (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  display_order integer NOT NULL DEFAULT 1,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id                  text PRIMARY KEY,
  kind                text NOT NULL DEFAULT 'customer' CHECK (kind IN ('self','customer')),
  name                text NOT NULL,
  aliases             jsonb NOT NULL DEFAULT '[]',
  industry_ids        jsonb NOT NULL DEFAULT '[]',
  primary_industry_id text NOT NULL DEFAULT '',
  size                text NOT NULL DEFAULT '',
  location            text NOT NULL DEFAULT '',
  description         text NOT NULL DEFAULT '',
  owner_member_id     text NOT NULL DEFAULT '',
  fiscal_start_month  integer,
  active              boolean NOT NULL DEFAULT true,
  custom              jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id         text PRIMARY KEY,
  company_id text NOT NULL,
  name       text NOT NULL,
  dept       text NOT NULL DEFAULT '',
  title      text NOT NULL DEFAULT '',
  key_person integer NOT NULL DEFAULT 1 CHECK (key_person BETWEEN 1 AND 3),
  email      text NOT NULL DEFAULT '',
  phone      text NOT NULL DEFAULT '',
  notes      text NOT NULL DEFAULT '',
  active     boolean NOT NULL DEFAULT true,
  custom     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE relation_types (
  id         text PRIMARY KEY,
  label      text NOT NULL,
  direction  text NOT NULL DEFAULT 'directed' CHECK (direction IN ('directed','mutual')),
  applies_to text NOT NULL DEFAULT 'company' CHECK (applies_to IN ('company','contact')),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 関係エッジは設計判断により物理削除可（data-design §1.1。削除は監査ログ必須）
CREATE TABLE company_relations (
  id               text PRIMARY KEY,
  from_company_id  text NOT NULL,
  to_company_id    text NOT NULL,
  relation_type_id text NOT NULL,
  notes            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (from_company_id <> to_company_id)
);

CREATE TABLE contact_relations (
  id               text PRIMARY KEY,
  from_contact_id  text NOT NULL,
  to_contact_id    text NOT NULL,
  relation_type_id text NOT NULL,
  notes            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (from_contact_id <> to_contact_id)
);

CREATE TABLE projects (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  company_id      text NOT NULL DEFAULT '',
  type            text NOT NULL DEFAULT 'internal'
    CHECK (type IN ('biz_consulting','sys_consulting','development','operation','internal')),
  status          text NOT NULL DEFAULT 'active',
  priority        text NOT NULL DEFAULT 'mid',
  owner_member_id text NOT NULL DEFAULT '',
  member_ids      jsonb NOT NULL DEFAULT '[]',
  start_date      date,
  end_date        date,
  budget          numeric,
  objective       text NOT NULL DEFAULT '',
  active          boolean NOT NULL DEFAULT true,
  custom          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_articles (
  id            text PRIMARY KEY,
  domain        text NOT NULL CHECK (domain IN ('industry','company','contact','relation','project')),
  target_id     text NOT NULL DEFAULT '',
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  tags          jsonb NOT NULL DEFAULT '[]',
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','escalation')),
  source_ref_id text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custom_field_defs (
  id            text PRIMARY KEY,
  entity        text NOT NULL,
  key           text NOT NULL,
  label         text NOT NULL,
  field_type    text NOT NULL DEFAULT 'text'
    CHECK (field_type IN ('text','number','date','select','multiselect','boolean')),
  options       jsonb NOT NULL DEFAULT '[]',
  required      boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 1,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE code_masters (
  id            text PRIMARY KEY,
  category      text NOT NULL,
  code          text NOT NULL,
  label         text NOT NULL,
  display_order integer NOT NULL DEFAULT 1,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_links (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  url           text NOT NULL,
  description   text NOT NULL DEFAULT '',
  icon          text NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 1,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- 記録系（追記のみ・巻き戻し禁止: 開発原則2） ----------

CREATE TABLE punch_records (
  id          text PRIMARY KEY,
  member_id   text NOT NULL REFERENCES members(id),
  date        date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('in','out','break_start','break_end')),
  at          text NOT NULL, -- JST ウォールクロック ISO（+09:00）
  source      text NOT NULL DEFAULT 'web' CHECK (source IN ('web','mobile','fix')),
  fixed_from  text,
  fix_reason  text,
  approved_by text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX punch_records_member_date_idx ON punch_records (member_id, date);
CREATE INDEX punch_records_date_idx ON punch_records (date);

CREATE TABLE attendance_fix_requests (
  id           text PRIMARY KEY,
  member_id    text NOT NULL REFERENCES members(id),
  date         date NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('in','out','break_start','break_end')),
  requested_at text NOT NULL, -- 修正後の打刻時刻（JST ISO）
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attendance_fix_requests_status_idx ON attendance_fix_requests (status);

CREATE TABLE leave_grants (
  id            text PRIMARY KEY,
  member_id     text NOT NULL REFERENCES members(id),
  leave_type_id text NOT NULL REFERENCES leave_types(id),
  grant_date    date NOT NULL,
  days          numeric NOT NULL CHECK (days > 0),
  kind          text NOT NULL DEFAULT 'special' CHECK (kind IN ('normal','proportional','special')),
  expire_date   date NOT NULL,
  granted_by    text, -- null = 周期自動付与
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 冪等性: 同一メンバー × 種別 × 付与日は 1 件のみ（再実行で残数が二重に増えない。原則2）
  CONSTRAINT leave_grants_idempotent UNIQUE (member_id, leave_type_id, grant_date)
);

CREATE TABLE leave_requests (
  id            text PRIMARY KEY,
  member_id     text NOT NULL REFERENCES members(id),
  leave_type_id text NOT NULL REFERENCES leave_types(id),
  date          date NOT NULL,
  unit          text NOT NULL DEFAULT 'full' CHECK (unit IN ('full','half')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason        text NOT NULL DEFAULT '',
  decided_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leave_requests_member_idx ON leave_requests (member_id, date);
CREATE INDEX leave_requests_status_idx ON leave_requests (status);

CREATE TABLE daily_reports (
  id             text PRIMARY KEY,
  author_kind    text NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human','ai')),
  member_id      text,
  ai_employee_id text,
  date           date NOT NULL,
  entries        jsonb NOT NULL DEFAULT '[]',
  reflection     text NOT NULL DEFAULT '',
  issues         text NOT NULL DEFAULT '',
  tomorrow       text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  submitted_at   text, -- JST ISO
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((author_kind = 'human' AND member_id IS NOT NULL) OR (author_kind = 'ai' AND ai_employee_id IS NOT NULL))
);
-- 人の日報は 1 人 1 日 1 件
CREATE UNIQUE INDEX daily_reports_human_uq ON daily_reports (member_id, date) WHERE author_kind = 'human';
CREATE INDEX daily_reports_date_idx ON daily_reports (date);

CREATE TABLE weekly_reports (
  id           text PRIMARY KEY,
  member_id    text NOT NULL REFERENCES members(id),
  week_start   date NOT NULL,
  goal_review  text NOT NULL DEFAULT '',
  main_work    text NOT NULL DEFAULT '',
  issues       text NOT NULL DEFAULT '',
  next_week    text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  submitted_at text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_reports_uq UNIQUE (member_id, week_start)
);

CREATE TABLE report_comments (
  id        text PRIMARY KEY,
  report_id text NOT NULL,
  member_id text NOT NULL,
  body      text NOT NULL,
  reactions jsonb NOT NULL DEFAULT '[]',
  at        text NOT NULL, -- JST ISO
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_comments_report_idx ON report_comments (report_id);

-- ---------- 設定系・監査 ----------

CREATE TABLE app_configs (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id        bigserial PRIMARY KEY,
  actor_id  text NOT NULL,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text NOT NULL,
  detail    text NOT NULL DEFAULT '',
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity, entity_id);
