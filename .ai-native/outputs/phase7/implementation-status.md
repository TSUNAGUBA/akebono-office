# Phase 7: 実装状況マトリクス（モックアップ / 本実装）

- **作成日:** 2026-07-17
- **作成ロール:** コーディングエージェント
- **目的:** 全ページ・機能ごとに「モックアップ」「本実装」の有無を可視化し、本実装の進捗管理の SoT とする
- **更新ルール:** 実装 PR をマージするたびに本表を更新する（コードとドキュメントの一貫性 = 開発原則5）

## 凡例

| 記号 | 意味 |
|---|---|
| ✅ | 実装済み |
| 🚧 | 今回バッチで実装中（本 PR） |
| ⏳ | 未着手（バッチ割当済み） |
| — | 対象外（実装しない判断。備考参照） |

**本実装の 2 列の意味:**
- **API+DB** … Cloud Run 上の API（`api/`）と RDS PostgreSQL（`app_office` スキーマ）でのサーバーサイド実装
- **フロント接続** … Nuxt フロントエンドが `useMockDb`（localStorage）ではなく API を呼ぶ状態

**バッチ計画（オペレーター指示 2026-07-17: タイムカード・勤怠管理・業務日報・マスタメンテナンス・設定 を先行）:**
- **バッチ1（マージ済み PR #12）:** 対象メニューの API+DB・認証基盤・CI/CD（Cloud Run デプロイ）
- **バッチ2a（マージ済み PR #14）:** フロント接続基盤（デュアルモード・Firebase Auth ログイン・dev 認証）+ マスタ/設定のフロント接続 + 通知 API + 周期有給付与
- **バッチ2b-1（マージ済み PR #17）:** 通知 + 業務日報のフロント接続 + ログイン失敗理由の区別表示
- **バッチ2b-2（マージ済み PR #18）:** 勤怠・休暇のフロント接続（タイムカード・日次/週次/月次・36 協定・打刻修正・休暇管理）
- **UI 改修（マージ済み PR #19・#20）:** マスタ部分 PATCH 修正・役職マスタ管理・部署の任意化（未所属登録/配属解除）・モック実装バッジ
- **バッチ3a（マージ済み PR #21）:** エスカレーション（F-12）の API 化 + フロント接続（起票・対応・ナレッジ還流・36協定/日報課題/チャットボットの発火）
- **バッチ3b（マージ済み PR #22）:** ワークフロー・稟議（F-07）の API 化 + フロント接続（申請・経路凍結・承認/却下/差戻し・代理承認・証跡・承認経路マスタ）
- **バッチ3c（マージ済み PR #23）:** シフト表（F-05）の API 化 + フロント接続 + バッチ3b レビュー指摘対応
- **バッチ3d 基盤（マージ済み PR #24）:** Vertex AI クライアント（ADC 認証・キー不要）+ IAM/デプロイ反映（オペレーター指示 2026-07-17: AI 機能は Vertex AI）
- **バッチ3d（マージ済み PR #25）:** AI業務アシスタント（F-14）+ 日報 AI アシスト（F-06-7）の API 化 + フロント接続（LLM 失敗時はモックと同一ヒューリスティックへフォールバック）
- **バッチ3e（マージ済み PR #26）:** Google カレンダー連携（F-06-8）の API 化 + フロント接続（OAuth 2.0・トークン暗号化保管・予定同期・日報ドラフト材料）— バッチ3 完了
- **バッチ4a（マージ済み PR #27）:** チャットボット応答（F-09-3）の Vertex AI 一次応答化 + バッチ3e レビュー指摘対応（OAuth state の CSRF 対策・同期 upsert の SoT 保護・復帰導線修正ほか）
- **バッチ4b（マージ済み PR #28）:** 意思決定支援（F-02）の API 化 + フロント接続 + バッチ4a レビュー指摘対応 + フォント修正（palt 起因の文字潰れ）
- **バッチ5a（マージ済み PR #29・オペレーター指示 2026-07-17）:** 顧客関係マスタの「会社」「人」「関係種別」3 分割 + 関係種別の削除対応 + 提出済み日報の本人編集 + AI アシスト旧バッジ除去 + Calendar API 自動有効化 + バッチ4b レビュー指摘対応
- **バッチ5b（マージ済み PR #30/#31・オペレーター指示 2026-07-17）:** チャットボットのセッション管理（DB 永続・マルチターン・過去セッション再開・新規開始）
- **バッチ5c（本 PR・オペレーター指示 2026-07-17）:** 権限制御基盤 F-16（ロール/役職/個人の 3 レイヤ・機能単位ガード・表示項目レベル制御・権限設定 UI）
- **バッチ5 続き（オペレーター指示 2026-07-17）:** チャットボットの全 DB 参照化（権限準拠）
- **バッチ6a（マージ済み PR #35）:** AI カンパニー F-08 の API 化 + フロント接続
- **バッチ6b（マージ済み PR #36）:** 売上管理 F-15 + mart ETL 基盤（ETL 出力先 = app_office 内 mart 互換テーブル。オペレーター判断 2026-07-18）
- **バッチ6c（マージ済み PR #37）:** 提供システム稼働状況 F-11（インシデント状態機械 + uptime 日次集計）
- **バッチ6d（本 PR）:** AKEBONO F-03（要望ボックス API 化）— **全ドメインの接続が完了し、API モードのモックバッジ全廃（マイルストーン）**

> **フロント接続の方式（バッチ2a で確立）:** `NUXT_PUBLIC_API_BASE` 未設定なら完全モック動作（デモ環境の下位互換）。
> 設定時は「API モード」となり、移行済みコレクションは `useMockDb.tbl()` が API ハイドレーションキャッシュを返す
> （全画面の参照が一貫して API データ）。書込は `useMasterCrudAsync` 等の API 経路のみ。認証は Firebase ID トークン
> （`/login` ページ）または dev 認証（`NUXT_PUBLIC_DEV_MEMBER_ID`。ローカル/E2E 専用）。

## 1. 対象メニュー（バッチ1 = 本実装着手済み）

### タイムカード（ヘッダーモーダル）+ 勤怠管理 `/attendance`

| 画面 / 機能 | 機能ID | モックアップ | 本実装 API+DB | 本実装 フロント接続 | 備考 |
|---|---|:---:|:---:|:---:|---|
| ヘッダー「タイムカード」モーダル（打刻） | F-01-3 | ✅ | ✅ `POST /v1/attendance/punches`・`GET /v1/attendance/state` | ✅ | 状態機械（未出勤→勤務中⇄休憩中→退勤済）をサーバー側で強制。同時打刻は advisory lock で直列化 |
| 日次ビュー（6 バケット分解） | F-04-1 | ✅ | ✅ `GET /v1/attendance/day` | ✅ | 集計はサーバーサイド（shared/domain/attendance-calc を共有） |
| 週次ビュー（週 40h 判定） | F-04-2 | ✅ | ✅ `GET /v1/attendance/month` の射影 | ✅ | 週次グリッドは月次 API 2 回呼び（月跨ぎ週）のフロント射影で構成 |
| 月次ビュー | F-04-3 | ✅ | ✅ `GET /v1/attendance/month` | ✅ | 60h 超繰越を含む月次集計をサーバーサイドで実行 |
| 36 協定アラート | F-04-4 | ✅ | ✅ `GET /v1/attendance/alerts` + `POST /v1/escalations/overtime-check` | ✅ | 直近 6 ヶ月の全平均判定。本人の月次閲覧を契機にサーバー判定で起票（冪等） |
| 休暇管理（本人: 残数・義務・申請） | F-04-5 | ✅ | ✅ `GET /v1/leave/balance` `GET /v1/leave/obligation` `POST /v1/leave/requests` | ✅ | FIFO 引当・失効・40 日上限（法定のみ）・年 5 日義務をサーバーサイドで計算 |
| 休暇申請の承認/却下 | F-04-5 | ✅ | ✅ `POST /v1/leave/requests/:id/decision` | ✅ | 管理者/人事のみ（AKO-LEV-002/003 ガード） |
| 打刻修正申請・承認 | F-04-6 | ✅ | ✅ `POST /v1/attendance/fix-requests`（+ `/decision`） | ✅ | 元打刻は削除せず保全。全件参照は管理者/人事（承認は管理者のみ）（記録系追記のみ）。承認は管理者のみ |
| 勤怠ルール設定 | F-04-7 | ✅ | ✅ `/v1/masters/attendance-rules` | ✅（バッチ2a のマスタ接続） | defaultFor の区分ごと 1 ルール排他を DB トランザクションで保証 |
| 全員のタイムカード（フィルター付きテーブル。旧称: タイムカード = §36 で改称） | F-04-8 | ✅ | ✅ `GET /v1/attendance/timecard` | ✅ | 期間（上限 62 日）× 部署 × 氏名。メンバー横断集計をサーバーサイドで実行。参照可否は権限表（attendance / timecard-all。既定 = 管理者/人事） |
| タイムカード（本人・独立メニュー `/timecard`） | F-04-10 | ✅ | ✅ 既存 API を利用（`/v1/attendance/month` = 本人分） | ✅ | §36 で F-04-8 から切り出し。本人の打刻 + 期間内の出退勤一覧のみ |
| 休暇管理（管理者/人事: 一覧/明細・個別/一括付与） | F-04-9 | ✅ | ✅ `POST /v1/leave/grants`（+ `/bulk`）`GET /v1/leave/grants` | ✅ | 冪等性は DB UNIQUE 制約（member × 種別 × 付与日）で保証 |
| 有給の周期自動付与（労基法 39 条テーブル） | F-04-5 | ✅（シードで表現） | ✅ `POST /v1/leave/periodic-grants/run`（管理者/人事）+ `/jobs/periodic-leave-grants`（Cloud Scheduler・CRON_SECRET） | ✅ 手動実行はサーバー / 定期実行は Cloud Scheduler | 入社日 + 6 ヶ月 + n 年で走査し UNIQUE 制約で冪等付与。当日付与分のみ本人へ通知 |

### 業務日報 `/reports`

| 画面 / 機能 | 機能ID | モックアップ | 本実装 API+DB | 本実装 フロント接続 | 備考 |
|---|---|:---:|:---:|:---:|---|
| 日報の作成・下書き・提出・提出後編集 | F-06-1 | ✅ | ✅ `PUT /v1/reports/daily` | ✅ | 提出済みは本人が編集可（PR #29・オペレーター指示 2026-07-17。提出状態・初回提出時刻は維持し編集を監査ログへ記録。下書きへ戻す操作のみ AKO-REP-001）。0.25h 刻み正規化をサーバー側で実施 |
| 自分の日報一覧・提出状況 | F-06-2 | ✅ | ✅ `GET /v1/reports/daily`（month / from-to 期間指定） | ✅ | 月単位の遅延ロードキャッシュ（画面の射影ロジックはモックと共通） |
| チーム提出状況・タイムライン（バッチ7h で全員公開） | F-06-5 | ✅ | ✅ `GET /v1/reports/daily?scope=team`（期間必須。管理者 = 下書き含む / 一般 = 提出済みのみ） | ✅ | 表示メンバー設定 ∩ 日報参照権限 F-16-6（§28 参照。バッチ7k で候補 = 在籍全メンバー・§31 参照） |
| コメント・リアクション | F-06-6 | ✅ | ✅ `GET/POST /v1/reports/:id/comments`・`POST /v1/reports/comments/:id/reactions`（トグル） | ✅ | コメント時の作成者通知はサーバー発火。コメントスレッドは参照ガード付き（他人の下書き 404・F-16-6 deny 404 = §28） |
| 週報 | F-06-4 | ✅ | ✅ `GET/PUT /v1/reports/weekly` | ✅ | 提出済みは編集不可（AKO-REP-002）。提出時の主要業務必須をサーバー側でも検証 |
| 工数乖離チェック（勤怠実労働との差） | F-06-3 | ✅ | ✅ 提出レスポンスの `hoursGapMinutes` | ✅ | 60 分超のみ返却。提出時警告はサーバー計算値。一覧・編集中の乖離表示は勤怠接続（PR #18）で有効化 |
| 日報リマインド通知 | F-06-2 | ✅ | ✅ `POST /v1/reports/remind`（管理者 → 対象者へ通知） | ✅ | |
| AI アシスト材料サマリ・ドラフト生成 | F-06-7 | ✅ | ✅ `/v1/assist`（logs・answers・memos・report-draft。PR #25）| ✅ | ドラフト = Vertex AI 構造化出力 + 出力正規化 → 失敗時 shared ヒューリスティック。生成結果は保存しない。カレンダー材料は PR #26（F-06-8）で接続済み |
| 提出時の課題エスカレーション | F-06-3 | ✅ | ✅ `PUT /v1/reports/daily` がサーバー側で起票 | ✅ | クールダウン中（AKO-ESC-001）は共有済みとして扱う |

### マスタメンテナンス `/masters/*`

| 画面 / 機能 | 機能ID | モックアップ | 本実装 API+DB | 本実装 フロント接続 | 備考 |
|---|---|:---:|:---:|:---:|---|
| メンバー | F-10-1 | ✅ | ✅ `/v1/masters/members` | ✅ | email 一意制約（Firebase Auth 突合キー）。部署は任意（未所属で登録可・部署画面から配属/解除） |
| 部署・組織図 | F-10-9 | ✅ | ✅ `/v1/masters/departments` | ✅ | 循環親子（AKO-DEP-003）を再帰 CTE で検査。無効化ガード（AKO-DEP-001/002） |
| 休暇種別 | F-10-10 | ✅ | ✅ `/v1/masters/leave-types` | ✅ | 法定有給はシード固定（AKO-LEV-008）。人事も編集可 |
| 役職 | F-10-11 | ✅ | ✅ `/v1/masters/code-masters`（category=title のビュー） | ✅ | 専用ページ `/masters/titles`。初期値はマイグレーション 0004 で投入。メンバーは役職名（ラベル）を保持するため名称変更は登録済みメンバーへ遡及しない（設計判断） |
| 業界 | F-10-2 | ✅ | ✅ `/v1/masters/industries` | ✅ | |
| 自社 / 顧客(会社) | F-10-3 / F-10-4 | ✅ | ✅ `/v1/masters/companies` | ✅ | kind（self/customer）で共用 |
| 顧客(人) | F-10-5 | ✅ | ✅ `/v1/masters/contacts` | ✅ | |
| 顧客関係(会社) / 顧客関係(人) / 関係種別 | F-10-6 | ✅ | ✅ `/v1/masters/company-relations` `/v1/masters/contact-relations` `/v1/masters/relation-types` | ✅ | PR #29 でメニュー・ページを 3 分割（オペレーター指示 2026-07-17: 顧客関係(会社)・顧客関係(人)・関係種別）。関係エッジは物理削除可、関係種別は未使用のみ物理削除可（使用中は AKO-RTM-001 → 無効化を案内）。ナレッジは既存の 5 ドメインで 会社/人 それぞれに紐付け可。顧客関係(人) の端点は顧客担当者に加えて自社メンバーも選択可（オペレーター指示 2026-07-17） |
| プロジェクト | F-10-7 | ✅ | ✅ `/v1/masters/projects` | ✅ | |
| ナレッジ | F-10-8 | ✅ | ✅ `/v1/masters/knowledge` | ✅ | 裁定還流（エスカレーション→ナレッジ）は PR #21 で接続済み |
| グラフ可視化（関係マップ） | F-10-6 | ✅ | —（API 不要） | ✅ | 表示射影はフロントの責務（マスタ API のデータから描画） |
| 監査ログ記録（全マスタ変更） | F-10-12 | ✅ | ✅ 全変更 API で記録（非ブロッキング） | ✅ | |
| 権限設定 | F-16 | —（バッチ5c で新設） | ✅ `/v1/masters/permission-rules`（0013）+ 機能ガード middleware（AKO-PRM-001）+ マスタ GET の表示項目剥がし（PR #32） | ✅ `/masters/permissions`（権限表 = ページ > 機能 > 項目 の階層マトリクス（既定タブ）+ ルール一覧の 2 モード）+ メニュー/ページ/カードの非表示 + ルートガード | 解決順 = 個人 > 役職 > ロール（同一レイヤは拒否優先。同一レイヤ内は明示キー → 一括キー（マスタ全体 = field null / 全メンバー = member:*）→ の順で参照 = バッチ7m。どのレイヤにも無ければアプリ既定値 = 許可（AIアシスタント参照のみ許可制）= 下位互換）。既存ロールガードは緩められない制限レイヤ。/v1/masters・configs・notifications・escalations はデータ面のためガード対象外（設計判断）。フィールド剥がしは API モードで有効（モックは管理 UI と機能ガードのみ） |

### 設定 `/settings`

| 画面 / 機能 | 機能ID | モックアップ | 本実装 API+DB | 本実装 フロント接続 | 備考 |
|---|---|:---:|:---:|:---:|---|
| 機能トグル（メニュー表示制御） | F-13-4 | ✅ | ✅ `GET /v1/configs` `PUT /v1/configs/:key` | ✅ | app_configs（key-value jsonb・upsert = 冪等） |
| カスタム項目定義 | F-13-1 | ✅ | ✅ `/v1/masters/custom-field-defs` | ✅ | |
| 汎用区分（コードマスタ） | F-13-2 | ✅ | ✅ `/v1/masters/code-masters` | ✅ | |
| 外部リンク管理 | F-13-3 / F-09-1 | ✅ | ✅ `/v1/masters/external-links` | ✅ | |
| 勤怠・承認・エスカレーションルールの集約導線 | F-13-5 | ✅ | ✅ 勤怠 = attendance-rules / エスカレーション = configs / 承認経路 = workflow-routes | ✅ | 承認経路（F-07-5）は PR #22 で API 化（`/v1/masters/workflow-routes`。編集 UI は `/workflow` 経路設定タブ） |
| 日報入力方式設定 | F-13-7 | ✅ | ✅ `PUT /v1/configs/reportInputMode` | ✅ | 日報画面の入力方式判定も `/v1/configs` 参照へ統一（PR #17） |
| 監査ログ閲覧 | F-13-6 | ✅ | ✅ `GET /v1/configs/audit-logs` | ✅ | 管理者のみ |
| デモデータリセット | —（モック専用） | ✅ | — | — | 本実装には持ち込まない（モックの体験導線） |

### 横断基盤

| 項目 | モックアップ | 本実装 | 備考 |
|---|:---:|:---:|---|
| 認証（Firebase Auth ID トークン検証 + members 突合） | —（ユーザー切替で代替） | ✅ API 側 + ✅ ログイン UI（`/login`・メール/Google・未登録ガイド・dev 認証） | ロール（admin/hr/member）ガードは API・フロント両方で適用 |
| PostgreSQL スキーマ（app_office）+ マイグレーション | — | ✅ `api/db/migrations`（起動時自動適用・advisory lock で多重起動安全） | |
| 共有ドメイン層（型・勤怠計算・JST） | ✅（アプリ内） | ✅ `shared/domain/` へ切り出し（フロント/API で共有） | ロジックの二重実装を防止（開発原則3） |
| CI/CD: API テスト（単体+統合）→ Cloud Run デプロイ | — | ✅ `.github/workflows/deploy.yml` | 統合テストは実 PostgreSQL（CI は services、ローカルは使い捨て initdb） |

## 2. 対象外メニュー（バッチ3 以降。現状はモックアップのみ）

> **モック表示の明示:** API モード（実データ運用）では、本表のモック実装ページ・機能に「モックアップ」バッジを表示する
> （**バッチ6d で全ドメインの接続が完了し、現在バッジ対象ページはゼロ**。判定の仕組み = mock-status.ts は将来のモック先行ページに備えて残す）
> （表示判定は `mockup/app/utils/mock-status.ts`。本表が SoT で、ドメインを接続したら両方から削除する）。
> モックモード（デモ配信）は全機能がモックのためバッジは表示しない。

| メニュー / ページ | 機能ID | モックアップ | 本実装 | 予定 |
|---|---|:---:|:---:|---|
| ダッシュボード（カードメニュー + 通知） | F-01-1/2 | ✅ | ✅ 通知のフロント接続済み | 通知は 60 秒ポーリング + 画面操作で反映。未接続ドメイン（AI カンパニー等）発の通知は、各ドメインの API 化（サーバー発火へ移行）まで API モードでは表示されない |
| 通知・エスカレーションセンター `/inbox` | F-12 | ✅ | ✅ エスカレーション接続済み（PR #21）: 起票（日報課題・36協定・チャットボット）→ 対応（回答/裁定/対応不要）→ ナレッジ還流まで API 化 | 通知タブは PR #17 で接続済み。AI カンパニー発シグナル（停滞・過負荷）はバッチ4 |
| AI業務アシスタント `/ai-assistant`（計画・AI コメント・振り返り・日報反映・インサイト） | F-14 | ✅ | ✅ AI アシスタント接続済み（PR #25） | カレンダー予定の材料は PR #26（F-06-8）で接続済み |
| Google カレンダー連携（予定同期・タスク反映） | F-06-8 | ✅（モック同期） | ✅ カレンダー接続済み（PR #26/#27）: OAuth 2.0 認可コードフロー（state = 一回性・10 分 TTL の DB ノンス + Google アカウント email と members.email の突合・トークンは AES-256-GCM 暗号化保管 = C3）・予定同期（google 発のみ置換 upsert = SoT 分離）・アプリ発タスク（Google 反映は補助処理）・連携解除（revoke + トークン破棄）・日報ドラフト材料へ接続 | OAuth 未設定時は enabled=false で連携 UI 非表示（他機能に影響なし）。Webhook push は将来拡張（手動同期で開始） |
| 稟議 `/workflow`（旧称: ワークフロー = §36 で改称） | F-07 | ✅ | ✅ ワークフロー接続済み（PR #22）: 申請・経路凍結・承認/却下/差戻し（クレームファースト）・代理承認・承認ログ・通知 + 承認経路マスタ | PR #23 で下書きの可視性を本人と管理者のみに制限（レビュー指摘対応）。§36 で本文を目的/内容へ分割（区分別テンプレート・旧 body は互換表示） |
| シフト表 `/shift` | F-05 | ✅ | ✅ シフト接続済み（PR #23） | 希望・割当の参照は管理者 = 全件 / 本人 = 自分のみのサーバースコープ |
| 意思決定支援 `/decision` | F-02 | ✅ | ✅ 意思決定接続済み（PR #28）: 判断テーマ = 汎用マスタ `/v1/masters/decision-themes`（0011 で mockup seed を移行）・判断ログ = `/v1/decisions/logs`（追記のみ = 記録系保護。テーマ・選択肢・理由をサーバーで強制） | シナリオ予測（決定的線形モデル）は表示射影としてクライアント側に維持（設計判断） |
| AKEBONO（3D オフィス） `/akebono` | F-03 | ✅ | 🚧 AKEBONO 接続（本 PR = バッチ6d）: 要望ボックス = `akebono_wishes`（0019・記録系 = 追記のみ・編集/削除なし）・`GET/POST /v1/akebono/wishes`（本文必須 = AKO-AKB-001・2000 cp 切詰め・全員参照可 = 社内 C2）・useAkebono デュアルモード化・機能ガード 'akebono'（F-16）・チャットボット文脈に AKEBONO ブロック追加。プレースホルダ（バナー・ロードマップ）は静的表示 = フロントの責務 | **本 PR で mock-status が空 = API モードのモックバッジ全廃（マイルストーン）** |
| AIネイティブカンパニー `/ai-company` | F-08 | ✅ | ✅ AI カンパニー接続済み（PR #35 = バッチ6a）: ロール/AI 社員 = 汎用マスタ（0015）・タスク依頼 → 分解（Vertex AI → 失敗時 shared/domain/ai-tasks の同一ヒューリスティック）→ 承認 → 実行 → 完了（FOR UPDATE 状態機械・活動ログ追記・依頼者へ通知・AI 社員 status 同期）・日次報告 = daily_reports（author_kind='ai'・冪等生成）・停滞/過負荷/低確信度エスカレーション・機能ガード 'ai-company'（F-16） | AI 社員の「実実行」（LLM がステップを自律実行）は将来拡張。現段階は進行操作を人が行うワークフロー |
| 業務支援ツール `/support` | F-09 | ✅ | ✅ | 外部リンクは接続済みマスタを参照。チャットボット（F-09-3）は PR #27 で接続済み。**ドキュメント管理はバッチ7l で本実装（§32 参照）= 全ドメイン移行完了** |
| 売上管理 `/sales` | F-15 | ✅ | ✅ 売上接続済み（PR #36 = バッチ6b）: 月次実績 = `sales_monthly`（0017・冪等キー month × company × projectType の upsert）・`GET/POST /v1/sales`（登録は管理者のみ・一括取込 500 件）・実績登録モーダル（管理者）・会計年度計算 = shared/domain/fiscal をフロント/API 共有・機能ガード 'sales'（F-16）・チャットボット文脈に売上サマリ追加 + **mart ETL**: `fact_sales` / `mart_load_runs`（app_office 内 mart 互換 = オペレーター判断 2026-07-18）へ一方向 ETL（`POST /v1/sales/etl/run` + `/jobs/sales-mart-etl`） | 実績データのためマスタ初期値シードなし（新規環境は管理者登録 or 取込から） |
| 提供システム稼働状況 `/status` | F-11 | ✅ | ✅ 稼働状況接続済み（PR #37 = バッチ6c）: サービス = `system_services`（0018・mockup と同一の 3 サービスをシード）・インシデント = `service_incidents`（記録系 = updates 追記のみ・正順の状態機械を FOR UPDATE で直列化・登録/更新で管理者通知）・uptime = `uptime_daily`（SoT はインシデント → shared/domain/uptime で日次導出・窓内 DELETE→INSERT で冪等。トリガ = 登録/更新時 + `/jobs/uptime-rollup` + 管理者の手動再計算）・`GET /v1/status` 一括ハイドレーション（90 日 operational 埋め）・機能ガード 'status'（F-16）・チャットボット文脈 + 決定的フォールバックも実データ化 | モックの乱数 uptime シードは本番へ持ち込まない（インシデント実績から導出） |
| チャットボット（画面内ヘルプ） | F-09-3 | ✅ | ✅ チャットボット接続済み（PR #27）+ ✅ セッション管理（PR #30/#31・オペレーター指示 2026-07-17）: 会話は chat_sessions / chat_messages（0012）で DB 管理・同一セッション内は直近履歴 12 件を LLM へ渡すマルチターン・過去セッションの再開/新規開始（履歴ドロワー + 新しい会話）・本人のみ参照（AKO-CHT-001）・メッセージは追記のみ。fallback 応答もセッションへ追記（履歴の忠実性） | 旧「会話履歴はセッションローカル」設計判断は PR #30/#31 で置換。ドキュメントはバッチ7l で実データ化（search_docs 経由の参照 + 署名 URL 案内 = §32）。エスカレーション起票は PR #21 で接続済み |
| mart（分析基盤）ETL: fact_attendance / fact_leave / fact_effort ほか | data-design §2 | —（写像可能な型のみ） | 🚧 fact_sales のみ本 PR（バッチ6b）で実装（app_office 内 mart 互換テーブル + mart_load_runs。data-design §2.3 の実装状況注記参照）。他ファクトは ⏳ | app_office → mart の一方向 ETL。mart 本体（akebono-scm-platform）への接続はテーブル移送 + ETL 先切替で対応（オペレーター判断 2026-07-18） |
| メディア分析 `/media`（AKEBONO 業務配下） | F-40 | ✅ | ✅ メディア接続（§37 = 2026-07-28）: GA 連携 = Google OAuth 2.0（**セグメント単位**・analytics.readonly・state ノンス + email 突合・トークン AES-256-GCM 暗号化 = 0030）→ GA4 プロパティ選択（Admin API accountSummaries → PUT /v1/media/property）・集計 = GA4 Data API batchRunReports → MediaMetrics 整形（lib/ga.ts・30 分導出キャッシュ・conversions 廃止のため keyEvents 使用）・メディア設定（部分更新 = hasOwn フィルタ）・記事インベントリ（論理削除/復元）・AI 記事生成（Vertex AI → 決定的フォールバック・採用/取消）・AI インサイト（media/integrated = weekly_insights と同型の upsert 保管） | 記事インベントリは実データのためシードしない（採用・手動登録で育成）。統合メトリクス（PDCA）は Phase C（§39）でサーバー組み立てへ引き上げ = 売上軸も実データ（GET /v1/media/integrated） |
| 業態/会社全体ダッシュボード `/akebono/dashboard`・`/akebono/company` | F-41 | ✅ | 🚧 ほぼ接続（Phase C = §39）: 集計（売上軸 = sales_records + メディア軸 = GA）はサーバー組み立ての実データ（/v1/media/integrated）。**AI レポートの保管（dashboardInsights）のみ未移行** = カードに「レポート保管 = ローカル」バッジ | 保管の media_insights 同型化は Phase D（§39-6）。ページ全体のモックバッジは撤去（M3 撤去条件成立） |
| Akebono 設定系（`/akebono` ハブのアプリ設定・`/akebono/masters`・`/akebono/settings/segments`・`/akebono/settings/items`） | F-20/F-30/F-31 | ✅ | ✅ Phase B 接続（§38 = 2026-07-29）: 業態 + 共通マスタ 8 種 = 汎用マスタ registry（0031・モックシードと同一 id を投入）・業態×アプリ設定 = `/v1/akebono/app-configs`（複合キーのバッチ upsert）・項目カスタマイズ = `/v1/akebono/item-settings`（部分 upsert + エンティティ単位 reset） | カタログ（アプリ・項目定義・業種プリセット）はフロント静的 SoT のまま |
| Akebono 記録系（`/akebono/products`・`purchase-orders`・`production`・`inbounds`・`outbounds`・`purchases`・`inventory`・`sales`・`billing`） | F-21〜F-29 | ✅ | ✅ Phase C 接続（§39 = 2026-07-29）: 記録系 15 コレクション = 0032（商品/SKU/画像・発注・生産・入荷・仕入・出荷・在庫台帳・売上明細・請求/支払通知/入金）。実績・台帳は追記のみ + 冪等キー・訂正は赤黒・確定系は赤伝。金額算定は shared/domain/akebono をモックと共有 | 実データのためシードなし（各画面に空状態の登録案内）。データ取込（F-32 `/akebono/imports`）のみモック残 = mock-status に登録（Phase D） |

## 3. バッチ3d（PR #25・マージ済み）: AI業務アシスタント + 日報 AI アシストの完了条件（Definition of Done）

- [x] task_plans / assist_logs テーブル（0008。結果記録済み計画は不変・ログは追記のみ = 記録系保護）
- [x] `/v1/task-plans`: 一覧（本人スコープ）/ upsert（AKO-TPL-001〜004）/ 削除（planned のみ）/ AI レビュー（Vertex AI generateJson → 失敗時は shared/domain/task-plan-review の同一ヒューリスティック = 原則4）/ 結果記録（FOR UPDATE クレームで 1 回確定・AKO-TPL-005）/ インサイト（管理者・SQL 集計）
  - **※当時の仕様。2026-07-21 に §34 で緩和済み**（done も本人による訂正可 = 本文編集・削除・結果の再記録・後追い AI コメント。削除も done 可・**AKO-TPL-004 は廃止/欠番**・結果は再記録可で初回 result_at 保持・他メンバーは F-16-7 の許可制で readonly 参照。詳細は §34 と api-design §4）
- [x] `/v1/assist`: 回答・メモの追記（AKO-RAS-001/002）/ ログ参照（本人のみ）/ 日報ドラフト生成（Vertex AI 構造化出力 + 正規化（実在 projectId・0.25h 刻み・progress 0-100）→ 失敗時 shared/domain/report-draft。保存しない = フォーム流し込み）
- [x] ヒューリスティック（計画レビュー・ドラフト生成）を shared/domain へ移設しモック実装を import へ置換（単一実装 = 原則3）
- [x] useTaskPlans / useReportAssist デュアルモード化・ai-assistant.vue / reports.vue の await 変換・表示時 refresh・モックバッジ除去
- [x] Vertex AI の GCP セットアップ（aiplatform 有効化 + 実行 SA へ roles/aiplatform.user）をオペレーターが Cloud Shell で実行済み（deploy の自動ステップでも冪等維持）
- [x] 検証: API 統合テスト 51 / API モード実クリック E2E 8 スイート 87 チェック / モック回帰（ナビ + マスタ 4 + 日報 9）/ typecheck（api・mockup）

## 4. バッチ3e（PR #26・マージ済み）: カレンダー連携の完了条件（Definition of Done）

- [x] calendar_tokens / calendar_events テーブル（0009。トークンは AES-256-GCM 暗号化・喪失時は再連携で回復 = 設計判断を文書化）
- [x] `/v1/calendar`: status / oauth/url（state = HMAC 署名）/ oauth/callback（認証除外・交換・302 復帰）/ sync（google 発のみ置換 upsert・refresh 対応）/ events CRUD（アプリ発のみ削除可・Google 反映は補助処理）/ disconnect（revoke 非ブロッキング）
- [x] デプロイ反映: deploy.yml（Secret Manager へ google-oauth-secret / token-encryption-key を冪等登録・CALENDAR_READY 時のみ有効化）/ setup-deploy-secrets.ps1（-GoogleOauthClientId / -GoogleOauthClientSecretPath・TOKEN_ENCRYPTION_KEY 初回自動生成）/ deploy-guide §1-9
- [x] useCalendar デュアルモード化（connect = 同意画面リダイレクト・復帰クエリ処理・enabled=false 縮退）・assist ドラフト材料へ calendar_events を接続
- [x] 検証: API 統合テスト 54 / 単体 19（crypto 追加）/ API モード実クリック E2E 9 スイート 92 チェック / モック回帰 / typecheck（api・mockup）
## 5. バッチ4a（PR #27・マージ済み）: チャットボット応答 + 3e レビュー対応の完了条件（Definition of Done）

- [x] `POST /v1/chatbot/ask`: Vertex AI 一次応答（本人スコープの文脈収集 = C3 保護・構造化出力・出力正規化）。LLM 無効/失敗/confidence<0.4 は fallback 指示 → クライアントの決定的ルーティングへ縮退（原則4）
- [x] useChatbot デュアルモード化（send async 化・通信失敗も決定的応答へ）・モックバッジ除去
- [x] バッチ3e レビュー指摘対応（重大 3): ①同期 upsert に source='google' 条件 = app 発予定の保護（回帰テスト追加） ②OAuth state を一回性・10 分 TTL の DB ノンス化（0010）+ Google アカウント email と members.email の突合（openid email スコープ追加） ③復帰リダイレクトをゲート設置ページ（/ai-assistant）へ
- [x] バッチ3e レビュー指摘対応（軽微): 割当 push の FOR UPDATE 直列化 / addTask の SoT 先行書込化 / status の復号可否判定 / 同期打ち切り時の削除抑止（maxResults 250）/ HH:MM 値域検証 / ps1 の gh 失敗時ガード / ゲートの成功トースト誤表示・ローディング中バナー修正 / AKO-CAL 台帳の重複行整理・production-architecture §9 更新（※編集漏れが 4a レビューで判明 → バッチ4b で実施）
- [x] 検証: API 統合テスト 56 / 単体 19 / API モード実クリック E2E 10 スイート 96 チェック / モック回帰 / typecheck（api・mockup）

## 6. バッチ4b（PR #28・マージ済み）: 意思決定支援 + 4a レビュー対応 + フォント修正の完了条件（Definition of Done）

- [x] decision_themes / decision_logs テーブル（0011。テーマは汎用マスタ・ログは追記のみ = 記録系保護。mockup seed dt-01〜03 を移行）
- [x] `/v1/masters/decision-themes`（汎用マスタ登録 = スキーマ・jsonb フィールド・部分 PATCH）/ `/v1/decisions/logs`（GET 一覧・POST 記録 = AKO-DEC-001〜003 をサーバーで強制）
- [x] useDecision デュアルモード化（テーマ = tbl() バッキングスワップ・ログ = API キャッシュ + 表示時 refresh）・decision ページ async 化・モックバッジ除去。シナリオ予測はクライアント維持（設計判断）
- [x] バッチ4a レビュー指摘対応（重大): ①ドキュメント是正 = AKO-CAL 台帳の重複行を実削除・production-architecture §9 を実更新 ②chatbot 有給文脈を leave ドメインの残数計算（balanceOf = FIFO 引当・失効・保有上限）の再利用へ置換
- [x] バッチ4a レビュー指摘対応（軽微): ILIKE の % _ エスケープ + ESCAPE 句 / confidence 欠落（NaN）を fallback 側へ倒す判定 / companies 照合の ORDER BY / app.ts の OAuth コメント陳腐化 / chatbot ページ説明の「モック応答」是正 + 未移行ドメイン回答のデモデータ明示 / カレンダー連携失敗の reason 別メッセージ（account-mismatch 等。denied 理由を callback に追加）/ 実装状況ドキュメントの見出し・行の過去バッチ化
- [x] UI フォント修正（オペレーター報告 2026-07-17）: main.css の `font-feature-settings: 'palt'` を除去（Windows の Meiryo 系で句読点が潰れ文字が重なるため）+ フォールバックに Yu Gothic UI を追加
- [x] 検証: API 統合テスト 57 / 単体 19 / API モード実クリック E2E 11 スイート 101 チェック / モック回帰（ナビ + マスタ 4 + 日報 9 + 勤怠 5）/ typecheck（api・mockup）
- [x] バッチ5a へ続く（§7 参照）

## 7. バッチ5a（PR #29・マージ済み）: 顧客関係マスタ分割 + 本番修正 + 4b レビュー対応の完了条件（Definition of Done）

- [x] 顧客関係マスタの 3 分割（オペレーター指示 2026-07-17）: `/masters/relations` を `/masters/relations-company`（顧客関係(会社)）・`/masters/relations-contact`（顧客関係(人)）・`/masters/relation-types`（関係種別）へ分割し、マスタメンテナンスのカードメニューへ 3 件で表示（関係種別が見つからない問題の解消）
- [x] 顧客関係(人) の端点拡張（オペレーター指示 2026-07-17）: 顧客の担当者（contacts）に加えて自社メンバー（members）も From/To に選択可（（自社）ラベルで表示。エッジの端点 id はどちらの id も保持可 = スキーマ変更なし・下位互換）
- [x] 関係種別の削除対応: 未使用（関係エッジから参照なし）のみ物理削除可。使用中は AKO-RTM-001（409）で拒否し無効化を案内（API ガード + 画面前チェック + 使用中件数の表示）
- [x] ナレッジの 会社/人 対応: 既存の 5 ドメイン（業界 / 顧客(会社) / 顧客(人) / 顧客関係 / プロジェクト）で両対応済みであることを確認（変更なし = 設計どおり）
- [x] 提出済み日報の本人編集（オペレーター指示 2026-07-17）: 提出状態・初回提出時刻を維持したまま内容を更新可。編集は監査ログへ記録。下書きへ戻す操作のみ AKO-REP-001 で拒否（画面は提出済みカードの「編集」ボタン → エディタ → 更新を保存）
- [x] AI アシスト旧バッジ除去: reports.vue に残っていた「モック（AI アシストはバッチ3 で本実装予定）」バッジ 2 箇所を削除（実装は PR #25 で完了済み = 表示だけが陳腐化。原則5 違反の是正）
- [x] カレンダー同期失敗（本番報告）: 原因 = Google Calendar API 未有効化（OAuth 交換は API 無効でも成功するため連携済み表示と同期失敗が併存）。deploy.yml で `calendar-json.googleapis.com` を自動有効化 + 403 時のエラーメッセージを設定不備として明示 + deploy-guide トラブルシュート追記
- [x] バッチ4b レビュー指摘対応（軽微 6）: implementation-status §1 の「本 PR」残存 3 箇所 / decision-themes スキーマの enum 強化（status・slot）+ options スロット重複ガード / API モードでアーカイブ済みテーマの表示除外 / OAuth error の denied 判定を access_denied のみに限定（他は oauth-error） / production-architecture §9 のバッチ5 反映 / 判断理由の 2000 字 cap
- [x] 検証: API 統合テスト 58（提出済み編集 + 関係種別削除ガードを追加）/ 単体 19 / API モード実クリック E2E 12 スイート 111 チェック / モック回帰（ナビ + マスタ 4 + 日報 9 + 勤怠 5）/ typecheck（api・mockup）
- [x] バッチ5b へ続く（§8 参照）

## 8. バッチ5b（PR #30/#31・マージ済み）: チャットボットのセッション管理の完了条件（Definition of Done）

- [x] chat_sessions / chat_messages テーブル（0012。セッション = 設定系（title / updated_at のみ更新）・メッセージ = 追記のみ + seq で表示順を保証 = 記録系保護）
- [x] `POST /v1/chatbot/ask` の拡張: sessionId 任意（未指定 = 新規セッション作成・タイトルは最初の質問 40 字）。user/assistant メッセージを永続化し、直近履歴 12 件（各 500 字）を LLM プロンプトへ含めるマルチターン
- [x] `GET /v1/chatbot/sessions`（本人のみ・新しい順・件数つき）/ `GET /v1/chatbot/sessions/:id/messages`（再開用・seq 順）/ `POST /v1/chatbot/sessions/:id/messages`（fallback 応答の追記 = 履歴の忠実性）。他人のセッションは AKO-CHT-001（404 = 存在を漏らさない）
- [x] useChatbot のセッション対応（デュアルモード）: API = DB が SoT / モック = chatSessions・chatMessages（localStorage）。セッション導入前のモック会話は「以前の会話」へ一度だけ移行（原則7）。「新しい会話」「履歴ドロワー（再開）」UI・ページ遷移しても会話を維持
- [x] 検証: API 統合テスト 59（セッション管理を追加）/ 単体 19 / API モード実クリック E2E 13 スイート 117 チェック / モック回帰（ナビ + マスタ 4 + 日報 9 + 勤怠 5）/ typecheck（api・mockup）
- [x] バッチ5c へ続く（§9 参照）

## 9. バッチ5c（PR #32・マージ済み）: 権限制御基盤 F-16 の完了条件（Definition of Done）

- [x] permission_rules テーブル（0013・汎用マスタ基盤 = 管理者のみ変更・監査ログ・論理削除）+ 共有判定ロジック shared/domain/permissions.ts（個人 > 役職 > ロール・同一レイヤ拒否優先・未設定は許可）
- [x] API: 機能ガード middleware（URL → 機能キー・deny は AKO-PRM-001 403・10 秒キャッシュ + 変更時クリア。クリアはプロセスローカルのため複数インスタンス時は他インスタンスが TTL 10 秒で追随 = 許容する設計判断）+ マスタ GET の表示項目剥がし。/v1/masters・configs・notifications・escalations はデータ面のためガード対象外（設計判断: 機能 deny でアプリ全体が壊れない）
- [x] 安全設計: 既存ロールガードを緩められない「制限レイヤ」+ 管理者の マスタ/設定 deny はロックアウト防止のため無視
- [x] フロント: usePermissions（can/canPath/canField）・メニュー/ダッシュボードカード/モバイルナビ/業務支援ハブの非表示・ルートガード（permissions.global.ts）・権限設定ページ `/masters/permissions`（3 レイヤのルール CRUD）
- [x] 検証: API 統合テスト 63（ロール deny 403・個人 allow 上書き・フィールド剥がし・復帰・subjectKind/subjectId ペア検証）/ 単体 19 / API モード実クリック E2E 14 スイート 124 チェック / モック回帰（ナビ + マスタ 4 + 日報 9 + 勤怠 5）/ typecheck（api・mockup）
- [x] 独立レビュー第 1 巡の指摘対応: ヘッダーの打刻/通知導線を権限フィルタ + 滞在中 deny の再判定（layouts/default.vue の watchEffect）/ ルール全件ロード（LIMIT 撤去 = 部分ロードによる fail-open 防止）/ キャッシュ伝播（他インスタンス TTL 10 秒追随）の文書化 / subjectKind・subjectId ペア検証（registry superRefine）/ data-design §1.1・§1.2 に PermissionRule・DecisionTheme・ChatSession・ChatMessage を追記
- [x] 独立レビュー第 2 巡: ブロッキング指摘ゼロで収束（軽微 2 件 = PATCH 保持アサート・data-design の SystemService 表崩れはバッチ5e で対応）

## 10. バッチ5e（PR #33・マージ済み）: アカウント機能 + 日報 UX 改善（オペレーター指示 2026-07-17 の 8 件）の完了条件（Definition of Done）

- [x] ① ログアウト: ヘッダーのアカウントメニューへ追加（API モード = Firebase signOut → /v1/me キャッシュ破棄 → /login）
- [x] ② API モードのデモユーザー切替を除去: アカウントメニューへ置換（モックモードのみデモ切替を残す = デモ機能）
- [x] ③ プロフィール/個人設定ページ `/profile`: アイコン画像の登録・削除（クライアントで 256px 縮小 → data URI → PUT /v1/me/profile・migration 0014 members.avatar・監査ログ）+ パスワード変更（Firebase reauthenticate → updatePassword。Google SSO / dev 認証 / モックは対象外の説明表示）+ アカウント情報の確認
- [x] ④ 休暇種別の使用期限が空欄にできないバグ修正: UiSchemaForm の number 入力が空欄を 0 に変換していた実バグ（Number('') = 0）→ 空欄は '' のまま保持し保存側で null 変換（全 number フィールド共通の修正）
- [x] ⑤ 全員の日報タブ: 提出済みのみの月次一覧（日付・名前・サマリー・工数）を全メンバーが参照可（GET /v1/reports/daily?scope=all）。行（PC）/ カード（モバイル）押下で詳細ドロワー = UiDataTable の自動切替を再利用（原則3・8）
- [x] ⑥ 選択式「プロジェクト」→ 自由入力「業務テーマ」: entries.theme が正・旧 projectId は互換保持（表示・編集時にプロジェクト名へフォールバック = 原則7。既存データのパッチ不要）。AI ドラフト生成（LLM スキーマ・ヒューリスティック）も theme 出力へ追随
- [x] ⑦ PC 表示で「業務テーマ」「作業内容」「工数」「進捗」を 1 行に（md 以上 5 カラムグリッド・モバイルは縦積み）
- [x] ⑧ 日付ナビ再構成: 上段「← / 今日 / →」・下段「選択中の日付（直接選択可）」
- [x] 5c レビュー第 2 巡の軽微 2 件: permission-rules PATCH の未送信フィールド保持アサート追加 / data-design §1.1 の SystemService 行を表内へ移動
- [x] 検証: API 統合テスト 66（theme 提出 + テーマなし 400・scope=all 提出済みのみ・プロフィール画像の登録/検証/削除・permission-rules PATCH 保持）/ 単体 19 + 35 / API モード実クリック E2E 15 スイート 140 チェック / モック回帰（ナビ + マスタ 4 + 日報 11 + 勤怠 5）/ typecheck（api・mockup）

## 11. バッチ5d（PR #34・マージ済み）: チャットボットの全 DB 参照化・権限準拠 + 5e レビュー指摘対応の完了条件（Definition of Done）

- [x] 文脈収集（buildContext）を DB の全移行済みドメインへ拡張: 勤怠（当月サマリ）・有給・日報（本人 = 下書き含む / 他人 = **提出済みのみ**）・ワークフロー（本人の申請）・シフト（本人の今後の割当）・意思決定（テーマ + 判断ログ）・タスク計画/カレンダー（本人の当日）・エスカレーション（本人対象の open）・メンバー/部署・顧客(会社/人)・プロジェクト・ナレッジ
- [x] 参照範囲は権限（F-16）に準拠: ドメインごとに canUseFeature で文脈生成可否を判定（5c の共有ロジック・10 秒キャッシュを再利用 = 原則3）・マスタ由来の文脈は stripDeniedFields で表示項目 deny を反映・本人スコープ（C3）維持
- [x] ブロック単位の収集失敗は全体を止めない（原則4 = 部分文脈でも回答を試みる）。未移行ドメイン（ドキュメント・稼働状況・売上）は従来どおり文脈対象外・モックの決定的応答が担う（設計判断）
- [x] 5e レビュー第 1 巡の指摘対応（マージ後着荷分）: ① avatar のサブタイプ allowlist 化（png/jpeg/webp の base64 のみ・SVG 拒否）② scope=all の month 必須化（全履歴ダンプ防止）③ ログアウト時のドメインキャッシュ破棄 + 未認証ポーリング停止 ④ dev 認証ではログアウト非表示 ⑤ 業務テーマ input に maxlength=100 ⑥ screen-design のヘッダー記述更新 ⑦ 全員の日報ドロワーで権限のない他人の工数乖離を計算しない（無駄な 403 の抑止）
- [x] 検証: API 統合テスト 67（buildContext 直接検証 = reports deny で文脈消失・フィールド deny 反映・他人日報は提出済みのみ・workflow deny / avatar allowlist / scope=all month 必須）/ 単体 19 + 35 / API モード実クリック E2E 15 スイート 140 チェック / モック回帰（ナビ + マスタ 4 + 日報 11 + 勤怠 5）/ typecheck（api・mockup）

## 12. バッチ6a（PR #35・マージ済み）: AI カンパニー F-08 の API 化 + 5d レビュー指摘対応の完了条件（Definition of Done）

- [x] DB（0015 = 表定義 / 0016 = 部分一意索引 + シード）: ai_roles / ai_employees（汎用マスタ = 管理者のみ変更・監査ログ・論理削除）+ ai_tasks（状態機械）+ ai_activity_logs（追記のみ）。AI 日次報告は既存 daily_reports（author_kind='ai'）を再利用。マイグレーションは append-only（適用済みファイルを改変せず 0016 で追補 = 6a 第 2 巡レビュー対応）
- [x] API `/v1/ai-company`: タスク依頼（分解 = Vertex AI 構造化出力 → 失敗時 shared/domain/ai-tasks の同一ヒューリスティック）→ 承認/進行/ブロック/中止（FOR UPDATE 直列化・AKO-AIC-001〜008・活動ログ・完了時 依頼者へ通知・AI 社員 status 同期）+ 日次報告の冪等生成 + 停滞/過負荷検知（workload-check・クールダウン冪等）。機能ガード 'ai-company'（F-16）+ チャットボット文脈へ AI タスクブロック追加
- [x] フロント: useAiCompany デュアルモード化（API = /v1/ai-company キャッシュ + 移行済みマスタ ai-roles/ai-employees。ロール設定ページは useMasterCrudAsync 化）。/ai-company のモックバッジを解除
- [x] 5d 独立レビュー指摘対応（マージ後着荷分・7 件）: ① チャットボットのエスカレーション文脈を issue_reported（本人の日報由来）に限定（他者起票の内部メモ・注入経路を遮断）② 見出し・会社名参照にも stripDeniedFields を適用（name deny 時はブロックごと非表示）③ 通知キャッシュの値クリア ④ ログアウトは clearApiData（再取得しない = 未認証バーストなし）⑤ nameHit の敬称限定（一般語との偽ヒット防止）⑥ workflow/task/calendar title の capCp ⑦ chatbot.ts の機能 ID を F-09-2 へ修正
- [x] 6a 独立レビュー指摘対応（重大 2 + 軽微 6）: ① 日次報告の並行重複 → 部分一意インデックス `daily_reports_ai_uq`（0015）+ ON CONFLICT DO NOTHING + UI 二重押下防止（0015 は AI テーブル新設と同時に索引を張るため既存本番に重複日報は生じ得ず、データパッチ不要 = 設計判断）② AI ロール/社員の初期データ未投入 → 0015 で mockup シードと同一の AI ロール 4・AI 社員 5 を `ON CONFLICT DO NOTHING` 投入（decision_themes 0011 と同方針 = 新規環境でも手動投入なしで F-08 が動く。AI 社員の新規作成 UI は将来拡張・現状は割当変更のみ = 明記）③ lowconf dedupe キーを 2 セグメント（`lowconf:emp`）へ簡約 ④ モック AI 日報 entries を theme 形式へ統一 ⑤ addLog seq を当該社員件数に統一 ⑥ decompose へ trim 後 title を渡す ⑦ ai-employees patchSchema から派生値 status を omit
- [x] 検証: API 統合テスト 72（マスタ CRUD・シード投入・status omit・状態機械 遷移/409・低確信度・日次報告の並行/逐次冪等・scope=all 掲載・機能 deny 403）/ 単体 19 + 35 / API モード実クリック E2E 16 スイート 150 チェック（6a = 依頼 → 分解 → 承認 → 完了 → 日次報告 → タイムライン掲載）/ モック回帰（ナビ + マスタ 4 + 日報 11 + 勤怠 5）/ typecheck（api・mockup）
- [x] 売上 + mart ETL（F-15）はバッチ6b（§13）で実装 → 残り: 稼働状況（F-11）→ AKEBONO（F-03）

## 13. バッチ6b（PR #36・マージ済み）: 売上管理 F-15 + mart ETL 基盤の完了条件（Definition of Done）

- [x] mart ETL 出力先のオペレーター確認（2026-07-18）: akebono-scm-platform の mart へ直接書かず **app_office 内に mart 規約準拠の互換テーブル** を作成（将来はテーブル移送 + ETL 先切替のみで mart 本体へ接続可能な形）
- [x] DB（0017）: `sales_monthly`（実績データ。冪等キー = month × company × projectType の UNIQUE。実績のためマスタ初期値シードは投入しない = 設計判断）+ `fact_sales`（mart 互換: tenant_key 先頭列・dim_date_key yyyymmdd・UNIQUE(tenant_key, source_txn_id)・会計期非正規化・load_run_id/created_at 監査列・customer_company_id/project_type は退化キー）+ `mart_load_runs`（ETL 実行監査 = 追記のみ）
- [x] API `/v1/sales`: GET 一覧（表示射影 = shared/domain/fiscal の純粋関数をフロントと共有）/ POST 一括 upsert（管理者のみ・rows 1〜500 件・AKO-SAL-001〜003・監査ログ）/ ETL 手動実行 + 実行履歴（管理者のみ）。日次バッチ `/jobs/sales-mart-etl`（CRON_SECRET = 周期有給付与と同型・イベント + 手動回復の両経路 = 原則6）。機能ガード 'sales'（F-16）
- [x] 会計年度計算を shared/domain/fiscal.ts へ切り出し（fiscalYearOf / fiscalMonthsOf / fiscalMonthNoOf / fiscalQuarterOf。useSales・ETL・チャットボット文脈で共有 = 原則3）
- [x] フロント: useSales デュアルモード化（API キャッシュ + 表示時 refresh + upsert）・sales.vue に管理者の実績登録モーダル・mock-status から /sales 除去（モックバッジ解除）
- [x] チャットボット文脈へ売上サマリブロック追加（can('sales')・年度累計/当月/前年同月比のみ = 明細は /sales へ誘導）
- [x] 検証: API 統合テスト 80（一括 upsert 冪等・入力検証（件数/金額上限含む）・管理者ガード・ETL 冪等/margin/会計期非正規化/実行履歴・/jobs/sales-mart-etl の CRON_SECRET 保護・buildContext 売上ブロック（deny で文脈消失）・sales deny 403・自社無効化時の既定 4 月フォールバック）/ 単体 19+9（fiscal）+ 35 / API モード実クリック E2E 12 チェック + モック回帰 9 チェック（E2E スタックは旧セッションの scratchpad 消失に伴い再構築）/ typecheck（api・mockup）
- [x] 独立レビュー第 2 巡: **重大ゼロで収束**（第 1 巡対応の正しさ・回帰なしを確認）。推奨 1 件 = buildContext 売上テストの実時計依存（2026-08 以降に固定期待値が fail する時限性）を本 PR 内で修正（期待値を実データ + 共有 fiscal 関数から相対導出へ）。0017 の CHECK 追加が「適用済み migration の in-place 修正」にあたらないことを確認（deploy は main push のみ = 修正前版 0017 が恒久環境へ適用された事実なし）。軽微メモ（production-architecture の「ドキュメント」バッジ文言と MOCK_PAGE_PATHS の不一致 = 本 PR 以前からの状態・CRON_SECRET テストの env 前提 = 既存同型）は次バッチで対応
- [x] 独立レビュー第 1 巡の指摘対応（重大 = ドキュメント整合 3 件: production-architecture の未移行ドメイン列挙・phase5/architecture の useSales 行・api-design useChatbot 行の文脈ドメイン列挙）+ 軽微 6 件（chatbot の自社会計月取得を selfFiscalStartMonth 再利用へ / useSales の自社解釈に active を追加 = サーバーと統一 / fact_sales.project_type に CHECK / 金額上限の番兵 AKO-SAL-001 / ETL 手動実行の監査ログ / テスト追補 3 本）。残る軽微（mart_load_runs の running 残留掃除・actor 列・PROJECT_TYPES 共有定数化・未来月登録の UX・ETL エラー経路テスト・初回表示の二重フェッチ）は次バッチで対応

## 14. バッチ6c（PR #37・マージ済み）: 提供システム稼働状況 F-11 の完了条件（Definition of Done）

- [x] DB（0018）: `system_services`（マスタ的 + components jsonb。mockup シードと同一の 3 サービスを `ON CONFLICT DO NOTHING` 投入 = 新規環境でも手動投入なしで F-11 が動く・原則1）+ `service_incidents`（記録系: updates jsonb 追記のみ・status/resolved_at はその射影・started_at は JST ISO text）+ `uptime_daily`（日次集計。UNIQUE(service_id, date)・非 operational の日のみ格納）。インシデント・uptime はシードしない（モックの乱数 uptime は本番へ持ち込まない = 実績データの偽装防止・sales_monthly と同方針）
- [x] uptime 集計を shared/domain/uptime.ts の純粋関数へ切り出し（JST 日境界の区間分割・重なりは和集合で二重計上しない・最悪値ロールアップ・発生直後のゼロ長でも当日状態へ写像。影響度→状態の写像 IMPACT_TO_STATE はフロント/API 共有 = 原則3）。**SoT = インシデント → uptime_daily は導出**（窓内 DELETE→INSERT のトランザクションで冪等）。トリガ = インシデント登録/更新時（イベント）+ `/jobs/uptime-rollup`（Cloud Scheduler・CRON_SECRET = 周期有給付与と同型）+ `POST /v1/status/uptime/recompute`（管理者の手動回復パス）= 原則6 の両経路
- [x] API `/v1/status`: GET 一括ハイドレーション（services + 全インシデント + 90 日 uptime を operational 埋めの密配列で返却 = フロント射影はモックと共通）/ POST incidents（管理者のみ・AKO-STS-001/002・初報 = updates[0]・管理者通知）/ POST incidents/:id/updates（管理者のみ・正順のみ = スキップ可・逆行 409 AKO-STS-004・FOR UPDATE 直列化・AKO-STS-003/005・resolved で resolvedAt）。機能ガード 'status'（F-16）
- [x] フロント: useSystemStatus デュアルモード化（API = /v1/status キャッシュ + 表示時 refresh・登録/更新 async 化 + 二重送信防止・通知はサーバー発火）・チャットボットの決定的フォールバック answerStatus を useSystemStatus 経由へ（API モードでも実データで回答）・mock-status から /status 除去（残る モックバッジは /akebono のみ）
- [x] チャットボット文脈へ稼働状況ブロック追加（can('status')・全体状態 + 対応中インシデント = 詳細は /status へ誘導）+ ページ説明の「稼働状況はデモデータ」記述を是正（原則5）
- [x] 検証: API 統合テスト 85（GET 密配列・登録/更新の権限と状態機械・updates 追記・通知発火・uptime 導出 150 分/冪等/管理者ガード・/jobs/uptime-rollup・buildContext 稼働状況の allow/deny・機能 deny 403 復帰）/ 単体 19+9+9（uptime）+ 35 / API モード実クリック E2E 12+16 チェック + モック回帰 9 チェック / typecheck（api・mockup）
- [x] 独立レビュー第 2 巡: **重大ゼロ・軽微ゼロで収束**（第 1 巡対応の正しさと新規問題なしを確認: FOR UPDATE OF i のロック範囲 = インシデント行のみでマスタと相互ブロックしない・ON CONFLICT 化後も単独実行の冪等性は同値・「窓内 DELETE→INSERT」の各記述は upsert 化後も正・ドキュメント矛盾の grep 全件確認）。観察 2 点（並行競合時の理論的な行残存 = 回復パス 3 経路で自己修復・許容）を記録
- [x] 独立レビュー第 1 巡の指摘対応（重大 = ドキュメント整合 4 件: production-architecture の未移行ドメイン列挙・api-design useChatbot 行・本ファイル F-09-3 行の「稼働状況はデモデータ」+「本 PR」残存・phase5/architecture の useSystemStatus 行。**6b 第 1 巡と同一箇所の再発クラスのため、この 3 ファイル + 本ファイルの旧記述確認を毎バッチのセルフチェックに含めること**）+ 軽微 6 件中 4 件採用（AKO-STS-006 起番 = 影響度不正の専用コード / 状況更新のサービス名取得を FOR UPDATE トランザクション内へ = コミット後 500 経路の排除 / uptime 再計算の INSERT を ON CONFLICT DO UPDATE 化 = 並行再計算の一意制約違反防止 / GET インシデント上限 500 の台帳明記）。残る軽微（capCp の共通化 = 3 箇所重複・登録→当日反映テストの深夜 0 時跨ぎフレーク耐性）は次バッチで対応

## 15. 今回バッチ（6d: AKEBONO F-03 = 最終バッチ・モックバッジ全廃）の完了条件（Definition of Done）

- [x] DB（0019）: `akebono_wishes`（記録系 = 追記のみ・巻き戻し禁止。編集・削除 API は設けない。要望は実データのためシードしない = sales_monthly / service_incidents と同方針）
- [x] API `/v1/akebono/wishes`: GET 一覧（新しい順・直近 500 件。表示名はフロントが members マスタキャッシュから解決）/ POST 投稿（本文必須 = AKO-AKB-001・2000 コードポイント切詰め）。参照・投稿は認証済み全員（モックと同一の可視性 = 社内 C2）。機能ガード 'akebono'（F-16）
- [x] フロント: useAkebono 新設（デュアルモード = useDecision 型。API 書込 → キャッシュ取り直し = 原則6）・akebono.vue の async 化 + 二重送信防止 + 表示時 refresh・**mock-status.ts を空化 = API モードのモックバッジ全廃（マイルストーン。判定の仕組みは将来のモック先行ページに備えて残す）**
- [x] チャットボット文脈へ AKEBONO ブロック追加（can('akebono')・構想状況 + 直近の要望 3 件 = 詳細は /akebono へ誘導）
- [x] 6b/6c 繰り越しの軽微指摘対応: ① capCp を lib/text.ts へ共通化（chatbot / ai-company / status / akebono の 4 箇所で共有 = 原則3）② PROJECT_TYPES を shared/domain/types の単一定義へ（registry の z.enum・sales の検証 Set が参照）③ 6c 統合テスト「登録 → 当日 uptime 反映」の深夜 0 時跨ぎフレーク耐性（昨日/今日のいずれかで判定）④ production-architecture の「未移行ドメイン」記述をバッジ全廃後の状態へ更新
- [x] 6b/6c 繰り越しのうち対応しない項目（理由付きで残置）: mart_load_runs の running 残留掃除（クラッシュ時のみ・実害なし = 導出データで常に再実行可能）・actor 列（監査ログで代替済み）・ETL エラー経路テスト・未来月登録の UX 注記・初回表示の二重フェッチ（実害なし）
- [x] 検証: API 統合テスト 88（投稿/一覧の可視性・trim・順序・未入力 AKO-AKB-001・2000 cp 切詰め・buildContext AKEBONO の allow/deny・機能 deny 403 復帰）/ 単体 19+9+9 + 35 / API モード実クリック E2E 12+16+11 チェック + モック回帰 10 チェック / typecheck（api・mockup）/ api build
- [x] 独立レビュー第 1 巡（PR #38 マージ後着荷 → フォローアップ PR で対応）: ランタイムコード・テスト・マイグレーションは指摘ゼロ。重大 2 件はいずれも再発クラスのドキュメント整合（api-design useChatbot 行へ AKEBONO 追記・phase5/architecture へ useAkebono 行追加）。軽微 1 件 = チャットボットの AKEBONO トリガ正規表現が顧客「アケボノ商事」・サービス「AKEBONO SCM」と衝突（文脈ノイズ。漏えいなし）→ negative lookahead で除外 + 回帰テスト追加
- [x] 独立レビュー第 2 巡（フォローアップ PR #39）: **重大ゼロ・軽微ゼロで収束**（正規表現の正当トリガ/除外 16 ケースを実測検証・ドキュメント新規矛盾なし・再発クラス 4 ファイルの再 grep クリーン）。観察 1 点（顧客別名「アケボノ」単独言及の文脈ノイズ = 曖昧性解消不可・顧客ブロック並行生成で判別可能・許容）を記録 — **バッチ6b〜6d の反復レビュー（原則9）全て収束・残タスク完了**

## 16. チャットボットのマルチターン改善（オペレーター報告 2026-07-18「会話の履歴を理解していない」対応）の完了条件（Definition of Done)

- [x] 原因分析: マルチターンの仕組み自体（直近 12 件を LLM へ渡す）はバッチ5b 実装済み。体感を壊していたのは ①文脈収集（buildContext）が今回の質問のキーワードのみで判定され、フォローアップ質問（「じゃあ去年は？」等）に文脈が供給されない → 低確信度 → フォールバックの連鎖 ②フォールバックの決定的ルーティングが履歴非対応 ③リロードで新しい会話になる（さらに調査中、認証確立フック onApiReset が復元済みセッション ID を null 化するバグを発見）
- [x] ① buildContext の話題判定を「今回の質問 + 直近のユーザー発言（3 件・各 200 cp）」へ拡張（キーワード・人名・顧客名・ナレッジ検索すべて。**権限判定（canUseFeature / stripDeniedFields）・本人スコープは不変** = 参照範囲は拡がらず話題の継続性のみ補う）
- [x] ② フォールバックの 2 段ルーティング（route を null 許容に分離）: 今回の質問で判定 → 該当なしなら直近のユーザー発言を連結して再判定 → それでも不明なら従来の定型応答。モックモードにも同一適用
- [x] ③ 表示中セッションをタブ内永続（sessionStorage）しリロード後に自動再開: onApiReset ではサーバーミラーのみ破棄しセッション ID は保持（復元可否はサーバーの所有チェックに委ねる = 他人・不在は 404 → refresh() が新しい会話へフォールバック。send 中の AKO-CHT-001 も同様にフォールバック）。ログイン切替の安全性はサーバー側 C3 チェックが担保
- [x] 検証: API 統合テスト 89（フォローアップ文脈供給・履歴コーパスへの権限 deny・/ask 経由のセッション実データ検証を追加）/ 単体 37 + 35 / E2E フルスタック 12+16+11+**6（chatbot-multiturn-e2e = 2 段ルーティング・リロード自動再開・新しい会話の回帰）** + モック回帰 10 / typecheck（api・mockup）
- [x] 独立レビュー第 1 巡の指摘対応（重大 1 = 再発クラス: phase5/architecture の useChatbot 行をセッション管理・2 段ルーティング・sessionStorage 永続込みへ更新 / 軽微 4 = ①refresh の永続破棄を AKO-CHT-001（404）限定へ = 一時的な通信断では保持し再試行 ②2 段目のサブ分類（申請/取り方・規程トピック）を今回の質問のみで判定 = 履歴側キーワードの上書き防止（route(corpus, subText) 分離）③onApiReset コメントの自己矛盾修正 ④E2E をストリーミング完了の条件待ち + 固有文言の出現回数で弁別する形へ強化）。**権限境界・セッション所有チェックはレビュアーが全経路照合し問題なし**
- [x] 独立レビュー第 2 巡: **重大ゼロ・軽微ゼロで収束**（route 分離の 1 段目挙動が従来とバイト同一・404 限定化で復元不能セッションの残留ループなし・E2E の弁別回数一致の妥当性・ドキュメント新規矛盾なしを確認）。観察 2 点（「じゃあ申請するには？」の 1 段目優先順は従来挙動・E2E の新しい会話後 500ms 待機は同期処理のため実害なし）を記録

## 17. チャットボットの DB 供給網羅（オペレーター報告 2026-07-18 #2「会社マスタの会社について答えられない」対応）の完了条件（Definition of Done)

- [x] 原因分析（2 系統の実バグ + 供給漏れ）: **① クライアント useApi.loadApiCollection のストア未作成バグ** — tbl() 未アクセスのコレクションを先にロードすると取得結果が捨てられ「ロード済み・中身は空」で固定される（フォールバック経路で会社照合が常に空振り = 報告の直接原因）。**② フォールバックのルーティングがマスタキャッシュの遅延ロードと競合**（初回質問時に未ロードで空振り）。**③ buildContext（LLM 文脈）の供給漏れ** — 業界・自社担当・先方担当者・会社間の関係・人の関係・自社情報・部署・休暇種別・外部リンクが DB にあるのに文脈化されていなかった
- [x] ① useApi.loadApiCollection: ensureStore で格納先を必ず作成（apiCollection と共有）② フォールバック前にルーティング参照コレクション（companies / industries / relationTypes / companyRelations / projects / knowledge / members）のロード完了を待機 ③ クライアント answerCompany に会社間の関係（relationTypes ラベル + 相手名）を追加
- [x] buildContext の会社ブロックを自社/顧客の両対応へ拡張: 業界（primary = 主マーク）・自社担当（members deny 反映）・先方担当者（contacts ≤5・deny 反映）・会社間の関係（relation_types ラベル・双方向・相手名に companies deny 反映）・自社は会計年度開始月も。「自社/わが社/うちの会社」キーワードで自社ブロック
- [x] 新ブロック追加: 業界逆引き（業界マスタ × 顧客一覧）/ 部署・組織（一覧 + 人数 + 責任者。部署名の**最長一致**で所属メンバー展開 = 「文脈開発部」より「開発部」が勝つ誤りをテストで検出し修正）/ 休暇種別（申請可能な種別一覧）/ 外部リンク。人の関係（contact_relations = 端点は顧客担当者または自社メンバー）を顧客担当者・メンバー両ブロックへ併記
- [x] 権限境界の維持: 全新規ブロックで canUseFeature / stripDeniedFields / 本人スコープの既存パターンを踏襲（companies.name deny で業界逆引きの顧客名が剥がれることをテストで検証）
- [x] 供給対象外の設計判断（変更なし・理由付き）: ドキュメント管理（未移行 = デモデータ）・通知/監査ログ/権限ルール（運用・管理データで会話文脈に不適）・コードマスタ/カスタム項目定義（メタ設定）
- [x] 検証: API 統合テスト 94（業界・自社担当・先方担当者・会社間の関係・別名照合・自社ブロック・業界逆引き + name deny 剥がし・人の関係の双方向・休暇種別・外部リンク・部署の所属展開）/ 単体 37+35 / E2E フルスタック 12+16+11+8（会社質問で業界・関係が返ることを追加）+ モック回帰 10 / typecheck（api・mockup）/ api build
- [x] 反復レビュー（原則9・PR #41）: 独立レビュー R1 で重大 1（**strip 網羅の漏れ** = ①自社ブロックの primaryIndustryId / fiscalStartMonth が剥がし前の生値参照 ②補助マスタ = 業界名・関係種別ラベル・関係メモ・休暇種別・外部リンク・部署名・意思決定テーマ・AI 社員名が未 strip で「マスタ由来はすべて strip」の宣言と矛盾）+ 軽微 3（業界逆引きの industryIds deny 時 TypeError で該当ブロック消滅・フォールバック待機リストに departments 欠落・personRelations の相手解決が active 未絞り込み）を検出 → **全件コード側で修正**（補助マスタも strip 適用。JOIN 由来の単一項目 = relation_types.label / ai_employees.name は canViewField で判定。顧客担当者ブロックの所属会社名の生値参照も同クラスとして修正）。補助マスタ deny の反映は統合テスト（fiscalStartMonth / primaryIndustryId / industries.name / relation-types.label / company-relations.notes / leave-types.name / external-links.url / departments.name の 8 観点）で回帰固定。R2 で残 1（会社ブロックの関連プロジェクト行の strip 漏れ = R1 でも双方見落とし）+ 軽微 1（decision-themes.category deny 時に既定「(PJ)」を捏造表示）を検出 → 修正し、projects.name / decision-themes.category deny の 2 観点をテストへ追加（計 10 観点・統合 95 件）

## 18. 営業日・祝日基盤（オペレーター報告 2026-07-18 #4「明日の計画が 7/20 = 1日ズレ」対応）の完了条件（Definition of Done)

- [x] 原因分析: バグではなく仕様どおりの挙動（screen-design §F-14「対象日ナビ 既定=翌営業日」）。報告日 7/18 が**土曜**のため翌営業日 = 7/20(月) が表示され、見出し「明日の計画」と乖離して 1 日ズレに見えた。オペレーター確認の結果、**翌営業日の既定は維持**し、①営業日定義のマスタ制御（外注等は平日以外も営業日になり得る）②祝日の公式データ反映 ③画面からの祝日データ更新、を追加する方針で合意
- [x] 営業日のマスタ制御: attendance_rules へ workingWeekdays（営業曜日 0-6・既定 [1-5]）/ holidayAware（祝日を非営業日扱い・既定 true）を追加（0020。既存行は DEFAULT で下位互換 = 従来挙動）。勤怠ルール編集モーダル（/attendance 設定タブ）で設定可
- [x] 祝日マスタ: public_holidays（0020。date 一意・SoT）。内閣府「国民の祝日」CSV（Shift_JIS）の公式取込 = `POST /v1/holidays/import`（管理者・date 一意 upsert = 冪等・再取込可・csvText / csvBase64 のオフライン経路あり = 公式サイト障害時の手動アップロード代替）。/masters/holidays 画面から「公式データから更新」ボタンでいつでも更新可 + 手動追加・物理削除
- [x] 翌営業日計算の共有化: shared/domain/business-day.ts（isWorkingDay / nextWorkingDay / workingDayRuleOf）を新設し、旧 report-draft.nextBusinessDay（土日固定スキップ）を全廃。クライアント = useBusinessDay（ruleFor を再利用）・API = /v1/assist/report-draft（ruleOf + holidaySetAfter）で同一ロジック
- [x] カレンダー表示への反映: AI業務アシスタントの対象日ナビへ「翌営業日」バッジ（対象日 ≠ 暦日の明日のとき）と「祝: 名称」バッジを表示（明日の計画・今日の振り返りの両方）
- [x] 検証: 単体 45（business-day 6 観点 = 週末スキップ・祝日スキップ・連休・週末稼働ルール・フォールバック・無限ループ打ち切り + CSV 解析 2 観点）/ API 統合 100（祝日マスタ CRUD・公式取込の冪等/Shift_JIS 自動判定/権限/解析エラー・勤怠ルールの営業日定義・日報ドラフトの祝日跨ぎ翌営業日）/ mockup 単体 35 / 両 typecheck / api build / E2E フルスタック 12+16+11+8 + モック回帰 10
- [x] 運用ノート: 本番リリース後、管理者が /masters/holidays で「公式データから更新」を 1 回実行して祝日を初期投入する（外部サイトへの起動時自動フェッチは行わない設計判断 = 政府サイト障害時にデプロイへ影響させない。以後の祝日改定も同ボタンで反映）。公式サイトに接続できない場合は「CSV から取込」で手元のファイルをアップロード可。**取込は追加・更新のみで削除しない**ため、祝日の移動・取消が告示された場合は旧日付の行を画面から手動削除する（data-design の設計判断参照）
- [x] 反復レビュー（原則9・PR #43 → フォローアップ PR）: 独立レビュー R1 で重大 1（**API モード初回表示のハイドレーション競合** = 祝日・勤怠ルールのロード完了前に既定対象日が確定し旧挙動へフォールバック → 手動変更まで既定値を再計算へ追随させる watch で修正）+ 軽微 7（存在しない UI を案内するエラーメッセージ → CSV アップロードボタンを実装 / 祝日移動の残留 → 設計判断を明文化 / 行クリック=削除の UX → 操作列の削除ボタンへ / CONVENTIONS.md の「15 種」陳腐化 → 21 種 / テスト間依存 → 祝日を自前登録 / 勤怠ルール SELECT 列の 3 箇所重複 → ATTENDANCE_RULE_COLS へ共通化 / モックの日付重複ガード → クライアント検証追加）を検出。**PR #43 はレビュー収束前にオペレーターがマージしたため、修正は全件フォローアップ PR で対応**

## 19. バッチ7a: AI 検索最適化基盤 + ナレッジのドキュメント取込（オペレーター報告 2026-07-18 #3「チャットボットの精度が悪い」）の完了条件（Definition of Done)

- [x] 原因分析（スクリーンショット 5 枚の実症状）: ①「弊社の取引先は?」回答不能 = 自社キーワードに弊社/当社が漏れ ②「つなぐばの取引先は?」で別会社カード = 正式名との完全一致照合のみ + 履歴コーパスが現在質問に勝つ ③「株式会社しまむら: 。」「規模 ()」= 空フィールドのテンプレート流し込み ④解釈型質問（「小売はどんなところで困る?」）に生データ返答 = ナレッジ探索が ILIKE 部分一致のみ・インデックス/ベクター最適化なし
- [x] 名寄せ・ルーティング精度（shared/domain/name-match をフロント/API 共有）: 法人格（株式会社/(株)/㈱等）・空白・全角英数を正規化した部分一致 + **最長一致**。優先順 = 今回の質問 → 履歴（新しい順）→ 自社キーワード（**弊社/当社を追加**）。クライアントフォールバックも同一ロジック + 自社/業界回答 + ナレッジ全文字句照合（最後の砦）。空フィールドはテンプレートへ出力しない
- [x] 検索最適化データ（search_docs 0021 = **派生キャッシュ・SoT は各マスタ/ナレッジ本体で不変** = オペレーター指示「既存のマスタやナレッジは崩さない」準拠）: 会社（業界・担当・先方担当者・関係・PJ・ナレッジ込み）/ 顧客担当者（所属・人の関係込み）/ 業界（顧客逆引き・ナレッジ込み）/ プロジェクト / ナレッジ全文 を AI が探索・解釈しやすい平文 + (entity, field) タグ付き segments へフラット化。**更新時に自動再生成**（マスタ書込後フック = デバウンス 1.5s・非ブロッキング）+ 起動時再生成 + `POST /v1/search/reindex`（手動回復。原則1/6）。body_hash 差分のみ埋め込み再計算 = 冪等・安価
- [x] インデックス/ベクター化: 字句 = 文字バイグラム被覆率（分かち書き・pg 拡張不要 = 環境可搬）+ ベクター = Vertex AI text-multilingual-embedding-002（RETRIEVAL_DOCUMENT/QUERY。LLM 無効環境は字句のみへ縮退 = 原則4）。ハイブリッドスコアの上位 4 件を「関連情報（社内データ検索）」ブロックとして LLM 文脈へ供給（精密ブロック描画済みは除外・照合は生データ・**描画は segments の表示項目チェック（canViewField）通過行のみ** = F-16 準拠）
- [x] ナレッジのドキュメント取込: `POST /v1/knowledge/import`（.md/.txt/.pdf/.docx。PDF = pdfjs-dist（旧 pdf-parse は Node 22 非対応で不採用）・DOCX = mammoth・タイトルは指定 > md 見出し > ファイル名・本文 20,000cp/原本 10MB 上限）→ knowledge_articles 記事化（**既存スキーマ不変**）+ 原本を knowledge_files へ保全 → 検索インデックス自動反映。UI = /masters/knowledge「ドキュメント取込」+ 詳細ドロワーの添付一覧・ダウンロード
- [x] 検証: 単体 51（name-match 正規化/最長一致/自社キーワード + bigram 境界）/ API 統合 106（reindex 権限・冪等 / 名寄せ・弊社・現在質問優先 / リトリーバル + knowledge.body/title deny の剥がし / md 取込のタイトル抽出・原本ラウンドトリップ・再インデックス反映 / txt・pdf・docx 抽出 / .doc 案内・破損 PDF 422・domain 検証）/ mockup 単体 35 / 両 typecheck / api build / E2E フルスタック 12+16+11+**10**（「弊社の取引先」の自社名寄せ実クリック 2 件追加）+ モック回帰 10
- [x] 供給対象外の設計判断（§17 から変更なし）: ドキュメント管理（/support/documents = 未移行デモデータ）は検索インデックス対象外。ナレッジへ取り込んだドキュメントは対象
- [x] 反復レビュー（原則9・PR #45）: 独立レビュー R1 で重大 3（いずれも漏えい方向: ①検索リトリーバルの segments チェック不足 = 先方担当者の役職・PJ の status/type・主業界マーク・業界所属・ナレッジ対象紐付けが deny を迂回 ②body_hash が segments を含まず checks 強化が既存行へ伝播しない = 手動 reindex が回復パスとして機能しない ③原本ダウンロード/添付一覧が knowledge.body/title の deny を迂回）+ 軽微 6（エスカレーション裁定還流の再生成フック欠落・埋め込み UPDATE の並行競合ガード・全件フェッチの決定性/規模コメント・旧実装コメント・未参照 devDependency・クライアント履歴照合の優先則差異）を検出 → **全件修正**（segments チェック網羅 + ハッシュへ segments 混入 + canViewField ガード + body_hash 条件付き埋め込み UPDATE + scheduleSearchRebuild フック + 履歴の新しい順 1 件ずつ再判定）。回帰テスト: contacts.title / companies.industryIds / projects.type の検索経路 deny・原本 DL 403・添付一覧空の 5 観点を追加（統合 108 件）

## 20. 権限設定の項目キー UI 刷新（オペレーター指示 2026-07-19）の完了条件（Definition of Done)

- [x] 項目キーの指定を物理名フリーテキスト → 論理名の複数選択オートコンプリート（UiMultiCombobox 新設。論理名・物理名の両方で部分一致検索）
- [x] 複数選択時は 1 項目 1 ルールで一括作成（PermissionRule スキーマ・API 不変 = 原則7）。同一ルール（レイヤ・対象・リソース・項目・効果が一致する有効ルール）は作成・編集ともスキップ/拒否
- [x] 編集時は単一選択・機能リソース選択時は項目欄非表示・一覧の項目列は論理名表示（物理キーは title 属性）
- [x] 既存データ互換（原則7）: カタログ外の物理キー（過去の手入力値）は一覧・編集チップにそのまま表示され壊れない。ただしチップを外すと候補にないため再選択は不可（キャンセルで復帰）。**旧 UI で可能だった `custom` キー（カスタム項目全体）の deny は新規作成不可**（id・active と同様に制御対象外とする設計判断。既存の custom ルールは表示・保持される）
- [x] 反復レビュー（原則9・PR #46）: R1 で重大 1（openEdit のフォーム差し替えに resource watch が発火して編集初期値の項目を消し、無変更保存で「項目 deny」が「マスタ全体 deny」へ静かに拡大する実バグ = Vue 実挙動で再現確認済み）+ 軽微 4 を検出 → 全件修正（リセットを watch → セレクトの change ハンドラへ移動・既存 subjectKind watch の同種 UX バグも同時解消・編集パスへ重複ガード追加・Enter の閉状態ガード + ARIA 補強・CONVENTIONS 在庫表追記・本注記）。R2 で全件解消 + 新規軽微 1（コンボボックスの Esc がモーダルまで閉じ入力途中を破棄）→ stopPropagation で修正し**収束**（実クリックスモーク 11 チェックで固定）

## 21. 権限表（マトリクス）モードの追加（オペレーター指示 2026-07-19 #2）の完了条件（Definition of Done)

> **注:** 本節の「未設定 → 拒否 → 許可 → 未設定 の循環」「フラットなセクション構成」はバッチ7m
> （§35。オペレーター指示 2026-07-21）で「常時可否表示 + トグル」「ページ > 機能 > 項目 の階層」へ
> 置き換えられた。以下は当時の DoD 記録として保持する。

- [x] /masters/permissions を 2 モード化（タブ切替。ルール一覧 = 従来機能をそのまま維持 / 権限表 = 新設）
- [x] 権限表: 行 = 機能 16 + 5 マスタの表示項目 51（論理名 = utils/permission-catalog を一覧モードと共有 = 原則3）× 列 = レイヤ内の対象（ロール 3 固定 / 役職 = 区分マスタの有効値 / 個人 = UiMultiCombobox で列を選択）
- [x] セルクリックで 未設定 → 拒否 → 許可 → 未設定 を循環。拒否化は同一キーの無効ルールがあれば復元して再利用（履歴の乱立防止・冪等 = 原則2）、許可→未設定は論理削除（監査保持）。連打は busy ガードで競合防止。成功時トーストなし = セルの状態変化が即時フィードバック（設計判断）
- [x] データはルール一覧モードと同一の PermissionRule（1 項目 1 ルール・スキーマ/API 不変 = 原則7）。両モードは完全相互運用（一覧で作ったルールが表に反映・表の変更が一覧に 1 件だけ現れることを実クリックで固定）
- [x] セルはそのレイヤの明示ルールを表示（同一キー複数はレイヤ内解決と同じ deny 優先で代表）。最終可否はレイヤ解決（個人 > 役職 > ロール）で決まる旨・admin のマスタ/設定 deny がロックアウト防止で無視される旨をヒント・脚注で明示
- [x] レスポンシブ（原則8): マトリクスは overflow-x-auto + 先頭列 sticky
- [x] 検証: mockup typecheck / 単体 35 / ブラウザ実クリックスモーク 17 チェック（従来 11 + 権限表 6 = 未設定表示・一覧作成ルールの反映・循環 3 状態・乱立なし）
- [x] 反復レビュー（原則9・PR #47）: R1 で重大 1（未設定→拒否の復元パスが restore → patch の順で、途中失敗時に無効だった allow ルールが有効化される = 拒否操作の失敗が権限を広げるフェイルオープン）+ 軽微 5（旧データの deny+allow 併存時の重複 allow 生成と解除の空振り / ロックアウト保護表示が個人レイヤの admin を対象外 / セクション見出しの sticky 不発 / aria-busy なし / タブ往復で権限表の状態破棄）を検出 → 全件修正（patch → restore の順へ入替 = フェイルセーフ・併存時は deny の論理削除 + 解除は全件論理削除で 1 クリック収束・member レイヤの admin 判定 + 脚注拡充・見出し内側 sticky・aria-busy・v-show 化）

## 22. バッチ7b: カレンダー同期対象の選択 + AI 社員間の依頼・連携（オペレーター指示 2026-07-19 #3）の完了条件（Definition of Done)

### 7b-1 カレンダー同期対象の選択
- [x] 回答: 従来の同期対象は **primary（マイカレンダー）固定**（`calendars/primary/events` ハードコード）。共有・サブカレンダー（チーム開発等）は同期対象外だった
- [x] `calendar_tokens.selected_calendar_ids`（0022。既定 `["primary"]` = 従来挙動の下位互換 = 原則7）+ `GET /v1/calendar/calendars`（Google calendarList + 保存済み選択のマージ）+ `PUT /v1/calendar/calendars`（1〜20 件・検証付き）
- [x] 同期は選択された全カレンダーを横断（同一イベント id は重複排除 = (member_id, google_event_id) 一意と整合）。**一部カレンダーの取得失敗は「取れた分だけ同期 + 削除フェーズ抑止 + warning」**（原則4。全滅のみエラー）。アプリ発予定の Google への反映先は常に primary（設計判断）
- [x] UI: カレンダー連携ゲートの連携済みバーへ「同期カレンダー」ボタン → チェックボックスモーダル → 保存で当日分を自動再同期。モックモードは擬似カレンダー 4 件 + localStorage 永続
- [x] スコープ変更なし（calendar.readonly で calendarList 参照可 = 再連携不要）

### 7b-2 AI 社員間の依頼・連携（マネージャーロール）
- [x] `AiRole.permissions` の認識キー **`delegate`**（shared/domain/ai-tasks の DELEGATE_PERMISSION。ロール設定の権限候補へ「他のAI社員への依頼・連携（マネージャー）」を追加）。マネージャーロール = この権限を付与したロール（オペレーターがロール設定画面から自由に作成できる）
- [x] `ai_tasks` へ追加列のみ（0022 = requester_ai_employee_id / parent_task_id。既存データ・API 不変 = 原則7）
- [x] フロー: マネージャーへの依頼 → 分解（従来どおり）→ **人間の承認 1 回で、他の有効 AI 社員へ分担を子タスク化**（割当 = LLM 構造化出力 → 失敗時 shared planDelegation = 役割名・ミッションとの字句類似 + ラウンドロビンの決定的ヒューリスティック。担当ごとに 1 子タスク・即 in_progress）
- [x] 連動: 子の完了 → 親へ報告ログ + ステップのロールアップ（全分担完了で親 done + 「統合して報告」+ 依頼者へ AI 連携完了通知。子の個別完了は人間へ通知しない = 重複防止）/ 子のブロック → 親へエスカレーションログ + 依頼者通知 / 親の中止 → 未完了の子へ連鎖。**子からの再連携なし = 連鎖の暴走防止**
- [x] UI: タスクボードへ「◯◯ からの分担依頼」「n 名の AI 社員へ分担中（完了 m）」の連携表示・AI 社員ドロワーへマネージャーバッジ
- [x] モックモードも同一ロジック（delegateOnApproveMock / rollUpToParentMock = shared planDelegation を共有）
- [x] 検証: 単体 54（planDelegation の類似割当・ラウンドロビン・決定性）/ 統合 113 ×3（連携生成・requester/parent 列・ステップ取りこぼしなし・連携ログ・全分担完了で親自動 done + 通知・ブロックのエスカレーション + 通知・中止の連鎖・非マネージャーは連携しない・カレンダー選択の検証/未連携ガード）/ 両 typecheck / api build / E2E 全スイート回帰 green
- [x] 反復レビュー（原則9・PR #48 → フォローアップ PR）: R1 で重大 0 + 軽微 9 を検出 → 全件対応（①連携計画の LLM 呼び出しをロック取得前へ移動 = Vertex ハング時のプール枯渇防止（llmDecompose と同配置・ロック後に分解不一致なら決定的計画で再作成） ②cancelled の分担を「完了待ち」に数えない = 中止が統合完了を恒久ブロックしない（親中止連鎖と同一集合・モックも同修正） ③親子ロック順序差のデッドロック（40P01）を AKO-AIC-009 = 409 再試行可能へ変換 ④sync の warning をフロントへ伝搬しトースト報告（保存後再同期・手動同期の両方） ⑤404（共有解除）カレンダーは「予定ゼロ」扱い = 削除フェーズを永久抑止しない + 選択見直しの案内 ⑥選択解除カレンダーの掃除タイミング（日付単位）を api-design へ明文化 ⑦モックの選択をイベント合成へ反映（既定選択は従来と同一 = 下位互換） ⑧同期統合を純関数 mergeCalendarFetches へ分離し単体 4 件追加 ⑨UI 細部 = 連携済みバーの flex-wrap・モーダル読込の aria-live/aria-busy・タスクボードの名前解決を無効化済み AI 社員含む全件へ）。回帰テスト: cancelled 分担のロールアップ統合 1 件 + カレンダー統合の単体 4 件（単体 58・統合 114）

## 23. バッチ7c: ぽいぽいメモ/議事録の独立メニュー + 業務種別マスタ + AI 参照統合（オペレーター指示 2026-07-19 #4）の完了条件（Definition of Done)

- [x] ぽいぽいメモを独立メニュー化（/poipoi。本人のみ参照 = C3）・議事録登録メニュー新設（/minutes。全員参照 = C2）。どちらも任意でプロジェクト・顧客・業務種別を紐付け（notes 0023 = 記録系・追記のみ）。ダッシュボード業務ツールへカード 2 枚
- [x] 業務種別マスタ（work_categories 0023 = /masters/work-categories。汎用マスタ CRUD・モックシード 4 件）
- [x] ドキュメント取込（.md/.txt/.pdf/.docx・10MB・旧 .doc は変換案内 = AKO-NOTE-001〜003）。原本は note_files へ保全。モックモードは .md/.txt のみ（抽出はサーバーの設計判断）
- [x] AI 用インデックス/ベクター化: search_docs へ kind 'note' を追加（body 1500cp + 紐付け segments。CHECK 制約差し替え）。**poipoi は owner_member_id = 本人スコープ**（searchDocsFor が WHERE owner IS NULL OR = user で絞る = チャットボット・AI業務アシスタントとも本人のメモしか参照しない）。書込後の自動再生成 + 起動時 + 手動 reindex は既存経路
- [x] AI業務アシスタントの参照統合: 日報ドラフト材料へ notes(poipoi, 当日, 本人) を合流（旧 assist_logs メモも下位互換で継続）。**LLM ドラフト生成へ buildContext（チャットボットと同じ参照範囲・権限準拠）を 4000cp cap で供給**（LLM 無効時は従来ヒューリスティックのみ = 原則4）
- [x] 日報・週報はフォーム入力が既定（reports.vue の entryMethod 既定を 'form' へ。設定 'both' = フォーム主 + AI アシスト補助）
- [x] 機能ガード poipoi / minutes を FEATURE_PERMISSION_KEYS / featureKeyOfPath へ追加（F-16 準拠）
- [x] 検証: 単体 58 / 統合 120 ×3（業務種別 CRUD / poipoi の本人スコープ・紐付け / 議事録の全員参照・.md 取込・原本ラウンドトリップ・poipoi 原本の本人ガード / 検索統合 = minutes 全員・poipoi 本人のみ / 機能 deny の API・検索文脈の一貫閉塞 / ドラフト材料合流）/ 両 typecheck / api build
- [x] 反復レビュー（原則9・PR #51）: R1 で重大 0 + 軽微 8（マスタページの複製残骸文言 / 検索リトリーバルの note ヒットに機能ガード（can('poipoi'/'minutes')）未適用 = F-16 一貫性 / 原本 2 エンドポイントの guardFeature 欠落 / titleFrom のセンチネル比較と cap 漏れ / HANDOFF の実装宣言と実態の乖離（2 系統併存の設計判断へ修正）/ data-design の kind 列挙漏れ / 材料サマリの件数が notes を含まない / テスト抜け）→ **全件修正** + 回帰（機能 deny の一貫閉塞・kind 不正 400）を追加

## 24. バッチ7d: ノートの取消フロー + 取込ボタン + 紐付けによる AI 文脈の混入防止（オペレーター指示 2026-07-19 #5）の完了条件（Definition of Done)

- [x] **本アプリ共通原則「操作の取消可能性」を CLAUDE.md 開発原則 9.5 + Push 前セルフチェック 11 として明文化**（全ユーザー操作に取消/立ち戻りフローを必須化。記録系は監査ログ付き論理削除）
- [x] ノートの取消: `POST /v1/notes/:noteId/archive`（notes.active 0024 = 論理削除 + 監査ログ 'archive'。poipoi = 本人のみ / minutes = 登録者 or 管理者。冪等 = UPDATE を active 条件付きで行い同時実行でも監査 1 回 = 原則2）。一覧 SQL・検索インデックス・日報ドラフト材料（API assist.ts + モック useReportAssist の両方）すべて active=true のみ参照
- [x] ノートの復元: `POST /v1/notes/:noteId/restore`（取消の取消 = 原則 9.5 の対称性。権限・冪等は取消と同一）。取消済みは `GET /v1/notes?includeArchived=1` で**復元権限者にのみ**見え、取消済みノートの原本ファイル（/:id/files・/files/:id）も復元権限者のみ参照可（誤アップロード原本を晒し続けない）
- [x] UI: 一覧の各行に取消ボタン（権限がある行のみ表示・確認ダイアログ付き）+ 「取消済みを表示」トグルから「元に戻す」で復元。モックモードも同権限判定で active:false 化
- [x] ファイル取込のステージ化: 選択で即アップロードせず、ステージ表示（ファイル名・サイズ・解除 X）→「この内容で取り込む」押下で実行。紐付けセレクト（プロジェクト・顧客・業務種別）の選択が取込にも適用される（取込 API は従来から紐付け対応 = UI の適用タイミングを明確化）
- [x] 混入防止: search_docs.links jsonb 0024（ノートの companyId/projectId を保持。**顧客未指定でも PJ 経由で顧客を補完** = PJ のみ紐付けたノートが顧客フィルタを素通りしない。body_hash にも算入 = 紐付け変更で再インデックス）。チャットボット/AI業務アシスタント（buildContext 共用）のリトリーバルで、質問が特定の顧客/プロジェクトに解決された場合、**異なる顧客/PJ に紐付いたノートを文脈から除外**（無紐付けノートは従来通り対象 = フェイルオープンで情報欠落を防ぐ）。解決は会社ブロックと同じ **「今回の質問 → 履歴の新しい順 → 自社キーワード」の優先順**（findMentionedIn へ共通化。2026-07-18 #3 で修正済みの「履歴が質問に勝つ」誤りを再導入しない）+ 正規化・最長一致（プロジェクトも同一ロジック）
- [x] 制約（設計判断）: 複数顧客の比較質問（「A 社と B 社を比較」）は最長一致の 1 社に解決され、もう一方の紐付けノートは文脈から外れる（既存の会社ブロックと同じ単一解決の制約。無紐付けノートと精密ブロックは影響なし）
- [x] 一回性コスト（オペレーター向け）: body_hash へ links を算入したため、**デプロイ後最初のインデックス再生成で全 search_docs 行のハッシュが変わり、Vertex 埋め込みの全件再計算が 1 回走る**（自動回復・恒久コストなし。埋め込み無効環境は影響なし）
- [x] 残課題（原則 9.5 の遡及適用。対象機能の改修時に順次）: AI業務アシスタント内の旧経路ぽいぽいメモ（assist_logs）・AKEBONO 要望ボックス・チャットメッセージは取消フロー未対応
- [x] 検証: 単体 58 / 統合 126 ×3（取消の権限マトリクス = HR 403・管理者可・登録者本人（非管理者）可・poipoi は管理者でも 403・本人可 / 冪等 no-op 警告（取消・復元とも）/ 取消前は検索文脈に載る正の対照 → 取消後の一覧・AI 文脈からの除外 / 復元で一覧へ復帰・includeArchived の可視範囲（他人には見えない）/ 取消済み原本の 403 / 取消済み poipoi がドラフト材料に混ざらない / 混入防止 = A 社の質問に A 紐付け議事録は載り B 紐付け議事録は載らない・無指定の質問では**両方**対象・**履歴に別会社が居ても今回の質問の会社を優先**）/ 両 typecheck / api build / E2E 全スイート green（12+16+11+10+10）

## 25. バッチ7e: マトリクス z-index 修正 + ぽいぽいポスト改称/管理者閲覧 + 議事録サマリー一覧 + マークダウン対応（オペレーター指示 2026-07-19 #6）の完了条件（Definition of Done)

- [x] チーム提出状況マトリクスの z-index 不具合修正: `.tbl th` の `z-index: 1`（要素 + クラスの詳細度）が Tailwind `z-[2]` に勝ち、メンバー列ヘッダーが日付ヘッダー（後続兄弟・同 z）に被られていた → `!z-[2]` で上書き。`.tbl` + sticky left の組み合わせは reports.vue のみ（PermissionMatrix / ShiftGrid は独立テーブルで影響なし = Grep で確認）
- [x] 「ぽいぽいメモ」→「ぽいぽいポスト」改称: UI 全表記・権限カタログの論理名・監査ログ文言・検索セグメント（種別: ぽいぽいポスト）・ドキュメント全件。内部キー `poipoi`・API パスは不変（下位互換 = 原則7）
- [x] 管理者の全ポスト閲覧（フィードバック・チーム改善用途）: `GET /v1/notes?kind=poipoi&scope=all`（管理者のみ・active のみ）+ poipoi 取込原本も本人 + 管理者が参照可へ変更。/poipoi に「全メンバーのポスト（管理者）」セクション（投稿者・日時・冒頭 → 押下で全文）。**取消は本人のみ・AI の参照スコープ（owner_member_id = 本人）は不変** = 管理者チャットボットに他人のポストは載らない（混入防止の設計維持）
- [x] 議事録のサマリー一覧 + 詳細表示: 一覧は登録日時・投稿者・冒頭 160 字のサマリー、押下で詳細モーダル（全文マークダウン描画・紐付け・取込バッジ）。全メンバー参照可（従来どおり C2）
- [x] マークダウン対応: `mockup/app/utils/markdown.ts`（安全なサブセットパーサ = 見出し/リスト/番号リスト/引用/コードブロック/強調/インラインコード/http(s) リンクのみ）+ `UiMarkdown.vue`（**AST → VNode 直接生成 = v-html 不使用（CONVENTIONS 絶対規則 4 準拠）で XSS が構造的に成立しない**。javascript: スキーム等はリンク化されず平文）。適用先: ノート詳細・日報（所感/課題/明日の予定の表示 + 編集プレビュー）・週報（4 欄の表示 + 編集プレビュー）・ノート登録フォームのプレビュートグル。**保存データはプレーンテキストのまま**（描画時解釈のみ = 下位互換・API 変更なし）
- [x] 検証: mockup 単体 41（markdown パーサ 6 追加 = XSS 安全性含む）/ api 単体 58 / 統合 128 ×3（scope=all の権限・取消済み除外・原本の本人 + 管理者ガード。7c 期待値は 7e 仕様へ更新）/ 両 typecheck / api build / E2E 全スイート green（12+16+11+10+10）
- [x] 一回性コスト（オペレーター向け）: 検索セグメントの「種別: ぽいぽいポスト」改称で **poipoi ノートの body_hash が変化し、次回のインデックス再生成時に poipoi 分のみ Vertex 埋め込みの再計算が 1 回走る**（バッチ7d の全件再埋め込みと同型・自動回復・恒久コストなし。埋め込み無効環境は影響なし）
- [x] 設計判断: 管理者閲覧は「一覧・原本の閲覧」のみで、取消済みポストは対象外（取消 = 本人の意思を尊重）。ai-assistant 内の旧経路ぽいぽいメモ（assist_logs）は §24 の残課題のまま（本バッチは notes 経路のみ）

## 26. バッチ7f: 権限デフォルト + AI 社員の増減 + AI カンパニーの実遂行化（オペレーター指示 2026-07-19 #7）の完了条件（Definition of Done)

- [x] 権限の運用デフォルト（0025 = DB レコード登録）: 一般（member）= 売上管理・意思決定支援・マスタ・設定 deny / 人事（hr）= 売上管理・意思決定支援 deny / 管理者 = 全 allow。**有効ルールが 1 件でも存在する環境には投入しない**（冪等・状態保護 = 原則2。運用済み設定を上書きしない）。マスタ/設定の deny は管理 UI 非表示のみ（/v1/masters・/v1/configs の参照 API はデータ面 = 対象外・参照データ供給は全ロール維持）。モックシードにも同一 6 ルール（SEED_VERSION 6）。個別例外は権限設定画面の上位レイヤ allow で上書き可
- [x] AI 社員の増減: `/ai-company/employees`（管理者）で追加（増員・席自動割当）・名前/ロール変更・無効化（減員 = 論理削除）・復元。減員後の新規依頼は 404・過去タスク/ログの担当名は保全。原則 9.5 = 復元でいつでも戻せる
- [x] AI カンパニーの実遂行化（モック動作の脱却）: 「進める」でステップを **Vertex AI が実際に遂行し成果物（マークダウン）を生成**（材料 = 依頼文 + 添付抽出テキスト + 画像（マルチモーダル・3 枚まで）+ 確認済み Q&A + 前ステップ成果。ロールの systemPrompt を反映）。ai_tasks.outputs へ追記（記録系）。全ステップ完了で統合報告（step=-1）。連携タスクは分担先の統合報告を親（マネージャー）が集約。LLM 無効環境は決定的ヒューリスティックの実施記録へ縮退（原則4 = モックと同一関数 heuristicStepOutput）
- [x] 人間のアクション要求: 遂行に判断・追加情報が必要と AI が判定（LLM 無効時は「説明 20 字未満 or 疑問符 = 一度だけ」の決定的判定 = heuristicNeedsInput）した場合、**依頼者へ具体的な質問（ai_task_questions）+ blocked + 通知**。回答待ち中の progress は AKO-AIC-014。`POST /tasks/:id/answer`（依頼者 or 管理者・添付可）で回答 → in_progress へ復帰し、回答が以後の遂行材料になる
- [x] 依頼者インプットの拡張: フリーテキスト + **添付 .md/.txt/.pdf/.docx/.pptx（テキスト抽出）/.jpg/.png（マルチモーダル）**。10MB × 5 件・原本は ai_task_files 保全（DL = 依頼者 + 管理者）。**.pptx 抽出を extract-text へ追加**（jszip = mammoth 経由の既存実体を明示依存化。スライド順・XML エンティティ復元・ノートは対象外の設計判断）
- [x] エラーコード: AKO-AIC-010（添付形式）/ 011（サイズ・件数）/ 012（回答対象なし）/ 013（回答権限）/ 014（回答待ち）を台帳へ追加
- [x] UI: タスク詳細モーダル（成果物 = UiMarkdown 描画・質問/回答スレッド・回答フォーム（テキスト + 添付）・「次のステップを遂行」）。タスクボードに「回答待ち」表示 + 「回答する」導線 + 成果物件数。依頼フォームに添付ステージ（選択 → 一覧表示 → 個別解除 = 即送信しない）
- [x] 検証: api 単体 62（pptx 抽出 4 追加 = zip 爆弾の打ち切り含む）/ 統合 132 ×3（権限デフォルトの再有効化検証 = member/hr の sales・decision 403・masters 参照 API 影響なし / AI 社員の増減・復元 / 実遂行 E2E = 質問 → 回答権限 403 → 回答 → 成果物 → 統合報告 / 添付バリデーション・原本 DL 権限）/ mockup 47 / 両 typecheck / api build / E2E 全スイート green
- [x] 設計判断（可視性 = レビュー R-5）: **タスクボードは従来どおり全員参照（C2）で、成果物・質問/回答（添付から抽出したテキストの引用を含む）も全員に見える** = 依頼と成果をチームで共有する前提。原本ファイル（バイナリ）のダウンロードのみ依頼者 + 管理者に制限。機密を含む資料は添付前に判断する運用
- [x] 既知の限界（レビュー M-10・**バッチ7i R1 M-1 で対象拡大**）: 添付抽出テキスト・回答・ロール systemPrompt・**Web 調査メモ（Google 検索グラウンディング由来のページ本文・出典タイトル = バッチ7i）**は LLM プロンプトへ直接入る = **プロンプトインジェクションで成果物の内容・「参考」リンクが汚染され得る**。generateJson は構造化出力のみ（ツール実行なし）で、描画は UiMarkdown（v-html 不使用・http(s) リンクのみ）のため影響は成果物テキストの範囲に限定される。**出典 URL（groundingChunks.web.uri）は Vertex のリダイレクト URL で一定期間後に失効し得る（R1 M-2）= 成果物の「参考」リンクは恒久保証しない**
- [x] 既知の境界（レビュー M-9/M-12）: 0025 のスキップガードは「有効ルールの有無」で判定 = 全ルールを意図的に無効化した環境には投入される / 分担中の親タスクを手動で進めると子と同名ステップの成果物が重複し得る（7b からの既存挙動。親 done の二重化はロールアップ側で防止済み）/ リクエストボディは 80MB の総量制限（AKO-GEN-004 = 413。**本番 Cloud Run は HTTP/1 リクエスト 32MB 上限があるため、大型添付の複数同時アップロードはプラットフォーム側で先に拒否され得る = UI 文言「10MB×5 件」の実効上限は環境依存**）を追加
- [x] 設計判断: テストは権限デフォルトを一旦無効化してから実行（既存の権限テスト群は未設定 = 全 allow 前提で自前でルールを出し入れするため。デフォルト自体の検証は専用テストが再有効化して実施）。モックモードの実遂行はヒューリスティックのみ（LLM なし）・添付はメタのみ保存（原本抽出はサーバーの設計判断 = ノート取込と同型）

## 27. バッチ7g: AI 参照範囲の権限化 + 週次 AI インサイト（オペレーター指示 2026-07-19 #8/#9）の完了条件（Definition of Done)

- [x] AI 参照範囲の権限化（F-16-5）: `PermissionRule` の擬似フィールド `ai-scope`（allow = すべて / deny = 自分の登録データのみ。スキーマ不変 = 既存レイヤ解決を再利用）+ shared `aiReferenceScope()`。対象区分 = AI_SCOPE_FEATURES（ぽいぽいポスト・勤怠・タスク計画 = 本人スコープを持つドメイン。'all' で供給されるのはチームのタスク計画のみ・カレンダー予定は本人分に限る）。**機能自体の deny が最優先**（機能が使えないユーザーの AI には当該ドメインを供給しない = 従来どおり）
- [x] ぽいぽいポストの AI 参照は**既定「すべて」へ変更**（指示 #8 = 他メンバーの投稿も参照して回答・アクション）: searchDocsFor へ allOwners を追加し owner フィルタを条件化。検索ドキュメントへ**投稿者名セグメント**を追加（誰のフィードバックかを文脈化）。勤怠・タスク計画の既定は「自分のみ」（C3 安全側）で、'all' 設定時はチーム全体の当月勤怠サマリー / 本日のタスク計画を文脈へ供給
- [x] 権限設定 UI: ルール一覧（擬似リソース「AI 参照範囲: ◯◯」で追加・編集。効果の語彙 = すべて/自分のみ）+ 権限表（AI 参照範囲セクション。✓ = すべて / × = 自分のみ・既定値を行ラベルへ表示）。両モードは同一 PermissionRule を読み書き
- [x] 週次 AI インサイト（F-06-10）: `GET /v1/reports/weekly-insight?weekStart=` = 該当週の全登録データ（提出済み日報（人間）・週報・タスク計画・稟議・エスカレーション・AI タスク・ノート・当月売上）を**決定的に集計**（WeeklyMetrics）→ Vertex AI が経営・営業・チーム視点の洞察（エグゼクティブサマリー・SWOT・リスク（high/mid/low）・推奨アクション）を構造化出力。**LLM 無効・失敗時は shared heuristicWeeklyInsight へ縮退（モックモードと同一関数 = パリティ）**。売上は can('sales') のみ供給・reports 機能 deny は 403
- [x] UI: 週報タブへサブビュー「自分の週報 | AI インサイト」（WidgetsWeeklyInsight = KPI カード 8 種 + メンバー別/テーマ別工数・日別提出数チャート + サマリー/SWOT 4 象限/リスク/アクション/課題明細。週ナビ + 再生成。保存しない = 常に最新データから生成）
- [x] 一回性コスト（オペレーター向け）: 検索ドキュメントへ投稿者セグメントを追加したため、**次回のインデックス再生成でノート分（poipoi + minutes の一部）の Vertex 埋め込み再計算が 1 回走る**（自動回復・恒久コストなし）
- [x] 検証: api 単体 67（aiReferenceScope 5 追加）/ 統合 135 ×3（既定 all で他メンバーの投稿が文脈へ・ai-scope deny で自分のみへ制限・レイヤ対象外は不変 / 勤怠の既定 own → allow ルールでチームサマリー供給 / 週次インサイト = 400・集計・決定的洞察・売上の権限マスク。7c の「本人のみ」期待値は 7g 仕様へ更新）/ mockup 47 / 両 typecheck / api build / E2E 全スイート green
- [x] 設計判断: モックモードのチャットボットはシナリオ応答（LLM なし）のため AI 参照範囲は API モードの文脈供給に適用（権限設定 UI・週次インサイトはモックでも動作）。日報ドラフト材料（本人の日報を書くための材料）は本人スコープのまま = ai-scope の対象外
- [x] 独立レビュー R1 フォローアップ（PR #56 はレビュー完了前にマージ → 指摘は後続コミットで対応）: **C-1** チーム勤怠/チーム計画ブロックが members.name の表示 deny を反映しない → `canField('members','name')` deny 時はチームブロック自体を供給しない（+ 回帰テスト）/ **M-1** weekStart の暦不正・月曜以外は 400（以前は pg 500 / 黙って週ずれ）/ **M-2** 週ナビの競合 = 世代トークンで古いレスポンスを破棄 / **M-3** F-06-10 行の表分離を修正 / **M-4** モックの aiTasksDone を「最終成果物（無ければ作成）日時の週内判定」で API（updated_at 週内）に近似 = 差異は api-design に記載 / **M-5** ai-assistant の区分ラベルを実挙動に合わせ「タスク計画」へ / **M-6** searchDocsFor の allOwners を SQL 側でも source_kind='note' に限定（将来の owner 付き種別追加でも poipoi 設定で漏れない）/ **M-7** E2E ハーネスをリポジトリ `e2e/` へコミット（README + chromium パス可搬化）。瑣末: sales 権限なし時は sales_monthly を SELECT しない・LLM risks の null 要素ガード

## 28. バッチ7h: UX 大規模改修（オペレーター指示 2026-07-19 #10）の完了条件（Definition of Done）

- [x] ① チームタブの表示メンバー + 日報参照権限（F-16-6）: チームタブを全員へ公開（一般 = 提出済みのみ・他人の下書きの存在/内容を見せない・リマインド/工数乖離は管理者/HR のみ）。表示メンバー設定（configs `teamVisibleMemberIds`・管理者の歯車 → モーダル・空 = 全員 = 取消フロー・自分は常に表示）。日報参照権限 = `PermissionRule` 擬似フィールド `member:<対象 id>`（resource='reports'・deny = 参照不可・未設定 = 参照可 = 下位互換・自分は常に参照可 = shared `canViewMemberReports`）。適用: チームマトリクス・全員の日報・API scope=all/team・チャットボットの他人日報文脈・週次インサイト集計（API/モック同一基準）。権限 UI はルール一覧の擬似リソース「日報の参照対象」（対象メンバーの論理名複数選択 = 1 名 1 ルール。権限表は 2 次元化するため対象外 = 設計判断）
- [x] ②③ ナビゲーション導線（UX 設計 = screen-design §5）: `utils/nav-map.ts`（SoT）にルート → 親/関連を一元定義し、レイアウトヘッダーが全ページ共通で「親ページへ戻る」（構造上の親・モバイル常時表示）+「関連」ドロップダウン（関連マスタ・設定・関連機能。canPath/管理者フィルタ・空なら非表示）を描画。子詳細 4 ページ + α のアドホック戻るリンクを撤去（原則3）
- [x] ④ 入力と参照の分離: ぽいぽいポスト/議事録 = 一覧基本ビュー + 入力モーダル（ファイル取込ステージ含む）/ 会社間・人間関係 = 追加ドロワー（マスタ標準に統一）/ 日報 mine = 参照カード（状態 + サマリ）→「日報を書く」でエディタ（AI アシスト材料・生成カードも入力時のみ表示・提出/閉じるで参照へ復帰）/ 週報 = 状態表示 →「週報を書く」でエディタ。打刻・AI アシスタントの計画入力は対象外（アクション/その場編集が適切 = 設計判断）
- [x] ⑤ カードメニューのカテゴリカスタマイズ（F-13-8）: `utils/menu-registry.ts`（SoT）にダッシュボード/マスタハブの全カード + 既定カテゴリを一元定義（3 ページ分散のハードコードを置換）。カテゴリチップ（すべて + カテゴリ・sessionStorage 記憶・消えたカテゴリは「すべて」へ復帰）。設定 > メニューカテゴリ（SettingsMenuCategoryEditor）でカテゴリの追加・削除・名称変更・並び替え・カード割当（論理名検索）。SoT = configs `menu-categories-<area>`（'' = 既定 = 下位互換）。未割当カードは「その他」へ自動表示 = カードが消えない。取消フロー = 「既定に戻す」+ 再編集（原則 9.5）
- [x] 検証: api 単体 72（canViewMemberReports 5 追加）/ 統合 138 ×3（チーム参照の公開 = 一般提出済みのみ・管理者下書き可 / 参照 deny で scope=all・team・チャットボット文脈・週次集計から除外・管理者/本人不変。既存「チーム参照は管理者のみ」期待値は 7h 仕様へ更新）/ mockup 51（nav-map 4 追加）/ 両 typecheck / api build / E2E 全スイート green（12+16+11+10+10 = リポジトリ e2e/ ハーネス）
- [x] 設計判断: チームタブの表示メンバー設定は「表示の整理」（configs）・参照可否は「権限」（permission_rules）と役割分離。メニューカテゴリの選択状態は sessionStorage（アカウント設定にしない = 軽い状態）。scope=team の一般公開は提出済みのみ返す = 下書きの秘匿を API 側で担保
- [x] 独立レビュー R2 フォローアップ（Critical 0 / Minor 3）: **Minor-1** M-1 の残余ウィンドウ（configs 到着前の編集開始）→ 設定ページを開いたら reloadConfigs し、完了まで保存・リセットを無効化（「読込中…」表示）。あわせて保存失敗時に編集内容を破棄しない（save/reset が Result を返す）/ **Minor-2** 表示メンバーを部分設定すると選択肢に出ない役員・業務委託がタイムラインから消える → 表示設定はマトリクス候補にのみ適用（候補外は参照権限のみで判定）/ **Minor-3** ルートコメント・機能マトリクス（F-06-5/6 行）の陳腐化記述を更新
- [x] 独立レビュー R1 フォローアップ（PR #57・Critical 0 / Minor 7）: **M-1** メニューカテゴリ編集の API 非同期レース（configs 到着前の編集で保存済みカスタマイズを上書き）→ 非 dirty 時の再同期 watch / **M-2** scope=team も期間指定必須（400。scope=all と同じダンプ防止）/ **M-3** コメントスレッドに参照ガード（他人の下書き 404・F-16-6 deny 対象者は提出済みでも 404 = 存在秘匿・管理者は下書き可・deny は管理者にも適用 + 回帰テスト 3 系）/ **M-4** screen-design のカテゴリ configs キー表記を実装（`menu-categories-<area>`）に統一 / **M-5** タイムラインの人間日報は「表示設定 ∩ 参照権限」のみで絞る（マトリクス候補の雇用区分条件は課さない = 役員等の提出済みは従来どおり表示）/ **M-6** touchTeamWindow の陳腐化コメント修正 / **M-7** E2E ハーネスの REPO をスクリプト位置から導出（環境変数で上書き可）+ pkill 範囲の限定・README 追記。ニット: 関係マスタの追加ドロワーで前回バリデーションエラーを持ち越さない

## 29. バッチ7i: AI カンパニー承認後の全自動実行 + Web 調査（オペレーター指示 2026-07-19 #11）の完了条件（Definition of Done）

- [x] 全自動実行: 承認（= ユーザーの意思表示）を起点に、「進める」の連打なしで全ステップを自動遂行（完了・依頼者への質問・中止まで）。API = サーバーの fire-and-forget ループ（autoRunTask。progressTaskOnce を HTTP ハンドラと共用・上限 12 ステップ・競合 AKO-AIC-009 は 1 回再試行・停止条件 005/006/014 は静かに終了）+ フロントの追跡ポーリング（3 秒 ×8 回・実行中タスクがある間のみ）。モック = 同期ループ（ヒューリスティック = 即収束）。回答（/answer）・ブロック解除・手動「進める」も自動実行の再開起点。連携分担（マネージャー）は承認時に子タスク群を並行自動実行し、親はロールアップで自動完了
- [x] Web 調査（Google 検索グラウンディング）: 各ステップの遂行前に `generateGroundedText`（Vertex `tools: [{googleSearch: {}}]`。groundingChunks から出典 URL を抽出）で調査メモを生成し、材料に加えて遂行。成果物には「参考」として出典 URL を明記。グラウンディングと構造化出力は併用保証がないため 調査（テキスト）→ 遂行（構造化出力）の 2 段構成。調査失敗・LLM 無効環境は調査なしで続行（原則4。Web 調査は API モードのみの機能 = モックは決定的出力）
- [x] 質問の限定: 依頼者への質問は「自社・顧客のドメイン情報が不可欠」「重要な意思決定・承認が必要」のみ（LLM プロンプトで限定 + ヒューリスティックは 実質空（10 字未満）or 内部参照（自社/弊社/当社/社内/顧客/お客様）+ 30 字未満 のみ。旧「? を含む」トリガーは廃止）。再質問上限 3 回・回答済み依頼へは再質問しない（不変）
- [x] UI: タスクボード・詳細モーダルの「進める」を「自動実行中」表示 + フォールバックの「再開」（サーバー再起動等で自動実行が止まった場合用）へ変更。承認・回答・解除のトーストを自動実行の文言へ更新
- [x] 検証: api 単体 76（質問ポリシー 4 追加）/ 統合 139 ×3（自動実行の収束待ち waitAiTask ヘルパー・十分な依頼に質問しないこと・自動質問 → 回答 → 自動再開 → 統合報告 / 分担の自動完了・ロールアップ。ブロックエスカレーション・中止分担のロールアップは自動実行と競合しない SQL セットアップへ再構成）/ mockup 51 / 両 typecheck / 両 build
- [x] 設計判断: 自動実行は fire-and-forget（Cloud Run のリクエストタイムアウトに全ステップの LLM 実行を載せない）。進捗の SoT は ai_tasks（自動実行中の専用状態は持たない = in_progress のまま。サーバー再起動で自動実行が失われても「再開」ボタン・回答・解除から再開可能 = 冪等な状態機械が排他）。Vertex グラウンディングの API 形状は公式ドキュメントで裏取り済み（tools.googleSearch / groundingMetadata.groundingChunks.web）
- [x] 独立レビュー R1 フォローアップ（PR #58 はレビュー完了前にマージ → 後続コミットで対応。Critical 2 / Minor 5）: **C-1** fire-and-forget 連鎖の未捕捉例外（通知の名前解決クエリ等）が未処理拒否 = プロセス終了に波及し得る → autoRunTask/autoRunAfterApprove を全体 try で非 reject 化・notifyTaskEvents を非スロー化・index.ts に unhandledRejection ハンドラ（深層防御）/ **C-2** Cloud Run のリクエスト課金では応答返却後の CPU がスロットリングされ自動実行が停止し得る → deploy.yml に `--no-cpu-throttling` を追加（**課金がインスタンス稼働時間ベースへ変わる。min-instances 0 のためアイドル時はゼロスケール = オペレーター周知事項**）/ **M-1/M-2** プロンプトインジェクション・出典 URL 失効の既知の限界を文書化（§26 追記）/ **M-3** モックの手動「再開」も残ステップを自動継続（API と同一挙動）/ **M-4** 自動実行中の「再開」競合（009）は「進行中」の案内トーストへ + 追跡ポーリングを 5 秒 ×36（約 3 分）に延長 / **M-5** Web 調査プロンプトに材料（Q&A・添付抜粋）を含める

## 30. バッチ7j: 週次 AI インサイトの永続化 + 前日まで前提 + 全体/個別分離（オペレーター指示 2026-07-19 #12）の完了条件（Definition of Done）

- [x] 永続化: `weekly_insights`（migration 0026。週 × audience 一意・upsert = 導出キャッシュ。SoT は集計元テーブル = 記録系ではない）。GET = 保存済みのみ返す（生成しない）・POST = 生成 + 保管。週ナビは保存済みを読むだけで、「生成/再生成」を押すまで保存内容が表示され続ける。モック = weeklyInsights コレクション（SEED_VERSION 7）+ 同一の upsert
- [x] 前日まで前提: 集計基準日 asOf = min(週末, 前日)・経過営業日（public_holidays + 月〜金既定 = shared/domain/business-day）を WeeklyMetrics に追加。提出数（reportSubmitted・reporters）は asOf まで基準・提出率評価は「経過営業日 × メンバー数」分母（heuristicWeeklyInsight）。LLM プロンプトにも「前日分までが正常・当日以降を悲観評価しない」を明示。経過営業日ゼロの週は提出系評価をスキップ
- [x] 全体/個別分離: 全体共通（company）= 全量集計を保管し、**配信時に閲覧者マスク**（売上 = sales 権限・メンバー別工数/課題 = F-16-6 の memberId 判定）。**全体の洞察本文は個人名・売上に言及しない形で生成**（全員が共有する保管物からの漏えい防止 = 設計判断）。個別（personal = `member:<id>`）= 本人の週次実績（提出・工数・テーマ・課題・計画・週報）+ ロール・役職・所属部署から heuristicPersonalInsight / llmPersonalInsight で生成し本人のみ配信（管理者 = 承認滞留・課題対応 / 人事 = 提出率フォロー / 一般 = 自身の実績、の視点切替）
- [x] UI: 週報タブ「AI インサイト」= 保存済みロード（未生成は案内 + 生成ボタン）→「あなた向けインサイト」セクション（サマリー・注目ポイント・推奨アクション）+ 全体（KPI/チャート/サマリー/SWOT/リスク/アクション）。生成日時・生成者・集計基準日（前日まで）を明示
- [x] 検証: api 単体 82（weekly-insight ヒューリスティック 6 追加）/ 統合 140 ×3（POST 保管 → GET 不変（generatedAt 一致）→ 再生成で上書き / 未生成 null / asOf = min(週末, 前日) / 当日提出は提出数に数えない（新設メンバーで検証）/ 個別は本人のみ（他ユーザーは personal null・全体は共有）/ 売上・F-16-6 の配信時マスク）/ mockup 51 / 両 typecheck / 両 build / E2E 全スイート green
- [x] 下位互換（原則7）: `GET /v1/reports/weekly-insight` の応答形が `{metrics, insight, llm}` → `{company, personal}` へ変更（消費者は本 SPA の useWeeklyInsight のみ = 同時更新。外部クライアントなし）。WeeklyMetrics へ asOf/businessDaysElapsed/memberId を追加（保存データはこのバッチで新設 = 旧形式の保存物なし）
- [x] PR #58（バッチ7i）R1 フォローアップも本 PR に同梱（§29 の R1 フォローアップ項参照。C-1 = fire-and-forget の非 reject 化 + unhandledRejection 深層防御 / C-2 = deploy.yml に --no-cpu-throttling（**課金モデル変更 = オペレーター周知**）/ M-1〜M-5）
- [x] 独立レビュー R1 フォローアップ（PR #59 はレビュー完了前にマージ → 後続 PR で対応。Critical 1 / Minor 5）: **C-1** generatedAt が timestamptz::text の生形式（スペース区切り・UTC）で返り表示が壊れる → リポジトリ規約どおり to_char の JST ISO へ / **M-1** 生成中の週送りで生成ボタンが永久無効化 → フラグを無条件復帰 + 生成中は週ナビも無効化 / **M-2** 全体洞察の個人名抑止をプロンプト指示だけに頼らない → 生成入力から個人名・memberId を剥がすデータ最小化（メンバー1/2… の匿名化）/ **M-4** 「前日まで」の適用範囲（提出系のみ。工数・グラフは週全量）へドキュメント表現を精緻化 / **M-5** featureGuard と重複する requireReportsFeature を除去（原則3）
- [ ] 残課題（R1 M-3・原則 9.5）: インサイトの再生成は前の内容を上書きし履歴・取消がない（導出キャッシュのため元データから再生成は可能だが、LLM 非決定で同一内容には戻らない）。個別のみの生成パスもなく、個別を作ると全体も上書きされる。必要になった時点で「世代保持 or personal 単独生成」を検討

## 31. バッチ7k: チームタブ表示メンバー候補の在籍全メンバー化 + 雇用区分バッジ（オペレーター指示 2026-07-19 #13）の完了条件（Definition of Done）

- [x] 候補拡大: 表示メンバー設定の選択肢を「在籍中の社員・契約・アルバイト」→「在籍中の全メンバー（取締役・外注含む）」へ拡大。既定（設定未設定）は従来どおり = マトリクスは社員・契約・アルバイトのみ / タイムラインは全員。設定ありは「選択メンバー + 自分」でマトリクス・タイムラインを統一（§28 R2 Minor-2 の「候補外は設定の影響を受けない」特例のうち**在籍中の取締役・外注分**は、選択肢に出るようになったため廃止 = 選択状態がそのまま表示状態。**候補に出ない在籍外（退職者等）は引き続き設定の影響外 = タイムライン常時表示** = 「選択肢に出ない対象が部分設定で消える」導線を作らない原則を維持）。判定 SoT = `mockup/app/utils/team-visibility.ts`（純関数へ切り出し = 単体テスト対象）
- [x] 雇用区分バッジ: 設定モーダルの候補行（UiStatusBadge・トーン付き）と選択チップ（小テキスト）に雇用区分を表示。UiMultiCombobox に任意 props `tag`/`tagTone` を追加（未指定 = 従来表示 = 下位互換）。雇用区分トーンは EMPLOYMENT_TYPE_TONES として labels.ts へ集約（メンバー管理のローカル定義を移設 = 原則3）
- [x] 文言: 「全員表示に戻す」→「既定の表示に戻す」（未設定の意味が「全員」から「既定表示」へ変わったため）。モーダル説明に既定の内訳（マトリクス = 社員・契約・アルバイト / タイムライン = 全員）を明記。取消フロー = 既定に戻す + 再設定（原則 9.5 = 従来どおり）
- [x] 検証: mockup 単体 62（team-visibility 11 追加: parse 3 / 既定判定 2 / マトリクス 3 / タイムライン 3）/ mockup typecheck / api 影響なし（表示メンバー設定はクライアント側の表示の整理。API scope=team の応答・F-16-6 は不変）
- [x] 下位互換（原則7）: 表示メンバー設定を**保存済み**の環境では、設定に含まれない**在籍中の**取締役・外注の提出済み日報がタイムラインに出なくなる（従来は候補外特例で常時表示）。表示したい場合は設定モーダルで追加すればよく（候補に出る = 回復フロー）、データパッチは不要（configs の形式・キーは不変）。**在籍外（退職者等）は設定の影響外のまま = 挙動変化なし**（候補に出ない = 回復フローが成立しないため。R1 M-1）。設定未保存（既定）の環境は挙動変化なし。付随: 設定で選択した取締役・外注はマトリクスに載るため、未提出なら管理者の一括リマインド対象にもなる（表示 = 提出管理対象という自然な帰結。提出義務のないメンバーは設定に入れない運用）
- [x] 独立レビュー R1 フォローアップ（Critical 0 / Minor 1 / ニット 4）: **M-1** 在籍外（退職者等 = 候補に出ない）が設定ありのときタイムラインから消え、回復フローが成立しない → timelineVisibleWith に selectable（在籍判定）を追加し、候補外は設定の影響外 = 常時表示へ（バッチ7h の原則を維持）+ 回帰テスト / **N-1** 保存済み設定に残る候補外 id が生 id チップ表示される → openTeamSettings で候補外 id をドラフトから除去（候補外は設定の影響外のため実挙動不変）/ **N-2** 候補検索を tag（雇用区分）にも対応（「外注」で絞り込み可）/ **N-3** リマインド対象の帰結を本 §31 に記載 / N-4 は型上到達しない防御的フォールバック = 修正不要
- [x] 独立レビュー R2 フォローアップ（Critical 0 / Minor 0 / ニット 2）: **N2-1** 保存済み設定の全 id が候補外（選択メンバー全員が退職）のとき、モーダルは空ドラフトなのに保存値が残る「ゴースト設定」が見えない → 候補外 id を除外した場合はモーダルに除外数と「このまま保存すると除外後の内容で確定（未選択 = 既定の表示）」の案内を表示 / **N2-2** UiMultiCombobox ヘッダコメントのフィルタ対象（ラベル・値）を tag 込みへ更新

## 32. バッチ7l: ドキュメント管理の本実装（ファイル管理 + Cloud Storage + ドライブ連携 + AI 参照。オペレーター指示 2026-07-19 #14）の完了条件（Definition of Done）

- [x] 保管（Firebase の Cloud Storage）: メタ = `documents`（0027）・実体 = GCS `documents/<id>/<filename>`（`STORAGE_BUCKET`。JSON API + ADC の raw fetch = 新規 npm 依存なし = カレンダー・Vertex と同一パターン）。**未設定環境は `document_blobs`（bytea）フォールバックで全機能動作**（ローカル/CI/未設定でも壊れない = 原則1・4。GCS 書込失敗時も DB へ縮退して取込成立）。SoT 順序 = 実体を先に保存 → メタ確定（DB 保管は行 + blob を同一トランザクション）
- [x] ダウンロード URL 案内: `POST /v1/documents/files/:id/url` = **15 分有効の V4 署名 URL**（IAM signBlob。実行 SA 自身への iam.serviceAccountTokenCreator を deploy.yml が付与。正規リクエスト構築は純関数 = 単体テストがコードポイント順ソートのバグを検出して修正）。DB 保管・署名失敗は url null → クライアントは base64 ダウンロードへ縮退。原本・URL とも documents.summary の表示項目 deny で 403（deny 迂回防止 = ナレッジと同型）
- [x] Google ドライブ連携: カレンダーの OAuth 基盤（calendar_tokens・AES-256-GCM・accessTokenFor リフレッシュ）を共用し SCOPES へ drive.readonly を追加。**既存連携者は再接続で有効化**（旧スコープは AKO-DOC-006 で AI アシスタントの連携導線を案内。カレンダーは従来どおり動作 = 下位互換）。`GET /drive/status` `/drive/files?q=` `POST /drive/import`（1 回 10 件・各 10MB・Google ドキュメント/スプレッドシート/スライドは docx/csv/pptx へエクスポート変換・**部分成功を imported/failed で報告し失敗分は選択に残して再試行** = 原則4）。取込はコピー保管（取込時点のスナップショット = Drive 側更新は自動同期しない設計判断）
- [x] AI 参照統合: テキスト抽出（extract-text 共用 + csv）→ `search_docs` に `source_kind='document'`（0027 で CHECK 更新・TITLE_CHECKS・owner なし = 全社共有）として字句バイグラム + Vertex 埋め込みのベクター検索へ流入。**チャットボット** = リトリーバルブロックに自動ヒット（機能ガード can('documents') 適用）+ ヒットしたドキュメントの署名 URL を文脈に添付し「回答に使った場合のみ案内」と指示。**AI カンパニー** = ステップ遂行の材料に社内ドキュメント検索（上位 3 件・失敗は材料なしで続行）を追加
- [x] UI（デュアルモード）: useDocuments を API 対応（/v1/documents キャッシュ + SoT 書込 → 取り直し）。実ファイルアップロード（10MB・抽出対象形式のヒント・抽出有無をトーストで通知）・「ドライブから取込」モーダル（連携状態 → 検索 → 複数選択 → 取込先フォルダ）・ドロワーに Drive/AI 検索対象バッジ + ダウンロード + 取込元リンク・**アーカイブ済み（n）トグル + 復元**（原則 9.5。API = /archive /restore + 監査ログ）。モックモードは従来のメタのみ動作を維持
- [x] 権限（F-16）: featureGuard `/v1/documents` → 'documents'（機能キーは既存）。一覧は stripDeniedFields('documents')。権限 UI の項目カタログへ documents（ファイル名・タグ・概要 = 本文相当）を追加
- [x] インフラ（deploy.yml・冪等・非ブロッキング）: `STORAGE_BUCKET` secret 登録時のみ = バケット作成（なければ）+ 実行 SA へ storage.objectAdmin + iam.serviceAccountTokenCreator（self）+ iamcredentials API 有効化。drive.googleapis.com を OAuth 構成時に有効化。setup-deploy-secrets.ps1 に -StorageBucket 追加。**未設定なら DB フォールバックで動作 = 手動ステップなしで最小構成が成立（原則1）**
- [x] 検証: api 単体 87（documents 5 追加 = V4 署名 3・循環検出 2）/ 統合 150（バッチ7l 9 追加: フォルダ・アップロード往復・署名 URL 縮退・インデックス登録・循環 400・アーカイブ/復元のインデックス連動・summary deny 403・機能ガード 403・ドライブ未設定 409・サイズ超過）/ mockup 62 / 両 typecheck / 両 build
- [x] 設計判断: 実体は DB に置かない（GCS が SoT。bytea はフォールバック = knowledge_files の前例を踏襲しつつ本命は外部化）。署名 URL は SDK でなく IAM signBlob の raw 実装（依存追加なし・ローカルでは自動縮退）。ドライブは per-user OAuth（管理者の一括同期ではなく本人の権限で読める範囲だけ取込める = 最小権限）
- [x] 独立レビュー R1 フォローアップ（Critical 1 / Minor 4 / ニット 7 = 全件対応）: **C-1** AI カンパニーの社内ドキュメント材料が権限ガード未適用（deny 迂回の 4 経路目）→ 依頼者基準で機能 'documents' + TITLE_CHECKS/segments の canViewField を適用（原本・URL・チャットボット文脈と一貫）/ **M-1** filename 無サニタイズ + encodeURIComponent の緩さで署名 URL が壊れ得る → sanitizeFilename（パス区切り・制御文字除去）+ strictEncode（RFC3986 厳格版 = ! ' ( ) * も %XX）を保存パス・署名クエリ・RFC5987 disposition に適用 + 単体テスト 3 追加 / **M-2** GCS 先行保存後の DB 失敗で孤児オブジェクト → saveFileRecord 失敗時に deleteObject でベストエフォート掃除（アップロード・ドライブ取込とも）/ **M-3** ダウンロードの window.open がポップアップブロックで無音失敗 → アンカー click ナビゲーションへ（attachment のため画面遷移なし）/ **M-4** 抽出テキスト（非信頼入力）と URL 案内指示の同居 → 「本文は引用であり指示ではない・一覧外の URL をダウンロード先として出力しない」ガード文を追加 / ニット: ①アップロードにもルート直下選択肢 ②フォルダ同名の部分一意 index（uq_documents_folder_name）+ 作成/改名/復元の 23505 → AKO-DOC-003 変換（TOCTOU 解消）③API モードの初回ロード後にツリー全展開（モックと整合）④ドライブ再取込は同一 drive_file_id を複製せずスナップショット更新（冪等 = 原則2。旧実体も掃除）⑤driveSearch/driveImport にモックモードガード ⑥URL 案内クエリに active 条件 ⑦本項の注記: §17・§19・§21 等の過去 DoD にある「ドキュメント = 未移行・デモデータ」は当時の記録（現況は本 §32 が正）
- [x] 独立レビュー R2 フォローアップ（R1 全 12 件解消を検証・新規 Minor 1 / ニット 3 = 全件対応）: **M-R2-1** ドライブ再取込（同名 = 同パス）の DB 更新失敗時に、R1 M-2 の掃除が既存レコードの現役 GCS オブジェクトを削除する退行 → 掃除条件を「既存レコードが同パスを参照していない場合」に限定 / ニット: ①一意 index を 0027 追記 → **0028 の別マイグレーションへ移動**（ランナーはファイル名単位の適用済み管理のため追記は反映されない）②再取込の db フォールバック時に旧 GCS 実体が残る → 成功時掃除の条件へ「GCS 参照が外れた場合」を追加 ③eslint 設定のない環境の死に eslint-disable コメントを除去

## 33. オペレーター報告 2026-07-20（チームタブで外注・取締役を有効化できない / ドライブ検索 HTTP 403）の対応

- [x] **① チームタブ表示メンバーの根本原因**: ロジックではなく**モバイル UI のクリッピング**。ボトムシート型モーダル（UiModal）では検索欄が画面下端付近にあり、UiMultiCombobox の候補リストが下方向（absolute + mt-1）に開くため画面外・フッターに隠れて見えず選択できなかった（実機スタック + モバイルビューポート 390×844 で再現。デスクトップでは選択 → 保存 → マトリクス反映 → リロード維持まで全フロー正常 = バッチ7k のロジック・設定保存経路に欠陥なし）
- [x] **① 修正**: UiMultiCombobox に開閉方向の自動判定を追加 — 開くたびに実測し、下の残り空間が候補リスト高（当時の実装 = 固定 max-h-56 + マージン。現行は R1 フォローアップ行のクリップ祖先基準 + 動的 max-height が正）に満たず上の方が広ければ**上方向（bottom-full）に開く**。汎用対応のため権限設定等の他の利用箇所でも同様に効く（下に収まる配置では従来どおり下開き。デスクトップでも下端付近では上開きになる = 意図した挙動）
- [x] **② ドライブ HTTP 403 の原因分析**: 「HTTP 403」のみの表示では判別不能だが、スコープ検査（calendar_tokens.scope に drive.readonly）は通過済み = 403 は Google API 側。最有力は **OAuth クライアントのプロジェクトで Google Drive API が未有効**（deploy.yml の自動有効化は権限不足時に警告のみで続行する非ブロッキング設計）。次点はスコープの再同意漏れ・OAuth 同意画面の制限
- [x] **② 修正（自己診断化）**: Google API エラー応答の reason / message を AKO-DOC-007 と取込 failed[].reason に含める（`accessNotConfigured` 等が画面に出る）+ 403 時は「Drive API の有効化（gcloud services enable drive.googleapis.com）/ 再接続」の運用ヒントを付記。deploy-guide §4 にトラブルシュート項を追加
- [x] 検証: 新規 E2E スイート `e2e/team-visibility-e2e.cjs`（当時 10 チェック。R1 フォローアップで実可視性を加え 11 チェック: デスクトップの選択 → 保存 → 反映 → リロード維持 / モバイルの上方向展開・ビューポート内・実可視・タップ → 反映）を run-batch6b-stack.sh に登録し green。mockup 62 / api 単体 90（現行 95 = R1/R2 フォローアップで追加）/ 統合 150 / 両 typecheck / 両 build green
- [ ] 残課題（オペレーター側の運用確認）: 本番 GCP プロジェクトで `drive.googleapis.com` が有効かの確認（無効なら有効化）。修正デプロイ後のエラーメッセージに Google の理由が表示されるため、それで確定診断できる
- [x] 独立レビュー R1 フォローアップ（PR #63 はレビュー完了前にマージ → 後続 PR で対応。Critical 0 / Minor 3 / ニット 4 = 全件対応）: **M-1** 方向判定がビューポート基準でクリップ祖先（モーダル本文の overflow 等）を見ておらず、未フィルタ時にリスト上端が切れ先頭候補が不可視になる残欠陥 → 可視境界を「クリップ祖先（overflow ≠ visible の祖先）とビューポートの交差」で実測し、開く側に収まらないときは max-height を残り空間へ動的縮小（下限 80px = リスト内スクロールで全候補到達可能）/ **M-2** googleErrorDetail・driveForbiddenHint の単体テスト追加（it 4 件: reason+message 結合・非 JSON 縮退・200cp cap・ヒント条件。R2 フォローアップで新形式 1 件を加え 5 件）/ **M-3** 403 ヒントを理由コードで条件化（calendar.ts の先行分類 + insufficient〜。レート超過 403 には出さない・理由不明は実用優先で出す）/ ニット: ①§33 の「デスクトップ従来挙動不変」を正確な記述へ ②deploy-guide の連続空行除去 ③E2E のシード API 成否検証 + lib.cjs の CHROMIUM_PATH を export して再利用 ④E2E モバイル検証に elementFromPoint の実可視性アサーションを追加（boundingBox だけではクリップを検出できない）
- [x] 独立レビュー R2 フォローアップ（R1 全 7 件の解消を実機プローブ（未フィルタ 15 候補・視高 380px の権限表）込みで検証・新規 Minor 1 / ニット 2 = 全件対応）: **M-R2-1** driveForbiddenHint の判定が errors[0].reason のみで、新形式（実理由が error.status / details 側・errors[].reason は forbidden 等の汎用値）だと Drive API 未有効でもヒントが抑止され得る → calendar.ts の先行実装と同様に**エラーボディ全文**へ regex を当てる方式へ変更（設定不備が明示 or 理由不明 = ヒントあり / レート・クォータ系が明示 = ヒントなし）+ error.status を reason のフォールバックに追加 + 新形式の単体テスト 1 件追加（api 単体 95）/ ニット: ①§33 の履歴行に「当時の実装値」注記（現行値との混同防止）②テスト件数の表記を it 単位へ修正

## 34. オペレーター指示 2026-07-21（AI業務アシスタントの再編集・後追い AI コメント・他メンバー readonly 参照 / 日報・週報の月・週切替 / 共通のボタン実行中表示）の完了条件（Definition of Done）

### 34-1 AI業務アシスタント（F-14）: 登録後の全項目再編集 + 後追い AI コメント + 他メンバー readonly 参照
- [x] **(1a) 記録済み（done）でも全項目を再編集可能に**（誤登録の訂正）。`useTaskPlans.upsertPlan`（計画本文）・`recordResult`（結果/所感の上書き再記録）・`removePlan`（取消削除）から done 制限（AKO-TPL-004）を撤去。API（`task-plans.ts`）も同様に緩和し、**done の訂正・再記録・削除は監査ログ（audit_logs）へ記録**（記録系保護を「巻き戻し防止」から「本人による訂正 + 監査」へ緩和 = 提出済み日報と同型）。初回記録日時 `resultAt` は保持（mock = `resultAt ?? now` / API = `result_at = COALESCE(result_at, $)`）＝ 原則2（記録の巻き戻しをしない）
- [x] UI: 「明日の計画」は status を問わず 編集/削除/AI コメント ボタンを表示。「今日の振り返り」の記録済み項目に「結果を編集」導線（キャンセルで取消 = 原則9.5）を追加
- [x] **(1b) AI コメントを後からでも取得可能に**。`aiReview` から done 制限を撤去（mock/API 両方）。振り返りカードの done 項目にも AI コメント表示 + 「AI コメントをもらう/再取得」ボタンを配置（done 後に到達できる導線）
- [x] **(1c) 権限がある人は他メンバーのページを readonly 参照**（既存の権限表で管理）。`shared/domain/permissions.ts` に `canViewMemberTaskPlans`（resource='ai-assistant' + field='member:<id>'。**既定 = 参照不可（許可制）**・自分は常に可・レイヤ解決は canViewField と同型。`resolve` に defaultAllow 引数を追加し既存 API は allow 既定を維持 = 下位互換）。権限設定 UI（`masters/permissions.vue`）に擬似リソース `assistant-view`（= 日報の参照対象 `report-view` と対称。effect allow=参照可）を追加
- [x] ページ: 対象メンバー切替セレクト（自分 + 許可された対象者のみ）・readonly バナー・全 mutation を `isReadonly` で無効化。読み取りは `targetId` で射影（mock は全メンバー分が seed テーブルにあるためそのまま / API は `?memberId=` で他メンバー分を専用キャッシュへ遅延ロード = 自分のキャッシュ・インサイトを汚さない）
- [x] API enforcement: `GET /v1/task-plans?memberId=` と `GET /v1/assist/logs?memberId=` は `canViewMemberTaskPlans` を経由し未許可は 403（AKO-PRM-002）。featureGuard（ai-assistant 機能 deny）が前段
- [x] デモ用シード: 既定ユーザー（管理者 m-03）が m-05 の AI業務アシスタントを readonly 参照できる allow ルール 1 件を mock seed に追加（運用デフォルト pr-def-* とは別 id・API は migration 0025 の運用デフォルトを不変に保ち権限表から設定）

### 34-2 日報・週報（F-06）: 月・週の切替
- [x] **(2a) 「全員の日報」タブの月切替**を「自分の日報」の日付コントロールに合わせて 左右ボタン + 「今月」+ 月直接選択（`<input type="month">`）に。`shiftMonth` で月境界を扱う
- [x] **(2b) 「チーム」「週報」タブの参照週を選択可能に**（左右ボタン + 「今週」+ 週レンジ表示）。`useReports` に `businessDaysOfWeek(weekStart)`・`timelineForDates(dates)` を追加し、チームマトリクス/タイムラインを選択週の営業日（月〜金）へ。週報タブは自分の週報を選択週で編集・提出可能に（週切替でエディタは参照へ戻す）。週次 AI インサイト（WidgetsWeeklyInsight）は既存の週ナビを踏襲

### 34-3 共通: ボタンの実行中フィードバック
- [x] `UiButton.vue`（`.btn` トークン踏襲 + `:loading` でプログレスサークル Loader2 回転 + 押下無効化 + aria-busy。`#icon` スロットで先頭アイコンをスピナーへ差し替え）と `useAsyncAction`（キー付き pending + 押下直後のスナックバー + 二重送信防止）を新設
- [x] 対象 2 ページ（ai-assistant / reports）の主要非同期ボタン（提出・保存・AI 生成・AI コメント・結果記録・同期・リマインド・週報生成/提出 等）へ適用 = 押下でスナックバー通知 + スピナー表示
- [x] 残課題（原則 9.5 / 原則3 の漸進適用。対象機能の改修時に順次）: 他ページのボタンへの UiButton/useAsyncAction 展開・API モードでの他メンバー readonly 参照時のカレンダー予定候補（本人操作のため readonly では非表示）
- [x] 検証: mock typecheck / mock 73 tests / api typecheck / api 101 unit tests green。統合テスト（DB 必須）は done 訂正フロー・他メンバー参照 403 を追加。独立レビュー（5 観点）+ 反復修正で指摘ゼロ

## 35. バッチ7m: 権限表の階層化 + 両モードのリソース一致 + 常時可否表示（オペレーター指示 2026-07-21）の完了条件（Definition of Done）

### 35-1 ルール一覧と権限表のリソース差分解消
- [x] ルール一覧で設定できる全リソースを権限表でも設定可能に: **日報の参照対象（F-16-6）・AI業務アシスタントの参照対象（F-16-7）を権限表へ追加**（それぞれ 日報・週報 / AI業務アシスタント ページ配下の「参照対象」ノード = 全メンバー一括 `member:*` > メンバー個別 `member:<id>` の階層）
- [x] 逆方向の一致: ルール一覧の対象メンバー選択肢に「全メンバー（一括既定）」（= `member:*`）を追加し、権限表で設定した一括ルールをルール一覧でも作成・編集・表示（「全メンバー（一括既定）」表示）できる。マスタ全体（field=null）ルールの項目列表示も「マスタ全体（一括既定）」へ明確化
- [x] `MEMBER_VIEW_ALL_FIELD = 'member:*'` を shared/domain/permissions.ts に新設（'*' はメンバー id として発番されない予約値）

### 35-2 タブの並びと既定表示
- [x] タブ並びを 権限表 → ルール一覧 へ変更し、既定表示を権限表に（`viewTab = 'matrix'`）

### 35-3 権限表ヘッダの常時表示
- [x] 表を内部スクロール領域（`max-height: calc(100dvh - var(--header-h) - 11rem)` + overflow-auto）に収め、列ヘッダ行を `sticky top-0`・先頭列を `sticky left-0`（交点は z-30）で固定 = スクロール中も対象列ヘッダが常に画面内（UiSectionCard の overflow-hidden と横スクロール要件のためページ側 sticky ではなく表専用スクロールで固定する設計判断。`.tbl th` の既存 sticky パターン踏襲 = 原則3）

### 35-4 ページ > 機能 > 項目 の階層と一括設定
- [x] 行構成を 3 階層ツリー化: ページ（機能 18）> 機能（AI 参照範囲 / 参照対象の全メンバー一括 / マスタ全体）> 項目（表示項目 / 対象メンバー個別）。下位層は開閉可能（既定 = 全閉。全て展開/全て閉じるボタン・aria-expanded・件数表示）
- [x] **各層の各項目で設定可能**。上位（マスタ全体 = field null / 参照対象の全メンバー = member:*）で設定すると、明示ルールの無い下位項目が一括で従い、下位項目の明示ルールが個別に優先される
- [x] 一括設定の実体は表示だけでなく**解決ロジック（shared/domain/permissions.ts の resolve）に実装**: 同一レイヤ内で 明示キー → 一括キー → 既定値 の順に参照（レイヤ優先 個人 > 役職 > ロール は不変）。canViewField は `[field, null]`、canViewMemberReports / canViewMemberTaskPlans は `[member:<id>, member:*]` で解決 = **権限表の表示と実際の判定が常に一致**
- [x] これに伴い、従来はどの判定でも参照されなかった（inert だった）フィールドリソースの field=null「マスタ全体」ルールが実際に機能するようになった（ルール一覧 UI の「未選択 = マスタ全体」表記と実挙動の乖離を解消）。stripDeniedFields はカタログ（shared/domain/permission-catalog.ts へ移動 = フロント/API 共有の SoT）全項目を剥がし対象に含める（id・active 等カタログ外キーは従来どおり対象外）
- [x] **下位互換の評価（原則7）**: スキーマ・API・シード・migration は不変。運用デフォルト（0025 の role deny 6 件）は機能キーのみで影響なし。**過去にルール一覧から作成された「マスタ全体」deny ルールが存在する環境では、本変更後に実際に全項目が剥がれるようになる**（= UI が従来から表示していた意図どおりの挙動）。適用前確認クエリ: `SELECT * FROM permission_rules WHERE active AND field IS NULL AND resource IN ('members','companies','contacts','projects','knowledge');`（該当があればオペレーターへ周知のうえ適用）
- [x] documents はマスタ項目とページ利用可否が同一キー（resource='documents'・field=null）のため、権限表ではページ行が項目の一括既定を兼ねる（canViewField のフォールバックと同一 = 表示が実挙動。マスタメンテナンス配下ではなく ドキュメント管理 ページ配下に項目行を配置）

### 35-5 未設定表示の廃止（常時可否表示）
- [x] セルは常に可否のいずれかを表示（「未設定（既定 = 許可）」表示を廃止）。明示ルール = 濃色・実線 / 上位の一括設定・アプリ既定値に従う状態 = 薄色・破線で区別し、ツールチップ・aria-label に出所（明示設定 / 上位の一括設定に従う / 既定値）を明記
- [x] クリック挙動を 3 状態循環 → **反転トグル**へ変更。引き継ぎ値と同じ値へ戻すと明示ルールを論理削除して上位・既定に従う状態へ復帰（= 操作の取消フロー 原則9.5。監査ログ・無効ルールは保持し、明示化の際は同一キーの無効ルールを復元して再利用 = 乱立防止・冪等 原則2）
- [x] フェイルセーフ順序を維持: 新規明示化は「無効のまま effect 書換 → 復元」・明示解除は「allow から論理削除し deny を最後に」・値反転は「代表 1 件を書換 → 残余を整理」= 途中失敗が権限を広げる方向に倒れない
- [x] 保護セルの表示も実挙動と一致: admin のマスタ/設定（ロックアウト防止で deny 無視）と参照対象の本人セル（常に参照可）は「許可/参照可」を表示し操作不可（※ 印 + 脚注）

### 35-6 検証・レビュー
- [x] api 単体テスト: permission-fallback.test.ts 新設（マスタ全体フォールバック・個別優先・レイヤ優先・stripDeniedFields のカタログ剥がし・member:* の両既定 = 11 件）。単体 112 件（既存 101 + 新設 11）green・api typecheck green
- [x] mockup typecheck / 単体 73 件 green。実クリック e2e（perm-combobox-e2e.cjs）を新仕様へ更新し**モック静的ビルドで 26 チェック green**: 既定タブ = 権限表・階層展開・常時可否表示・トグル・一括→下位の継承表示・個別優先・member:* の両モード一致・取消フロー（BASE 環境変数対応 = README と整合）。スクリーンショットでデスクトップ（内部スクロール後も thead 常時表示）・モバイル 390px（ページ横スクロールなし = 原則8）を目視確認
- [x] ドキュメント全件更新（原則5）: functional-requirements（F-16-1/2/3/5/6/7）・data-design（PermissionRule）・api-design（usePermissions）・screen-design（§5.4/5.5）・architecture（MastersPermissionMatrix）・CONVENTIONS（在庫表）・types.ts/permissions.ts の docstring・本表 §21 に置換注記

## 36. オペレーター指示 2026-07-22（稟議への改称・通知タブ分け / タイムカード切り出し・全員のタイムカード権限化 / 日報・週報のタブ再編・明日の予定・週月ビュー / 稟議の目的・内容分割 + テンプレート）の完了条件（Definition of Done）

### 36-1 ダッシュボード
- [x] 名称変更「ワークフロー」→「稟議」: メニューカード（menu-registry）・ナビ（navigation）・ページタイトル（workflow.vue）・権限機能ラベル（FEATURE_PERMISSION_KEYS）を改称（パス `/workflow`・機能キー `workflow`・決裁データは不変 = 下位互換）
- [x] 通知フィードをタブでカテゴリ分け: すべて / エスカレーション（kind=escalation）/ 承認依頼（kind=approval のうち稟議以外）/ 稟議（リンク先 `/workflow` の通知）。未読数バッジ付き。判定は `categoryOf`（index.vue）

### 36-2 勤怠管理・タイムカード
- [x] 「タイムカード」タブを独立メニュー `/timecard`（F-04-10）へ切り出し: **ログインユーザー本人のみ**（打刻ウィジェット + 期間フィルター付き出退勤一覧。API モードは本人の月サマリキャッシュから射影 = 追加 API なし）。メニューカード・ナビ・nav-map・機能キー `timecard`（既定 allow）を追加。**timecard のデータ面は attendance API に従属するため、canPath は timecard AND attendance で判定**（attendance deny 時はページごと非表示 = UI と API の一致。API 側はフロント enforcement = lib/permissions.ts の設計判断に明記。R1 レビュー #6 対応）
- [x] 既存タブは「全員のタイムカード」へ改称して維持。参照可否を権限表で管理: `shared/domain/permissions.ts` に `TIMECARD_ALL_FIELD='timecard-all'`・`canViewAllTimecards`（**既定 = 管理者/人事のみ = 従来ロールガードと同値の下位互換**。明示ルールで一般への付与・人事からの剥奪が可能）。権限表（PermissionMatrix）に「全員のタイムカードの参照」行（列対象ごとの既定値 = `defaultAllowOf`）を追加。API `GET /v1/attendance/timecard` のガードを requireHrOrAdmin → canViewAllTimecards へ変更（403 = AKO-ATT-004）
- [x] 他メンバーの日次詳細への行クリック遷移は従来どおり管理者/人事のみ（API の guardTargetMember と同一 = UI と API の権限判断を一致。権限付与された一般メンバーは一覧まで・本人行は可。R1 監査 A-1 で hr 除外の退行を検出し修正）
- [x] 休暇申請フォーム: 「任意。承認者への補足があれば記入してください」を hint から「理由」の placeholder へ移動
- [x] 単体テスト: `mockup/tests/permissions-timecard.test.ts`（既定・付与・剥奪・レイヤ優先・論理削除 = 7 件）

### 36-3 日報・週報
- [x] タブ再編: 自分の日報 / 自分の週報 / 全員の日報 / 全員の週報 / チーム（旧 `?tab=weekly` は 自分の週報 へ互換マップ）。参照権限は権限表「日報・週報の参照対象」（F-16-6 canViewMemberReports。ラベルを「日報の参照対象」から改称）で管理
- [x] 自分の日報: 名称変更（業務テーマ→テーマ・作業内容→内容・工数→時間）。通常入力を**共通ヘッダ 1 行のテーブル形式**へ（各セルへ入力・行追加/削除・0.25h ステッパー維持・モバイルはコンテナ内横スクロール = 原則8）
- [x] 明日の予定: テーマ/目的/内容/時間 × 最大 3 件（`TomorrowPlan[]`・`TOMORROW_PLANS_MAX`）。**翌営業日（本人の勤怠ルール基準 = useBusinessDay）の日報エディタへエントリとして自動反映**（反映元バナー表示）。旧自由記述 `tomorrow` は互換保持・互換表示（原則7）。API: `daily_reports.tomorrow_plans jsonb`（migration 0029）・PUT/SELECT 対応
- [x] 自分の日報の表示モード「週」「月」: 週 = 週ストリップ（提出状態・日選択）/ 月 = 1 日〜末日の**横スクロール**と**カレンダー形式**の 2 ビュー切替
- [x] 全員の日報・全員の週報・チーム: **部署・メンバーで絞り込み**（AI 社員の日報は絞り込み未指定時のみ表示）
- [x] 全員の週報タブ（F-06-11）新設: 選択週の提出済み週報一覧（参照権限適用）→ 詳細ドロワー。API `GET /v1/reports/weekly?scope=all&weekStart=YYYY-MM-DD`（提出済みのみ・canViewMemberReports でサーバー側も絞り込み。weekStart 未指定は互換のため直近 500 件上限 = 全履歴ダンプを許容しない方針は daily と同型。R1 指摘対応）。週次 AI インサイトは本タブのサブビューへ移設
- [x] チームの表示モード「週」「月」: 月 = 1 日〜末日の**横スクロールマトリクス**と**カレンダー形式**（日別提出数 + 選択日の詳細リスト）の 2 ビュー切替。一括リマインドは選択中ビューの表示メンバー・対象日基準

### 36-4 稟議（F-07）
- [x] 新規申請フォームの「本文」を「目的」「内容」に分割（`WorkflowRequest.purpose/content`・旧 `body` は互換表示 = 原則7。migration 0029 で列追加・draft/submit の PUT/INSERT/SELECT 対応）
- [x] 内容の**区分別テンプレート**（`utils/workflow-templates.ts` = SoT。標準（現状と課題/実施する理由/実施しない場合の影響/期待する効果/緊急度・優先度）+ 購買/契約/経費/採用/出張）。呼び出し時に入力済み内容の上書き確認（黙って消さない = 原則9.5）
- [x] 詳細ドロワーは 目的/内容（マークダウン描画）を表示し、旧データは「本文」として互換表示

### 36-5 検証・ドキュメント
- [x] mockup typecheck / 単体 80 件（73 + 新設 7）green・api typecheck / 単体 112 件 green・**統合 156 件（既存 152 + 新設 4 = tomorrow_plans 往復・weekly scope=all（週指定・下書き秘匿・F-16-6 deny）・timecard-all（既定/付与/剥奪 = AKO-ATT-004）・稟議 purpose/content 往復）green**
- [x] 反復レビュー（原則9）: 独立コードレビュー + システム監査の 2 ロールで実施。**R1** = 重大 3 件（API モードの旧稟議本文消失（?? → || 修正 + mock も body 移行で両モード一致）・明日の予定自動反映の初回不発（autoPlans computed + watch で遅延ロード到着に追従）・チーム月ビューの未ロード（touchTeamDates の明示タッチ = 誤リマインド防止））・中 3 件（AI 日報のフィルタバイパス・hr の日次詳細導線退行・timecard/attendance 依存）・軽微/表記ほかを修正。**R2** = R1 修正 10 項目すべて解消・機能デグレゼロを確認したうえで、残存の表記 3 件（AI ドラフト生成根拠の 業務テーマ/工数・権限設定の aria-label・e2e チェックラベル）+ 設計 SoT ドキュメント未追随 3 本（screen-design の /attendance・/timecard・/reports・/workflow 節 / data-design の DailyReport・WorkflowRequest・PermissionRule / api-design の weekly scope=all・timecard ガード）+ 本欄の完了宣言先行を指摘 → 全件修正（isPristineEditor の hours/progress 判定強化・weekStart 非月曜の設計判断コメントを含む）。修正後に typecheck・単体・統合の全スイートで再検証
- [x] ドキュメント更新（原則5）: functional-requirements（F-01-2/F-04-8/F-04-10/F-06-1/F-06-3/F-06-9/F-06-11/F-06-10/F-07 見出し/F-07-1）・本表（タイムカード・稟議行）・mockup/README
- 既知の制約: API モードの「明日の予定の自動反映」は自分の日報キャッシュ到着後に反映（遅延ロード）。AI 日報ドラフト（F-06-7）は明日の予定（構造化）を生成しない（従来の tomorrow 文字列のみ = 将来拡張）

## 37. メディア分析 F-40 の本実装（GA 連携・/media 全機能の API 化。2026-07-28）の完了条件（Definition of Done）

### 37-1 GA 連携（Google OAuth 2.0 + GA4 Data/Admin API）
- [x] migration 0030: media_settings（設定系）/ media_ga_tokens（**セグメント単位**のトークン = メディアは業態の資産。connected_by で連携者記録）/ media_oauth_states（一回性 + 10 分 TTL）/ media_metrics_cache（30 分の導出キャッシュ = GA クォータ対策。SoT は GA）/ media_articles / media_article_briefs / media_generated_articles / media_insights。segment_id はモック側エンティティ（businessSegments 未移行）のため FK なし（理由を migration に文書化）
- [x] `/v1/media`: status（enabled/connected/needsProperty）/ oauth/url・oauth/callback（calendar と同型: state ノンス・email 突合・認証前登録・復帰 = `/media/settings?ga=&segment=`）/ properties（Admin API accountSummaries の平坦化）/ property（選択で connected 完成）/ disconnect（revoke 非ブロッキング・設定と記事は残す = 原則9.5）
- [x] metrics（batchRunReports 2 呼び: 総計当期/前期 → 必須・内訳 5 レポート → 失敗時は空 + warning = 原則4）/ monthly（yearMonth。最終月 = 直前の完了月）。GA レスポンス整形は lib/ga.ts の純粋関数（rows 欠落・NaN・ゼロ除算防御・channels 日本語マッピング・yearMonth/date 変換・前期比 pagePath 突合・セクション = インベントリ優先 → 第 1 階層）。**conversions は GA4 で廃止済みのため keyEvents を使用**
- [x] 認可: 書込系（oauth/url・property・disconnect・settings・articles 手動登録）は admin のみ。/v1/media は F-16 機能キー対象外（アプリ設定 = 業態別アプリ media + 機能トグルで制御。lib/permissions.ts に設計判断を文書化）
- [x] デプロイ反映: deploy.yml が analyticsdata / analyticsadmin API を冪等有効化。deploy-guide §1-9b（リダイレクト URI `/v1/media/oauth/callback` の追加・API 有効化・同一 OAuth クライアント共用）

### 37-2 /media 全機能の API 化
- [x] メディア設定: GET/PUT /v1/media/settings（部分更新 = **body に実在するキーのみ** Object.hasOwn フィルタ。CLAUDE.md の Zod v4 注意に従い「送っていないフィールドの保持」を統合テストでアサート）
- [x] 記事インベントリ: GET/POST /v1/media/articles + deactivate/restore（論理削除 = 原則9.5）。**実データはシードしない**（akebono_wishes / sales_monthly と同方針。採用・手動登録で育成）。API モードの分析空状態は articleCount でなく「GA データ空」で判定（analytics.vue）
- [x] AI 記事生成: POST /v1/media/articles/generate = Vertex AI（generateJson）→ null は shared/domain/media-article の決定的生成へフォールバック（llm フラグ保存 → UI に Vertex AI / 自動生成 表示）。brief + 生成物をトランザクション保存。adopt（冪等: 二重採用 no-op + warning）/ unadopt / remove / restore
- [x] AI インサイト: media_insights（weekly_insights 0026 と同型。UNIQUE(segment_id, scope) の upsert）。scope=media はサーバーが GA から集計・scope=integrated は**クライアント合成の統合メトリクスを受領**（売上明細 salesRecords が未移行のモック側 SoT のため。設計判断を routes/media.ts・useMediaAnalytics.ts に文書化）。生成は LLM → heuristicMediaInsight / heuristicIntegratedInsight
- [x] フロント デュアルモード化: useMediaSettings（GA 状態 = サーバー SoT の合成）/ useMediaAnalytics（metricsFor はロード中 null・ready/warning/retry を公開）/ useMediaInsight・useMediaArticles（async 化）/ MediaGaConnect（OAuth リダイレクト + 復帰クエリ + プロパティ選択モーダル + needsProperty 再開 = リロードで詰まない）/ analytics.vue（ロード中・取得失敗・データ空・部分失敗警告の区別表示）/ useDashboardInsight（generate 前に GA 月次を await）。モックモードの挙動は不変（下位互換）
- [x] エラーコード: AKO-MEDIA-003〜008・011〜016 を採番（api-design §4。001/002/010/013 はモック専用・009・015 は欠番。008 = 記事パスの重複はレビュー 1 巡目 m5 で起番）

### 37-3 反復レビュー（原則9・1 巡目 = 独立コードレビュー + システム監査。major 3・minor 11）
- [x] M1: GA 月次の取得失敗を「トラフィック 0」と区別（integratedReady = 取得成功のみ・integratedFailed 新設・PDCA タブに失敗表示 + 再試行導線）。失敗・未ロード状態では generateIntegrated / generateSegment / generateCompany を実行しない（AKO-MEDIA-004 でエラー = 虚偽の 0 由来インサイトを保管させない）
- [x] M2: scope=integrated の受領検証を whitelist 正規化 + 全数値の有限・非負・範囲検証へ強化（normalizeIntegratedMetrics。不正は 400 = 500 を出さない・型崩れの保管と LLM プロンプトへの逐語挿入を遮断）。**メディア軸（sessions/conversions/engaged）は GA 連携済みならサーバー導出の月次で上書き**（applyServerMediaAxis = クライアント申告値を信頼しない。GA 一時障害時はクライアント値 + warning 告知で続行 = 原則4）。**改ざん耐性の受容判断**: 売上軸は salesRecords（未移行のモック側 SoT）でサーバー検証不能 = 範囲検証 + generated_by の監査可能性で緩和し、認証済み社内ユーザーの脅威モデルでは受容（routes/media.ts にコメント化。salesRecords の API 移行時にサーバー組み立てで解消）。生成の認可は全ロール可を維持（mockup の画面ゲートと一致・根拠を同コメントに記載）
- [x] M3: PDCA タブに「売上・受注 = デモデータ」バッジ + 注記を表示（API モード。実 GA × デモ売上の合成を実績と誤認させない。ダッシュボード（F-41）のモックバッジと基準を統一。salesRecords 移行時に撤去）
- [x] m4: 統合ファネルの「主体的関与」を GA の engagedSessions 実測へ（/monthly に追加・MediaMonthlyPoint.engagedSessions。実測が無い場合のみ従来の 0.55 係数で近似 = モック不変）/ m5: media_articles に部分一意 INDEX（segment_id, path WHERE active）+ 重複登録・復元衝突は AKO-MEDIA-008 の 409 / m6: GA 403 の理由分類（API 未有効化 vs プロパティ権限なし）を分離し案内を修正 / m7: プロパティ確定・連携解除時にクライアント分析キャッシュを invalidate / m8: PUT /settings でサーバー metrics キャッシュ破棄 / m9: 月次の再試行に force を伝搬 / m11: インサイト生成の劣化データ warning を media_insights.warning へ保管し生成トースト・説明文に表示 / m12: phase3 機能要件（F-40/F-41）・phase5 データ設計 §1.4・アーキテクチャ・画面設計へ追記 / m13: media トグルはクライアント側のみの制御である旨を lib/permissions.ts に明記 / m14: OAuth 基礎処理を calendar と共通化しない判断根拠をコード内コメント化 + 記事手動登録の curl 手順を deploy-guide §1-9b へ記載
- [x] **R2** = 1 巡目 14 件の全件 RESOLVED を両ロールが実行検証（テスト数値の実測一致・0030 直編集の安全性 = 「origin/main 未マージ・デプロイは main のみ・テスト DB 使い捨て」で確定。main マージ後は直編集不可の運用注意を記録）したうえで、新規 minor 3 件を指摘: N1 = ダッシュボード再生成が GA 一時障害後に同一セッション内でデッドエンド化 / A1 = §37-2 のエラーコード記述の文書内矛盾（008 欠番の残存）/ A2 = 認可コメント「メディア軸は改ざんが効かない」が GA 未連携セグメントで不成立 → 全件修正（ensureIntegratedLoaded に失敗確定検知 + 明示操作起点の 1 回 force 再試行 = M1 の無限リトライ封止・生成遮断は維持 / 記述の四者整合 / 「GA 連携済みなら」の限定 + 未連携時の受容判断明記）。**R3** = 両ロールが修正を検証し**指摘残ゼロを宣言**（N1: 呼び出し元 Grep 全件で computed/watch 経路ゼロ・force が /monthly の force=1 まで貫通・回帰テスト未追加は mockup テスト基盤が純関数のみ対象という制約を事実確認 / A1: §37-2・§37-3・api-design 台帳・media.ts ヘッダの四者整合 / A2: applyServerMediaAxis の適用条件と文言一致）。修正後に typecheck（api・mockup）・api 単体 155・統合 163・mockup 単体 148・build の全スイート再検証 green

### 37-3b 外部ボットレビュー（PR #80 Codex・P2 × 3 件 = 全件採用）
- [x] 指摘1: 28 日メトリクス系のゲート（ロード中・失敗・空）を**メディア分析タブ限定**へ（PDCA タブは 6 ヶ月の月次 + 売上を見る画面のため、直近 28 日が空でも月次側の状態のみでゲート。モックでも記事 0 件時に PDCA（売上軸）が見えるようになる = 両モード同一の整合的変更）
- [x] 指摘2: ページ別レポートは (pagePath, pageTitle) 組ごとに複数行で返るため、**正規化 path で集約してから** MediaPageStat 化（重複エントリ・セクション記事数の水増し・prevPageviews の重複割当を解消。タイトルは PV 最大行を代表値・直帰率は PV 加重平均。users は組合算の近似 = 設計判断をコメント化）。回帰テスト追加（ga-report 20 件）
- [x] 指摘3: セクション集計は「サイト全体の内訳」のため、ページ別レポートの limit を 50 → 10000 へ（前期比突合の prevPages も 200 → 10000）。表示上限は整形側の topPages slice(12) が担い、レスポンス・キャッシュ（media_metrics_cache）には整形後 MediaMetrics のみが載るためサイズ影響は軽微。10000 組超の超ロングテールは打ち切り許容（PV 降順・コメント化）

### 37-3c 本番障害対応（PR #80 マージ後の実環境・2026-07-29。オペレーター報告）
- 症状: ①メディア分析タブに「内訳の取得に失敗したため総計のみ表示」が常態化 ②PDCA タブの「月次トレンドを取得中…」が永続
- [x] 根本原因②（確定 = フロントのロード起動デッドロック）: analytics.vue の v-else-if 連鎖はローディング分岐で短絡し、ロードの唯一の起動点だったコンテンツ分岐（metricsFor / integrated computed）が評価されない → ロード未発火でスピナー永続。**状態判定関数（metricsReady / integratedReady）自身が遅延ロードを起動する**よう修正（読取り = 遅延ロードの既存イディオムへ統一。apiLoadOnce の一度きりセマンティクス維持 = M1 の無限リトライ封止は不変。訪問順・タブ順への依存を排除）。他画面（/media ハブ・ダッシュボード）は metricsFor / ensureIntegratedLoaded 経由で起動済みであることを点検
- [x] 根本原因①（有力因子 = 内訳バッチの all-or-nothing + タイムアウト予算）: 内訳 5 レポートは 1 バッチ同梱のため 1 レポートの問題（互換性 400・クォータ 429・タイムアウト）で全滅する。limit 10000 × 2 を含む内訳は総計より重く 15 秒では不足しうる（※当時の外部リファレンス裏取りで「メトリクス名は全て正規」と判断したが、**後日 GA 応答で entrances のみ無効と確定** = 下の 2026-07-29 続報で訂正・削除）。対策 = **自己診断・自己回復設計**: ①バッチ失敗時は各レポートを個別 runReport で並行リトライし、取れた内訳だけ表示 + 失敗した内訳名のみ warning に列挙（原則4 の粒度を per-report へ）②GA の実エラー理由（error.message 先頭 150 字）を warning / エラーメッセージへ付加（gaErrorDetailOf。従来はサーバーログのみで画面から原因が見えなかった）③内訳・月次のタイムアウトを 15s → 25s（総計は 15s のまま）
- [x] 検証: api 単体 160（gaErrorDetailOf 4 件追加）/ 統合 163 / mockup 単体 148 / typecheck・build 全 green。deploy-guide §4 トラブルシュートへ「画面 warning の GA 応答 + Cloud Run ログの `ga batchRunReports failed:` / `ga runReport failed:` 行で生エラーを確認」を追記
- 既知の制約: ②のロード起動はテンプレート短絡に依存しない設計へ変えたが、composable の API モード分岐は単体テスト基盤（純関数のみ）の対象外 = 実クリック e2e の領域（N1 と同じ判断）
- [x] 続報（2026-07-29 = 本番で根本原因①が確定）: P1/P2 で仕込んだ GA 応答の surfacing が機能し、オペレーター画面に「**Field entrances is not a valid metric**」が表示された = 記事別（topPages）レポート単体失敗の根本原因は **`entrances` が GA4 Data API の無効メトリクス**だったこと（UA 時代の名前で GA4 の UI レポートには存在するが Data API には無い。外部リファレンスによる事前裏取り「entrances は正規」は誤りだったと訂正）。per-report フォールバックにより他の内訳は障害中も表示継続。対応: リクエストから除去 + **`MediaPageStat.entrances` を型ごと削除**（消費トレース: UI 列・インサイトヒューリスティック・LLM プロンプト整形のいずれにも実質消費なし = 偽ゼロ温存や代替レポート追加より削除が正。モック導出・テストフィクスチャも追随。保管済みインサイト metrics jsonb の旧キーは読み飛ばされ無害 = 原則7）
- [x] 続き（PR #81 Codex レビュー P1/P2 = 全件採用）: **P1** = per-report 失敗の内訳が null 防御のゼロ埋めで「実トラフィック = 0」の顔で描画される穴を、`MetricsResult.unavailable`（'daily'〜'prevPages' の利用不能マーカー）のレスポンス貫通で封止 — フロントは該当ビジュアライゼーション（日別チャート・チャネル/デバイスドーナツ・記事別/セクション別・前期比列）を「取得できませんでした」表示へ置換しゼロ描画しない（M1 の原則を内訳へ適用。総計 KPI は総計レポート由来で影響なし・キャッシュは unavailable 空のときのみ = 従来どおり・モックは常に空 = 全表示）。**P2** = 失敗理由分類に quota（429 / RESOURCE_EXHAUSTED）を追加し、**quota・確定的失敗（API 無効・権限なし）では per-report ファンアウトをスキップ**（枯渇プロパティへの 5 本の追い打ちでクォータ消費を倍増させない。1 巡目 observation の「確定的失敗でも無害リトライ」も同時解消）。回帰テスト = media-fetch.test.ts 新設（fetch モック: 429 で 2 呼びのみ・部分失敗で unavailable 貫通 + 取れた内訳の整形）+ gaFailReasonOf / shouldFanOut の分類 4 件。検証: api 単体 166 / 統合 163 / mockup 148 / typecheck・build 全 green

### 37-4 検証・残課題
- [x] 検証（レビュー修正後の再実行）: api 単体 **156**（ga-report 20 + media-routes 24 を新設）/ api 統合 **163**（メディア 7 スイート = 部分更新の保持・重複登録/復元衝突・生成→採用→取消→復元・統合インサイト upsert + 受領検証・GA 未設定経路）/ mockup 単体 148 / typecheck（api・mockup）/ mockup build 全 green
- [ ] 残課題: ~~統合メトリクスの売上月次・salesRecords の API 移行~~ → **Phase C（§39）で解消**（/v1/media/integrated のサーバー組み立て化 = 売上軸の改ざん耐性限界（M2）解消・AKO-MEDIA-016 欠番。businessSegments は Phase B = §38）。F-41 ダッシュボード**保管**（dashboardInsights）のみ Phase D（§39-6）。GA プロパティのタイムゾーンが JST 以外の場合の日単位ずれは許容（lib/ga.ts に設計判断を文書化）。記事インベントリ手動登録の専用 UI（現状は管理者 API + curl = deploy-guide §1-9b）

## 38. Akebono 設定・実データの本実装 Phase B: 設定系 11 コレクションの API 永続化（2026-07-29）の完了条件（Definition of Done）

> オペレーター指示「設定・実データの本実装」第 1 弾。従来 localStorage + 日次リシードのモックコレクション
> だった Akebono 設定系を API（PostgreSQL）へ移行し、API モードで「翌日消える設定」を解消する。
> 段階計画: **Phase B（本節 = 設定系）→ Phase C（売上系記録データ + PDCA 売上軸のサーバー実データ化）
> → Phase D（残り記録系・導出系）**。各 Phase で独立レビューを回す。

### 38-1 DB（migration 0031）
- [x] 11 テーブル新設: business_segments（業態 = 業態軸の根。app_name/app_icon/app_icon_image・default_unit_id・default_billing_type・default_variant_axis1/2_label を含む）/ warehouses / units / tax_rates / payment_terms / consignment_terms / variant_axis_templates / product_categories / product_image_sections（is_seed = 既定シード保護）/ akebono_app_configs（**PK (segment_id, app_key)**）/ item_settings（**UNIQUE (app_key, entity, item_key)**・差分列は全て nullable）
- [x] 初期データの判断を migration 冒頭コメントに文書化: 9 マスタは**モックシードと同一 id・同一値**を投入（①業態が空だと全 Akebono 画面が業態軸を失う ②既存 API 実データ（media_ga_tokens / media_settings）と Phase C まで残るモック記録系が seg-01 等の同 id を参照 = 下位互換 原則7）。ON CONFLICT DO NOTHING = 冪等・既存行を巻き戻さない（原則2）。akebono_app_configs / item_settings は**投入しない**（プリセット / カタログ既定がコード側フォールバック = 空でも欠けない）
- [x] FK なしの判断: warehouses.company_id / consignment_terms.company_id の参照先シード（c-ak-* = デモ取引先）が実環境の companies に存在しないため。Phase C（記録系移行）で参照整合の引き上げを判断（0030 の media 系 FK も同時に判断）

### 38-2 API
- [x] 汎用マスタ registry へ 9 種追加（`/v1/masters/business-segments`・`warehouses`・`units`・`tax-rates`・`payment-terms`・`consignment-terms`・`variant-axis-templates`・`product-categories`・`product-image-sections`。id プレフィックスはモックと同一 = seg/wh/unit/tax/pt/ct/vat/pcat/pis）。business-segments の appIconImage は data:image png/jpeg/webp base64 のみ・400,000 文字上限（プロフィール画像と同じ SVG 拒否 = スクリプト混入防止。80MB の body 上限に対し余裕）
- [x] product_image_sections の既定シード（is_seed）は無効化不可 = **AKO-AKB-002**（409。名称変更は可 = 商品画像の整合保護。archive ルートの entity 別ガードとして実装）。isSeed は PATCH 対象外（patchSchema から omit）。**POST の isSeed=true も 409**（レビュー B-1: 作れると archive 恒久拒否の取消不能行になる = 原則9.5。leave-types の isStatutory ガードと同型）
- [x] 複合キーの 2 コレクションは registry（id 主キーの行 CRUD）に合わないため**専用 API**（routes/akebono.ts に判断根拠をコメント化）: `GET/PUT /v1/akebono/app-configs`（PUT = 管理者のみ。rows 1〜200 のバッチ upsert・同一 (segmentId, appKey) は後勝ちで畳む = 単一 upsert 文の二重更新エラー防止・冪等）/ `GET/PUT /v1/akebono/item-settings`（PUT = 管理者のみ。**body に実在するキーのみ**の部分 upsert = Object.hasOwn・null は「カタログ既定へ戻す」明示値）/ `POST /v1/akebono/item-settings/reset`（管理者のみ。エンティティ単位の差分全削除 = カタログ既定へ戻す取消フロー 原則9.5・監査ログ）
- [x] カタログ（アプリキー・依存・業種プリセット・ITEM_CATALOG）は**フロント静的 SoT** = サーバーはキー形式のみ検証し存在検証しない（設計判断: カタログ更新でサーバー再デプロイ不要）。参照は全員可（メニュー表示・項目解決に全画面が使う）・書込は管理者のみ（設定画面の管理者ゲートと一致）

### 38-3 フロント（デュアルモード化。モックモードの挙動は不変）
- [x] useApi: MIGRATED_MASTERS へ 9 マスタ追加 + **CUSTOM_COLLECTION_ENDPOINTS 新設**（akebonoAppConfigs / itemSettings = 専用 GET でロードする移行済みコレクション。isMigratedCollection / loadApiCollection が分岐）
- [x] useAkebonoMasters: 9 cruds を useMasterCrudAsync 化。/akebono/masters・/akebono/settings/segments は save/archive/restore を await + 保存中表示（連打防止）。segments.vue の localStorage 容量警告はモックモード限定へ
- [x] useAkebonoApps: setEnabled / setLabel / applyPreset を async 化（API モードは変更行だけを PUT → 応答でキャッシュ反映 = SoT 書込→キャッシュの順。行が無い業態はプリセットを materialize してから差分適用）。/akebono ハブのトグル・ラベル・一括適用がエラートースト対応
- [x] useItemSettings: upsert（API = PUT → 複合キーで置換反映）/ resetEntity（API = POST reset → キャッシュから当該 entity を除去）を async 化。/akebono/settings/items の各ハンドラがエラートースト対応
- [x] 取消可能性（原則9.5): マスタ = 論理削除 + 復元（既存パターン）。アプリ設定 = トグルの再操作で戻る（設定値の上書き）。項目カスタマイズ = null 指定で個別に既定へ戻す + reset でエンティティ単位の一括取消

### 38-4 検証・ドキュメント
- [x] テスト: api 単体 **177**（akebono-configs 11 件新設 = appConfigRowsOf の後勝ち畳み込み・境界 / itemSettingPatchOf の hasOwn フィルタ・null 意味論）/ api 統合 **170**（Phase B 7 スイート新設 = 業態シード + **部分 PATCH で未送信フィールド保持**・iconImage 検証（SVG 拒否・403）・units CRUD・pis-01 の AKO-AKB-002 と名称変更可・POST isSeed=true の 409（B-1）・app-configs バッチ upsert（重複畳み込み・冪等・403/400）・item-settings 部分 upsert（labelOverride 保持）+ reset）/ mockup 単体 148 / typecheck（api・mockup）・build 全 green
- [x] ドキュメント: data-design §1.5（テーブル一覧 + SoT 宣言 + 初期データ・FK 判断）・§1.4 の businessSegments 記述更新 / api-design §3（useAkebonoMasters / useAkebonoApps / useItemSettings）+ §4 台帳（AKO-AKB-002）/ CONVENTIONS（composable の async 化追随）/ 本節

### 38-4b 反復レビュー（原則9・1 巡目 = 独立コードレビュー + システム監査。minor 2 件のみ = 他項目全クリア）
- [x] B-1（コードレビュアー）: `POST /v1/masters/product-image-sections` が isSeed=true を受理し**取消不能行**（archive = AKO-AKB-002 恒久拒否・PATCH は isSeed omit = SQL 直接操作でしか戻せない）を作れた（原則9.5 違反）→ leave-types の isStatutory ガードと同型に POST で 409（AKO-AKB-002）を追加 + この経路の統合テスト 1 件（isSeed=true 拒否・省略時は既定 false で作成可）
- [x] B-2（監査官）: businessSegments 移行完了後も「未移行のモック側エンティティだから存在検証しない」という**旧根拠**コメントが残存（原則5。実体判断 = Phase C まで参照整合を保留は data-design 文書化済みで正）→ media.ts（ヘッダ・segmentIdOf・segmentName 受領・統合組み立て）+ useMediaAnalytics + useMediaArticles（同型の残存 1 件を波及確認で追加検出）の理由記述を「Phase C の参照整合判断まで保留（business_segments はテーブル化済み）」へ修正。挙動変更なし

### 38-5 残課題（Phase C / Phase D 計画）
- [x] **Phase C: 売上系記録データ + PDCA 売上軸のサーバー実データ化** → **§39 で実装完了（2026-07-29）**。FK 判断・c-ak-* 整理・バッジ撤去を含む（dashboardInsights の media_insights 同型化のみ Phase D へ = §39-6）
- [x] **Phase D: 残り記録系・導出系** → **§40 で実装完了（2026-07-29）**（データ取込 F-32・dashboardInsights のサーバー保管・委託精算取消・出荷→売上。**走査 30 コレクション全移行 = localStorage 依存ゼロ**。§40-4 の移行完了表・§40-5 の currentSegment 判断）
- [x] 各 Phase で独立レビュー（コードレビュアー + システム監査官）を回す（原則9。Phase B = §38-4b）

## 39. Akebono 設定・実データの本実装 Phase C: 記録系 15 コレクションの API 永続化 + PDCA 売上軸の実データ化（2026-07-29）の完了条件（Definition of Done）

> オペレーター指示「設定・実データの本実装」第 2 弾（Phase B = §38 の続き）。
> 記録系 15 コレクション（商品〜売上〜請求）を API（PostgreSQL）へ移行し、統合メトリクス
> （PDCA 売上軸）をサーバー組み立てへ引き上げて「売上・受注 = デモデータ」バッジを撤去する。

### 39-1 DB（migration 0032）
- [x] 15 テーブル + 採番台帳: products（部分一意 = UNIQUE(segment_id, code) WHERE active）/ product_skus / product_images（data URI TEXT）/ purchase_orders / production_orders（results jsonb）/ inbound_plans / inbound_results / purchase_records / outbound_plans / outbound_results / **inventory_transactions（在庫の SoT・追記のみ・冪等キー UNIQUE(ref_type, ref_line_id, kind)）** / sales_records / invoices / payment_notices / payment_receipts + **akebono_doc_seqs**（伝票コード PREFIX-0001 の単一 UPDATE 原子的採番 = 並行安全）
- [x] companies へ Akebono 拡張列を追加（partner_roles jsonb / payment_term_id / billing_term_id = F-30-1。追加列のみ = 原則7。registry の companies スキーマにも追加 = 顧客マスタ画面の取引ロール・支払/回収条件が API モードで永続化）
- [x] **実データ方針: 記録系はシードしない**（akebono_wishes / sales_monthly / media_articles と同方針）。各画面の主要テーブルに空状態の登録案内（empty-hint）を整備 = デモデータ前提の誤誘導なし
- [x] **FK を張らない判断（確定）**: 参照整合は API 書込パスの存在検証（SKU・倉庫・会社・セグメント = requireRef/requireSkus）で担保。理由 = ①lines jsonb 内参照は FK 表現不可（整合手段の二重化）②記録系原本は赤黒で不変・マスタは論理削除のみ ③モック期 localStorage データの持ち込み経路なし。0030/0031 への後付けも同判断（0032 冒頭コメント + data-design §1.6 が正）
- [x] c-ak-* デモシード参照の整理: 0031 の warehouses（wh-02/03）・consignment_terms（ct-01〜04）は c-ak-* を参照するが実環境の companies に不在 → **実運用開始時に画面から実取引先へ付け替える**（統合テストで wh-02 の付け替え → 店舗預け移動を検証。オペレーター手順は §39-5）

### 39-2 API（routes/akebono-trade.ts / akebono-billing.ts。/v1/akebono 配下へ追加マウント）
- [x] 商品: POST /products（既定 SKU 同時生成 = XA-1・コード重複 409）・PATCH（hasOwn 部分更新）・archive/restore・POST /:id/skus/matrix（既存組合せスキップ = 冪等・生成で既定 SKU 無効化）・PATCH /product-skus/:id・画像（POST /:id/images = **data:image png/jpeg/webp/gif base64・400,000 字上限 = SVG 拒否 AKO-PRD-004**・archive/restore・セクション変更）
- [x] 伝票: 発注（状態機械 = shared PO_STATUS_NEXT を FOR UPDATE 検証）・生産（実績追記 + production_in + 全数完成判定を 1 トランザクション）・入荷/出荷（実績 = 追記のみ。在庫 post + 予定ステータス再計算を 1 トランザクション・実績ありの予定取消 409・出荷は在庫不足 409 + 店舗納品の預け倉庫 transfer_in をサーバー解決）・仕入（入荷管理 OFF 経路の warehouseId 指定で purchase_in・赤黒訂正で在庫戻し・二重訂正 409）
- [x] 在庫: GET 台帳（残高はフロントが shared foldBalances で導出 = 両モード同一）・adjust / transfer（不足 409・出入 2 行を同一トランザクション）・stocktake（差分行のみ計上）。**postInventory = ON CONFLICT DO NOTHING の冪等追記（モック useInventory.post と同一意味論）**
- [x] 売上・請求: sales-records（原価・課金区分をサーバーが SKU/商品から解決・赤黒 = 相殺行の追記・請求済みは 409）・billing/close（未発行ドラフトの洗い替え = 冪等）・issue / void（赤伝 = マイナス請求 + 売上リンク解除・paid は 409・委託マージンは AKO-BIL-008）・payment-receipts（部分入金・全額で paid）・**consignment/close（店舗マージン請求 + 作家支払通知の一括発行・委託条件スナップショット凍結・精算リンクで再締め冪等）**・payment-notices/:id/confirm。金額算定は **shared/domain/akebono**（calcTax / calcStoreMargin / calcPayoutAmount 等 = utils/akebono.ts から移設しモックと共有。mockup 側は再エクスポートで既存 import 不変）
- [x] 認可: 参照・書込とも認証済み全員（モック画面に管理者ゲートなしの日常業務 = 社内 C2）。/v1/akebono は **featureGuard 'akebono'（F-16 = PATH_FEATURES）の対象**（機能 deny で全体遮断できる安全側。個別アプリの表示制御は業態×アプリ設定 = クライアント側。レビュー A2 で「対象外」の誤記述を訂正）。発行・精算・訂正・取消は監査ログ
- [x] エラーコード: モック composable と同一の AKO-PRD/POR/MFG/INB/PCH/OUT/INV/SLS/BIL 系を台帳へ起番（新規 = AKO-PRD-004 のみ。api-design §4）

### 39-3 統合メトリクスのサーバー組み立て + M3 バッジ撤去（オペレーター明示要望）
- [x] `GET /v1/media/integrated?segmentId=&months=&force=`（buildIntegratedMetrics）: 売上軸 = sales_records を **foldBusinessMonthly（赤黒訂正の元月帰属 = businessMonthly と同一の共有純関数）** で集計 + メディア軸 = GA 月次（30 分キャッシュ・force 伝搬）をサーバーで突合。GA 未連携 = mediaConnected=false（メディア軸 0 が正）・GA 一時障害 = mediaFailed=true（フロントは 0 描画せず失敗表示 + 再試行 = M1 の意味論を維持）
- [x] scope=integrated のインサイト生成は**クライアント合成メトリクスの受領を廃止**（サーバー組み立てのみ = M2 の改ざん耐性限界を解消。normalizeIntegratedMetrics / applyServerMediaAxis と AKO-MEDIA-016 を撤去 = 016 欠番。GA 月次が取れないときは 004 で生成拒否 = M1 のサーバー側強制）
- [x] フロント: useMediaAnalytics = /monthly クライアントキャッシュを /integrated キャッシュへ置換（integratedReady/Failed/refreshMonthly/ensureIntegratedLoaded は同名で意味論維持・N1 の 1 回 force 再試行も維持）。モック合成も shared composeIntegratedMetrics へ統一（挙動不変 = 単体 148 green）。**売上の計上・赤黒訂正後は invalidateIntegratedFor でキャッシュ無効化**（SoT 変化の追随 = 原則6）
- [x] **M3 バッジ撤去**: PDCA タブの「売上・受注 = デモデータ」バナー・analytics.vue 撤去 / ダッシュボード・会社全体のページ全体モックバッジ撤去（撤去条件 = salesRecords 移行の成立）。**AI レポート保管（dashboardInsights）のみ未移行のため「レポート保管 = ローカル」のスコープ付きバッジをカードに残す**（正直な表示。Phase D で撤去）
- [x] mock-status: `/akebono/imports`（F-32 = 唯一のモック残）を登録（従来の未登録は表示漏れだった旨を記録）

### 39-4 フロント（デュアルモード化。モックモードの挙動は不変）
- [x] useApi: CUSTOM_COLLECTION_ENDPOINTS へ 15 コレクション追加 + **apiWrite ヘルパー新設**（書込 → 影響コレクションの force 再ロード = 実績登録の多コレクション波及（実績 + 在庫台帳 + 予定ステータス）をキャッシュ手術でなく再取得で整合 = 原則6）
- [x] 9 composable の書込系を async 化（useProducts / usePurchaseOrders / useProduction / useInbound / usePurchases / useOutbound / useInventory / useAkebonoSales / useConsignment）。読み取り・導出（残高・消込率・月次 KPI）は両モード共通の純関数のまま
- [x] 9 ページの呼び出しを await + エラートースト追随（Grep 全件）。**作成系ハンドラに busy ガード（二重送信 = 重複伝票の防止。§34 の実行中フィードバックの漸進適用）** + products/segments は保存中表示
- [x] 空状態の導線: 全記録ページの主要テーブルへ empty-hint（登録方法の案内）を整備（§39-1 実データ方針）

### 39-5 検証・オペレーター確認
- [x] テスト: api 単体 **174**（akebono-integrated 6 件新設 = recentMonthKeys / foldBusinessMonthly の赤黒元月帰属 / composeIntegratedMetrics 派生値。旧 M2 テスト 9 件は機能撤去に伴い削除）/ api 統合 **179**（Phase C 8 スイート新設 = 商品/SKU/画像・発注→入荷→在庫・在庫操作・仕入赤黒・出荷店舗預け・売上/請求フロー・委託精算・統合メトリクス。旧「クライアント合成受領」統合テストは新契約へ書き換え）/ mockup 単体 148 / typecheck（api・mockup）・build 全 green
- [x] オペレーター確認手順: ①`/akebono/products` で商品登録（空状態から）→ SKU マトリクス → 画像 ②`/akebono/purchases` 仕入計上（在庫入庫）→ `/akebono/inventory` 残高・調整・移動・棚卸 ③`/akebono/sales` 売上計上 → `/media/analytics` PDCA タブに実売上が反映（デモバッジなし）④`/akebono/billing` 締め → 発行 → 入金 / 委託精算（事前に顧客マスタで取引先へ「店舗」「委託仕入先（作家）」ロール + 共通マスタで委託条件を実取引先で登録・**wh-02/03 の預け先を実店舗へ付け替え**）⑤いずれもリロード・翌日も保持されること
### 39-6 残課題（Phase D）→ **§40（Phase D）で消し込み完了（2026-07-29）**
- [x] **委託精算の取消フロー** → **§40 で実装**（0037。マージン請求の赤伝 + 支払通知の論理取消 + 売上リンク解除 = 再締め可能・二重取消 AKO-BIL-010。AKO-BIL-008 は「単独赤伝不可 = consignment/cancel を使用」へ更新）
- [ ] **入荷/出荷/生産実績の伝票レベル補償**（実績は追記のみで取消手段なし。在庫数量は調整（adjust）で補償可能 = その旨を運用案内。レビュー A1）→ **§40 でも据え置き**（在庫の数量補償で足りる = §40 残課題に分類・根拠記載）
- [ ] 観察事項（レビュー 1 巡目・スコープ外の記録）: canceled 予定への実績受理を許している / qtyLines の不正行を無音スキップしている（明細検証の厳格化）→ **§40 残課題として据え置き**（データ整合ではなく入力厳格化の課題 = 別軸）
- [x] データ取込（F-32）: importSources / importMappings / importRuns の API 化 → **§40 で実装**（0035。設定系 + 記録系。取込設定・実行履歴の永続化。実ファイル取込・パースは F-32 後続 = §40 残課題）
- [x] dashboardInsights のサーバー保管（media_insights 同型）→ **§40 で実装**（0036。導出キャッシュ upsert。機能トグル 'media' はサーバーが app_configs から解決 = 見送り理由を解消。「レポート保管 = ローカル」バッジ撤去）
- [x] 出荷実績 → 売上明細の自動計上（sourceKind='shipment'）→ **§40 で実装**（0038。postSales オプション・二重計上防止・店舗預けは対象外）。取込からの売上計上（'import'）は実ファイル取込の本実装とセット = §40 残課題

### 39-7 反復レビュー（原則9・1 巡目 = 統合指摘 major 2・minor 4 → 全件対応）
- [x] **C-1（major・並行性）**: check-then-act の突破を 3 経路で封止（migration **0033** + アプリ側）。①在庫（出荷・移動・棚卸）= `pg_advisory_xact_lock`（SKU × 倉庫キーを重複排除 + ソート取得 = デッドロック防止）で残高チェック → 台帳追記を直列化 ②請求締め = advisory lock（得意先 × 期間）+ **部分一意 INDEX（(company_id, period_from, period_to, invoice_type) WHERE status='draft'）** を最終防衛に 23505 → 409 変換 ③精算・発行のリンク張り = `WHERE invoice_id IS NULL` + 更新件数検証（すり抜けは 409 で全体中止）+ 精算は advisory lock（業態 × 月）。**並行性テストの実装可否**: advisory lock の直列化は統合テストで Promise.all の並行 2 発（出荷 = [201, 409] + 残高 0 / 締め = draft 1 枚）として決定的に検証できた。部分一意 INDEX は DB 直接 INSERT の 23505 で検証。精算の件数ガードは競合ウィンドウ限定のため決定的テスト不能 = advisory lock の直列化テスト + コードガードでカバー（判断を記録）
- [x] **C-2 + A1（major・取消フロー = 原則9.5）**: ①入金の受理ガードを issued/paid のみに（void への入金による「void → paid」終端状態破壊を封止）②**入金取消を実装**（0033 の voided_at/voided_by = 監査列付き論理取消。有効入金の再集計で paid → issued を 1 Tx・二重取消 = **AKO-BIL-009**。モック側も同一挙動 + 入金履歴 UI に取消ボタン）③AKO-BIL-008 の文言を実態化（「精算のやり直しで対応」→「取消フローは今後対応予定・管理者へ相談」）④委託精算取消・実績の伝票補償を §39-6 + data-design §1.6 に残課題として明記
- [x] **C-3（minor）**: `POST /products/:id/restore` の部分一意衝突（同コード再登録後の復元）を 23505 → **AKO-PRD-002 409 + 対処案内**へ（media_articles restore と同型。500 を出さない）
- [x] **A2（minor・原則5）**: 「/v1/akebono は F-16 対象外」という実挙動（PATH_FEATURES で featureGuard 'akebono' の対象 = 安全側）と逆の記述 3 箇所（akebono-trade.ts ヘッダ・api-design §3・本書 §39-2）を訂正。実在しない「akebono.ts と同判断」引用も削除
- [x] **A3（minor）**: §37-4 残課題行へ Phase C 完了を反映（サーバー組み立て化・M2 限界解消・016 欠番）
- [x] 検証: api 単体 174 / 統合 **184**（レビュー対応 5 スイート新設 = C-1a 並行出荷・C-1b 一意 INDEX + 並行締め・C-2 入金ガード/取消/再入金・C-3 復元衝突）/ mockup 148・typecheck・build 全 green

### 39-8 反復レビュー（外部ボット PR #84 Codex・P1×3・P2×1 = **スケール境界の取得ロジック** → 全件採用）
> 全指摘とも本番規模（仕入 > 500 件・台帳/売上 > 2 万件）で顕在化する「取得窓に依存した誤集計」。
> オペレーターには「小規模デモでは正しく見えるのにデータが育つと金額・残高がずれる」形で影響するため、
> 取得ロジックを**窓非依存**へ是正した。migration **0034**（GIN）追加。
- [x] **P1-1（作家支払の原価解決が全 SKU 横断の直近 500 件窓）**: `resolveUnitCost`（purchase_cost 方式）が仕入を「全 SKU 横断で `ORDER BY purchase_date DESC, id DESC LIMIT 500`」で取ってから JS 走査していたため、仕入総数が 500 を超えると対象 SKU の直近仕入が窓外へ落ち標準原価へ誤フォールバック = **作家支払額が誤った**。SQL を **`lines @> [{"skuId":…}]::jsonb` で対象 SKU を含む明細に絞り最新 1 件**へ是正（モックの全走査と窓非依存で一致）。**0034** = `purchase_records.lines` の GIN（`jsonb_path_ops`）で本番規模の全 SKU スキャンを回避
- [x] **P1-2（在庫台帳 LIMIT 20000 の打ち切りが残高を壊す）**: `GET /inventory-transactions` は表示用の直近明細（LIMIT 20000）だが、フロントはこの明細を `foldBalances` で畳んで残高としていたため、台帳が 2 万行を超えると期首在庫・過去の移動が残高・棚卸入力から消えた。**`GET /inventory-balances`（GROUP BY sku_id, warehouse_id の Σqty・全量集約・0 残高は HAVING で除外）を新設**し、API モードの `useInventory` は「残高 = サーバー集約値・明細 = 表示用」に分離（`balanceOf`/`totalOf`/`balancesOfWarehouse`）。実績書込の reload に `inventoryBalances` を追加（SoT → キャッシュ = 原則6）。**モックモードは従来どおり全件ローカル `foldBalances`（不変）**
- [x] **P1-3（統合メトリクスの売上取得が無順序 LIMIT 20000）**: `/v1/media/integrated` が売上を無順序 `LIMIT 20000` で取ってから `foldBusinessMonthly` に渡すため、2 万件超のセグメントで任意の部分集合になり売上総額・受注数・赤黒ペアリング・PDCA が誤った。**対象月窓（periodFrom〜periodTo）に絞って取得**へ是正。ただし赤黒訂正は「元伝票の計上月」へ帰属する意味論のため、`LEFT JOIN` で `COALESCE(元伝票.sales_date, 自身.sales_date)` が窓内の行を取る（**窓内の元伝票を offset する訂正は訂正日が当月=窓外でも拾う / 元伝票が窓外の訂正は帰属月も窓外で取得せず = 元不明フォールバックの暴発防止**）。`foldBusinessMonthly` の意味論は不変
- [x] **P2-4（商品 PATCH が segmentId を無視 = モックと乖離）**: `productPatchOf` が作成時のみ segmentId をコピーし PATCH では無視 → 成功を返すのに旧セグメントのまま（モックは反映 = 乖離）。PATCH でも `Object.hasOwn` で受理 + 参照セグメントの存在検証（requireRef）を追加。別セグメントへの移動で同コード衝突 = 部分一意 INDEX (segment_id, code) WHERE active → 23505 → **AKO-PRD-002 409**（POST/restore と同型・文言をコード変更/移動の双方を案内する形に更新）
- [x] **回帰テスト（スケール境界を小規模フィクスチャで決定的に検証）**: P1-1 = 対象 SKU の直近仕入を「別 SKU の新しい仕入の後」に置き作家支払 = 仕入単価 650×2=1300（標準原価 900 フォールバックなら 1800）で窓非依存を確認 / P1-2 = `inventory-balances` の Σ集約一致・0 残高非返却 / P1-3 = 元伝票が窓内・訂正日が当月（窓外）の赤黒が元月へ帰属して相殺（訂正日で単純フィルタする回帰なら 7000/2 件になる） / P2-4 = PATCH で segmentId 反映・不存在は 404・移動先の同コードは 409
- [x] 検証: api 単体 174 / 統合 **188**（Codex 4 スイート新設 = P1-1 原価窓非依存・P1-2 残高集約・P1-3 統合メトリクス月窓 + 赤黒元月帰属・P2-4 segmentId PATCH）/ mockup 単体 148 / typecheck（api・mockup）・build 全 green

## 40. Akebono 設定・実データの本実装 Phase D: 残記録系・導出系の API 永続化（データ取込 F-32・ダッシュボード保管 F-41・委託精算取消・出荷→売上。2026-07-29）の完了条件（Definition of Done）— **本実装プログラムの最終フェーズ**

> オペレーター指示「設定・実データの本実装」第 3 弾（最終）。Phase B（設定系 = §38）・Phase C（記録系 +
> 売上軸 = §39）に続き、**残っていたモックコレクションを API 化して「API モードで localStorage 保管のまま
> 端末ローカル/日次消失する設定・実データ」を 0 にする**。走査した Akebono 30 コレクションの移行完了表（§40-4）と
> 突き合わせて確認済み。migration **0035-0038**。

### 40-1 DB（migration 0035-0038。テーブルごとに記録系/設定系/導出系の別と SoT をコメント明記）
- [x] **0035（データ取込 F-32）**: import_sources（**設定系**・論理削除で取消/復元）/ import_mappings（**設定系/版管理**・新版追記で旧 active は superseded・UNIQUE(source_id, version) + 部分一意 (source_id) WHERE active）/ import_runs（**記録系**・追記のみ・counts/errors jsonb）。SoT = 本テーブル群。シードしない（実データ方針 = C/D 同方針）
- [x] **0036（ダッシュボード保管 F-41）**: dashboard_insights（**導出キャッシュ**・media_insights 0030 と同型の upsert。UNIQUE(scope, segment_id)・company は segment_id='' 番兵で ON CONFLICT を単純化）。SoT = 集計材料（sales_records + GA）。復元不要（再生成で作り直せる）
- [x] **0037（委託精算取消）**: invoices/payment_notices へ settlement_id（精算バッチ id）・payment_notices へ voided_at/voided_by（論理取消の監査列 = payment_receipts 0033 と同型）を**追加のみ**（後方互換 = 原則7）+ consignment_margin の期間 INDEX
- [x] **0038（出荷→売上）**: sales_records の部分一意 INDEX `(source_ref) WHERE source_kind='shipment'`（二重計上防止の最終防衛。スキーマ変更なし = source_kind='shipment' は 0032 で許容済み）

### 40-2 API
- [x] **データ取込（routes/akebono-imports.ts。/v1/akebono 配下へ追加マウント）**: 取込元 CRUD + archive/restore（AKO-IMP-001）・マッピング版管理（version 採番を advisory lock で直列化 = 二重 active を部分一意 INDEX が最終防衛。AKO-IMP-003）・取込実行（記録系・追記。有効マッピングなしは AKO-IMP-002・実行はサーバーが決定的にシミュレート = simulateRun。隔離行 AKO-IMP-010）。**参照は全員・書込は管理者のみ**（imports 画面は管理者運用）。純関数 importFieldsOf / simulateRun は単体テスト対象
- [x] **ダッシュボード保管（routes/akebono-dashboard.ts。env を取り Vertex AI を使う）**: GET dashboard-insights（scope=segment/company）・POST /generate（**buildIntegratedMetrics を消費**してサーバーで SegmentSummary/CompanySummary を組み立て → Vertex AI → 失敗時 heuristicSegmentInsight/heuristicCompanyInsight。llm フラグ）。**機能トグル 'media' はサーバーが app_configs から解決**（mediaFeatureEnabled = seed 既定 true と一致）= Phase C の見送り理由（クライアント専用トグル依存）を解消。GA 連携済みで月次取得失敗は AKO-MEDIA-004（company は 1 業態でも失敗で拒否 = M1）
- [x] **委託精算取消（akebono-billing.ts）**: POST consignment/cancel。バッチ（issued・credit_for IS NULL のマージン請求）を void + 赤伝追記・売上リンク解除・支払通知を voided_at で論理取消。close と同一 advisory lock で排他・二重取消 AKO-BIL-010。confirmNotice は取消済みを 409。AKO-BIL-008 文言を「単独赤伝不可 = consignment/cancel を使用」へ更新
- [x] **出荷→売上（akebono-trade.ts）**: outbound-results に postSales オプション。対象明細から売上を自動生成（source_kind='shipment'・source_ref='obr:<明細行id>'・原価/課金区分をサーバー解決・同一トランザクションで原子的）。店舗預けは AKO-OUT-005（売上導線の二重化を作らない）・出荷先/セグメント未指定・単価未解決も AKO-OUT-005。事前検証を在庫 post の前に置き部分適用を作らない

### 40-3 フロント（デュアルモード化。モックモードの挙動は不変 = 原則7）
- [x] useApi: CUSTOM_COLLECTION_ENDPOINTS へ importSources/importMappings/importRuns を追加（dashboardInsights は media_insights と同じくキー単位の apiLoadOnce = composable 管理）
- [x] useAkebonoImports: addSource/archiveSource/restoreSource/saveMapping/runImport を async 化（API = apiWrite → 影響コレクション再ロード）。imports.vue のハンドラを await + busy ガード + 注記文言を実態化
- [x] useDashboardInsight: loadSegment/generateSegment/loadCompany/generateCompany を async 化（API = GET/POST /v1/akebono/dashboard-insights）。**サマリー（KPI/チャート）は従来どおり常時ライブ集計**（/v1/media/integrated を消費 = 変更なし）。dashboard.vue/company.vue を await 化 + **「レポート保管 = ローカル」バッジを撤去**
- [x] useConsignment: cancelConsignment を追加（両モード。マージン赤伝 + 支払通知 voidedAt + 売上リンク解除）。billing.vue に「委託精算を取消」導線 + 取消済み通知の表示/確定ガード。PaymentNotice 型へ voidedAt 追加
- [x] useOutbound: registerResult に postSales/segmentId を追加（両モード。店舗預けは無効化 + 自動解除）。outbounds.vue に「売上として計上する」チェックボックス。sales.vue の空状態文言を実態化
- [x] mock-status: **再び空**（Phase C で一時登録した /akebono/imports を撤去）= API モードのモックバッジは無い

### 40-4 走査 Akebono 30 コレクションの移行完了表（B/C/D のどこで移行したか）
> localStorage + 日次リシードだったモックコレクションの全件。**30 コレクションすべて API（PostgreSQL）へ移行完了**。

| # | コレクション | 分類 | 移行先エンドポイント | 移行フェーズ |
|---|---|---|---|---|
| 1 | businessSegments | 設定系 | `/v1/masters/business-segments` | **B**（0031） |
| 2 | warehouses | 設定系 | `/v1/masters/warehouses` | **B** |
| 3 | units | 設定系 | `/v1/masters/units` | **B** |
| 4 | taxRates | 設定系 | `/v1/masters/tax-rates` | **B** |
| 5 | paymentTerms | 設定系 | `/v1/masters/payment-terms` | **B** |
| 6 | consignmentTerms | 設定系 | `/v1/masters/consignment-terms` | **B** |
| 7 | variantAxisTemplates | 設定系 | `/v1/masters/variant-axis-templates` | **B** |
| 8 | productCategories | 設定系 | `/v1/masters/product-categories` | **B** |
| 9 | productImageSections | 設定系 | `/v1/masters/product-image-sections` | **B** |
| 10 | akebonoAppConfigs | 設定系（複合キー） | `/v1/akebono/app-configs` | **B** |
| 11 | itemSettings | 設定系（差分 upsert） | `/v1/akebono/item-settings` | **B** |
| 12 | products | 設定系 | `/v1/akebono/products` | **C**（0032） |
| 13 | productSkus | 設定系 | `/v1/akebono/product-skus` | **C** |
| 14 | productImages | 設定系 | `/v1/akebono/product-images` | **C** |
| 15 | purchaseOrders | 指示系 | `/v1/akebono/purchase-orders` | **C** |
| 16 | productionOrders | 指示系 + 実績 | `/v1/akebono/production-orders` | **C** |
| 17 | inboundPlans | 予定系 | `/v1/akebono/inbound-plans` | **C** |
| 18 | inboundResults | 記録系 | `/v1/akebono/inbound-results` | **C** |
| 19 | purchaseRecords | 記録系（赤黒） | `/v1/akebono/purchase-records` | **C** |
| 20 | outboundPlans | 指示系 | `/v1/akebono/outbound-plans` | **C** |
| 21 | outboundResults | 記録系 | `/v1/akebono/outbound-results` | **C** |
| 22 | inventoryTransactions | 在庫の SoT（台帳） | `/v1/akebono/inventory-transactions`（+ `/inventory-balances`） | **C** |
| 23 | salesRecords | 売上の SoT（記録系・赤黒） | `/v1/akebono/sales-records` | **C** |
| 24 | invoices | 確定系（赤伝） | `/v1/akebono/invoices` | **C** |
| 25 | paymentNotices | 確定系 | `/v1/akebono/payment-notices` | **C** |
| 26 | paymentReceipts | 記録系（論理取消） | `/v1/akebono/payment-receipts` | **C** |
| 27 | importSources | 設定系 | `/v1/akebono/import-sources` | **D**（0035） |
| 28 | importMappings | 設定系/版管理 | `/v1/akebono/import-mappings` | **D** |
| 29 | importRuns | 記録系 | `/v1/akebono/import-runs` | **D** |
| 30 | dashboardInsights | 導出キャッシュ | `/v1/akebono/dashboard-insights` | **D**（0036） |

> **参考（30 の外・Akebono 隣接）:** akebonoWishes = F-03 バッチ6d（0019）で移行済み / mediaSettings・mediaArticles・
> mediaInsights・articleBriefs・generatedArticles = F-40（0030）で移行済み。**currentSegment は §41（0039）で per-user DB 永続化へ変更（当初は端末ローカル = §40-5）**。

### 40-5 currentSegment（`ako.currentSegment.v1`）の判断: **端末ローカルのまま維持（移行しない）** — 根拠

> ⚠️ **本判断は §41（2026-07-30）で上書き済み**: オペレーター指示「どの端末からログインしても同じ状態で閲覧できるように
> DB へ永続化する」により、currentSegment は per-user で DB 永続化（`user_preferences`）へ変更した。以下の根拠は当時の
> 記録として残す（「端末間同期はむしろ不都合」という想定より、端末間で状態を揃えたいという運用要求が優先された）。
- **性質**: 「今どの業態で作業しているか」= 一時的な UI 選択状態（直近の作業コンテキスト）。記録系でも設定系でもない。
- **日次消失しない**: 専用 localStorage キーで、日次リシードの対象（useMockDb = `ako.mockdb.v1`）とは別管理。端末に永続する（useCurrentUser と同パターン）。よって「API モードで日次消失する設定・実データ」には**該当しない**。
- **非破壊**: 無効 id は既存の純関数 `resolveDefaultSegmentId` が先頭業態へフォールバック（原則2）。失っても情報損失なし（既定へ戻るだけ）。
- **端末間同期はむしろ不都合**: PC で業態 A・スマホで業態 B を見ている状態を強制同期すると作業が乱れる。UI 状態は端末ローカルが妥当（走査 A-8 で検討したが「端末ローカルが妥当な UI 状態」に分類）。
- **結論**: サーバー保存しない。ゆえに本フェーズ完了時点で「localStorage 保管のまま端末ローカル/日次消失する**設定・実データ**」は 0（currentSegment は設定・実データではない UI 状態）。

### 40-6 検証・オペレーター確認（テスト数はレビュー 1 巡目対応後の確定値 = §40-8）
- [x] テスト: api 単体 **182**（akebono-phase-d 8 件新設 = importFieldsOf/simulateRun/normalizeDashboardInsight）/ api 統合 **198**（Phase D スイート新設 = 取込の版管理/実行履歴・ダッシュボード upsert（GA 未連携・会社全体・**売上権限ゲート**）・委託精算取消の冪等と再締め・**入金済み/確定済みの取消拒否**・出荷→売上の二重計上防止と店舗預け 409・**source_ref 一意 INDEX**。Phase C の close 応答へ settlementId 追随）/ mockup 単体 **155**（akebono-phase-d 7 件新設 = consignmentCancelBlockReason・buildShipmentSaleLines）/ typecheck（api・mockup）・build 全 green
- [x] オペレーター確認手順:
  1. `/akebono/imports`（管理者）で取込元を追加 → マッピングを保存（v1 → v2 で版が上がる）→ 取込を実行（履歴が積み上がる）→ **リロード・翌日も保持**
  2. `/akebono/dashboard`（業態ダッシュボード）→ 「レポートを生成」→ AI レポート・インサイトが表示 → **リロードで保持（バッジ「レポート保管 = ローカル」が無いこと）**。`/akebono/company`（会社全体・売上権限）でも同様
  3. `/akebono/billing`（委託精算タブ）で「委託精算を締める」→ マージン請求 + 支払通知が発行 → 「委託精算を取消」→ マージンに赤伝・支払通知が取消済み・対象売上のリンク解除 → **同月を再締めできる**
  4. `/akebono/outbounds`（出荷）で「直接出荷登録」→ 出荷先（得意先）+ 「この出荷を売上として計上する」を有効 → 登録 → `/akebono/sales` に発生源=出荷実績の売上が計上（同一出荷の二重計上なし）。店舗預けの出荷では計上チェックが無効
  5. いずれも API モードで**リロード・翌日も保持**されること（localStorage 依存の解消）

### 40-7 残課題（本フェーズ後）
- [ ] **データ取込の実ファイル取込（F-32 後続）**: CSV/固定長/JSON のアップロード・パース・マッピング変換適用・API 接続の SSRF 対策・認証情報のサーバー保管。**本フェーズは取込設定・実行履歴の永続化（localStorage 依存の解消）が目的**で、実行はサーバーが決定的にシミュレートする（imports 画面に明示）。取込からの売上計上（source_kind='import'）はこの本実装とセット。
- [ ] **入荷/出荷/生産実績の伝票レベル補償**（実績は追記のみ・取消手段なし。**在庫の数量は adjust で補償可能** = 運用でカバー。伝票そのものの赤黒/取消は需要を見て判断）。
- [ ] 観察事項（明細検証の厳格化・別軸）: canceled 予定への実績受理 / qtyLines の不正行の無音スキップ。データ整合ではなく入力厳格化の課題として据え置き。

### 40-8 反復レビュー（原則9・1 巡目 = 独立コードレビュアー + システム監査官・いずれも Opus。統合指摘 major 1・中 1・minor 6 → 全件対応）
> Phase D の 1 巡目レビュー。財務整合の major 1 件・原則9.5 実態化の中 1 件を是正し、minor を全消し込み。
- [x] **MAJOR-1（財務整合・両モード）: `consignment/cancel` が下流確定状態を無視して片側反転**（入金済み/部分入金のマージン請求は `status='issued'` 条件から外れ void されず孤児入金化・支払通知は期間一括 void で再締め時に片側消失）→ **バッチに有効入金のあるマージン請求（部分入金含む）or 確定済み支払通知が 1 件でもあれば取消を AKO-BIL-011 で拒否**（整合を壊さない拒否を採用。全反転は入金・確定という確定系の自動巻き戻しになり危険なため不採用）。先に入金取消（AKO-BIL-009）を行えば取消可能。判断は共有純関数 `consignmentCancelBlockReason`（API = SQL EXISTS + JS 純関数、モック = 同純関数 = 両モード一致）。統合テスト（入金済みは 409 → 入金取消後は 200・確定通知は 409）+ mockup 単体
- [x] **中（原則9.5）: 取込元 archive/restore が UI 未接続**（composable/API/統合テストは在るが imports.vue に導線なし = 宣言だけで実態が伴わない）→ imports.vue に **無効化（確認ダイアログ付き）+「無効も表示」トグル + 復元導線**を追加（既存マスタ画面の論理削除 UI パターン踏襲・原則8）
- [x] **m1（テスト数の食い違い 182 vs 180）**: 2 巡目レビューで独立コードレビュアーが再び 182 を実測して不一致が残ったため、コーディネータが `80effd1` で `npm test`（JSON reporter 含む）を複数回実行し **api 単体 182**（skipped 0・条件付きスキップなし・安定）を確定値とした。1 巡目対応時の 180 は当該環境の一時的な計測差で誤り。§40-6/§40-8 を実測 182 へ是正
- [x] **m2（出荷→売上の 23505 が生 500）**: outbound-results の inTxn に `.catch` を追加し 0038 部分一意衝突（source_ref 重複）を **AKO-OUT-005 409** へ変換（原則4）。DB 制約の直接検証テスト（同一 source_ref の 2 行 INSERT = 23505）を追加
- [x] **m4（imports のモード差 = 非管理者が直 URL で書込可）**: useAkebonoImports の全書込に **admin ガード（AKO-AUTH-003）を両モードで追加**（API の requireAdmin と一致）+ imports.vue の書込 UI を isAdmin でゲート + 非管理者向け閲覧のみ注記
- [x] **監査-2（原則5）: §40-2「事前検証を post の前に置く」が API 実装と不一致**（postInventory 後に検証していた）→ **API の postSales 事前検証 + 単価解決を postInventory の前へ移動**（モック useOutbound と同順序 = 記述を実態に一致・部分適用防止をトランザクション順序でも表現）
- [x] **監査-3（原則9・テスト）: mock 新規ロジックの単体テストがゼロ**→ 新規ロジックを共有純関数へ抽出（`consignmentCancelBlockReason`・`buildShipmentSaleLines`）し **mockup 単体 7 件**を追加（SR コード累積採番・取消ガードの precedence を検証 = mock/API 乖離の検知）
- [x] **監査-4（原則6/認可）: 会社全体 dashboard（C3 = 売上含む）にサーバー側売上権限検証がない**→ scope=company の GET/生成に **`canUseFeature(rules, subject, 'sales')` サーバーゲート（AKO-PRM-001 403）**を追加（featureGuard と同型・ルール未設定は既定 allow）。統合テスト（売上 deny の member は 403・admin/業態単位は 200）
- [x] **監査-5（原則5・既存不整合）: §38 タイトル「12 コレクション」**→ 本文/表/実装と一致する「**11**」へ是正
- [x] 観察-6（用語基準・任意）: 対応見送り（「導出キャッシュ」「設定系/記録系/確定系」の呼称は data-design §1.5-1.7 で統一済み = 実害なし）
- [x] 検証: api 単体 **182** / 統合 **198**（レビュー対応 3 スイート新設 = MAJOR-1 取消拒否・監査-4 売上権限ゲート・m2 source_ref 一意 INDEX）/ mockup 単体 **155**（監査-3 = 2 純関数）/ typecheck（api・mockup）・build 全 green

## 41. currentSegment（現在の業態）の per-user DB 永続化 = 端末間同期（オペレーター指示 2026-07-30）

> オペレーター指示:「データが一部ローカルストレージ扱いになっている箇所がないか調査し、どの端末からログインしても
> 同じ状態で閲覧できるように DB へ永続化する」。§40-5 の「currentSegment は端末ローカルのまま」判断を上書きする。

### 41-1 調査結果（localStorage/sessionStorage の全走査）
- 独立監査（Explore ロール）で `mockup/app` の全 `localStorage`/`sessionStorage` アクセスと、`commit()` を呼ぶ全 37 composable を精査。
- **API モードで localStorage にのみ残る「業務・個人状態」は `currentSegment`（`ako.currentSegment.v1`）ただ 1 つ**と確定。
  - 他の localStorage キーは全てモックモード限定のフォールバック（`ako.mockdb.v1` / `ako.currentUser.v1` /
    `akebono-mock-calendar-selection` = いずれも `if (isApi)` の後段 or モック分岐からのみ到達）。
  - sessionStorage（`ako.chatSession.v1` = 表示中セッション id・`menu-cat-*` = メニュー絞り込みチップ）は
    **タブ単位の一時 UI 状態（アカウント設定ではない）**で、同期対象外と判断（実データはサーバー側）。
- `switchSegment` だけが `isApi` ガードなしで無条件に localStorage 書込していた = 端末ごとに開く業態が変わる原因。

### 41-2 DB（migration 0039）
- [x] **`user_preferences`（設定系・per-user）**: `(member_id FK ON DELETE CASCADE, key, value jsonb, updated_at)`・PK `(member_id, key)`。
  app_configs（0001 = テナント全体の key-value）の**ユーザースコープ版**（原則3 = 既存パターン再利用）。SoT = 本テーブル。シードしない。
  members マスタには載せない（`/v1/masters/members` で全員へ露出させない・マスタ CRUD の巻き戻し対象にしない = avatar と同じ分離方針）。下位互換 = 新規テーブル追加のみ（原則7）。

### 41-3 API
- [x] **`GET /v1/me`**: レスポンスに `prefs`（本人の user_preferences をオブジェクト化）を追加。フロント起動時の 1 フェッチで同期状態を配信。
- [x] **`PUT /v1/me/preferences/:key`**: 本人のみ・upsert = 冪等（原則2）。key は configs と同一 allowlist（`^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`）・value(jsonb) は実バイト 4KB 上限・新規キーは 1 ユーザー 100 件上限（storage 暴走防止 = 監査-2）。
  **監査ログは記録しない**（per-user・高頻度・非セキュリティな UI 状態。app_configs = 管理者テナント設定とは性質が異なる）。

### 41-4 フロント（デュアルモード。モックモードの挙動は不変 = 原則7）
- [x] **useApi**: `ApiUser` に `prefs?` を追加 + `saveMePreference(key, value)`（PUT → 成功時 me.prefs 反映 = SoT 書込→キャッシュの順。原則6）。
- [x] **useCurrentSegment**: `currentSegmentId` を computed 化（API = `me.prefs.currentSegmentId` を SoT / モック = 従来の useState + localStorage）。
  `switchSegment` は API モードで楽観反映 + 非ブロッキング永続化（原則4。失敗しても resolveDefaultSegmentId が先頭業態へ倒す = 原則2）。
  消費側（layout/MediaSegmentBar 等）は読み取り + switchSegment 呼び出しのみで signature 互換（`currentSegmentId` への外部代入はゼロを grep 確認）。

### 41-5 ドキュメント（原則5 = 全件更新）
- [x] data-design §1.10（`user_preferences` テーブル定義）+ §1 末尾の currentSegment 注記を「per-user DB 永続化」へ是正。
- [x] api-design（`GET /v1/me` の prefs・`PUT /v1/me/preferences/:key` 行を追加）。
- [x] mock-status.ts / useCurrentSegment.ts のヘッダコメントを是正。§40-4 参考・§40-5 に上書き注記。

### 41-6 検証
- [x] api 単体 **182** / api 統合 **199**（`/v1/me` prefs + preferences upsert/取得/冪等/per-user 分離/キー・サイズ検証の 1 スイート新設）/ mockup 単体 **155** / typecheck（api・mockup）・build 全 green。
- [x] オペレーター確認手順（API モード）: 端末 A で業態を切り替え → **別端末（or 別ブラウザ）で同じアカウントでログイン → 同じ業態で開く**。無効化された業態を選択済みでも先頭業態へフォールバック（壊れない）。モックモードは従来どおり端末ローカル。

### 41-7 反復レビュー（原則9・1 巡目 = 独立コードレビュアー + システム監査官・いずれも Explore/Opus）
> blocker/major はゼロ。minor を全件是正（重複する race/報告の指摘は 1 つの修正で同時解消）。
- [x] **CR-M1 / 監査-1（クライアント race + 報告不足）: `saveMePreference` の round-trip 後の書き戻しが、`switchSegment` の楽観更新と重なり、PUT の後着完了で古い値へ戻り得た**（+ 失敗を握りつぶし「次回ロードで既定へ倒れる」というコメントが不正確 = 実際は最後に保存できた値へ戻る）→ **楽観反映を `saveMePreference` 内でクリック順に同期確定**（round-trip 後の書き戻しを撤去 = 取り違え解消）+ `switchSegment` の二重更新を撤去 + **保存失敗を warn トースト通知**（原則4 の「報告」）+ コメントを実態へ是正。
- [x] **CR-M2（テスト薄さ）: per-user 分離テストが「書いていない HR が undefined」だけで、同一キーの独立保持を証明していない**→ **HR に別値（seg-09）を保存させ、MEMBER=seg-03 / HR=seg-09 の独立保持をアサート**。
- [x] **CR-M3（デッドコード）: `serialized === undefined` は JSON 由来値では到達不能**→ 削除（configs.ts と同形へ）。
- [x] **監査-2（storage 暴走）: value サイズ上限はあるがキー数無制限**→ **新規キーは 1 ユーザー 100 件上限**（既存キー更新は常に可の WHERE ガード付き upsert・超過は AKO-GEN-001）。
- [x] **監査-3（サイズ単位）: 4KB 上限が文字数（UTF-16）で「4KB」表記と不一致**→ **`Buffer.byteLength` の実バイトで判定**（表記と一致）。
- [x] 監査で確認済み（是正不要）: SoT=サーバー・冪等 upsert・他ユーザー参照/書込不可（member_id は認証コンテキスト）・下位互換（新規テーブル + 任意フィールド）・featureGuard 対象外が妥当・ドキュメント整合・§40-5→§41 の上書き注記・統合テスト数 199 実測一致。
- [x] 再検証（是正後）: api 単体 182 / 統合 199 / mockup 単体 155 / typecheck（api・mockup）・build 全 green（テスト本数は不変 = 既存 it へアサート追加）。

## 42. 勤怠承認ワークフロー: 直行/直帰の申請・承認 + 勤怠承認経路（稟議と同様の経路設定。オペレーター指示 2026-07-30）

> オペレーター指示:「①直行/直帰の申請と承認 ②承認された日は直行/直帰の打刻記録修正を申請できる ③勤怠管理の
> ワークフローも稟議と同様に経路設定できる」。F-04-11（直行/直帰）・F-04-12（勤怠承認経路）を新設し、既存の
> 打刻修正（F-04-6）を経路対応の多段承認へ拡張した。migration **0040**。

### 42-1 設計方針
- 稟議（F-07）の経路（workflow_routes）は **区分×金額帯** が選択キー。勤怠は金額でないため、**金額帯を持たない勤怠専用の
  経路マスタ `attendance_routes`（区分 = direct/fix）を新設**（Path B）。ステップ/承認エンジン（順序・ロール解決・直列前進・
  凍結）は稟議と同型で踏襲。承認者ロールは稟議の manager/director/president に **hr（人事）** を追加。
  > **注（2026-07-30・§43 で刷新）:** 本節の manager/director/president/hr プリセットは §43 で「役職／ロール／個人」モデルへ統一済み。以降の SoT は §43。
- **下位互換（原則7）**: 区分に有効経路が無ければ従来どおり**管理者 1 名の単段承認へフォールバック**。既存の打刻修正の挙動は
  経路未設定なら不変（既存統合テストがそのまま green）。新規テーブル + 列追加のみ。
- **記録系保護（原則2）**: 打刻修正の最終承認で `source='fix'` 打刻を追記（元打刻は削除しない = 既存フロー踏襲）。

### 42-2 DB（migration 0040）
- [x] `attendance_routes`（設定系マスタ・論理削除）/ `direct_requests`（承認系・多段）/ `attendance_fix_requests` へ
  `current_step`・`route_snapshot`・`direct_request_id` を**列追加のみ**（既存行は既定値で単段のまま）+ status CHECK に `in_review` を許容。

### 42-3 API
- [x] 直行/直帰: `POST/GET /v1/attendance/direct-requests`・`POST /direct-requests/:id/actions`（approved/rejected/withdrawn）。
- [x] 打刻修正を多段承認化（`/decision` = 現ステップ承認者 or 管理者・最終ステップで打刻追記）。承認者解決は稟議 stepApprover と同型 + hr。
- [x] 直行/直帰起因の打刻修正ゲート（`directRequestId` = 承認済み・同日・対象打刻種別を満たすこと。AKO-ATT-005）。
- [x] `attendance-routes` を汎用マスタ登録（registry。/v1/masters/attendance-routes）+ order 重複のサーバー検証。
- [x] 通知は現ステップ承認者へ（経路なしは管理者一斉。補助処理 = 原則4）。統合テスト 3 本（経路なし/経路あり多段/取下げ）。

### 42-4 フロント（デュアルモード。モックの挙動は API と一致）
- [x] shared: 型 + 純関数 `attendance-route.ts`（resolveAttendanceRoute / directKindsOf）+ 単体テスト。SEED_VERSION 13。
- [x] useAttendance: directRequests/attendanceRoutes を追加・submitDirect/decideDirect/approvedDirectFor・requestFix/decideFix を
  経路対応（両モードで canDecide/前進を一致）。useApi に attendanceRoutes を移行済みマスタ登録。
- [x] attendance.vue: 日次タブに「直行/直帰を申請」+ 承認済み日の「出勤/退勤 打刻を申請」導線・申請タブで直行/直帰の承認（多段の途中は
  「次の承認へ進みました」）・**経路設定タブ**（区分ごとの承認ステップの追加/編集/無効化・復元 = 稟議 F-07-5 と同型）。labels 追加。

### 42-5 検証
- [x] api 単体 **187**（attendance-route 5 本）/ api 統合 **202**（直行/直帰の経路なし・多段・取下げの 3 本）/ mockup 単体 155 /
  typecheck（api・mockup）・build 全 green。
- [x] オペレーター確認手順: ①日次タブ「直行/直帰を申請」→ 申請タブで承認 → 承認済み日に「出勤打刻を申請」→ 承認で打刻反映
  ②経路設定タブで direct/fix に承認ステップ（例 manager→hr）を追加 → 申請が多段承認になる（各段の承認者のみ操作可）。

### 42-6 反復レビュー（原則9・1 巡目 = 独立コードレビュアー + システム監査官・いずれも Explore/Opus）
> blocker ゼロ。major/minor を是正。両者が独立に同じ上位 2 件（取下げ UI・経路解決の決定性）を検出。
- [x] **M（原則9.5）: 直行/直帰の取下げが backend/composable/テストに在るが UI 未接続**（誤操作で詰む導線）→ 「自分の申請」表に **取下げボタン**（承認前 = pending/in_review の直行/直帰のみ・確認ダイアログ付き `onWithdraw`）を追加。
- [x] **M（モック/API 乖離・決定性）: `freezeRouteSteps` が `ORDER BY` 無し + 合成 id で resolveAttendanceRoute のタイブレークを破壊**（同区分に同ステップ数の有効経路が 2 つ以上あると API がモックと別経路を凍結し得る）→ **`ORDER BY id` + 実 id を保持**。併せて `approverCandidates` にも `ORDER BY id`、モック `pickApprover` も **id 昇順ソート**して first-match をモック/API で一致させた。
- [x] **m（原則5）: 陳腐化コメント/ヘッダ** → attendance.ts の「承認は管理者のみ」を「現ステップ承認者 or 管理者」へ、ファイルヘッダのエラーコード一覧へ AKO-ATT-005 を追記、「自分の申請」カード説明を実態化。
- [x] **m（表示）: 直行/直帰モーダルのハードコード「出勤/退勤」** → 選択種別に応じた `directUnlockLabel`（directKindsOf → ラベル）へ。
- [x] 是正不要（設計判断として記録）:
  - **管理者・承認者の自己承認を許容**: 経路未設定のフォールバック（管理者単段）で自己申請を承認できないと単独管理者環境でデッドロックする。従来の打刻修正も管理者は自己承認可だったため既存踏襲。一般社員は承認者ロールに解決されないため自己承認は構造的に不可（影響小）。
    > **注（2026-07-30・§43 で失効）:** §43 でロール選択肢を **管理者/人事のみ** に制限したため「一般社員は承認者に解決されない」は設計上も担保（role=一般 は選べない）。役職/個人指定で自己が承認者になり得る点は §43 の設計判断を参照。
  - **PATCH の order 重複チェック省略**: 稟議 workflow-routes と同一挙動（UI は常に order=i+1 を送出＝到達不能）。
- [x] 再検証（是正後）: api 単体 187 / 統合 202 / mockup 単体 155 / typecheck（api・mockup）・build 全 green。
- [x] **2 巡目（是正の再確認・独立エージェント）: 指摘ゼロ**。4 修正すべて正しく、原指摘を解消し、新規欠陥なしを確認（決定性・取下げ UI の表示条件と本人ガード・ドキュメント整合・種別連動ラベル）。情報メモ 1 件（member id が将来 collation 依存文字を採ると `ORDER BY id` と JS `localeCompare` が理論上乖離し得る = 現行 `m-*` 形式では非顕在）。

### 42-7 残課題
- [ ] **打刻修正申請（AttendanceFixRequest）の取下げ**: 直行/直帰には取下げを実装したが、打刻修正には `withdrawn` 状態が無い（本改修以前からの仕様）。原則9.5 の観点で後続改修時に追加を検討（記録として明示）。

## 43. 承認経路の承認者指定を「役職／ロール／個人」へ統一（稟議・勤怠 共通。オペレーター指示 2026-07-30）

> オペレーター指示:「稟議・勤怠管理のワークフローで、承認経路の設定に『役職』『ロール』『個人』のいずれかから
> 選択して設定できるようにする」。承認ステップの承認者指定を PermissionRule.subjectKind（role|title|member）と
> 同じ 3 種モデルへ統一した。migration **0041**。

### 43-1 設計方針
- 旧 `approverRole` 単一プリセット（manager/director/president〔勤怠は+hr〕）を廃し、**`approverType`（title=役職/role=ロール/
  member=個人）+ approverTitle/approverRole(MemberRole)/approverMemberId** の判別式へ。`WorkflowRouteStep` と
  `AttendanceRouteStep` を共通 **`ApprovalRouteStep`** に統合。
- 承認者解決を共有純関数 **`pickApprover`（shared/domain/approver.ts）** に一元化 → 稟議・勤怠・API・モックで同一ロジック
  （役職一致/ロール一致/個人指定 → id 昇順先頭・不在は管理者フォールバック）。既存の重複解決（workflows.ts の
  approverFor/stepApprover・attendance.ts の pickApprover・useWorkflow/useAttendance）を撤去して集約（原則3）。
- **下位互換（原則7・データ更新パッチ）**: `normalizeApproverStep` が旧形式（approverType 無し）を吸収し、
  migration 0041 が既存 steps jsonb を行動保存的に変換（president→役職代表取締役 / director→役職取締役 /
  manager→役職マネージャー / hr→ロール人事 / 個人指定→個人）。**冪等**（approverType を持つ行は非変換）。
  進行中申請の凍結スナップショットは非変換だが `pickApprover` が旧形式も解決するため影響なし。

### 43-2 実装
- [x] shared: `ApproverType` + `ApprovalRouteStep` 統合 + `approver.ts`（pickApprover/normalizeApproverStep）+ 単体テスト 8 本。
- [x] registry: 共通 `approverStepSchema`（type ごとの必須を superRefine）を workflow-routes / attendance-routes に適用。
- [x] migration 0041: 両テーブルの steps を新形式へ変換（一時関数 + 冪等ガード）。
- [x] API: workflows.ts / attendance.ts の承認者解決を共有 `pickApprover` へ集約。
- [x] フロント: 共有コンポーネント **`WidgetsApproverSteps`**（役職/ロール/個人セレクタ + 解決名プレビュー・
  useCodeMaster('title')/MemberRole/メンバーから選択）を 稟議・勤怠 の経路設定で使用。seed を新形式へ（SEED_VERSION 14）。
  labels に `APPROVER_TYPE_LABELS` / `approverTargetLabel`（表示共通化）。

### 43-3 検証
- [x] api 単体 **195**（approver 8 本）/ api 統合 **202**（migration 0041 適用・稟議/勤怠の承認者解決を維持）/
  mockup 単体 155 / typecheck（api・mockup）・build 全 green。
- [x] 下位互換確認: 稟議の既存経路 seed（wr-01..10）は役職ラベルへ移行しても解決メンバーが不変
  （マネージャー=葛西 / 取締役=佐伯 / 代表取締役=山下 / 人事=村瀬）。
  ただし旧 manager/director は「role+employmentType」解決だったのに対し新モデルは「役職(title)一致」解決のため、
  **標準の役職名を用いる環境でのみ解決結果が一致**する（非標準運用は移行後に経路確認が必要 = 0041 ヘッダ + オペレーター確認事項）。

### 43-4 反復レビュー（原則9・1 巡目 = 独立コードレビュアー + システム監査官）
> blocker ゼロ。両者が「移行の行動保存の主張が過大」を検出（監査は INFO・コードレビューは major）+ 監査が「ロール=一般の footgun」を検出。是正:
- [x] **ロール選択肢を 管理者/人事 のみに制限**（一般=任意の一般社員へ解決＝承認者として無意味・自己承認の温床）。UI（ApproverSteps.vue）+ Zod（approverStepSchema の approverRole を `['admin','hr']`）の双方で担保。
- [x] **移行の「行動保存」表現を是正**: 旧 role+employmentType 解決 → 新 役職一致 解決の差異と、非標準役職名環境での確認事項を 0041 ヘッダ・§43-1/§43-3 に明記（原則7 のオペレーター説明）。
- [x] **原則5 全件チェック**: §42 の旧承認者モデル記述（manager/director/president+hr）と「一般社員は承認者に解決されない」不変条件へ §43 への失効注記を追加。
- [x] **straggler 是正**: `mockup/tests/approval-route.test.ts` の旧形状ステップを新形状（役職指定）へ更新。
- [x] 是正不要（設計判断として記録）: 役職/個人指定で自己が承認者になり得る点は稟議の運用上許容（承認者名をプレビュー表示）。approverMemberId/approverTitle の実在チェックは既存 approverMemberId と同様に非強制（不在は管理者フォールバック）。migration のステップ単位ガードは all-or-nothing 変換のため到達不能。
- [x] 再検証（是正後）: api 単体 195 / 統合 202 / mockup 単体 155 / typecheck（api・mockup）・build 全 green。
- [x] **2 巡目（是正の再確認・独立エージェント）: 指摘ゼロ**。5 修正すべて正しく原指摘を解消し、新規欠陥なし・回帰スイープ clean を確認（ロール制限は UI+Zod 双方・migration 本体は無変更で冪等維持・旧形式の凍結スナップショット解決は不変）。

## 44. 項目カスタマイズの全アプリ汎用化（F-31。オペレーター指示 2026-07-30 ①）

> オペレーター指示:「Akebono 業務のセグメントごとの各アプリで、フォーム(管理項目)のカスタマイズが商品と
> 売上明細にしかないため、すべてのアプリに適用して同一の項目カスタマイズエンジンで動作するようにする」。
> 本 PR は Part ①（②取込マッピングは後続 PR）。

### 44-1 現状の課題（探索で判明）
- 項目カスタマイズのエンジンが 2 系統に分裂:（A）`CustomFieldDef`（項目追加。member/company/contact/project 限定）、
  （B）`ItemSetting`（既定項目の表示/ラベル差分。カタログは product/sales_record のみ・管理画面でしか使われず実フォーム未連動）。
- custom 保存列を持つのは Product のみ。他アプリは保存先なし。

### 44-2 実装（統一エンジン）
- [x] 型: `AkebonoEntity`（10 アプリ）を追加し `CustomFieldEntity` を拡張（API/DB の entity は自由文字列 = 型のみ）。
- [x] 既定項目カタログ（ITEM_CATALOG）・ラベルを全 10 アプリへ拡張。
- [x] **`useAppFields`**: 「既定(カタログ+ItemSetting差分)＋カスタム(CustomFieldDef)」を 1 つに束ねる統一解決を新設。
  フォーム/一覧、および後続の取込マッピング右辺の**単一 SoT**。
- [x] 管理画面 `akebono/settings/items.vue`: 全アプリのタブ + 各アプリへ**追加カスタム項目の追加/編集/削除**を実装
  （`useCustomFields` を再利用。原則3）。CRM/HR 側 `settings.vue` は CrmEntity サブセットへ限定。
- [x] 保存基盤（migration 0042）: 全アプリのレコード表へ `custom jsonb DEFAULT '{}'` を追加（列追加のみ = 下位互換）。
- [x] 共有 `WidgetsCustomFields`: entity のカスタム項目を UiSchemaForm で描画し `custom` へ読み書き（各フォームへ 1 行差込）。
- [x] フォーム反映: **商品（products.vue）・売上明細（sales.vue）を接続**（必須チェック含む）。売上は API 側 `sales-records`
  も custom 対応（SR_COLS/INSERT）。統合テストで custom jsonb 往復を検証。

### 44-3 検証
- [x] api 単体 195 / api 統合 202（migration 0042 適用・売上 custom 往復）/ mockup 単体 155 / typecheck（api・mockup）・build 全 green。

### 44-4 本 PR のカバレッジと残作業
- [x] 全 10 アプリ: **項目カスタマイズ設定（既定項目の表示/ラベル/必須 + 追加カスタム項目の定義）が可能**（エンジン+管理画面+保存列）。
- [x] フォーム反映（描画+保存）: **商品・売上明細**を接続済み。
- [ ] 残エンティティ（発注/生産/仕入/入荷/出荷/在庫/請求 ＋ **SKU**）のフォーム反映は同一パターン（`WidgetsCustomFields` 差込 +
  各 API/composable の custom 往復）で順次接続（保存列は 0042 で用意済み）。SKU は商品配下でフォーム導線が別（バリアント・マトリクス）のため、
  SKU カスタム項目の入力導線は商品/SKU 詳細側の別途対応とする。
- [ ] 一覧（UiDataTable）へのカスタム列反映（`appFields(entity,{scope:'list'})` の消費）は未実装（フォーム反映を優先）。

### 44-5 反復レビュー（原則9・1 巡目 = 独立コードレビュアー + システム監査官）
> blocker/major（コードレビュー）ゼロ。監査は blocker ゼロ・major 2（管理画面の文言過大 / Part② のキー空間）。是正:
- [x] **M1（原則5・文言過大）**: 管理画面の説明・保存トーストを「フォーム反映に対応済みのアプリ（現在は商品・売上明細）で表示。一覧・取込は順次」へ是正（実態と一致）。
- [x] **CR-minor（両モード差異）**: 赤黒訂正の相殺行 custom をモックでも `{}` に統一（API の既定 '{}' と一致）。
- [x] **m3/m4（原則5）**: §44-4 の残エンティティに SKU・一覧反映を追記。architecture.md に `useAppFields`・`WidgetsCustomFields` を登録。
- [x] 是正不要（記録）: カスタム項目キー重複防止は `cf.list`（archived 含む）参照＝値保全のため意図的。`appFields` の scope 別可視性は未消費（Part② で消費）。CF_TYPE_LABELS の重複はリポジトリ方針（labels.ts 編集禁止）に沿う。
- [ ] **残課題（軽微・follow-up）**: ①読み取りビュー（商品詳細・売上一覧/詳細）へのカスタム値表示、②一覧列へのカスタム反映、③売上フォームのカスタム必須エラーのインライン表示（現状トースト）。いずれもフォーム入出力は成立済みで、表示面の完全化を後続で行う。
- [x] 再検証（是正後）: api 単体 195 / 統合 202 / mockup 単体 155 / typecheck（api・mockup）・build 全 green。

### 44-6 Part ②（取込マッピング）への申し送り
- **エンティティキー空間の整合（監査 M2）**: 取込の `ImportTargetEntity` は `company` を含むが `AkebonoEntity` には無く `ITEM_CATALOG['company']` も無い。取込右辺を `useAppFields(targetEntity)` で構成する際、`company` は Akebono 側カタログを持たず CRM 側 `company` カスタム項目（別画面 settings.vue 管理）と名前空間が衝突する。Part② 着手時に「company 用の Akebono カタログを追加」または「company 取込は CRM エンティティを明示的に参照」のいずれかを決定・文書化する。

## 45. データ取込・連携の方式別マッピング設定（F-32。オペレーター指示 2026-07-30 ②）

> オペレーター指示:「Akebono 業務のセグメントごとの『データ取込・連携』について、各取込方式ごとのマッピング設定が
> 有効じゃないように見える」。CSV = 何列目↔アプリ項目 / 固定長 = 開始〜終了バイト↔アプリ項目 /
> JSON = キー↔アプリ項目 / API = JSON + エンドポイント・トークン。**左辺 = 取込元・右辺 = そのセグメントアプリの
> 有効項目（既定＋カスタマイズ項目）**。§44（Part ①）の `useAppFields` を右辺の SoT として使う。

### 45-1 現状の課題（探索で判明）
- マッピング編集が方式に依らず「取込元項目（自由文字列）↔対象キー（自由文字列）」の 2 テキスト入力のみで、
  方式別のロケータ（CSV 列番号・固定長バイト範囲・JSON キー）と接続設定（CSV ヘッダ有無/区切り・API エンドポイント/認証）を
  一切保持していなかった（「AI 候補」ボタンはスタブ）。右辺もアプリの有効項目と連動していなかった。

### 45-2 実装（方式別マッピングエンジン）
- [x] 型: `ImportSourceConfig`（hasHeader/delimiter・endpoint/authType/authValue・jsonRootPath）・`ImportAuthType`・
  `ImportFieldMap` へ方式別ロケータ（columnIndex/byteStart/byteEnd/jsonKey）を追加。`ImportSource.config?` を追加。
- [x] 純関数（`shared/domain/import-parse.ts`・単体テスト対象・**フロント/API 共有 = 原則3**）:
  解析 = `parseCsvLine`（クォート/エスケープ対応）・`parseCsvColumns`（ヘッダ有無で列番号＋論理名を抽出）・
  `extractJsonKeys`（配列/単一・rootPath・非オブジェクト/空配列は throw）。
  正規化 = `numOrNull`・`normalizeFieldLocators`（方式別ロケータ）・`normalizeImportSourceConfig`（config を method 別に整形。
  delimiter は単一文字パーサに合わせ 1 文字へ切詰め）。**モック（useAkebonoImports）と API（akebono-imports）が同一関数を使い両モード parity を保証**。
- [x] 保存基盤（migration 0043）: `import_sources.config jsonb DEFAULT '{}'` を追加（列追加のみ = 下位互換）。
  ロケータはマッピングの既存 `fields jsonb` 各要素へ追加のためテーブル変更不要。
- [x] API（`akebono-imports.ts`）: POST /import-sources が config を永続化・**PUT /import-sources/:id/config**（管理者のみ・
  変更キー名を監査 detail に記録〔秘匿値は残さない〕）を新設。`importFieldsOf` は shared `normalizeFieldLocators` でロケータを正規化。
  **`GET /import-sources` は認証情報（config.authValue）を管理者にのみ実値で返し、非管理者にはマスク**（最小権限。参照自体は全員可）。
- [x] composable（`useAkebonoImports`）: `addSource`/`updateSourceConfig` が shared `normalizeImportSourceConfig` で config を整形・
  `saveMapping` が shared `normalizeFieldLocators` でロケータを整形（API と同一 = parity）。`updateSourceConfig(id, config)` を新設（両モード）。
- [x] UI（`akebono/imports.vue`）: マッピングモーダルを**方式別**に刷新。
  - CSV: ヘッダ有無・区切り文字（1 文字）・**ファイル読込→列（列番号＋論理名）を左辺へ自動展開**（取込元の文字コードで復号 = Shift_JIS 対応）。
  - 固定長: 各項目の**開始〜終了バイト**入力（1 始まり・両端含む）。
  - JSON: ルートパス・**貼付 JSON からキーを検出**して左辺へ展開。
  - API: 上記 JSON ＋ エンドポイント・認証方式（なし/Bearer/APIキー/Basic）・トークン値。
  - **右辺 = `useAppFields(targetEntity)` の有効項目（既定＋カスタム。カスタムは「（カスタム）」表記）をセレクトで選択**。
    保存時に方式別ロケータのみ保持（JSON/API は `jsonKey = sourceField`）。設定は SoT（config）→ マッピング新版の順（原則6）。

### 45-3 company 取込のキー空間（§44-6 の決定）
- [x] 監査 M2 の申し送りを解決。`company` は Akebono カタログを持たないため、取込右辺は**CRM 会社の既定項目
  （会社名/区分/業界/メール/電話/住所/備考）＋ CRM 会社カスタム項目**で構成する（管理画面 items.vue に company タブを増設せず、
  既存の CRM 側 `company` 名前空間を明示参照）。他アプリは `appFields(entity)` をそのまま使用。

### 45-4 取消可能性（原則9.5）
- [x] マッピングは**新版で上書き**（旧版は履歴に残り版一覧から追える）。取込元は従来どおり論理削除＋復元。
  config は設定系のため上書き更新（記録系ではない）。上書き時は変更キー名を監査ログに残す（値レベルの追跡性を補完）。

### 45-5 反復レビュー（原則9・独立コードレビュアー + システム監査官）
> blocker ゼロ。指摘（コードレビュー major 1・監査 major 1・minor/nit 複数）を全件是正:
- [x] **監査 M-1（セキュリティ・最小権限）**: 新設した config.authValue（API トークン/資格情報）が `GET /import-sources` で
  全認証ユーザーに実値露出 → **非管理者にはマスク**（管理者のみ実値・編集は管理者専用画面）。統合テストで member マスク/admin 実値を検証。
- [x] **コードレビュー M1（両モード parity）**: モック `saveMapping` がロケータを生値で保存し、`v-model.number` の空入力が `''` として
  残っていた（API は `null`）→ 正規化を shared 純関数へ集約し**モック/API が同一関数**を使う形へ（原則3/6）。単体テストで `'' → null` を固定。
- [x] **minor**: モック config も shared 正規化を適用（method 別 subset を両モード一致）/ delimiter を 1 文字へ（単一文字パーサ整合）/
  CSV 読込を取込元の文字コードで復号（Shift_JIS 文字化け解消）/ config 更新の監査 detail に変更キー名を記録 /
  「AI 候補」旧導線の残存コピー（説明・空状態・コメント・設計書）を解析ベース導線の記述へ更新（原則5）。
- [x] **nit**: 空配列 JSON のエラーメッセージを区別（「レコードがありません」）/ §45-2 の「UiSelect」表記をネイティブ select へ訂正。

### 45-6 検証
- [x] api 単体 **213**（import-parse に 解析＋正規化テストを集約 = CSV 行/列・JSON キー/空配列・numOrNull/normalizeFieldLocators〔`''→null`〕・
  normalizeImportSourceConfig〔method 別/delimiter 1 文字〕。akebono-phase-d に importFieldsOf ロケータ）/
  api 統合 **203**（config の method 別正規化・PUT /config の権限と正規化・**authValue の管理者限定/非管理者マスク**・
  CSV 列/固定長バイト範囲/JSON キーのロケータ往復）/ typecheck（api・mockup）・mockup build 全 green。

### 45-7 本 PR のカバレッジと残作業
- [x] 4 方式すべてで**方式別のマッピング設定 UI・接続/解析設定・右辺のアプリ有効項目連動**が成立。
- [ ] **実ファイルの取込・パース・API 実接続（SSRF 対策付き）**は従来どおり F-32 後続スコープ（本 PR は設定の永続化と
  マッピング編集体験まで。取込実行は決定的シミュレートのまま = §40 の位置づけを踏襲）。マッピングに保持した
  ロケータ・config は後続の実パース実装がそのまま消費できる I/F として定義済み。
- [ ] 後続で扱う軽微事項（実パース実装とセット）: 数値ロケータの範囲検証（byteStart ≤ byteEnd・1 始まり）は本 PR では UI の
  `min=1` のみ（API 未強制）/ ヘッダ無し CSV で手動追加した行は列位置（columnIndex）を持てない（自動検出行のみ位置確定）。

## 46. データ取込画面の応答遅延・無効化タイムアウトの是正（オペレーター報告 2026-07-30）

> 報告:「/akebono/imports で取込元の**登録が異常に遅い**（エラーにはならないが完了が遅い）。**無効化でエラー**が起きる」。

### 46-1 原因（診断）
- **根本原因は Cloud Run の `--min-instances 0`（アイドル時ゼロスケール）**。アイドル後の初回リクエストで
  コンテナ起動 + Node 初期化 + DB プール（RDS への SSL 接続）確立の**コールドスタート遅延**（数秒〜十数秒）が発生する。
  登録は成立するが遅い。無効化（archive）はロジック自体は健全（統合テストで論理削除/復元が green）だが、
  コールドスタート中のインスタンスへ届いた要求がタイムアウト/切断され、ブラウザでネットワーク層失敗
  （"Provisional headers shown" + 赤×）として表面化する。
- 併発要因: pg プールの既定 idle 10s で暖機インスタンス上でも接続が落ち、次要求が SSL 再確立の遅延を払う。

### 46-2 是正
- [x] **Cloud Run `--min-instances` を既定 1 へ**（常時 1 台暖機 = コールドスタート解消）。repository variable
  `CLOUD_RUN_MIN_INSTANCES` で可変（`0` でゼロスケールへ復帰＝コスト優先）。`--cpu-boost` も付与
  （スパイク時の増設インスタンスの起動高速化。CLI フラグは `--cpu-boost`。既存 `--no-cpu-throttling` 併用のため
  暖機インスタンスは CPU 常時割当 = コスト下限が上がる点は deploy-guide §1-4b に明記）。
- [x] **DB プール**（`pool.ts`）: `keepAlive` + `idleTimeoutMillis` 延長（既定 10s→60s）+ `connectionTimeoutMillis`
  15s（無限待ちを避け、滞留は原則4 のとおりエラーで応答）。暖機インスタンス上の接続再確立チャーンを抑制。
- [x] **冪等書込の再試行**（`apiWrite` に opt-in `idempotent`）: ネットワーク層失敗（AKO-GEN-NET = 応答なし）を
  **1 回だけ**再試行。無効化・復元・方式別設定更新（いずれも冪等）に適用し、コールドスタートの一過性失敗を吸収する。
  **非冪等な新規登録（POST）は二重作成の危険があるため再試行しない**。
  - 許容事項（レビュー minor）: 初回が「サーバー確定・応答のみ消失」だった場合、再試行で監査ログ（追記のみ）が
    1 行重複し得る。エンティティ状態は冪等で正しく、監査は追記系のため許容（値レベルの二重排除は過剰と判断）。
- [x] docs: deploy-guide §1-4b（コールドスタート対策・`CLOUD_RUN_MIN_INSTANCES` の可変化・`--no-cpu-throttling` 併用のコスト注記）。

### 46-3 検証
- [x] api 単体 213 / api 統合 203（pool 変更後も green）/ typecheck（api・mockup）・mockup build 全 green。
- [ ] 反映はデプロイ後（main マージ → deploy パイプライン）。コスト最優先なら `CLOUD_RUN_MIN_INSTANCES=0` で従来のゼロスケールへ戻せる。
