-- 0003: 通知（F-12 の通知部分。休暇・打刻修正・日報リマインドの発火先）
SET search_path TO app_office;

CREATE TABLE notifications (
  id         text PRIMARY KEY,
  member_id  text NOT NULL REFERENCES members(id),
  kind       text NOT NULL CHECK (kind IN ('approval','comment','reminder','ai_report','system','escalation')),
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  link       text NOT NULL DEFAULT '',
  read       boolean NOT NULL DEFAULT false,
  at         text NOT NULL, -- JST ISO
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_member_idx ON notifications (member_id, read);
