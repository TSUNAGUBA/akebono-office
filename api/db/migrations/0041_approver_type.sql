-- 0041: 承認経路の承認者指定を「役職/ロール/個人」の 3 種へ統一（オペレーター指示 2026-07-30）
--   稟議（workflow_routes）・勤怠（attendance_routes）の承認ステップを、旧 approverRole 単一プリセット
--   （manager/director/president/hr）から approverType（title/role/member）+ approverTitle/approverRole/
--   approverMemberId の判別式へ移行する。PermissionRule.subjectKind（role|title|member）と同じモデル。
--
-- 設計方針:
--   * steps は CHECK 無しの jsonb のため DDL 変更は不要。既存行のデータのみ新形式へ書き換える（原則7 = データ更新パッチ）。
--   * 行動保存的マッピング（現行の解決結果を変えない）:
--       個人指定(approverMemberId) → member
--       president → 役職「代表取締役」 / director → 役職「取締役」 / manager → 役職「マネージャー」
--       hr        → ロール「人事(hr)」
--   * 冪等（原則2）: approverType を既に持つ（= 新形式の）ステップは変換しない。
--   * 進行中申請の route_snapshot（workflow_requests / direct_requests / attendance_fix_requests）は凍結値のため
--     変換しない。解決側 pickApprover が旧形式もフォールバック吸収するため、進行中申請も正しく解決される。
SET search_path TO app_office;

-- 旧形式ステップ配列 → 新形式ステップ配列への変換（一時関数。両テーブルで共用し最後に破棄）
CREATE OR REPLACE FUNCTION _migrate_approver_steps(steps jsonb) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'order', s->'order',
      'approverType', CASE
        WHEN (s->>'approverMemberId') IS NOT NULL THEN 'member'
        WHEN (s->>'approverRole') = 'hr' THEN 'role'
        ELSE 'title' END,
      'approverRole', CASE
        WHEN (s->>'approverMemberId') IS NULL AND (s->>'approverRole') = 'hr' THEN 'hr'
        ELSE NULL END,
      'approverTitle', CASE
        WHEN (s->>'approverMemberId') IS NOT NULL THEN NULL
        WHEN (s->>'approverRole') = 'president' THEN '代表取締役'
        WHEN (s->>'approverRole') = 'director'  THEN '取締役'
        WHEN (s->>'approverRole') = 'manager'   THEN 'マネージャー'
        ELSE NULL END,
      'approverMemberId', s->'approverMemberId',
      'mode', COALESCE(s->'mode', '"serial"'::jsonb)
    ) ORDER BY (s->>'order')::int
  ), '[]'::jsonb)
  FROM jsonb_array_elements(steps) s;
$$ LANGUAGE sql IMMUTABLE;

UPDATE workflow_routes SET steps = _migrate_approver_steps(steps)
WHERE jsonb_typeof(steps) = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(steps) s WHERE (s ? 'approverRole') AND NOT (s ? 'approverType'));

UPDATE attendance_routes SET steps = _migrate_approver_steps(steps)
WHERE jsonb_typeof(steps) = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(steps) s WHERE (s ? 'approverRole') AND NOT (s ? 'approverType'));

DROP FUNCTION _migrate_approver_steps(jsonb);
