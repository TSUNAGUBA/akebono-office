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
  バッチ6b で E2E ハーネスを再構築し、現在は**リポジトリ直下 `e2e/` にコミット済み**（検証スタック節参照）。
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
  **本番リリース後は管理者が /masters/holidays の「公式データから更新」を 1 回実行して祝日を初期投入する**）/
  **バッチ7a: AI 検索最適化基盤 + ナレッジのドキュメント取込**（search_docs = 派生・自動再生成 +
  Vertex 埋め込み・名寄せ照合・/v1/knowledge/import（.md/.txt/.pdf/.docx = pdfjs-dist + mammoth）。
  implementation-status §19。新規依存: pdfjs-dist・mammoth（api/dependencies）。
  テストフィクスチャ（api/test/fixtures/sample.pdf・sample.docx）はコミット済みバイナリ（最小の
  標準準拠ファイル。再生成が必要なら pdf-lib 等で作り直す）。
  検索インデックスは起動時に自動生成されるため運用の手動ステップなし）/
  **権限設定 UX 2 件**（PR #46 = 項目キーの論理名オートコンプリート / PR #47 = 権限表モード）/
  **バッチ7b: カレンダー同期対象の選択 + AI 社員間の依頼・連携**（selected_calendar_ids +
  GET/PUT /v1/calendar/calendars + 複数カレンダー横断同期 / AiRole.permissions の delegate 権限 =
  マネージャーロール + ai_tasks の親子連携列。implementation-status §22。
  **マネージャーロールはシードしない = オペレーターが /ai-company/roles で delegate 権限を付けて作成**）
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

### 検証スタック（リポジトリ `e2e/`。PR #56 R1 M-7 対応でコミット済み）
- 旧スタック（run-batch2a-stack.sh + 16 スイート）は旧コンテナの scratchpad ごと消失。
  バッチ6b で再構築し、**7g R1 レビュー（M-7: 「E2E green」の主張がリポジトリ内で検証不能）を受けて
  リポジトリ直下 `e2e/` へコミットした**（README.md に前提・実行手順。chromium は
  CHROMIUM_PATH → /opt/pw-browsers/chromium → playwright 既定の順で解決するよう可搬化）:
  - `run-batch6b-stack.sh`: 使い捨て PostgreSQL + API（dev 認証・:8788・CORS_ORIGINS 必須）+
    API モード静的配信（:4174）+ モック静的配信（:4173）を起動し、E2E スイートとモック回帰を実行
  - `batch6b-e2e.cjs`（API モード実クリック 12 チェック）/ `mock-regression-e2e.cjs`（ナビ + 売上 + 主要ページ 9 チェック）
  - `lib.cjs`（playwright ヘルパー。`npm ci` を e2e/ 内で実行しておく）/
    `serve.cjs`（SPA フォールバック付き静的配信）
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

---

## 9. バッチ7c 設計メモ（オペレーター指示 2026-07-19 #4）— **実装済み（implementation-status §23 が SoT）**

要求: ①ぽいぽいメモを AI業務アシスタントから独立メニュー化（任意で PJ/顧客/業務種別を選択） ②業務種別のマスタ化 ③議事録登録メニュー（同じ選択肢） ④両方 .md/.txt/.pdf/.docx（.word=docx。旧 .doc は変換案内）アップロード対応 ⑤AI 用インデックス/ベクター化して保管し、チャットボット・AI業務アシスタントが参照 ⑥AI業務アシスタントはチャットボットが参照する全データを参照して業務をアシスト ⑦日報・週報はフォーム入力が既定・AI アシストは補助。

設計（確定）:
- migration 0023: `work_categories`(id,name,display_order,active) / `notes`(id, member_id, kind('poipoi'|'minutes'), title, body, project_id?, company_id?, work_category_id?, source('text'|'upload'), created_at。記録系=追記+論理削除なし・修正は将来) / `note_files`(knowledge_files と同型) / `search_docs` へ `owner_member_id text NULL` 追加（NULL=全員参照可。poipoi は本人のみ = C3）
- MASTERS registry へ 'work-categories'（idPrefix 'wc'）。mockup: workCategories コレクション + MIGRATED_MASTERS + /masters カード + 汎用マスタページ（industries ページのパターン）
- API `/v1/notes`: GET（?kind=。poipoi=本人のみ / minutes=全員） POST（本文 + 任意 projectId/companyId/workCategoryId） POST /import（extract-text 再利用・note_files 原本保全・AKO-NOTE-001〜003 = KNW と同型） GET /:id/files・/files/:id（poipoi は本人ガード）。書込後 scheduleSearchRebuild
- FEATURE_PERMISSION_KEYS へ 'poipoi'（ぽいぽいメモ）・'minutes'（議事録）追加。featureKeyOfPath も
- search-index: buildSearchDocs へ kind 'note' 追加（title=タイトル or 冒頭、segments= 本文/紐付け(PJ/顧客/業務種別名)。checks は notes.body 等 + 紐付け先 name）。poipoi → ownerMemberId=member / minutes → null。searchDocsFor へ user.id を渡し WHERE owner_member_id IS NULL OR = user
- chatbot buildContext: searchDocsFor 呼び出しへ user.id（既存呼び出しの変更のみ）
- assist（⑥）: /v1/assist/report-draft の LLM プロンプトへ buildContext(pool, user, その日の材料要約, rules, [], env) を cap して供給（LLM 無効時は従来どおり）。poipoi 材料は notes(kind=poipoi, 当日, 本人) + 旧 assist_logs の両方を読む（下位互換）
- ぽいぽいメモは 2 系統併存の設計判断: 独立メニュー（/poipoi）= notes（検索インデックス対象・日付 = 登録日）/ AI業務アシスタント内の従来入力 = assist_logs（過去日付指定に対応・従来互換）。日報ドラフト材料は両ソースを合流して読む
- ページ: /poipoi・/minutes（一覧 + テキスト登録 + アップロード + PJ/顧客/業務種別セレクト任意）。ダッシュボード 業務ツールカテゴリへカード 2 枚。useNotes composable（デュアルモード）
- ⑦: reports.vue の entryMethod 既定を 'form' へ（設定既定 'both' は維持 = フォーム主・アシスト補助）

---

## 10. バッチ7d 設計メモ（オペレーター指示 2026-07-19 #5）— **実装済み（implementation-status §24 が SoT）**

要求: ①議事録ファイルアップロードに誤操作時の立ち戻りフローがない。**本アプリ共通として、行った操作を取り消すフローを必ず用意** ②アップロードは選択で即実行せず取込ボタン押下を挟む。アップロードにも任意の PJ/顧客/業務種別紐付け ③ぽいぽいメモ・議事録の顧客/PJ 関連を正確に捉え、AI アシスタント・チャットボットに無関係な情報が混ざらないようにする。

設計（確定）:
- **共通原則化（①）**: CLAUDE.md 開発原則 9.5「操作の取消可能性」+ セルフチェック 11 を追加。新設・改修する操作に必須（既存機能への遡及は改修時に順次 = 残課題は implementation-status §24）。記録系 = 監査ログ付き論理削除。設定系 = 既存の archive/restore パターン
- migration 0024: `notes.active boolean NOT NULL DEFAULT true` / `search_docs.links jsonb NOT NULL DEFAULT '{}'`
- `POST /v1/notes/:noteId/archive`・`/restore`: poipoi = 本人のみ / minutes = 登録者 or 管理者。冪等（状態不一致 → 警告 no-op。UPDATE を active 条件付きで実行 = 同時実行でも監査 1 回）。監査ログ 'archive'/'restore' + scheduleSearchRebuild。一覧・検索インデックス・日報材料（assist.ts + useReportAssist）は active=true のみ。取消済みは `?includeArchived=1` で復元権限者にのみ可視・原本ファイルも復元権限者のみ
- UI（NotesPanel）: 選択 → ステージ表示（名前/サイズ/解除 X）→「この内容で取り込む」で実行（紐付けセレクト + タイトル欄の値を取込に適用・取込後クリア）。一覧行に取消ボタン（権限行のみ・確認ダイアログ）+ 取消済みトグルから復元
- 混入防止（③）: note の search_docs へ links={companyId?, projectId?} を保持（body_hash に算入。顧客未指定は PJ→顧客で補完）。chatbot リトリーバルで言及顧客/言及 PJ を**「今回の質問 → 履歴の新しい順 → 自社キーワード」の優先順**（findMentionedIn へ共通化・正規化最長一致）で解決し、**異なる紐付けの note ヒットをスキップ**（無紐付け note は対象のまま = フェイルオープン。複数顧客の比較質問は最長一致の 1 社解決 = 既存会社ブロックと同じ制約）。assist は buildContext 経由で同じ経路

---

## 11. バッチ7e 設計メモ（オペレーター指示 2026-07-19 #6）— **実装済み（implementation-status §25 が SoT）**

要求: ①日報・週報「チーム」タブの提出状況マトリクスで日付ヘッダーがメンバー列ヘッダーへ被る z-index 不具合の修正 ②ぽいぽいメモ →「ぽいぽいポスト」改称 + 管理者へのフィードバック/チーム改善活用（管理者はオリジナル内容を閲覧可） ③議事録は全員参照・登録日時/投稿者/サマリー(冒頭)の一覧 + 押下で全文 ④議事録・日報等のフリー入力文章のマークダウン入力・描画対応。

設計（確定）:
- ①: `.tbl th`（main.css）の `z-index:1` が詳細度で Tailwind `z-[2]` に勝つのが原因 → メンバー列 th を `!z-[2]` へ（該当は reports.vue のみ）
- ②: 内部キー `poipoi`・DB・API パスは不変（改称は表記レイヤのみ = 原則7）。管理者閲覧は `GET /v1/notes?kind=poipoi&scope=all`（admin 以外 403・active のみ）+ 原本ガードを「本人 or 管理者」へ。取消権限・検索インデックスの owner スコープ（AI 参照 = 本人のみ）は変えない
- ③: NotesPanel の一覧をサマリー行（冒頭 160 字・登録日時・投稿者）+ 詳細モーダル（UiModal + UiMarkdown）へ。議事録の参照範囲は従来どおり全員（C2）
- ④: 依存追加なしの自前サブセットパーサ（utils/markdown.ts）+ UiMarkdown（VNode 直接生成。v-html 禁止規約を維持 = XSS 構造的不成立・リンクは http(s) のみ）。保存はプレーンテキストのまま = 描画時解釈のみ。入力側は textarea + プレビュートグル（ノート登録・日報編集・週報編集）

---

## 12. バッチ7f 設計メモ（オペレーター指示 2026-07-19 #7）— **実装済み（implementation-status §26 が SoT）**

要求: ①権限表がすべて未設定 → 運用に即したデフォルトを DB へ登録 ②AI 社員を増やしたり減らしたりできるように ③AI カンパニーはステップが進むだけで結果を出していない → 実際に依頼内容を遂行し、人間のアクションが必要な箇所は依頼者にアクション・回答を求める。依頼者インプットはフリーテキスト + 画像（.jpg/.png）+ ファイル（.txt/.md/.pdf/.docx/.pptx）。

設計（確定）:
- ①: migration 0025 で role レイヤの deny 6 件（member: sales/decision/masters/settings・hr: sales/decision）を **有効ルールゼロの環境のみ**投入。モックシードにも同一内容（SEED_VERSION 6）。テストは beforeAll で一旦無効化（既存権限テストのクリーン前提を維持）し、専用テストが再有効化して検証（clearPermissionCache 必須 = 10 秒 TTL キャッシュ）
- ②: ai-employees は既存の汎用マスタ → 管理 UI（/ai-company/employees）を roles.vue と同型で新設。減員 = archive（論理削除）・復元 = restore。席（deskPosition）は 4 列グリッドへ自動割当
- ③: ai_tasks.outputs jsonb（成果物）+ ai_task_questions（依頼者への質問。open でブロック）+ ai_task_files（添付原本 + extracted_text）。progress = prepareStepExecution（LLM をロック外で実行 = prepareDelegationPlan と同じ配置。generateJson へ images = インライン画像を追加）→ tx 内で成果物追記 or 質問起票。フォールバック = shared/domain/ai-tasks の heuristicNeedsInput / heuristicStepOutput / buildFinalReport（モックと同一 = パリティ）。質問ブロック中の progress は AKO-AIC-014（状態ガードより先に判定）。回答 = POST /tasks/:id/answer（依頼者 or 管理者）。.pptx 抽出は jszip（ppt/slides/slideN.xml の <a:t> をスライド番号順）

---

## 13. バッチ7g 設計メモ（オペレーター指示 2026-07-19 #8/#9）— **実装済み（implementation-status §27 が SoT）**

要求: ①ぽいぽいポストの AI 参照は他メンバーの投稿も含めすべて参照 ②AI はユーザーの権限範囲内で全データを参照して回答・アクション ③権限設定で AI 参照を区分ごとに「すべて / 自分のみ」から設定 ④週報タブを週次全データからの AI インサイトビューへ（集計カード・グラフ・エグゼクティブサマリー・SWOT・リスク）。

設計（確定）:
- ai-scope = PermissionRule の擬似フィールド（スキーマ・migration 不要）。解決は shared aiReferenceScope（レイヤ・deny 優先は機能ルールと同一）。既定は AI_SCOPE_FEATURES で区分ごとに宣言（poipoi = all / attendance・ai-assistant = own）
- 文脈供給: searchDocsFor(allOwners) で poipoi の owner フィルタを条件化 + note ドキュメントへ投稿者セグメント。勤怠/タスク計画は scope=all のときのみ「チーム全体」ブロックを追加供給（既存の本人ブロックは不変）
- 週次インサイト: 集計（WeeklyMetrics）とヒューリスティック洞察は shared/domain/weekly-insight でモック/API 共有。LLM は API のみ（構造化出力・失敗時 heuristic）。保存しない設計（常に最新データから再生成・記録系を作らない）
- テスト注意: buildContext へは activePermissionRules(pool) の実ルールを渡すこと（[] を渡すと ai-scope ルールが効かない）。直接 SQL でルールを切り替えた後は clearPermissionCache 必須

## 14. バッチ7h 設計メモ（オペレーター指示 2026-07-19 #10）— **実装済み（implementation-status §28 が SoT）**

要求: ①チームタブの表示メンバー設定 + 誰の日報を参照できるかの権限制御 ②各ページから関連マスタ・設定へ到達
③戻る/関連ページ導線の整理（UX 設計） ④入力と参照の分離（参照 = 基本ビュー） ⑤カードメニューのカテゴリ化 + カスタマイズ。

設計（確定。UX 設計の本文は screen-design §5）:
- 導線 SoT = `mockup/app/utils/nav-map.ts`（parent/related）。レイアウトヘッダーが全ページ共通で描画（親リンク + 関連ドロップダウン）。ページ個別の戻るリンクは撤去済み — 新ページは nav-map へ登録する
- メニュー SoT = `mockup/app/utils/menu-registry.ts`（カード定義 + 既定カテゴリ）。カスタマイズは configs `menu-categories-<area>`（useMenuCategories。'' = 既定）。未割当カードは「その他」へ自動表示
- 日報参照権限 = PermissionRule 擬似フィールド `member:<対象 id>`（resource='reports'）。解決は shared `canViewMemberReports`（自分は常に可・未設定 = 可）。API scope=all/team・チャットボット他人日報・週次集計に同一適用。チームタブは全員公開（一般 = 提出済みのみ = API 側で下書き秘匿）
- 表示メンバー設定 = configs `teamVisibleMemberIds`（空 = 全員・自分は常に表示）。「表示の整理」と「権限」を役割分離
- テスト注意: scope=team の旧テスト（管理者のみ 403）は 7h 仕様（200・提出済みのみ）へ更新済み。参照 deny テストは clearPermissionCache + activePermissionRules の実ルールを渡す規約（§13 と同じ）

## 15. バッチ7i 設計メモ（オペレーター指示 2026-07-19 #11）— **実装済み（implementation-status §29 が SoT）**

要求: ①承認後は「進める」の連打なしで全自動実行 ②自 DB のみに頼らず WebSearch（インターネット）で情報収集して遂行
③依頼者への質問は「自社・顧客のドメイン情報が不可欠」「重要な意思表示が必要」のみに限定。

設計（確定）:
- 実行エンジン: `progressTaskOnce`（1 ステップ = 旧 progress ハンドラの本体）を HTTP と `autoRunTask`（fire-and-forget ループ）で共用。承認/回答/解除/手動「進める」が再開起点。排他は従来の FOR UPDATE 状態機械のまま = 専用状態なし・サーバー再起動しても「再開」で復帰
- Web 調査: `api/src/lib/llm.ts generateGroundedText`（Vertex `tools:[{googleSearch:{}}]`・出典 = groundingMetadata.groundingChunks.web）。**グラウンディングと responseSchema は併用しない**（調査テキスト → 構造化遂行の 2 段）。失敗は調査なし続行（原則4）
- 質問ポリシー: shared `heuristicNeedsInput` を限定（<10 字 or 内部参照 +<30 字のみ・? トリガー廃止）+ LLM システムプロンプトで限定
- テスト注意: 承認後は自動実行が走るため、**手動 progress の逐次ループで検証しない**。`waitAiTask`（ポーリングヘルパー）で収束を待つ。ブロックエスカレーション・中止分担ロールアップ等「実行中の子」が必要なテストは SQL で親子を直接セットアップする（承認経由だと分担が即完了して競合する）

## 16. バッチ7j 設計メモ（オペレーター指示 2026-07-19 #12）— **実装済み（implementation-status §30 が SoT）**

要求: ①週次インサイトは一度生成したら DB 保管・再生成まで保存結果を表示 ②日報は前日分までが正常であることを理解した生成 ③全体共通とログインユーザー向け個別（ロール・役職・所属で最適化）の分離。

設計（確定）:
- 保管 = `weekly_insights`（0026。週 × audience（'company'/'member:<id>'）一意 upsert = 導出キャッシュ）。GET は読むだけ・POST が生成。モックは weeklyInsights コレクション（SEED_VERSION 7）
- **共有保管物の権限処理が肝**: 全体は全量で集計・保管し、配信時に閲覧者マスク（売上 = sales・memberHours/issues = F-16-6 の memberId）。**洞察本文は個人名・売上に言及させない**（マスク不能なテキストに漏えい面を作らない）。売上・個人向けの言及は per-member 保管の個別インサイトが担う
- 前日まで前提: WeeklyMetrics.asOf / businessDaysElapsed（business-day + public_holidays）。提出系は asOf 基準・評価分母は経過営業日 × メンバー数
- テスト注意: 当日提出の除外検証は「新設メンバーで当日分を提出 → reportSubmitted 不変」のデルタ方式（実行日非依存）。GET が生成しなくなったため、旧「GET = 生成」前提のテストは POST → GET へ更新済み
