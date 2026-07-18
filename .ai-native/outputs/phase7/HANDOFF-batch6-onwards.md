# 引き継ぎドキュメント: バッチ6 以降（AI カンパニー後の残タスク）

- **作成日:** 2026-07-18
- **作成者:** Claude（Fable → Opus 引き継ぎ時）
- **目的:** セッションリセット後の担当（Fable）がオペレーター指示なしで残タスクを継続できるようにする
- **SoT:** 進捗は `implementation-status.md`、本番構成は `production-architecture.md`。本ファイルは残タスクの設計メモ

---

## 0. 現在地（2026-07-18 バッチ6b 時点で更新）

`akebono-office` をモックアップから本番（Cloud Run API + RDS PostgreSQL・Vertex AI）へ段階移行中。
**開発ブランチはセッションごとに指定される**（バッチ6a までは `claude/nice-mayer-ipu30d`、
バッチ6b 以降は `claude/akebono-batch6b-onwards-3kma75`）。1 バッチ = 1 PR で、マージ後に必ず
ブランチを最新 main から再作成する（後述の「運用慣行」参照）。

- **バッチ6a（PR #35）・6b（PR #36）・6c（PR #37）はマージ済み**（6b の ETL 出力先 = app_office 内
  mart 互換テーブル。オペレーター判断 2026-07-18。§1〜2 参照）。**バッチ6d（AKEBONO F-03）は本 PR で
  実装済み（§3 参照）= 本ドキュメントの残タスクはすべて完了**
- **マイルストーン達成: 全ドメインの API 接続が完了し、mock-status は空 = API モードのモックバッジ全廃**。
  唯一の未移行はドキュメント管理（表示のみのデモデータ・バッジ対象外の設計判断）
- 旧セッションの scratchpad（E2E スタック 16 スイート）は**コンテナ再作成で消失**。
  バッチ6b で E2E ハーネスを scratchpad `e2e/` に再構築した（§4 検証スタック参照）。
  現在のスイート: batch6b（12）+ batch6c（16）+ batch6d（11）+ モック回帰（10）

### 完了済み（マージ済み PR）
- バッチ1〜4b: 勤怠・休暇・日報・マスタ・設定・通知・エスカレーション・ワークフロー・シフト・
  AI アシスタント・カレンダー・チャットボット応答・意思決定支援
- バッチ5a〜5e: 顧客関係マスタ分割 / セッション管理 / 権限制御基盤 F-16 / チャットボット全 DB 参照 /
  アカウント機能 + 日報 UX 改善
- オペレーター報告対応（2026-07-18）: マルチターン改善（PR #40）/ チャットボット DB 供給網羅 +
  キャッシュ実バグ 2 件（PR #41。implementation-status §17）/ 一覧順序の決定化 = CI フレーク閉塞（PR #42）/
  **営業日・祝日基盤**（public_holidays + attendance_rules.workingWeekdays/holidayAware +
  shared/domain/business-day + 内閣府 CSV 取込 + /masters/holidays 画面。implementation-status §18。
  **本番リリース後は管理者が /masters/holidays の「公式データから更新」を 1 回実行して祝日を初期投入する**）
- **バッチ6a（PR #35・独立レビュー 2 巡でブロッキング指摘ゼロに収束・オペレーターのマージ待ち）:
  AI カンパニー F-08**
  - migration は 0015（表定義）+ 0016（部分一意索引 + AI ロール/社員シード）
  - **注意**: PR #35 の webhook 購読はセッションバインドのため、リセット後の新セッションには
    イベントが届かない。マージ済みかどうかは `pull_request_read`（get）で確認し、マージ済みなら
    「§4 運用慣行」のブランチ再作成手順を実行してから 6b に着手すること

### API 化が完了したドメイン
勤怠・休暇・日報（週報含む）・マスタ全種・設定・通知・エスカレーション・ワークフロー・シフト・
AI アシスタント（F-14）・カレンダー・チャットボット（F-09-2）・意思決定（F-02）・権限（F-16）・
プロフィール（F-17）・**AI カンパニー（F-08・6a）**

### 未接続ドメイン（残タスク = 本ドキュメントの主題）
`mockup/app/utils/mock-status.ts` の `MOCK_PAGE_PATHS` に残る 3 ページ:
- `/sales` （F-15 売上管理）
- `/status`（F-11 提供システム稼働状況）
- `/akebono`（F-03 AKEBONO = プレースホルダ）

---

## 1. バッチ6b: 売上管理（F-15）+ mart ETL 基盤 — **実装済み（本 PR）**

> **結果メモ（2026-07-18）:** オペレーター確認の結果、mart ETL の出力先は
> **app_office 内の mart 互換テーブル（fact_sales / mart_load_runs・migration 0017）** に決定。
> 実装は下記方針どおり（sales_monthly 冪等 upsert・/v1/sales・shared/domain/fiscal・
> useSales デュアルモード + 実績登録モーダル・chatbot 売上文脈・機能ガード 'sales'・
> /jobs/sales-mart-etl）。詳細は implementation-status.md §13 が SoT。

### 要件（F-15-1）
年度選択 → 月次推移・前年比・粗利率・顧客別/事業種別内訳の KPI + チャート。意思決定支援（F-02）への導線。

### モック実装（参照元）
- `mockup/app/composables/useSales.ts`（163 行）: SoT = `salesMonthly` コレクション。会計年度は自社
  （companies kind='self'）の fiscalStartMonth 起点。表示射影はすべて純粋 computed
- `mockup/app/pages/sales.vue`（100 行）
- 型: `SalesMonthly`（shared/domain/types.ts）。seed = `buildSalesMonthly()`（data/seed）

### 設計方針
1. **DB**: migration 00XX で `sales_monthly` テーブル（month・customer_id・project_type・amount・cost 等。
   SalesMonthly 型に合わせる）。**汎用マスタではなく専用 read + 管理者の登録/取込 API**。
   売上は**記録系ではなく実績データ**なので、月次の upsert（冪等キー = month × customer × type）を想定
2. **mart ETL（data-design.md §2 が SoT）**: これがバッチ6b の肝。akebono-scm-platform の `mart` 規約準拠で
   `fact_sales`（tenant_key・dim_date_key・customer party_key・project_type・amount・cost・margin）を
   app_office → mart へ**一方向 ETL**（逆流禁止）。共有ディメンション（dim_date/dim_party/dim_tenant）は
   既存資産を利用。冪等キー `UNIQUE(tenant_key, source_txn_id)`・監査列 `load_run_id, created_at`。
   - **重要**: data-design.md §2 に fact_sales / dim_ext_tsun_project 等の提案スキーマが既にある。
     まずそれを精読すること。ETL は日次バッチ（Cloud Run Job 想定）か API トリガのどちらかを設計判断
   - 日報原文は mart に載せない（件数・工数のみ）= ai-manager 原則。売上は金額のみなので問題なし
3. **API**: `/v1/sales`（GET 集計・POST/PUT 月次登録）。featureGuard に `sales` 追加（F-16）。
   会計年度計算は shared/domain へ純粋関数として切り出し、フロント/API 共有
4. **フロント**: useSales デュアルモード化（既存パターン = useReports 等を踏襲）。mock-status から /sales 除去
5. **チャットボット文脈**: 売上は移行済みになるので buildContext に売上ブロック追加（can('sales')）

### 検証
統合テスト（月次 upsert 冪等・会計年度集計・mart ETL の冪等 UNIQUE・sales deny 403）+ E2E スイート
（年度選択 → KPI 表示）+ モック回帰。

### 注意
mart は akebono-scm-platform 側のスキーマ。**このリポジトリ（akebono-office）には mart テーブルは無い**。
ETL の出力先を app_office 内の派生テーブルにするか、実際に akebono-scm-platform の mart へ書くかは
オペレーター確認が必要（現状 akebono-scm-platform リポジトリはこのセッションのスコープ内）。
**ETL 先の設計はオペレーターに AskUserQuestion で確認してから着手を推奨**（アーキテクチャ級の判断のため）。

---

## 2. バッチ6c: 提供システム稼働状況（F-11）— **実装済み（本 PR）**

> **結果メモ（2026-07-18）:** 下記方針どおり実装。uptime_daily の SoT はインシデントで、
> shared/domain/uptime の純粋関数から日次導出（窓内 DELETE→INSERT = 冪等。トリガ =
> 登録/更新時 + /jobs/uptime-rollup + 管理者の手動再計算）。モックの乱数 uptime シードは
> 本番へ持ち込まない。詳細は implementation-status.md §14 が SoT。

### 要件
- F-11-1 全体サマリ: コンポーネント状態（operational/degraded/partial_outage/major_outage/maintenance）の
  最悪値ロールアップ → 全体バナー + システム一覧
- F-11-2 システム詳細: 90 日稼働率バー（日別色分け）+ uptime% + インシデント履歴
- F-11-3 インシデント管理: ライフサイクル investigating → identified → monitoring → resolved・
  影響度 minor/major/critical・タイムスタンプ付きフィード（管理者操作に反応）

### モック実装（参照元）
- `mockup/app/composables/useSystemStatus.ts`（205 行）
- `mockup/app/pages/status/index.vue`・`status/[id].vue`
- 型: `SystemService`・`ServiceIncident`・`UptimeDaily`。seed = seedSystemServices / seedServiceIncidents /
  buildUptimeDaily()

### 設計方針
1. **DB**: `system_services`（汎用マスタ的だが components jsonb を持つ）・`service_incidents`（記録系 =
   ライフサイクル状態機械 + updates[] 追記）・`uptime_daily`（日次集計 = serviceId × date）
2. **API**: `/v1/status`（GET サマリ・詳細）+ `/v1/status/incidents`（POST 起票・状態遷移。管理者のみ）。
   featureGuard に `status` 追加。インシデントは記録系 = FOR UPDATE の状態機械（ワークフロー・AI タスクと同型）
3. **uptime_daily**: インシデントの影響時間から日次 downMinutes を算出する集計。日次バッチ or
   インシデント解決時の再計算。冪等性に注意
4. **フロント**: useSystemStatus デュアルモード化。mock-status から /status 除去
5. **チャットボット文脈**: 稼働状況ブロック追加（can('status')）。「◯◯システムは今どう？」に答えられる

### 検証
統合テスト（インシデント状態機械・uptime 集計・status deny 403）+ E2E + モック回帰。

---

## 3. バッチ6d: AKEBONO（F-03）— **実装済み（本 PR）**

> **結果メモ（2026-07-18）:** 下記方針どおり実装（akebono_wishes 0019・/v1/akebono/wishes・
> useAkebono デュアルモード・機能ガード 'akebono'・チャットボット文脈）。mock-status は空になり
> **API モードのモックバッジ全廃**。詳細は implementation-status.md §15 が SoT。

### 要件（軽量）
- F-03-1 プレースホルダページ: 「要件定義中」バナー + 構想ロードマップ表示
- F-03-2 要望ボックス: 要望を投稿 → 受付リストに反映（操作反応の担保）

### 設計方針
最も軽量。要望ボックス（akebonoWishes コレクション）だけが実データを持つ。
1. **DB**: `akebono_wishes`（id・member_id・body・at。追記のみ）
2. **API**: `/v1/akebono/wishes`（GET 一覧・POST 投稿）。featureGuard に `akebono`
3. **フロント**: 該当 composable をデュアルモード化。mock-status から /akebono 除去 →
   **これで mock-status は空になり、API モードのモックバッジが全廃**（マイルストーン）

### 検証
統合テスト（要望投稿・一覧）+ E2E + モック回帰。

---

## 4. 運用慣行（必ず踏襲すること）

### ブランチ運用
- 開発は `claude/nice-mayer-ipu30d` 固定
- **マージ後は必ず再作成**: `git fetch origin main && git checkout -B claude/nice-mayer-ipu30d origin/main && git push -u origin claude/nice-mayer-ipu30d --force-with-lease`
- 1 バッチ = 1 draft PR。マージ済み PR は再利用しない（新規 PR を切る）

### コミット
- 末尾に必ず付与:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MQg2bQoDRkRjdB8NS6Hsd4
  ```
- **モデル ID（claude-fable-5 等）を push 物に入れない**（チャット返信のみ）

### PR
- draft で作成 → テンプレ準拠（変更概要 / 関連フェーズ Refs #2 / 変更内容 / 要件との整合性 /
  レビュー観点 / セルフチェック 10〜11 項目）
- 作成後 `subscribe_pr_activity`。bot の「セルフチェック N/M」green チェックコメントは対応不要
  （反復レビュー項目はレビュー収束後にチェックするため意図的に未チェック）
- **send_later は使用禁止**（オペレーターが拒否済み・定期チェックを再アームしない）

### 反復レビュー（原則9・必須）
- 各バッチのコミット後、**独立レビュー（general-purpose サブエージェント）をバックグラウンド起動**
- 指摘は重大→軽微を分類。**マージ前なら同 PR で修正 → 第 2 巡レビューで収束確認**、
  **マージ後に届いた指摘は次バッチの PR に取り込む**
- 「直した」で終わらず「直した結果も問題ない（新たな問題が出ていない）」まで確認

### 検証スタック（scratchpad。バッチ6b で再構築）
- 旧スタック（run-batch2a-stack.sh + 16 スイート）は旧コンテナの scratchpad ごと消失。
  バッチ6b でセッション scratchpad の `e2e/` 配下に再構築した:
  - `run-batch6b-stack.sh`: 使い捨て PostgreSQL + API（dev 認証・:8788・CORS_ORIGINS 必須）+
    API モード静的配信（:4174）+ モック静的配信（:4173）を起動し、E2E スイートとモック回帰を実行
  - `batch6b-e2e.cjs`（API モード実クリック 12 チェック）/ `mock-regression-e2e.cjs`（ナビ + 売上 + 主要ページ 9 チェック）
  - `lib.cjs`（playwright ヘルパー。**chromium は executablePath '/opt/pw-browsers/chromium' 固定**。
    `npm install playwright` を e2e/ 内で実行しておく）/ `serve.cjs`（SPA フォールバック付き静的配信）
  - 新バッチの E2E は `batchXX-e2e.cjs` を追加し、スクリプトの SUITES へ 1 行追記
  - ハマりどころ: ①フロントは**ハッシュルーティング**（URL は `/#/sales` 形式）②healthz は DB エラーでも
    200 のため「最終マイグレーションの schema_migrations 登録」を待ってからシードする ③tsx プロセスの
    pkill パターンは `tsx/dist/loader.mjs src/index.ts`（`tsx src/index.ts` では一致しない）
- ビルド: api = `npm run build`（dist に db/migrations コピー必須）/ mockup = `npx nuxt generate`
  （モック版 = 環境変数なし / API 版 = `NUXT_PUBLIC_API_BASE=http://127.0.0.1:8788 NUXT_PUBLIC_DEV_MEMBER_ID=m-e2e`）
- 各バッチ完了時: api typecheck / 単体 / 統合 / mockup typecheck / 単体 / E2E フルスタック / モック回帰
  を**全て green** にしてからコミット

### デュアルモード化の型（既存パターン = 原則3）
1. `MIGRATED_MASTERS`（useApi.ts）へ汎用マスタを追加、または専用キャッシュ（apiXxx ref +
   apiLoadOnce + onApiReset）を用意
2. composable 内で `isApi = useApiMode()` で分岐。API 経路は「API 書込 → キャッシュ取り直し」（原則6）
3. 操作関数を async 化 → ページ側の呼び出しも await 追随
4. 分解・集計など決定的ロジックは shared/domain へ切り出しモック/API で共有
5. featureGuard の PATH_FEATURES に機能キーを追加（F-16 権限準拠）
6. 移行済みになったドメインは chatbot.ts の buildContext にブロック追加（can(feature) ガード）
7. mock-status.ts から該当パスを除去 + 全ドキュメント更新（原則5）

### ドキュメント（原則5・毎バッチ全件チェック）
- `phase3/functional-requirements.md`（機能表）
- `phase5/api-design.md`（composable 契約 + エンドポイント + AKO エラーコード台帳）
- `phase5/data-design.md`（エンティティ §1 + mart §2）
- `phase7/implementation-status.md`（§2 対象外表 + バッチ DoD セクション追記）
- `phase7/production-architecture.md`（バッチ一覧）
- 必要に応じ `phase5/screen-design.md`・`phase7/deploy-guide.md`

### エラーコード
`AKO-{領域}-{番号}` を api-design.md の台帳へ必ず起番。既存: AKO-AIC（AI カンパニー）・AKO-PRM（権限）・
AKO-CHT（チャット）・AKO-REP（日報）など。売上は AKO-SAL、稼働状況は AKO-STS 等を新設想定。

---

## 5. 既知の技術的注意点（CLAUDE.md 由来 + 実障害）

- **Zod v4 の .partial()**: `.default()` フィールドに既定値を注入する。部分更新は masters.ts の
  `Object.hasOwn` フィルタで実在キーのみ更新（部署配属で email 消失の実障害あり）。
  派生値は patchSchema から `.omit()` する（ai-employees.status の例）
- **JST**: timestamptz は表示時 `to_char(... AT TIME ZONE 'Asia/Tokyo', ...)` で JST 文字列化。
  記録系の at 列は JST ISO 文字列（text 型）
- **並行冪等**: 「既存チェック → INSERT」は並行時に破れる。部分一意インデックス + ON CONFLICT DO NOTHING で
  DB 保証する（AI 日次報告 daily_reports_ai_uq が実例。6a レビューで発覚）
- **dedupe キー**: lib/escalate.ts は先頭 2 セグメント + reason + クールダウンで判定。
  3 セグメント目（日付等）は照合されないので付けない
- **SVG クリックの E2E**: isometric office 等の SVG 要素はヒットテストで弾かれることがある →
  `{ force: true }` + `.first()`（aria-label 経由）
- **マイグレーションのシード**: 新テーブルの初期データは migration で `ON CONFLICT (id) DO NOTHING`
  投入（decision_themes 0011・ai_roles/ai_employees 0015 が実例。手動投入を残さない = 原則1）

---

## 6. オペレーター（yamashita@tsunaguba.co.jp / GitHub: takahiro0428）の継承事項

- DB パスワード `Tsunaguba-001` が過去にチャット露出 → ローテーション推奨済み
- シークレットはチャット貼付禁止。OAuth secret は `setup-deploy-secrets.ps1 -GoogleOauthClientSecretPath`
  でファイル渡し。クライアント ID はチャット可だが未提供
- Vertex AI は ADC 認証。AI 機能は全て「LLM 失敗時は決定的ヒューリスティックへ縮退」（原則4）
- 標準スタック: Cloud Run API + RDS PostgreSQL・重処理サーバー側・Vertex AI で全 AI 機能
