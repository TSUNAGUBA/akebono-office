-- 0040: 勤怠承認ワークフロー（F-04 拡張。オペレーター指示 2026-07-30）
--   ① 直行/直帰 申請＋承認（direct_requests）
--   ② 承認された日について打刻修正が申請できる（attendance_fix_requests に direct 紐付け + 多段承認列）
--   ③ 勤怠ワークフローを稟議と同様に経路設定できる（attendance_routes = 区分ごとの承認ステップ）
--
-- 設計方針:
--   * 稟議（workflow_routes 0006）と同型の「区分×承認ステップ」経路。ただし金額帯は持たない（勤怠は金額でない）。
--   * 区分に有効な経路が無ければ管理者 1 名の単段承認へフォールバック（下位互換 = 原則7。既存の打刻修正は不変）。
--   * 承認ステップは申請時に route_snapshot へ凍結（後の経路変更が進行中申請に影響しない = 稟議と同じ）。
--   * 記録系保護（原則2）: 承認時は打刻を追記（source='fix'）。元打刻は削除しない（既存フロー踏襲）。
SET search_path TO app_office;

-- 勤怠承認経路（設定系マスタ。論理削除 active）。稟議 workflow_routes の勤怠版（金額帯なし）
CREATE TABLE IF NOT EXISTS attendance_routes (
  id         text PRIMARY KEY,
  category   text NOT NULL CHECK (category IN ('direct','fix')), -- direct=直行/直帰申請 / fix=打刻修正申請
  steps      jsonb NOT NULL DEFAULT '[]', -- [{ order, approverRole(manager/hr/director/president), approverMemberId, mode }]
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 直行/直帰 申請（承認系・多段）。承認されると当日の打刻修正が申請可能になる
CREATE TABLE IF NOT EXISTS direct_requests (
  id             text PRIMARY KEY,
  member_id      text NOT NULL REFERENCES members(id),
  date           date NOT NULL,
  type           text NOT NULL CHECK (type IN ('chokkou','chokki','both')), -- 直行/直帰/直行直帰
  reason         text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_review','approved','rejected','withdrawn')),
  current_step   integer NOT NULL DEFAULT 1,
  route_snapshot jsonb NOT NULL DEFAULT '[]', -- 申請時に凍結した承認ステップ（空 = 管理者単段）
  decided_by     text, -- 最終承認/却下者
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX direct_requests_member_date_idx ON direct_requests (member_id, date);
CREATE INDEX direct_requests_status_idx ON direct_requests (status);

-- 打刻修正申請へ多段承認列 + 直行/直帰紐付けを追加（列追加のみ = 下位互換。既存行は既定値で単段承認のまま）
ALTER TABLE attendance_fix_requests ADD COLUMN IF NOT EXISTS current_step integer NOT NULL DEFAULT 1;
ALTER TABLE attendance_fix_requests ADD COLUMN IF NOT EXISTS route_snapshot jsonb NOT NULL DEFAULT '[]';
ALTER TABLE attendance_fix_requests ADD COLUMN IF NOT EXISTS direct_request_id text REFERENCES direct_requests(id);
-- status に in_review（多段承認の途中）を許容する（既存は pending/approved/rejected のみ）
ALTER TABLE attendance_fix_requests DROP CONSTRAINT IF EXISTS attendance_fix_requests_status_check;
ALTER TABLE attendance_fix_requests ADD CONSTRAINT attendance_fix_requests_status_check
  CHECK (status IN ('pending','in_review','approved','rejected'));
