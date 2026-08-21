-- 0078: 週報・月報の権限ルールを旧 'reports' キーから新キーへ物理移行（改善要望 2026-08-21）。
-- 背景: 独立化（2026-08-20 第2バッチ）では「新キーの明示ルールが無い間は旧 'reports' 設定を継承する」
--       動的フォールバックで下位互換を取っていたが、旧キーの deny が権限管理画面に表示されず
--       解除もできない（権限表は ✓ なのに週報のタブが出ない）実バグの原因になった。
--       本マイグレーションで旧ルールを新キーへ移し、動的継承は撤去する（shared/domain/permissions.ts）。
--       以後、権限表に見えるルール = 実効ルール。deny は勝手に緩めず、そのまま新キーへ移す
--       （解除は権限管理画面から通常操作で可能になる = 取消可能性の回復）。
-- 冪等: 旧形式（resource='reports' AND field LIKE 'tab:weekly-%' 等）の行が無ければ全文 no-op。
-- 実行順の要点: 機能レベルの複製（ステップ 1）を**タブ移行より先**に行う。複製スキップ判定の
--   「新キー側の active ルール」が、直後に移行される旧タブルールを「管理者の新設定」と誤認して
--   機能 deny の複製を落とす（= deny 緩和）ことを防ぐため（判定時点の新キールール = 管理者が実際に
--   作ったもののみ、が成立するのは移行前だけ）。
SET search_path TO app_office;

-- 1) 機能レベル（field IS NULL）の 'reports' ルールは分割前「日報・週報・月報の全体」を意味していたため、
--    weekly-report / monthly-report へ複製する（旧行は日報用としてそのまま残す）。
--    同一対象（subject）が新キー側に**何らかの active ルール**（タブルール含む・field 不問）を既に持つ場合は
--    「その対象は新キーで明示管理されている」とみなし複製しない（管理者の新設定を deny 複製で
--    上書き強化しない。切替判定は subject 単位 = 対象ごとの意図を保存する。旧動的継承の resource 単位切替
--    〔他 subject の設定が全員へ波及〕は偶発的挙動として引き継がない = 設計判断）。
--    同 id の複製が既にあれば ON CONFLICT でスキップ（冪等。再適用時は前回の複製行が NOT EXISTS で検出される）
INSERT INTO permission_rules (id, subject_kind, subject_id, resource, field, effect, active)
SELECT old.id || ':wr', old.subject_kind, old.subject_id, 'weekly-report', NULL, old.effect, true
FROM permission_rules old
WHERE old.resource = 'reports' AND old.field IS NULL AND old.active
  AND NOT EXISTS (
    SELECT 1 FROM permission_rules n
    WHERE n.active AND n.resource = 'weekly-report'
      AND n.subject_kind = old.subject_kind AND n.subject_id = old.subject_id
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO permission_rules (id, subject_kind, subject_id, resource, field, effect, active)
SELECT old.id || ':mr', old.subject_kind, old.subject_id, 'monthly-report', NULL, old.effect, true
FROM permission_rules old
WHERE old.resource = 'reports' AND old.field IS NULL AND old.active
  AND NOT EXISTS (
    SELECT 1 FROM permission_rules n
    WHERE n.active AND n.resource = 'monthly-report'
      AND n.subject_kind = old.subject_kind AND n.subject_id = old.subject_id
  )
ON CONFLICT (id) DO NOTHING;

-- 2) 週報タブルール: reports/tab:weekly-<k> → weekly-report/tab:<k>
--    新キー側に同一対象・同一タブの active ルールが既にあれば移さず旧行を無効化（新キー優先）
UPDATE permission_rules AS old
SET active = false, updated_at = now()
WHERE old.resource = 'reports' AND old.field LIKE 'tab:weekly-%' AND old.active
  AND EXISTS (
    SELECT 1 FROM permission_rules n
    WHERE n.active AND n.resource = 'weekly-report'
      AND n.field = 'tab:' || substr(old.field, 12)
      AND n.subject_kind = old.subject_kind AND n.subject_id = old.subject_id
  );

UPDATE permission_rules
SET resource = 'weekly-report', field = 'tab:' || substr(field, 12), updated_at = now()
WHERE resource = 'reports' AND field LIKE 'tab:weekly-%' AND active;

-- 3) 月報タブルール: reports/tab:monthly-<k> → monthly-report/tab:<k>
UPDATE permission_rules AS old
SET active = false, updated_at = now()
WHERE old.resource = 'reports' AND old.field LIKE 'tab:monthly-%' AND old.active
  AND EXISTS (
    SELECT 1 FROM permission_rules n
    WHERE n.active AND n.resource = 'monthly-report'
      AND n.field = 'tab:' || substr(old.field, 13)
      AND n.subject_kind = old.subject_kind AND n.subject_id = old.subject_id
  );

UPDATE permission_rules
SET resource = 'monthly-report', field = 'tab:' || substr(field, 13), updated_at = now()
WHERE resource = 'reports' AND field LIKE 'tab:monthly-%' AND active;
