-- 営業日・祝日基盤（オペレーター報告 2026-07-18 #4）
-- 1) 祝日マスタ（SoT）。公式取込（内閣府 syukujitsu.csv = POST /v1/holidays/import）と手動管理の両対応。
--    date は一意（再取込は upsert = 冪等）。source は取込元の記録（official / manual）
CREATE TABLE public_holidays (
  id         text PRIMARY KEY,
  date       date NOT NULL UNIQUE,
  name       text NOT NULL,
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('official', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_public_holidays_date ON public_holidays (date);

-- 2) 勤怠ルールへ営業日定義を追加（既定 = 月〜金 + 祝日考慮 = 従来挙動。既存行は DEFAULT で下位互換）。
--    外注等の週末稼働は working_weekdays に 0/6 を含める・holiday_aware=false で表現する
ALTER TABLE attendance_rules
  ADD COLUMN working_weekdays jsonb NOT NULL DEFAULT '[1,2,3,4,5]',
  ADD COLUMN holiday_aware boolean NOT NULL DEFAULT true;
