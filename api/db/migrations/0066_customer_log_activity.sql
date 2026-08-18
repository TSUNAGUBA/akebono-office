-- 0066: 顧客ログ → 顧客活動への改修（改修依頼 2026-08-18）。
--
-- (1) customer_logs.method: 活動手段（訪問 / Web会議 / 電話 / メール / チャット / その他）を追加。
--   単一選択・任意（'' = 未設定）。値の allowlist は shared/domain/types.ts の
--   CUSTOMER_LOG_METHOD_PRESETS（「値=ラベル」方式）を API/モックの検証層で担保する
--   （0065 と同じ「FK/CHECK ではなくアプリ層で担保」の方針 = プリセット追加時に migration 不要）。
--   既存データは '' = 未設定として自然に読める（下位互換 = 原則7）。
--
-- (2) 参照対象ルールの無効化（原則7 のデータ更新パッチ）:
--   一覧の表示範囲が「全メンバーの登録データを全員が閲覧できる」に変わったため（改修依頼 2026-08-18）、
--   旧「顧客ログの参照対象」（resource='customer-log'・field='member:<id>' / 'member:*' の許可制 =
--   canViewMemberCustomerLog）は撤去した。既存ルールは削除ではなく active=false の論理無効化で残す
--   （設定履歴の監査可能性を保つ。resource='customer-log'・field IS NULL の機能利用可否ルールは
--   従来どおり有効なまま = 対象外）。
--
-- 補足: 名称変更（顧客ログ → 顧客活動 / 属性タグ → 活動目的）は表示ラベルのみの変更で、
--   テーブル名 customer_logs・列名 tags は下位互換のため維持する（原則7）。
-- 冪等: ADD COLUMN IF NOT EXISTS + 条件付き UPDATE（再実行しても既存データは変化しない = 原則2）。
SET search_path TO app_office;

ALTER TABLE customer_logs ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT '';

-- 旧・参照対象ルール（member:...）の論理無効化（機能利用可否 = field NULL は対象外）
UPDATE permission_rules
   SET active = false
 WHERE resource = 'customer-log'
   AND field LIKE 'member:%'
   AND active = true;
