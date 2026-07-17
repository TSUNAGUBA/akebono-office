-- 0002: 参照データの初期投入（冪等: ON CONFLICT DO NOTHING）
-- デモデータは投入しない（本番 DB を汚さない）。業務上の前提となる最小参照データのみ。
SET search_path TO app_office;

-- 法定有給（シード固定・編集/無効化不可: AKO-LEV-008 ガード対象）
INSERT INTO leave_types (id, name, grant_method, expiry_months, is_statutory, description, display_order)
VALUES ('lt-paid', '有給休暇', 'periodic', 24, true, '労基法 39 条の年次有給休暇。勤続・週所定に応じて周期自動付与', 1)
ON CONFLICT (id) DO NOTHING;

-- 既定の勤怠ルール（fallback。運用開始時に設定画面から調整する）
INSERT INTO attendance_rules (id, name, applies_to, default_for, work_start, work_end, break_minutes, closing_day, legal_holiday_weekday)
VALUES ('ar-standard', '標準（9:00-18:00 休憩60分）',
        '["director","employee","contract","parttime"]',
        '["director","employee","contract","parttime"]',
        '09:00', '18:00', 60, 31, 0)
ON CONFLICT (id) DO NOTHING;

-- アプリ設定の既定値
INSERT INTO app_configs (key, value) VALUES ('reportInputMode', '"both"')
ON CONFLICT (key) DO NOTHING;
