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
| 稟議 `/workflow`（旧称: ワークフロー = §36 で改称） | F-07 | ✅ | ✅ ワークフロー接続済み（PR #22）: 申請・経路凍結・承認/却下/差戻し（クレームファースト）・代理承認・承認ログ・通知 + 承認経路マスタ | PR #23 で下書きの可視性を本人と管理者のみに制限（レビュー指摘対応）。§36 で本文を目的/内容へ分割（区分別テンプレート・旧 body は互換表示）。**添付は §48-2 で実ファイル化（workflow_files。従来はファイル名文字列のみ）** |
| シフト表 `/shift` | F-05 | ✅ | ✅ シフト接続済み（PR #23） | 希望・割当の参照は管理者 = 全件 / 本人 = 自分のみのサーバースコープ |
| 意思決定支援 `/decision` | F-02 | ✅ | ✅ 意思決定接続済み（PR #28）: 判断テーマ = 汎用マスタ `/v1/masters/decision-themes`（0011 で mockup seed を移行）・判断ログ = `/v1/decisions/logs`（追記のみ = 記録系保護。テーマ・選択肢・理由をサーバーで強制） | シナリオ予測（決定的線形モデル）は表示射影としてクライアント側に維持（設計判断）。**テーマの作成・編集 UI は §48-3 で新設（/masters/decision-themes。従来はシード 3 テーマ固定）** |
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
| Akebono 記録系（`/akebono/products`・`purchase-orders`・`production`・`inbounds`・`outbounds`・`purchases`・`inventory`・`sales`・`billing`） | F-21〜F-29 | ✅ | ✅ Phase C 接続（§39 = 2026-07-29）: 記録系 15 コレクション = 0032（商品/SKU/画像・発注・生産・入荷・仕入・出荷・在庫台帳・売上明細・請求/支払通知/入金）。実績・台帳は追記のみ + 冪等キー・訂正は赤黒・確定系は赤伝。金額算定は shared/domain/akebono をモックと共有 | 実データのためシードなし（各画面に空状態の登録案内）。データ取込（F-32 `/akebono/imports`）は Phase D で設定・履歴を永続化 → **§48-1 で取込実行も実取込化（シミュレーション廃止）** |

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
- [x] **データ取込の実ファイル取込（F-32 後続）**: → **§48-1 で実装完了（2026-07-30）**。CSV/固定長/JSON のアップロード・パース・マッピング変換適用・API 接続の SSRF 対策・取込からの売上計上（source_kind='import'）まで実装。
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
- [x] **実ファイルの取込・パース・API 実接続（SSRF 対策付き）** → **§48-1 で実装完了（2026-07-30）**。マッピングに保持した
  ロケータ・config をそのまま消費する実パース（shared/domain/import-run）が接続された。
- [x] 軽微事項も §48-1 で解消: バイト範囲検証（1 始まり・byteStart ≤ byteEnd）は抽出時に強制（AKO-IMP-008）/
  ヘッダあり CSV は列位置未設定でもヘッダ名（sourceField 一致）で解決できる。

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

## 47. 顧客ログ（新設メニュー。オペレーター指示 2026-07-30）の完了条件（Definition of Done）

**要件:** 「顧客ログ」メニューを新設し、いつ（何月何日・時刻は任意）どの顧客（会社/人）とどんな会話をしたかを記録する。
このデータは AI の参照対象。閲覧は自分の登録は常に見え、他人の記録の閲覧は権限で許可する。

- [x] データモデル（記録系・C2）: `customer_logs` 0044（memberId=記録者・logDate 必須・logTime 任意・companyId 必須・
  contactId 任意（会社所属を API 層で検証）・title 任意・body 必須・active・created/updated_at）。日報・タスク計画と同じ
  **本人所有・本人のみ操作可**パターン。company_id/contact_id は app_office マスタへの ID 参照。
- [x] API `/v1/customer-logs`（notes/task-plans パターン = 手動バリデーション・監査ログ・FK 23503→400・JST 文字列返却）:
  `GET`（既定=本人。`?memberId=` は canViewMemberCustomerLog で許可された対象者のみ・未許可 403 AKO-PRM-002・自分は常に可。
  `?from=&to=&companyId=&contactId=&includeArchived=1`（取消済みは本人のみ））・`POST`（入力検証 AKO-CLG-001・会社/担当者不整合
  AKO-CLG-003）・`PATCH /:id`（**本人のみ・部分更新 = 送られたキーのみ更新し未指定は現状維持** = CLAUDE.md 部分更新原則）・
  `POST /:id/archive` `/:id/restore`（取消/復元 = 論理削除の対称操作・冪等・本人のみ AKO-CLG-002）。app.ts へ登録・
  PATH_FEATURES に `customer-log`（機能ガード・既定 allow）。
- [x] 可視性（F-16）: 機能キー `customer-log`（FEATURE_PERMISSION_KEYS・featureKeyOfPath の known）+ 参照対象の擬似フィールド
  `customer-log` × `member:<id>`（shared `canViewMemberCustomerLog` = **既定 deny の許可制**・自分は常に可 = AI業務アシスタント
  と同型）。権限設定 UI（ルール一覧 = `customerlog-view` 擬似リソース / 権限表 = viewTargetNodes サブツリー・本人セルは
  自動保護）で付与・剥奪できる。**参照権限は編集権限を与えない**（他人の記録は 403）。
- [x] AI 参照（このデータは AI の参照対象）: search_docs へ `source_kind='customer-log'` を追加（0044 で CHECK 差し替え・
  TITLE_CHECKS・buildSearchDocs のビルドループ = 日時/顧客/担当者/記録者/本文 segments）。**owner_member_id = 記録者 = 本人スコープ**
  （searchDocsFor の allOwners は note 限定のため他メンバーの顧客ログは AI 文脈へ供給しない = 安全側の既定。UI の参照権限とは別軸
  として文書化 = 原則6）。links.companyId でチャットボット文脈の顧客混入防止。書込/取消後に scheduleSearchRebuild。
- [x] 取消可能性（原則9.5）: 取消（archive）/復元（restore）+ 本人編集（監査ログ）。取消済みは本人の折りたたみ一覧から復元。
- [x] 画面: `/customer-log`（ダッシュボード「業務ツール」カード + ヘッダナビ + nav-map）。widget `CustomerLogPanel`
  = 対象メンバー切替（readonly）/ 検索・会社フィルタ / 一覧 → 詳細モーダル / 登録・編集モーダル（担当者は選択会社の連絡先のみ）/
  取消済み復元。モバイルはカード型。デュアルモード（API = /v1/customer-logs / モック = customerLogs コレクション + デモシード）。
- [x] 検証: api 単体 222（顧客ログ参照権限 7 = 既定 deny・自分常時可・allow 付与・member:* 一括・レイヤ/deny 優先）/
  api 統合 208（登録検証・本人スコープ・部分更新の項目保持・取消/復元冪等・参照権限マトリクス = HR 403→allow で 200・編集は依然 403）/
  mockup 単体 155 / typecheck（api・mockup）全 green。
- [x] docs（原則5）: data-design（CustomerLog エンティティ・SearchDoc sourceKind・PermissionRule 擬似フィールド）・
  api-design（useCustomerLogs 契約・AKO-CLG-001/002/003）・screen-design（サイトマップ + 画面定義）を更新。

## 48. モック残存・非永続 5 件の本実装（監査指摘 2026-07-30 = オペレーター指示）

> 独立監査（2026-07-30。composable 全 54 本・全 64 ページ・API ルート走査）で挙がった
> 「モックアップ実装・データが永続化されない機能」5 件の本実装。①データ取込の実行（完全シミュレーション）
> ②稟議添付（ファイル名文字列のみ）③意思決定支援の分析コンテンツ（静的シード・テーマ編集 UI なし）
> ④チャットボット初回送信失敗時の履歴消失 ⑤日報ドラフトのフォールバックがモックシード参照。

### 48-1 ①データ取込の実行を実取込へ（F-32 後続の本実装）
- [x] **取込内容の取得**: ファイル方式（file_csv/file_fixed/file_json）= `POST /v1/akebono/import-runs` が `contentBase64`（10MB 上限）を受領し encoding（utf8/sjis = ICU TextDecoder）で復号。API 方式（api_pull）= **SSRF ガード付き pull**（`api/src/lib/safe-fetch.ts` = https のみ・プライベート/ループバック/リンクローカル/メタデータ（169.254.169.254）等の内部レンジを**接続前に**拒否・検証済みアドレスで接続する自前 lookup = DNS リバインディング防止・リダイレクト不追跡・30 秒タイムアウト・10MB 上限。認証は config の authType/authValue = bearer/api_key/basic をヘッダへ）
- [x] **レコード抽出**: `shared/domain/import-run.ts`（純粋関数・単体テスト対象）= CSV（列番号 or ヘッダ名解決・引用対応）/ 固定長（1 始まり両端含む**バイト範囲**スライス = Shift_JIS の全角対応）/ JSON（ルートパス・ドットパスキー）+ transform（trim/number/date/upper/lower）。上限 5000 行（AKO-IMP-006）
- [x] **対象別の反映（検証 → 反映を同一トランザクション・取込元単位の advisory lock で直列化）**:
  - product = (segment, code) upsert（参照 = セグメント/カテゴリ/仕入先/税区分/単位を id or 有効行名称で解決・未解決は隔離・**空セルは既存値を保持**・新規は既定 SKU 同時生成 = POST /products と同型・custom.* は custom jsonb へマージ）
  - sku = SKU コード一致の更新のみ（親商品を表現できないため新規作成は対象外と明記。→ **§58 のバリアント軸取込
    （product_variant）がグルーピングキーで親商品を表現し、商品＋SKU の同時取込に対応**（2026-08-07））
  - company = 会社名完全一致 upsert（業界解決・同名複数は隔離）
  - sales_record = `source_ref` = **行フィンガープリント（sha256）で冪等追記**（0046 部分一意 INDEX + ON CONFLICT DO NOTHING → 再実行は skipped = 売上の二重計上なし）。原価・課金区分は SKU/商品から解決（POST /sales-records と同一）
  - inventory = adjust/棚卸のみ受理し `ref_line_id` = フィンガープリントで台帳へ冪等追記（既存 UNIQUE(ref_type, ref_line_id, kind) を再利用）
- [x] **エラー行隔離**: 行単位 SAVEPOINT（rowWrite）で一意制約衝突等も当該行のみ隔離し残りを反映（原則4）。errors は 50 件まで記録。counts = staged/applied/skipped/failed・全滅時のみ status='failed'
- [x] フロント: imports.vue に実行用ファイル選択（API モード × ファイル方式で必須・10MB 検査・取込元切替でクリア）+ 実行結果トースト（反映/スキップ/隔離の内訳）+ 注記を実態へ更新（モックモード = シミュレートのままを明示）。useAkebonoImports.runImport(sourceId, file) 化 + 反映先コレクション（products/salesRecords 等）の再ロード（原則6）。company 取込の項目候補を companies マスタの実項目（size/location/description）へ是正（旧 email/phone は実列がなく反映不能だった）
- [x] simulateRun（決定的シミュレート）は API から撤去（モックモードのシミュレートは維持 = デモ導線）
- [ ] **残課題（原則9.5 の記録 = 取込の一括取消）**: akebono-menu-design 決定 #9（旧値 JSON の保全 → 一括復元・赤黒一括生成）と
  決定 #14（アップロード原本の GCS 保全）は未実装。反映済みデータの是正は当面、各アプリの既存フロー
  （商品/取引先/SKU = 編集・無効化 / 売上 = 赤黒訂正 / 在庫 = adjust）で個別に行う（akebono-imports.ts ヘッダに明記）。
  なお売上・在庫は冪等キーにより再実行での二重反映はない

### 48-2 ②稟議添付の実ファイル化
- [x] `workflow_files`（0045。bytea = ai_task_files と同型・10MB・5 件/申請）。draft/submit が `files`（base64 新規）+ `keepFileIds`（既存維持）を受領し**差分同期**（トランザクション内で SoT 書込 → attachments 表示名一覧を合成 = 原則6。名前のみ旧データ・旧クライアントは互換 = 原則7）。形式 allowlist（.md/.txt/.csv/.pdf/.docx/.xlsx/.pptx/.jpg/.png = AKO-WFL-004）
- [x] `GET /v1/workflows/:id/files`（メタ一覧）+ `GET /v1/workflows/:id/files/:fileId`（base64 原本 DL）。可視性 = 申請一覧と同一（下書きは本人と管理者のみ 404）
- [x] workflow.vue: 手打ちファイル名入力 → **ファイル選択**へ置換（API = 実体保管・詳細ドロワーからダウンロード / モック = 名前のみ登録をヒントに明示 = ドキュメント管理と同方針）。編集時は既存添付の取り外し（keepFileIds）に対応

### 48-3 ③意思決定支援テーマの管理 UI
- [x] `/masters/decision-themes` 新設（管理者専用・MasterShell 準拠）: テーマの作成・編集・無効化/復元。①意味（key/value）②関係（リンク）③制約と打ち手（✓/△/✗ + 選択肢への昇格）・選択肢 A/B/C（★推奨・予測・根拠）・推奨理由・シナリオ比較パラメータの全項目を編集可能。書込は既存の汎用マスタ CRUD（`/v1/masters/decision-themes`）を再利用（原則3 = API 追加なし）
- [x] マスタメンテナンスのカード + 意思決定支援ページの「テーマを管理」導線（管理者）。DecisionTheme 型へ active? を追加
- [x] 既知の制約（変更なし・明記）: シナリオ予測の係数はテーマ固有ロジック（dt-01〜03）のため、新規テーマは汎用線形式で予測される（ページ説明に明示。実データ接続は将来課題）

### 48-4 ④チャットボット初回送信失敗時の履歴消失
- [x] `POST /v1/chatbot/sessions`（明示作成）+ `POST /sessions/:id/messages` に `role: 'user'` を追加（不正 role は assistant へ倒す）
- [x] useChatbot.send の回復経路: /ask 不達（通信断・コールドスタート等）でセッション未確定のとき、セッションを明示作成 → 質問（role=user）→ フォールバック応答を追記（履歴の忠実性）。これも失敗する完全な通信断はメモリ表示のみで継続（非ブロッキング = 原則4）

### 48-5 ⑤日報ドラフトフォールバックのモックシード混入
- [x] useReportAssist.generateDraft のフォールバック材料を `tbl('notes')` / `tbl('taskPlans')`（未移行コレクション = API モードではモックシード）から **useNotes('poipoi') / useTaskPlans().plansOf**（モード対応済みの API キャッシュ）へ置換。API 断時に実在しないシードのタスク・ポストがドラフトへ混入し、気付かず提出すると虚偽内容が日報として永続化される問題の是正（事実を作らない）
- [x] あわせて useReports ヘッダの陳腐化コメント（「提出時エスカレーションは未発火」= バッチ3a で解消済み）を是正

### 48-6 検証
- [x] api 単体 **238**（import-run 抽出/変換/復号 12 件 + safe-fetch SSRF 判定 7 件を新設・simulateRun テストを置換）/ api 統合 **214**（実取込 4 スイート = 商品 CSV upsert・売上 JSON 冪等〔同一内容行の序数含む〕・SSRF ガード〔IPv4/IPv6 リテラル〕・無効取込元 409 / 稟議添付 1 スイート = 保存・DL・差分同期・可視性・旧クライアント互換 / チャットボット回復経路 1 スイート）/ mockup 単体 **155** / typecheck（api・mockup）・build 全 green
- [x] オペレーター確認手順（API モード）:
  1. `/akebono/imports` で商品 CSV の取込元 + マッピング（列番号 or ヘッダ名）→ ファイルを選択 → 実行 → `/akebono/products` に実データが登録・同一ファイル再実行で二重登録なし
  2. `/workflow` で申請にファイルを添付 → 提出 → 承認者が詳細ドロワーからダウンロードできる
  3. `/masters/decision-themes` でテーマを新規作成 → `/decision` に表示され判断を記録できる
  4. 機内モード等で `/support/chatbot` の新規会話へ送信 → 復帰後にセッション履歴へ質問と応答が残る（回復経路が動いた場合）

### 48-8 反復レビュー（原則9・1 巡目 = 独立コードレビュアー + システム監査官。CRITICAL 0・MAJOR 計 5〔重複 1〕→ 全件対応）
- [x] **CR-M1（SSRF・IPv6 リテラルバイパス）**: `https://[::1]/` 等は URL.hostname が角括弧付きで isIP=0 となり事前チェックを素通り + https.request は IP リテラルに lookup を呼ばない → **角括弧を剥がして両ファミリで接続前判定** + v4 射影の 16 進表記（`::ffff:7f00:1`）の再検査 + NAT64/Teredo レンジ追加。単体 7 件 + 統合（[::1]）の回帰テストを新設
- [x] **CR-M2（売上 amount の numeric(14,2) あふれで取込全体が 500）**: 金額（数量 × 単価）上限を検証で隔離 + 商品/SKU 価格にも範囲検証を追加
- [x] **CR-M3 / 監査-MINOR-5（稟議編集の添付全消去リスク）**: 既存添付一覧の遅延ロード未完了/失敗中に保存すると keepFileIds が空扱いで既存添付を全削除し得た → openEdit で**確定ロード**（loadFiles）し、未確定の間は files/keepFileIds を送らない（サーバーの「未指定 = 実体に触れない」下位互換経路へ倒す）+ 取得失敗は警告表示・添付編集を無効化
- [x] **監査-MAJOR-1（§42 重複採番・挿入位置）**: 新設セクションを §48 へ再採番し文書末尾へ移動・相互参照 4 箇所を追随
- [x] **監査-MAJOR-2（useReports コメント是正の未実施チェック）**: useReports.ts ヘッダの陳腐化 2 箇所（提出済み編集不可・エスカレーション未発火）を実際に是正
- [x] **監査-MAJOR-3 / CR-m1（隔離が product のみ）**: sku/company/sales/inventory の書込も行単位 SAVEPOINT（rowWrite）で包み、在庫の発生日は YYYY-MM-DD を検証で隔離（不正日付 1 行で取込全滅する経路を排除）
- [x] **監査-MINOR-6（既存セッションの /ask 不達で質問消失）**: AKO-GEN-NET（応答なし）のときのみ role=user で質問を追記（応答ありの 5xx は /ask が質問を永続化済みのため追記しない = 重複最小化。トレードオフをコメントに明記）
- [x] **監査-MINOR-7（ファイル内の正当な同一内容行が skipped に収束）**: フィンガープリントへ出現序数を追加（再実行では序数も再現される = 冪等維持。統合テストで同一内容 2 行 → 2 件反映 → 再実行スキップを検証）
- [x] 監査-MINOR-1〜4・8 / CR-n1（陳腐化コメント・akebono-menu-design/§45-7 の旧記述・F-32-5 取消の乖離記録・data-design 表列数・同名チップの二重削除）: 全件是正
- [x] 受容（対応せず記録）: CR-m2/NIT-2 = skipped 行でも SR 採番が飛ぶ（記番ギャップのみ・機能影響なし）/ CR-n2 = /ask 受理済み + 応答喪失時の回復経路でセッションが二重化し得る（データ破壊なし・履歴の冗長のみ）
- [x] 再検証（是正後）: api 単体 238 / api 統合 214 / mockup 単体 155 / typecheck（api・mockup）・build 全 green

## 49. 日報・週報の既読管理 + 日報フォーム改修 + 顧客ログ項目拡張（オペレーター指示 2026-07-31）

**要件:** ①「全員の日報」「全員の週報」の既読/未読管理（必ず永続化）と可視化 ②日報登録フォームの「進捗」非表示
③日報フォーム最下部にぽいぽいポスト登録（同一経路・入力があれば同時登録・空欄スキップ）
④顧客ログ: 属性タグ / 開始・終了時刻（分は 15 分単位から選択）/ 自社担当者（既定 = ログインユーザー）/
会社・担当者のコンボボックス（未登録は新規マスタ登録して反映）/ 会話内容を担当者メモ・議事録メモへ分割。

### 49-1 日報・週報の既読/未読管理（永続化 + 可視化）
- [x] DB（0047）: `report_reads`（member_id × report_kind('daily'/'weekly') × report_id = PK・read_at）。**SoT = 本テーブル（必ず永続化の要件）**。
  read_at は初回既読時刻を保持（再読は ON CONFLICT DO NOTHING = 原則2）。未読へ戻すは物理削除（閲覧状態のため = 原則9.5 の取消フロー）。
  report_id は 2 親（daily/weekly）を kind で切替参照するため FK なし = API 層が対象の存在・参照可否を検証してから INSERT。
- [x] API `/v1/reports/reads`: `GET ?kind=daily&month=` / `?kind=weekly&weekStart=`（本人の既読 id 一覧。期間必須 = 全履歴ダンプ不可）・
  `PUT {kind, reportId}`（既読化。対象ガード = 日報はコメントスレッドと同一（他人の下書き 404・F-16-6 deny 404 = 存在秘匿）/
  週報は本人 or 提出済み + F-16-6）・`DELETE /reads/:kind/:reportId`（未読へ戻す・冪等）。
- [x] フロント（useReports + reports.vue）: 全員の日報（月単位）・全員の週報（週単位）と同じ粒度の遅延ロードキャッシュ。
  未読バッジ（一覧行）+ 未読件数（フィルタバー）+ 「未読のみ」トグルで可視化。詳細ドロワーを開くと自動既読
  （他人の提出済みのみ。チーム・タイムライン経由でも一貫 = drawerId の watch で実装）・ドロワー内「未読に戻す」。
  自分のレポートは既読管理の対象外。既読付けの API 失敗は非ブロッキング（原則4・次回ロードで自己修復）。
  モックモード = reportReads コレクション（localStorage 永続化 = モックの規約どおり）。

### 49-2 日報登録フォームの改修
- [x] 「進捗」列を入力フォームから非表示（テーブルヘッダ・入力セルを撤去）。**既存データの進捗値は編集・保存でも保持**され、
  参照表示（提出済み表示・詳細ドロワー）には従来どおり表示（原則7 = 既存データ・参照 UI は不変）。
- [x] ぽいぽいポスト欄をフォーム最下部へ追加: 入力があると日報の下書き保存・提出・提出済み更新の**成立時**に
  トップメニューのぽいぽいポストと**同一経路（useNotes('poipoi').add = モック/API 両対応）**で登録・空欄はスキップ。
  登録成功で欄をクリア（再保存でも二重登録しない = 冪等）・失敗は警告のみで日報フローを止めない（原則4）。
  日付・ユーザー切替で欄をクリア（別日の日報への持ち越し防止）。

### 49-3 顧客ログの項目拡張
- [x] DB（0047）: `end_time`（終了時刻）・`tags`（jsonb 属性タグ）・`staff_member_id`（自社担当者 = members FK。
  **既存行は member_id でバックフィル + NOT NULL 化 = 原則7 のデータ更新パッチ**）・`minutes_memo`（議事録メモ。**→ §55 で廃止（migration 0050・2026-08-03）**）。
  旧 `body` は「担当者メモ」として意味を引き継ぐ（列名・既存データ不変 = 下位互換）。
- [x] API/モック検証（パリティ維持）: 開始/終了時刻（HH:MM・終了は開始必須 + 開始より後。**15 分単位は UI の選択肢制約**
  = 旧データの単位外時刻を API が拒否しない下位互換の設計判断）・タグ（trim・30cp cap・重複除去・最大 10 件 =
  shared `CUSTOMER_LOG_TAG_PRESETS`/`CUSTOMER_LOG_TAGS_MAX` が SoT）・担当者メモ/議事録メモのどちらか必須・
  staffMemberId 未指定はログインユーザー。PATCH は新項目も「送られたキーのみ更新」（CLAUDE.md 部分更新原則 + 回帰テスト）。
- [x] コンボボックス + 新規マスタ登録: `newCompanyName`/`newContactName` を受け、未登録名なら **同一トランザクションで**
  companies（kind='customer'）/contacts へ新規登録してログへ反映（失敗時はロールバック = 孤児マスタなし・原則6）。
  正規化名（shared name-match = 法人格・空白ゆらぎ除去）の完全一致は既存へ名寄せ = 重複マスタを作らない。
  新規登録は監査ログ（companies/contacts create）。**一般メンバーでもこの経路ではマスタ登録可**（汎用マスタ CRUD の
  管理者限定とは別経路 = 顧客ログ記録に必要な範囲のみ）。モックモードも同一規則（照合 → 検証 → 作成の順で原子性を担保）。
  フロントは書込後に companies/contacts キャッシュを再取得（SoT → キャッシュ・原則6）。
- [x] UI（CustomerLogPanel）: 開始/終了時刻 = 15 分単位セレクト（旧データの単位外時刻は編集時のみ選択肢へ補完 = 原則7）・
  属性タグ = プリセットチップ + 自由入力追加・会社/担当者 = 新設 `UiCombobox`（単一選択 + 自由入力。開閉方向ロジックは
  UiMultiCombobox と `useDropdownDirection` へ共通化 = 原則3）・自社担当者セレクト（既定 = ログインユーザー）・
  担当者メモ/議事録メモの 2 欄。一覧 = タグチップ・時間帯表示・両メモ横断検索。詳細 = タグ・自社担当・メモ区分表示。
- [x] AI 参照（search-index）: segments へ属性タグ・自社担当者・議事録メモを追加・日時は開始〜終了表示。本人スコープは不変。
- [x] モックシード: customerLogs へ新項目を反映・reportReads 追加（SEED_VERSION 15 → 16）。

### 49-4 検証
- [x] api 単体 **251**（+13 = shared 顧客ログ検証の単体テスト新設 = 49-5 R1 対応）/ **api 統合 221**（顧客ログ: 項目拡張 検証・
  部分更新の新項目保持・コンボボックス新規登録/名寄せ〔正規化名・aliases〕/PATCH 経路 = 3 スイート新設。
  既読管理: 期間必須（実在日検証含む）・冪等（read_at 不変）・未読戻し・404 秘匿（下書き・F-16-6 deny・クロス kind）= 4 スイート新設）/
  mockup 単体 155 / typecheck（api・mockup）全 green。
- [x] docs（原則5）: functional-requirements（F-06-1/9/11 更新・**F-18 顧客ログを新設** = R1 監査 MAJOR-1）・
  data-design（CustomerLog 拡張・ReportRead 新設 + §1.2 例外注記）・api-design（useCustomerLogs / useReports 契約・AKO-CLG-001）・
  screen-design（/reports・/customer-log）・mockup/CONVENTIONS.md（UiCombobox / useDropdownDirection 在庫）・本ファイルを更新。

### 49-5 反復レビュー（原則9・1 巡目 = 独立コードレビュアー + システム監査官。CRITICAL 0・MAJOR 計 3〔重複 1〕→ 全件対応）
- [x] **CR-M1（UiCombobox の Enter が無関係な先頭候補を選択）**: 完全一致入力・選択済み・空入力での Enter が
  「全候補表示の先頭」へ選択を差し替え得た → Enter の優先順を「①完全一致を選択 ②選択済み/空入力は閉じるだけ
  ③絞り込み一致の先頭を選択 ④一致なしは自由入力として確定」へ再設計（選択対象は表示用でなく検索文字列そのままの絞り込み結果）。
- [x] **CR-m1（同名同時登録で重複マスタ）**: 「照合 → INSERT」を正規化名単位の pg_advisory_xact_lock で直列化
  （後着はロック待ち → 再照合で既存へ名寄せ。ロックはトランザクション終了で自動解放・hashtext 衝突は無害な直列化のみ）。
- [x] **CR-m2 / 検証順パリティ CR-n1・n-2（モック/API の検証割れ）**: 検証ロジック・メッセージ・順序を
  **shared/domain/customer-log へ集約（パリティの SoT・原則3）**し、API・モックとも同一関数を同一順で適用。
  法人格のみの会社名（「株式会社」等 = 正規化で空）は両モードで拒否・担当者不整合は存在→所属の順で判定。
  単体テスト 13 件を新設（api/test/unit/customer-log-validate.test.ts）。
- [x] **CR-m3（編集オープン時に担当者リンクが黙って消える）**: openCreate/openEdit の一括代入で companyId watch が発火し、
  無効化済み担当者・contacts 未ロード時に contactId をクリアしていた → フォーム復元中フラグ（fillForm）で
  「ユーザーが会社を変更したとき」だけクリアが働くよう抑止。
- [x] **CR-n4（タグ上限の UI 事前ガード漏れ）**: プリセットトグルも共通ガード（applyTags）経由にし、上限超過は保存前に警告。
- [x] **監査 MAJOR-1（phase3 機能要求の未更新）**: F-06-1（進捗の入力非表示・ぽいぽいポスト欄）・F-06-9/F-06-11（既読管理）を更新し、
  欠落していた顧客ログの機能要求 **F-18（F-18-1〜3）を新設**。
- [x] **監査 MINOR-1（CONVENTIONS の UI 在庫）**: UiCombobox 行を追加・UiMultiCombobox 行へ useDropdownDirection 共通化を注記。
- [x] **監査 MINOR-2（検証漏れ）**: aliases 名寄せ・法人格のみ名の拒否・クロス kind 既読拒否を統合テストへ追加
  （weekStart 実在日の統合テストは機能実装コミット側で追加済みであることを確認 = 2 巡目監査 MINOR-1 で記録を訂正）。
  shared 検証の単体 13 件で API/モックのパリティを構造的に固定。
- [x] **監査 NIT-2（data-design の配置）**: §1.2 見出し直下に ReportRead の例外注記（閲覧状態 = 追記のみ原則の対象外）を追加。
- [x] **残課題（原則9.5 = 監査 MAJOR-2 / CR-m4）**: コンボボックス経由で新規登録された companies/contacts マスタの
  **作成者本人による取消導線は未実装**。現状の回復経路 = 管理者が /masters から無効化（論理削除・復元あり）+
  作成は監査ログで追跡可能。誤登録リスクは「正規化名の名寄せ + 法人格のみ名の拒否 + 保存前の未登録ヒント表示」で低減済み。
  本人 undo（作成直後の取消・未参照マスタの自動無効化等）は顧客ログ改修時に対応する（宣言だけで実態が伴わない状態を作らない
  ための明示記録 = 原則9.5 の残課題運用）。
- [x] 受容（対応せず記録）: CR-n3 = 既読キャッシュの取得中に「未読に戻す」を行うと一時的に既読表示へ戻り得る
  （SoT は正しく削除済み・次回ロードで自己修復。コードコメントに設計判断を明記）/ CR-NIT-1 = UiCombobox と UiMultiCombobox の
  フィルタ・キー処理の類似実装（開閉方向は共通化済み。自由入力の有無という要件差で別部品を維持・将来の統合候補として記録）/
  監査 MINOR-2 の一部 = 0047 バックフィルの「既存行あり状態」のマイグレーションテスト（統合テストは空 DB 起点のため未通過。
  バックフィルは単純な UPDATE + SET NOT NULL でレビュー確認済み = 設計判断）・ぽいぽい同時登録のフロント自動テスト
  （リポジトリにコンポーネントテスト基盤がなく、経路は既存の useNotes('poipoi').add = notes API の統合テスト済み経路。
  フォーム側は「成立時のみ・成功でクリア・失敗警告」の 3 分岐のみ = 手動確認 + レビューで担保する設計判断）。
- [x] 再検証（是正後）: api 単体 251 / api 統合 221 / mockup 単体 155 / typecheck（api・mockup）全 green。

### 49-6 反復レビュー（原則9・2 巡目。CRITICAL/MAJOR 0・MINOR 計 2・NIT 計 5 → 全件対応/受容記録）
- [x] **監査（2 巡目）**: 1 巡目是正の実質確認（テスト件数の実測一致・F-18 と実装の突合・残課題/受容記録の妥当性）= 形骸化なし。
  - MINOR（§49-5 の記録誤り = weekStart 実在日テストを是正コミットの追加と誤記）→ 記録を事実（機能実装コミットで追加済み）へ訂正
  - NIT（実在日判定の重複 = 原則3）→ `isRealDateKey` を shared/domain/jst へ移設（customer-log は再エクスポートで互換維持）し、
    reports.ts の 2 箇所（/reads weekStart・validWeekStart）を共通判定へ置換
  - NIT（api-design に検証パリティ SoT の記載なし）→ useCustomerLogs 行へ `shared/domain/customer-log` を SoT として明記
- [x] **コードレビュー（2 巡目）**: 1 巡目是正 5 件すべて解消を確認（Enter 優先順・advisory lock の順序一貫性 = デッドロック構成不能・
  shared 集約の挙動不変・fillForm の flush タイミング・applyTags）。
  - MINOR-1（PATCH の検証順が shared 宣言順と乖離 = tags parse が時刻範囲検証より先に throw）→ フィールドを宣言順に逐次解決する形へ
    並べ替え（範囲 → タグ）+ 「範囲・タグ同時不正は範囲エラーが先」の回帰テストを統合テストへ追加
  - NIT-1（advisory lock のハッシュ）→ 既存パターン（akebono-trade/billing）と同じ 64bit `hashtextextended($1, 0)` へ統一
  - NIT-2（会社名検証が未 cap 名で行われ長大名がすり抜け）→ customerLogCompanyError を NAME_CAP 切り詰め後の名で判定 + 単体テスト追加
  - NIT-3（自由入力ヒントと Enter 挙動の不一致）→ 部分一致候補がある間は「Enter は絞り込み候補の先頭を選択」の説明をヒントへ追加
  - NIT-5（タグ 30cp 超の無警告切り詰め）→ addTag で 1 タグの文字数上限も保存前に警告
- [x] 受容（対応せず記録）: CR NIT-4 = 候補リストの aria-activedescendant によるキーボードナビゲーション未実装
  （既存 UiMultiCombobox と同一パターン = 回帰ではない。Tab でリスト内ボタンへ到達可能。将来の a11y 改善候補として記録）。
- [x] 再検証（2 巡目是正後）: api 単体 252 / api 統合 221 / mockup 単体 155 / typecheck（api・mockup）全 green。

## 50. メディア分析の独立チャンネル化 + 任意の業態連携 + 外部投稿記事（オペレーター指示 2026-08-03）の完了条件（Definition of Done）

メディア分析を「事業セグメント（業態）と 1:1 結合」から「**独立したメディアチャンネル + 任意の Akebono
業務アプリ（業態）連携**」へ両モード（mockup + API）で移行した。連携は必須でなく、未連携（単体）でも
分析・記事生成・単体 AI インサイトが動く。業務 × メディアの統合 PDCA は連携済みチャンネルでのみ利用可能。
外部で投稿した記事原文を保管し media インサイト生成の材料に活用する機能を追加した。

- [x] **DB 移行（migration 0048_media_channels.sql・低リスク・データ移動最小化）**:
  - `media_channels`（旧 media_settings を置換・拡張。name・segment_id NULL 可・site/AI 設定。GA は media_ga_tokens が SoT のまま）を新設
  - **backfill: 旧 media_settings 1 行 → channel 1 件。channel.id = 旧 segment_id 値そのもの**（child の segment_id 値がそのまま channel_id として有効 = child 行の UPDATE 不要）。name = coalesce(nullif(site_name,''), business_segments.name, '無題メディア')・segment_id = 旧 segment_id（連携済み）
  - child 7 テーブル（media_ga_tokens/oauth_states/metrics_cache/articles/article_briefs/generated_articles/insights）は `RENAME COLUMN segment_id TO channel_id`（索引名も命名整合で rename）
  - `media_external_articles`（外部投稿記事の原文。channel_id・title・body 必須・論理削除）を新設
  - DROP TABLE media_settings（データは移設済み）。全操作 IF NOT EXISTS / IF EXISTS / information_schema ガードで冪等
- [x] **shared/domain/media-*.ts は不変**（純ロジックは opaque id 扱い。media スコープは channelId、integrated スコープは連携先 segmentId を渡す）。shared のテスト（mockup media-* / api unit media 系）は無変更で green
- [x] **API（api/src/routes/media.ts）**: 全 segmentId → channelId re-key（segmentIdOf → channelIdOf）。新エンドポイント = チャンネル CRUD（GET/POST /channels・PUT/PATCH /:id・/:id/archive|restore）・外部記事 CRUD（GET/POST /external-articles・PATCH /:id・/:id/archive|restore）。設定/GA/記事/生成/インサイトは channelId keying。integrated は連携必須（channel.segmentId null は AKO-MEDIA-022）。media インサイト生成に外部記事原文を材料反映（LLM プロンプト + heuristic 両経路に applyExternalMaterial）。F-41 ダッシュボードは buildSegmentIntegratedMetrics（業態基点で連携チャンネルを解決）へ切替
- [x] **新エラーコード**: AKO-MEDIA-020（チャンネル名必須）/ 021（対象チャンネルなし）/ 022（統合には連携業態が必要）/ 023（外部記事の入力不正）/ 024（対象外部記事なし）。既存 003/004/005/006/007/008/011/012/014 と重複なし・016 は欠番のまま
- [x] **mockup**: types（MediaSetting → MediaChannel・child は channelId・MediaExternalArticle 新設）・seed（mediaChannels = 各業態連携 4 + 単体 mc-note・外部記事シード）・MockDbShape 更新・SEED_VERSION 16 → 17。composables = useMediaSettings → useMediaChannels（チャンネル CRUD + 設定 + GA）・useCurrentChannel（新設。mock localStorage 'ako.currentChannel.v1' / API pref 'currentChannelId'）・useMediaExternalArticles（新設）・analytics/articles/insight を channelId へ。components = MediaSegmentBar → MediaChannelBar・MediaGaConnect を channelId へ。pages = index（チャンネルハブ + 追加）・analytics（PDCA は連携時のみ・未連携は案内）・settings（チャンネル選択/追加/取消復元 + 連携業態選択（任意）+ AI 設定 + 外部記事管理）・akebono/dashboard は useMediaChannels へ
- [x] **メニュー**: menu-registry の MENU_CARDS.dashboard に media カード追加（featureToggle:'media' = 既存トグル）・DEFAULT_MENU_CATEGORIES の 'insights'（経営・状況）へ 'media' 追加。AKEBONO_APP_CATALOG から media 撤去（トップメニュー化。AKEBONO_APP_KEYS には下位互換で残置 = 既存 app-configs 保護）。nav-map の /media を HOME 直下へ移動
- [x] **下位互換（原則7）**: channel.id = 旧 segment_id の backfill により child 行の segment_id 値がそのまま channel_id として解決（0048 で child 行の値変更なし）。統合テストで「channel.id = 旧 segment_id 値のチャンネル + その値を channel_id に持つ子行が解決する」ことを検証。既存 app-configs の 'media' キー・プリセット件数は無変更
- [x] **検証（実測値）**:
  - `cd api && npx tsc --noEmit` green / `cd mockup && npm run typecheck` green
  - `cd api && npm test`（unit）: **259 passed**（旧 252 + 外部記事の純関数テスト 7 = externalArticleInputOf・externalMaterialOf・applyExternalMaterial・settingsPatchOf の name/segmentId）
  - `cd api && npm run test:integration`（実 PostgreSQL・0048 適用込み）: **225 passed**（メディア F-40 describe を新チャンネル API 形へ更新 = チャンネル CRUD・単体チャンネルの記事生成・連携チャンネルの integrated・単体は 022・external-articles CRUD・下位互換・チャンネル取消/復元。akebono-dashboard/billing/sales の integrated 参照を channelId へ更新）
  - `cd mockup && npm test`: **155 passed**（既存 shared 純ロジックテストは無変更）
- [x] **既知の未検証（GA/Vertex はこの環境で E2E 検証不可）**: GA OAuth トークン交換・GA4 Data/Admin API 呼び出し・Vertex 生成はコード整合とユニット/統合（非 GA 経路・LLM 無効 = 決定的フォールバック）で担保。外部記事のインサイト材料反映は unit（applyExternalMaterial）で検証（統合は GA 未設定のため media インサイト生成が 005 = 生成経路は通せない）

### 50-x 反復レビュー（原則9・1 巡目 = 独立コードレビュアー + システム監査官。CRITICAL 0・MAJOR 3〔重複 1〕・MINOR 3・NIT → 全件対応/受容）
- [x] **MAJOR（要件(d)の「AI活用」がモードで欠落 = 監査 MAJOR-2 / CR m-2）**: 外部投稿記事のインサイト材料化
  （externalMaterialOf / applyExternalMaterial）を **shared/domain/media-insight へ移設**し、API とモック
  （useMediaInsight の mock generateMedia）で同一ロジックを適用（原則3・両モードパリティ）。api/routes/media は再エクスポートで
  既存 import 互換維持。mockup 単体テストを 2 件追加（外部材料の cap/抜粋・articles 先頭反映）。
- [x] **MAJOR（現行リファレンス docs の更新漏れ = 監査 MAJOR-1）**: 削除済みシンボル（useMediaSettings / MediaSegmentBar）を
  参照していた mockup/CONVENTIONS.md・.ai-native/outputs/phase5/architecture.md・mockup/README.md を
  新構成（useMediaChannels / useCurrentChannel / useMediaExternalArticles / MediaChannelBar・独立チャンネル + 任意連携）へ更新。
- [x] **MAJOR（新規連携チャンネルの統合キャッシュ無効化漏れ = CR M-1）**: `invalidateIntegratedFor(segmentId)` を、
  引数 id 自身に加え **その segmentId に連携する全チャンネル id**（UI 作成で id=mc-xxxx のもの）も対象にするよう修正
  （useMediaChannels.channelIdsForSegment を追加・キーからチャンネル id を復元して突合）。原則6。
- [x] **MINOR（F-41 ダッシュボードのチャンネル解決のモード乖離 = 監査 MINOR-1）**: useDashboardInsight（mock）が
  segmentId をそのまま channelId 扱いしていたのを、useMediaChannels.channelForSegment（id=segmentId 優先・無ければ
  segmentId 連携の先頭 active チャンネル）で解決するよう修正。UI 作成の mc- 連携チャンネルも業態ダッシュボードへ反映。
- [x] **MINOR（移行 0048 の孤児 backfill = CR m-1）**: media_settings 行を持たない業態（GA 連携済み/記事ありだが設定未保存）の
  子行を救済するため、子テーブル（ga_tokens/articles/briefs/generated/insights/metrics_cache）に現れる segment_id のうち
  未 backfill のものからチャンネルを補完する step 2b を追加（RENAME 前・冪等）。
- [x] **NIT（akebono-dashboard の記事数 JOIN）**: media_channels JOIN に `c.active` フィルタを追加（取消済みチャンネルの記事を数えない）。
- [x] 受容（対応せず記録）: CR NIT（akebono の appKey 'media' 残置 = app-configs 件数保護の意図・無害。既にコメント済み）。
- [x] 再検証（是正後）: api 単体 259 / api 統合 225 / mockup 単体 **158**（外部材料テスト +2 → 156、既存 +... = 158）/ typecheck（api・mockup）全 green。

### 50-y 反復レビュー（原則9・2 巡目 = 最終確認。CRITICAL/MAJOR 0・MINOR 1・NIT 2 → 対応/記録）
- [x] 1 巡目是正 6 件はいずれも実体として解消を独立ロールが確認（テスト実測一致・shared 移設の挙動不変・
  invalidateIntegratedFor のキー解析・channelForSegment の両モード動作・0048 孤児 backfill の実 PG 検証）。
- [x] **MINOR（0048 step 2b の冪等性退行）**: step 2b が子テーブルの segment_id を無ガード参照しており、
  ファイルが謳う「多重適用でも壊れない」不変条件に反していた（手動再適用時に column 不在で失敗）。
  step 2b を information_schema 列存在ガード（media_metrics_cache.segment_id）で囲み、RENAME 済み環境では
  丸ごとスキップ = 再適用安全に修正。使い捨て PostgreSQL で「全マイグレーション適用 → 0048 再適用 OK」を実測確認。
  （本番ランナー migrate.ts は schema_migrations で適用済みをスキップ + ファイル単位トランザクションのため
  通常運用では顕在化しないが、ファイルの不変条件の整合性として是正）。
- [x] NIT（0048 は本ブランチで新規追加＝未デプロイのため 0048 編集で正。既デプロイ環境がある場合のみ 0049 分離が必要）:
  0048 は本 PR で新設した未リリースのマイグレーションであり、編集で問題なし（デプロイ実績なし）。記録のみ。
- [x] NIT（50-x のコミットメッセージ「2 件追加」は実際 3 件）: mockup 単体の追加 it は 3 件（155→158）。
  ヘッドライン件数 158 は正。記録を訂正（テスト件数の SoT は 158）。
- [x] 再検証（是正後）: api 単体 259 / api 統合 225 / mockup 単体 158 / typecheck（api・mockup）全 green +
  0048 の全適用 → 再適用の冪等性を実 PostgreSQL で確認。**未解決指摘ゼロで収束**。

## 51. ダッシュボードの表示・配置カスタマイズ（レイアウト。3 階層 + テンプレート。オペレーター指示 2026-08-03）の完了条件（Definition of Done）

ダッシュボード（`/`）の表示・配置（セクション構成・メニュー要素の配置・通知欄の位置・AKEBONO 業務
セクションの表示・カード密度）を、**世の中の業務アプリを参考にした 5 種のテンプレート（プレビュー付き）**
から選択できるようにした（両モード = mockup + API）。設定は **ユーザー / テナント / アプリ既定の 3 階層**で、
解決順は **ユーザー設定 > テナント設定 > デフォルト表示（アプリ既定）**。既存の 3 機能（外部リンク配置・通知サイド欄・
未読フィルタ）と現行メディア/顧客ログ等の挙動は不変。

- [x] **型・テンプレート・純ロジック（新 SoT = `mockup/app/utils/dashboard-layout.ts`。新規 shared 不要）**:
  `DashboardLayout`（templateId + sections:MenuCategoryDef[] + options{notifications:'side'|'bottom'|'hidden' /
  showAkebono:boolean / density:'comfortable'|'compact'}）・`DashboardTemplate`。テンプレート 5 種:
  - `default`（標準）= 現行構成（DEFAULT_MENU_CATEGORIES.dashboard 流用）+ 通知 side + showAkebono
  - `operations`（現場オペレーション）= 毎日の業務（timecard/attendance/shift/reports/ai-assistant）を最上部
  - `sales`（営業・顧客）= 営業（customer-log/sales/media/workflow）上部・CRM 風
  - `executive`（経営）= 経営・状況（sales/status/ai-company/decision）上部・通知 bottom
  - `focus`（集中/ミニマル）= 単一「メニュー」に全カード・通知 bottom・density compact・AKEBONO 非表示

  全テンプレートの cardIds は既存カード id のみ参照（未割当カード + 外部リンクは categorize が「その他」へ）。
  純関数: `resolveDashboardLayout`（階層解決）・`parseDashboardLayout` / `parseMenuSections`（検証・1 段
  フォールバック）・`layoutFromLegacyCategories`（下位互換）・`materializeLayout`（テンプレ→ディープコピー）・
  `categorizeCards`（useMenuCategories と共有 = 原則3）。
- [x] **categorize ロジックの共通化（原則3）**: 従来 useMenuCategories 内にあった categorize / parseCategories を
  dashboard-layout.ts へ集約（`categorizeCards` / `parseMenuSections` / `CategorizedCards`）。useMenuCategories は
  それを再利用する薄いラッパへ（挙動不変 = 未割当→その他・空セクション除去・順序保持）。
- [x] **解決 composable（新 `mockup/app/composables/useDashboardLayout.ts`）**: `effectiveLayout` /
  `resolvedScope`（'user'|'tenant'|'default'）/ `activeTemplateId` / `templates` / `userLayout` / `tenantLayout` /
  `tenantLayoutOwn`（新キー自身。解除可否・ハイライト用）/ `hasUserLayout` / `hasTenantLayout` /
  `hasTenantLayoutOwn` / `baseLayoutForScope(scope)`（保存先層自身を土台に取る = pickBaseLayout）/
  `applyTemplate(id, 'user'|'tenant')` / `saveSections(sections, scope)` / `resetLayout(scope)`（取消・原則9.5）。
  ユーザー層 = API `me.prefs.dashboardLayout`（saveMePreference）/ mock localStorage `ako.dashboard-layout.v1`
  （useCurrentSegment の SSR 安全 useState + localStorage 流儀）。テナント層 = `getConfig/setConfig('dashboard-layout')`。
  下位互換 = テナント新キー未設定で従来 `menu-categories-dashboard` があればその sections を default options と
  組み合わせテナント層として解釈（原則7）。テナント適用/解除は管理者のみ（非管理者は警告 no-op = 非ブロッキング）。
- [x] **UI（プレビュー付き選択・レスポンシブ = 原則8）**:
  - `OfficeDashboardLayoutPreview`（実データ不要の軽量ミニ描画。セクション見出し + カード数チップ + 通知位置図示 +
    AKEBONO バンド + 密度反映）
  - `OfficeDashboardLayoutPicker`（テンプレートを 1→2 列カードで一覧 + プレビュー + 適用スコープ〔自分/全社〕+
    現在有効層・適用中テンプレート明示 + 層ごとの解除。管理者以外は「自分」のみ）
  - `OfficeDashboardNotifications`（通知欄を index.vue から分離 = 通知位置 side/bottom で再配置可能に。挙動不変）
  - ダッシュボードヘッダに「レイアウト」ボタン → UiModal で Picker を開く
- [x] **反映（`mockup/app/pages/index.vue`）**: effectiveLayout に従いセクション（categorizeCards）・通知位置
  （side=右カラム / bottom=メニュー下 / hidden=非表示）・AKEBONO 表示（options.showAkebono ∧ 既存条件
  〔isEnabled('akebono')・canPath('/akebono')・活性業態数>0〕を AND で維持）・density（UiCardMenu の新 `dense` prop）。
  既存のカテゴリチップ絞り込み・外部リンク合流・通知の未読/カテゴリタブは不変。
- [x] **API 追加なしの確認**: ユーザー設定は既存 `PUT /v1/me/preferences/:key`（key='dashboardLayout'。
  user_preferences 0039 の汎用 key/value）、テナント設定は既存 `PUT /v1/configs/:key`（key='dashboard-layout'。
  app_configs 汎用）を利用。**新規 API ルート・マイグレーションは追加なし**。configs のキー正規表現
  `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$` に 'dashboard-layout' / 'dashboardLayout' とも適合。**user_preferences の
  value は実バイト 4KB 上限**があるため、全テンプレートの materialize 済み JSON が 4KB 未満であることを
  テストで担保（最大でも 1KB 未満）。
- [x] **下位互換（原則7）**: `dashboard-layout` 未設定 + 従来 `menu-categories-dashboard` 設定済みのテナントは、
  従来のセクション構成が default options と組み合わさりテナント層として解決 = 既存カスタマイズ不変。
  すべて未設定なら default テンプレート = 現行の見た目と一致。壊れた JSON・不正構造は 1 段フォールバックで
  表示を壊さない。ユーザー/テナント設定は「解除」で下位層へ戻せる（データ喪失なし）。
- [x] **検証（実測値。この環境で実行）**:
  - `cd mockup && npm run typecheck` green / `cd api && npm run typecheck`（tsc --noEmit）green
  - `cd mockup && npm test`: **191 passed**（本節実装時点。以後 §52・§53 で増加 = 最新値は §53-3 が正）。
    新規 `tests/dashboard-layout.test.ts` = 解決階層〔user>tenant>default〕・壊れ JSON の 1 段フォールバック・
    categorize 流用・テンプレート健全性〔全 cardId が MENU_CARDS.dashboard に存在・focus は全カード・
    default=DEFAULT_MENU_CATEGORIES・executive/focus の通知位置〕・materialize ディープコピー・下位互換・4KB 上限。
    既存 nav-map/media 等は無変更で green
  - `cd api && npm test`（unit）: **259 passed**（本機能は既存 API のみ利用 = API 変更なし・回帰なし）
  - `cd api && npm run test:integration`（実 PostgreSQL）: **225 passed**（既存 green 維持）
- [x] **既知の制約・設計判断**:
  - テナント層は `dashboard-layout`（新・リッチ）が `menu-categories-dashboard`（F-13-8・従来）より優先。
    両方設定された場合は前者が有効になり、SettingsMenuCategoryEditor の編集は当該テナントのダッシュボードでは
    シャドウされる（テナント層を「解除」すると従来カテゴリ設定が再び有効化される）。細粒度編集は F-13-8、
    プリセット一括適用は F-13-9 と役割分担。
  - 密度（density）は options として保持し UiCardMenu の余白に反映（compact = 余白を詰める）。任意項目。
  - AI 生成・GA 等の外部依存はなく、両モードで決定的に動作。

### 51-x 反復レビュー（原則9）
- [x] **セルフレビュー（Push 前チェック）**: 手動ステップなし / 冪等（applyTemplate・resetLayout は upsert・delete
  相当で再実行安全）/ 既存パターン再利用（useCurrentSegment・useMenuCategories・useAppSettings を踏襲・categorize
  共通化）/ 非ブロッキング（テナント権限外は警告 no-op・壊れ JSON はフォールバック）/ ドキュメント全件更新
  （functional-requirements F-01-4・F-13-9 / screen-design 5.6 / data-design 1.10 + AppConfigItem / api-design
  useDashboardLayout 契約 / CONVENTIONS 早見表 + コンポーネント在庫 / 本 §51）/ 波及は Grep で確認（CategorizedCards
  の参照元は useMenuCategories のみ = 再エクスポート削除で auto-import 重複警告も解消）/ SoT→キャッシュ順序遵守
  （saveMePreference は楽観反映後にサーバー保管・setConfig は既存経路）/ 下位互換確認済み / レスポンシブ・取消可能性あり。

## 52. AKEBONO 業態アプリのカテゴリ配置（#24）+ セクション配置の 3 階層化（#25）の完了条件（Definition of Done）

> オペレーター指示 2026-08-03。§51（レイアウト = テンプレート + 3 階層解決）の土台の上に、(1) AKEBONO 各業態
> アプリを基本メニュー・外部リンクと同じくメニューカテゴリへ配置可能にし、(2) セクション配置そのものを
> ユーザー > テナント > アプリ既定の 3 階層で編集・保存できる導線を追加した。ブランチ
> `claude/reports-customer-log-updates-k6on2x`（作業ツリーに残す・未コミット）。

### 52-1 要件1（#24）: AKEBONO 業態アプリのメニューカテゴリ配置
- [x] **写像の純関数（SoT = `mockup/app/utils/akebono.ts`）**: `akebonoSegmentCardId(segmentId)` =
  `akebono-seg:<segmentId>`（安定 id）・`parseAkebonoSegmentCardId(cardId)`（逆写像・非該当は null）・
  `INDUSTRY_CARD_ICON`（業種タイプ別 lucide: retail=Store / maker=Factory / logistics=Truck /
  it_service=MonitorSmartphone / other=LayoutGrid）・`akebonoSegmentCard(segment, appCount)` = MenuCard
  （title=segmentAppName・description=`<業種ラベル>・<appCount> アプリ`・icon=業種別・to=`/akebono?seg=<id>`）。
- [x] **新 composable（`mockup/app/composables/useAkebonoAppCards.ts`。useExternalLinkCards と同型）**:
  `akebonoCards` = active な各業態を `akebonoSegmentCard(s, enabledAppsOf(s.id).length)` で MenuCard 化。active のみ
  （activeSegments 由来）。アプリ数は既存 useAkebonoApps.enabledAppsOf（機能トグル反映）を利用 = **新規 API なし**。
- [x] **二重表示防止（純関数 `planDashboardCards` = `mockup/app/utils/dashboard-layout.ts`）**:
  `assignedAkebonoSegmentIds(sections)` でセクションに割当済みの業態 id を集め、
  - showAkebono=true: 割当済み業態カードのみプールへ（categorize がセクション配置）・未割当業態は
    `unassignedAkebonoSegmentIds` として専用セクションが担当 → **未割当が「その他」へ落ちて二重表示になるのを防ぐ**。
  - showAkebono=false（focus 等）: 全業態カードをプールへ（未割当は「その他」= 消えない）・専用セクションは出さない。
  - akebono 利用不可（機能 OFF・権限なし・業態 0 件）: index.vue が akebonoCards を空で渡す = どこにも出さない。
- [x] **index.vue 反映**: `akebonoAccessible`（isEnabled('akebono') ∧ canPath('/akebono') ∧ 業態数>0）と
  `showAkebono`（= akebonoAccessible ∧ options.showAkebono）を分離。`cardPlan = planDashboardCards({...})` から
  visibleCards（pool）と unassignedAkebonoIds を導出。専用「AKEBONO 業務（業態別）」セクションは
  `v-if="showAkebono && unassignedAkebonoIds.length > 0"` で **未割当業態のみ**表示（全割当済みなら非表示）。
- [x] **SegmentApps.vue 拡張**: optional prop `segmentIds?: string[]`（指定時はその業態のみ・順序も指定順・無効 id 除外。
  未指定は従来どおり全 active）。専用セクションは `:segment-ids="unassignedAkebonoIds"` を渡す。
- [x] **MenuCategoryEditor.vue（dashboard 領域）**: cardOptions に AKEBONO 業態アプリを追加
  （label = `<segmentAppName>（AKEBONO）`。外部リンクと同様）= 管理者がテナント層カテゴリへ akebono を割当可能。
- [x] **動的性の考慮**: 業態は増減する。cardIds に残った未存在業態 id は categorize が単に無視（既存挙動）。
  UiCardMenu は lucide アイコン描画のため追加改修不要。

### 52-2 要件2（#25）: セクション配置の 3 階層化（ユーザー > テナント > アプリ既定）
- [x] **解決は既存の土台を利用**: effectiveLayout（resolveDashboardLayout）が既に user>tenant>default で sections も
  解決済み。不足していた「編集・保存」導線を追加。
- [x] **`useDashboardLayout.saveSections(sections, scope)`**: **保存先スコープ自身の層**の options を維持したまま
  （純関数 `pickBaseLayout`。effectiveLayout ではない = §53 MAJOR 対応）sections を差し替えた DashboardLayout
  （templateId='custom'）を該当層へ保存。保存経路は applyTemplate と共通化した
  `persistLayout(layout, scope)`（原則3。user=saveMePreference/localStorage・tenant=setConfig〔管理者のみ・非管理者は
  警告 no-op〕）。組み立ては純関数 `buildCustomLayout(sections, options)`（dashboard-layout.ts・ディープコピー）。
- [x] **共通編集部品 `UiMenuSectionEditor`（`mockup/app/components/ui/`。原則3）**: カテゴリの追加・削除・改名・
  並び替え・カード割当（UiMultiCombobox）。v-model（MenuCategoryDef[]）で、更新はユーザー操作起点でのみ emit
  （親の dirty 判定を壊さない）。**MenuCategoryEditor もこれを使うよう refactor**（重複削減。既存の
  ハイドレーション/dirty/保存オーケストレーションは維持）。
- [x] **新 UI `OfficeDashboardSectionEditor`**: **保存先スコープ自身の層**の sections をドラフト初期値に
  （baseLayoutForScope。effectiveLayout ではない = §53 MAJOR 対応。スコープ切替時は seed し直す）、スコープ
  （自分=user / 全社=tenant〔管理者のみ〕）を選んで編集・保存（saveSections）。割当候補 = 基本メニュー + 外部リンク +
  AKEBONO 業態アプリ。「この階層の設定を解除」= resetLayout(scope)（取消フロー・原則9.5）。現在有効な層
  （resolvedScope）と適用中テンプレートを明示。ハイドレーション（reloadConfigs）・dirty ガードは MenuCategoryEditor
  と同流儀。`DashboardLayoutPicker` に「テンプレート」/「セクションを編集」のタブを追加して内包。
- [x] **二重編集導線の判断（記録）**: 既存の /settings の MenuCategoryEditor（F-13-8）は masters 領域は従来どおり残す。
  dashboard 領域は「3 階層のレイアウトセクションエディタが主導線」とし、MenuCategoryEditor のダッシュボードタブに
  **案内文**（3 階層はレイアウトから・ここは従来テナント共通設定の下位互換導線）を表示。dashboard タブ自体は
  残す（削除しない）= 既存挙動（テナント `dashboard-layout` が `menu-categories-dashboard` を優先）を壊さない選択。

### 52-3 検証（実測値。この環境で実行）
- [x] `cd mockup && npm run typecheck`（nuxt typecheck）**green**（exit 0）
- [x] `cd mockup && npm test`: **207 passed**（16 files）。新規/追加テスト:
  - `tests/akebono-multi-segment.test.ts`（22 = 従来 + 新規: akebonoSegmentCardId/parse 往復・INDUSTRY_CARD_ICON
    マッピング一致・akebonoSegmentCard 写像〔id 形式・appName 優先・業種別 icon・description〕）
  - `tests/dashboard-layout.test.ts`（42 = 従来 + 新規: assignedAkebonoSegmentIds・planDashboardCards〔showAkebono
    on で割当/未割当振り分け・全割当済みで専用セクション空・off で全プール + 「その他」・akebonoCards 空で不出現〕・
    buildCustomLayout〔custom/options 維持/ディープコピー・user>tenant>default 解決・全カード詰めて 4KB 未満〕）
- [x] `cd api && npm run typecheck`（tsc --noEmit）**green**（exit 0。API 変更なし）
- [x] `cd api && npm test`（unit）: **259 passed**（回帰なし）
- [x] `cd api && npm run test:integration`（使い捨て PostgreSQL）: **225 passed**（既存 green 維持）

### 52-4 API 追加なし・下位互換・既知の制約
- [x] **API 追加なしの確認**: user=`/v1/me/preferences`（key='dashboardLayout'）・tenant=`/v1/configs`
  （key='dashboard-layout'）の既存汎用 key/value のみ。**新規 API ルート・マイグレーションなし**。shared/domain 変更なし。
  user_preferences の value 4KB 上限に対し、全基本メニュー + 外部リンク 20 + 業態 20 を単一セクションに詰めた
  最大構成でも JSON < 4KB をテストで担保。
- [x] **下位互換（原則7）**: 既存の `menu-categories-dashboard`・既存の `dashboard-layout` 保存値は不変で解釈可能。
  akebono/外部リンクのカード id はセクション定義に「追加で」入るだけ（既存 cardIds を壊さない）。akebono カードが
  未存在（業態削除・機能 OFF）でも categorize が無視 = レイアウトは壊れない。取消（解除）で下位層へ戻せる。
- [x] **既知の制約**:
  - akebono 業態カードのアイコンはカテゴリ配置では業種タイプ別 lucide（INDUSTRY_CARD_ICON）で統一。トップの
    専用セクション（AkebonoSegmentApps）は従来どおり AkebonoSegmentIcon（画像 or lucide）で描画 = 意図的な二系統。
  - セクション編集のドラフト初期値・保存時に引き継ぐ options は「**保存先スコープ自身の層**」を土台にする
    （純関数 `pickBaseLayout`。user→user〔無ければ tenant→アプリ既定〕/ tenant→tenant〔無ければアプリ既定。**user 層には
    フォールバックしない**〕）。これにより管理者が全社（tenant）を編集しても、自分の user 設定の options/sections が
    テナントへ紛れ込まない（§53 レビュー MAJOR 対応。以前は effective〔解決結果〕を土台にしていた）。スコープ切替時は
    対象層の土台でドラフトを seed し直す。tenant へ保存しても user 設定がある間は effective は user 優先 = 表示は変わらない（仕様どおり）。
  - focus テンプレート（showAkebono=false）では業態カードが通常メニュー（未割当は「その他」）に混ざる = ミニマル
    表示の意図に沿う設計判断。

### 52-x 反復レビュー（原則9）
- [x] **セルフレビュー（Push 前チェック）**: 手動ステップなし / 冪等（saveSections・resetLayout は upsert/delete 相当で
  再実行安全）/ 既存パターン再利用（useExternalLinkCards と同型の useAkebonoAppCards・共通部品 UiMenuSectionEditor で
  MenuCategoryEditor と重複削減・persistLayout で保存経路共通化）/ 非ブロッキング（tenant 権限外は警告 no-op・
  akebono 利用不可は空で処理）/ ドキュメント全件更新（functional-requirements F-01-4・F-01-5・F-13-8・F-13-9 /
  data-design 1.10 / api-design useAkebonoAppCards・useExternalLinkCards・saveSections 契約 / screen-design 5.3・5.6 /
  CONVENTIONS 早見表 + コンポーネント在庫 / 本 §52）/ 波及は Grep で確認（AkebonoSegmentApps 参照元 = index.vue のみ・
  planDashboardCards/akebonoSegmentCard は新規）/ SoT→キャッシュ順序遵守 / 下位互換確認済み / レスポンシブ
  （UiMenuSectionEditor は flex-wrap・チップ）・取消可能性（解除フロー）あり。
- [x] **二重表示の網羅確認**: showAkebono on/off × 割当あり/なし/全割当済み × akebono 利用可/不可 を planDashboardCards
  の単体テストで網羅。categorize と組み合わせた「その他」落ちも実測。

## 53. ダッシュボードカスタマイズ（§51・§52）の独立レビュー反復（原則9）と修正の完了条件（Definition of Done）

> オペレーター指示 2026-08-03。§51・§52 の実装に対し独立ロール（コードレビュアー・システム監査官）の
> レビュー/監査を実施し、指摘（MAJOR 1・MINOR 2・NIT 2）を全件修正した。ブランチ
> `claude/reports-customer-log-updates-k6on2x`。挙動・API・マイグレーション変更は伴わない（純ロジック + UI + ドキュメント）。

### 53-1 指摘と修正
- [x] **MAJOR（保存先スコープと無関係な層の設定が漏れる）**: `saveSections` と `DashboardSectionEditor` のドラフトが
  `effectiveLayout`（解決結果）の options/sections を土台にしていたため、**個人（user）設定を持つ管理者が全社（tenant）を
  編集すると、自分の user の options/sections がテナントへ保存されてしまう**不具合。→ 保存先スコープ自身の層を土台に取る
  純関数 `pickBaseLayout(scope, {userLayout, tenantLayout})`（SoT = `utils/dashboard-layout.ts`・原則3）を新設し、
  `useDashboardLayout.baseLayoutForScope` / `saveSections` / `DashboardSectionEditor` のドラフト seed をこれに統一。
  tenant は tenant 層自身（無ければアプリ既定）を土台にし、**user 層へはフォールバックしない**（漏れ防止）。
  スコープ切替時はドラフトを対象層の土台で seed し直す（`watch(scope)`）。
- [x] **MINOR（テナント「解除」が何もしないのに成功表示）**: `resetLayout('tenant')` は新キー `dashboard-layout` のみを
  クリアする（従来 `menu-categories-dashboard` は MenuCategoryEditor が管理）が、解除ボタンの活性・適用中ハイライトが
  下位互換込みの `hasTenantLayout` を見ていたため、従来キーのみ設定のテナントで「解除」が押下でき（実際は無操作）成功トーストが出た。
  → 新キー自身を表す `tenantLayoutOwn` / `hasTenantLayoutOwn` を追加し、`DashboardSectionEditor` / `DashboardLayoutPicker`
  の解除可否・ハイライトをこれに切替（従来キーは MenuCategoryEditor 側で解除する導線を維持 = SoT 分離）。
- [x] **MINOR（ドキュメント不整合）**: §51 見出し・本文の「2 階層」を「3 階層」に修正（§52 が §51 を「3 階層解決」と参照して
  いた不整合を解消）。§52-3「既知の制約」の「ドラフトは常に現在の有効レイアウトを初期値にする」は MAJOR 修正で反転したため
  「保存先スコープ自身の層を土台にする」へ書き換え。§51 のテスト実測値は本節実装時点である旨を明示（最新値は 53-3 が正）。
- [x] **NIT（templateId='custom' の生表示）**: 手動編集レイアウトの `activeTemplateId`='custom' が UI に生の "custom" と
  出ていたため、`templateName` に「カスタム」表示を追加（Picker / SectionEditor 双方）。
- [x] **NIT（記録）**: セクションエディタの割当候補は機能 OFF 時も外部リンク/AKEBONO を提示しうるが、cardIds は categorize が
  未存在を無視するため表示は壊れず、再有効化時に設定が生きる利点がある = 意図的挙動として記録（修正不要）。

### 53-2 波及確認（原則5・原則6）
- [x] `saveSections` の options 由来を Grep で確認（`effectiveLayout.value.options` の残存なし）。`hasTenantLayout` の
  UI 参照を解除可否から `hasTenantLayoutOwn` へ切替済み（メッセージ表示等の情報用途は用途に応じて維持）。
- [x] 純ロジック（pickBaseLayout）は utils に集約し composable は薄い委譲（原則3）。SoT→キャッシュ順序・下位互換は不変。

### 53-3 検証（実測値。この環境で実行）
- [x] `cd mockup && npm run typecheck`（nuxt typecheck）**green**（exit 0）
- [x] `cd mockup && npm test`: **212 passed**（16 files）。`tests/dashboard-layout.test.ts` は **47**
  （§52 の 42 + 新規 `pickBaseLayout` 回帰テスト 5 = tenant 編集の土台がテナント層自身であること・管理者個人の user
  設定が tenant 編集へ紛れ込まないこと・tenant 層なしは user へフォールバックせず既定・user のフォールバック順・
  saveSections 相当の options 維持）
- [x] `cd api && npm run typecheck`（tsc --noEmit）**green**（API 変更なし）
- [x] `cd api && npm test`（unit）: **259 passed** / `cd api && npm run test:integration`（使い捨て PostgreSQL）: **225 passed**（回帰なし）

### 53-4 独立ロールによる反復レビュー（原則9。指摘ゼロまで）
53-1 の修正後、独立ロール（コードレビュアー・システム監査官）で再レビュー/監査を実施。結果と対応:
- [x] **コードレビュー = MAJOR/MINOR なし**（`pickBaseLayout` の層分離・`effectiveLayout.value.options` 残存ゼロ・
  watch(scope)×watch(baseSections) の冪等性・回帰テストが弱いアサーションでないことを確認）。NIT のみ。
- [x] **システム監査 = MINOR-1（ドキュメント是正漏れ・原則5）**: 旧挙動（ドラフト/options = effectiveLayout）の記述が
  複数ドキュメントに残存（`phase5/screen-design.md` §5.6・`phase5/api-design.md` useDashboardLayout・`phase7/§52-2`・
  `phase5/data-design.md`・`phase3/functional-requirements.md` F-13-9）。**全件を「保存先スコープ自身の層を土台にする
  （pickBaseLayout）」へ統一**し、api-design.md に `tenantLayoutOwn` / `hasTenantLayoutOwn` / `baseLayoutForScope` を追記。
  Grep で旧挙動の記述が残っていないことを再確認（ヒットゼロ）。
- [x] **NIT-1（従来キーのみテナントでの表示食い違い。両ロールが指摘）**: 新キー未設定 + 従来 `menu-categories-dashboard`
  のみのテナントで「設定なし」と出て解除も無効なのに、上部バナーは「全社設定 有効」でドラフトが legacy sections で埋まる
  問題。→ `DashboardSectionEditor` / `DashboardLayoutPicker` に **`tenantLegacyActive`（新キーなし ∧ legacy あり）** の
  分岐メッセージを追加（「従来のメニューカテゴリ設定が全社に適用されています（解除は『設定 > メニューカテゴリ』から）」）。
  これにより `hasTenantLayout`（legacy 込み）を再度 UI が消費 = 旧 NIT（デッド export）も解消。
- [x] **NIT-2（スコープ切替で未保存ドラフトが無警告破棄）**: 他層汚染（MAJOR）防止のための無条件 re-seed は意図的設計。
  ドラフトは未永続（確定操作ではない）ため原則9.5 の必須対象外と判断し、確認ダイアログは追加しない（設計判断として記録）。
- [x] **再検証**: 上記対応後 `cd mockup && npm run typecheck` green / `npm test` **212 passed**（挙動変更なし = テスト不変）。
  以上で未解決の指摘ゼロ。

## 54. 日報・週報の項目拡張 + ぽいぽいポストの宛先通知（バッチ4。オペレーター指示 2026-08-03）の完了条件（Definition of Done）

> 日報（自分の日報）・週報（自分の週報）のフォーム項目を改称・拡張し、ぽいぽいポストを提出必須化。さらに
> ぽいぽいポスト原文を「ロール/役職/個人」で設定した宛先へ通知する仕組みを追加した（両モード = mockup + API）。
> ブランチ `claude/reports-customer-log-updates-k6on2x`。

### 54-1 要件1: 自分の日報
- [x] **項目名変更**: 所感 → **本日の所感**、課題 → **本日の課題**（`reports.vue` のエディタ・参照表示・詳細ドロワーの全ラベル。型キー reflection/issues は不変 = 原則7）。
- [x] **本日の課題の種別**: `DAILY_ISSUE_CATEGORY_PRESETS`（業務手順/目的の理解不足/事前の情報不足/スキル/経験の不足/コミュニケーション不足/工数/優先順位/顧客/外部要因/その他）を UiSelect で単一選択（空 = 未選択）。SoT = `shared/domain/types.ts`。`DailyReport.issueCategory?` を追加（migration 0049 = `daily_reports.issue_category`）。API/mock とも cleanIssueCategory でプリセット外を '' へ正規化。
- [x] **説明文の除外**: 「マークダウン記法に対応」（所感）・「記入して提出すると管理者へ自動共有されます」（課題）・「入力があると…ぽいぽいポストとして登録されます（空欄ならスキップ）」（ぽいぽい）の 3 ヒントを撤去。
- [x] **ぽいぽいポスト必須化**: ラベルから「（任意）」を除去し `required`。提出（onSubmit）時に未入力なら警告して中断（下書き保存・提出済み更新は必須にしない = 既登録の再投稿防止）。

### 54-2 要件2: 自分の週報
- [x] **項目名変更**: 今週の目標達成 → **今週の成果・達成感**（例文プレースホルダ付き）、主要業務 → **今週の主要業務**、課題 → **課題・原因仮説**、来週の予定 → **来週の最重要テーマ（最大3つ）**（「最大3つ」は入力ガイド）。
- [x] **新規項目**: **うまくいったこと・続けたいこと**（goodPoints）、**チーム共有事項**（種別 `WEEKLY_TEAM_SHARE_KINDS`〔相談したい/判断してほしい/対応を依頼したい/特になし〕を UiChipTabs で選択・既定「特になし」 + 自由入力 teamShareNote〔任意〕）。`WeeklyReport.goodPoints?/teamShareKind?/teamShareNote?` を追加（migration 0049）。cleanTeamShareKind でプリセット外を '' へ正規化。

### 54-3 要件3: ぽいぽいポスト原文の通知 + 宛先設定
- [x] **宛先解決の純関数（新 SoT = `shared/domain/notify-recipients.ts`）**: `NotifyRecipientTarget`（type=title/role/member = ApproverType 流用 = 原則3）・`resolveNotifyRecipientIds`（在籍者・重複排除・投稿者除外・id 昇順）・`parseNotifyRecipients`（JSON/配列の正規化・不正要素除去）。mock 用 shim = `utils/notify-recipients.ts`。
- [x] **通知種別**: `NotificationKind` に `poipoi` を追加（migration 0049 = notifications の CHECK 張り替え。冪等 = DROP IF EXISTS → ADD）。ラベル `NOTIFICATION_KIND_LABELS.poipoi='ぽいぽいポスト'`・inbox のトーンマップも追加。
- [x] **発火**: API = `POST /v1/notes`（kind=poipoi）で configs `poipoi-notify-recipients` を解決し原文プレビュー（140cp）を宛先へ notify（link=/poipoi・投稿者除外・非ブロッキング = 原則4）。mock = `useNotes.add`（kind=poipoi）で同等に発火（API モードは useNotifications.notify が no-op のためサーバー発火と二重にならない）。
- [x] **設定 UI**: `SettingsNotifyRecipientsEditor`（ロール/役職/個人を複数指定・解決人数プレビュー・空許容）を設定「ぽいぽいポストの通知先」に追加。SoT = configs `poipoi-notify-recipients`（JSON 文字列）。管理者のみ。

### 54-4 検証（実測値。この環境で実行）
- [x] `cd mockup && npm run typecheck`（nuxt typecheck）**green** / `cd api && npm run typecheck`（tsc --noEmit）**green**
- [x] `cd mockup && npm test`: **221 passed**（17 files。新規 `tests/notify-recipients.test.ts` 9 = parse/resolve〔role/title/member・退職者除外・重複排除・投稿者除外・空〕）
- [x] `cd api && npm test`（unit）: **259 passed**
- [x] `cd api && npm run test:integration`（使い捨て PostgreSQL・migration 0049 適用）: **229 passed**（新規 4 = 日報 issueCategory 往復 + 正規化 / 週報 goodPoints・teamShareKind・teamShareNote 往復 + 正規化 / ぽいぽい設定なしで無通知 / ぽいぽい宛先ロールへ通知 + 投稿者除外）
- [x] **migration 0049 冪等性**: 使い捨て PostgreSQL で二重適用を確認（ADD COLUMN IF NOT EXISTS の NOTICE スキップ・CHECK 張り替えは DROP IF EXISTS → ADD で再実行安全・poipoi 許可/bogus 拒否を実測）。

### 54-5 API 追加なし・下位互換・既知の制約
- [x] **API ルート追加なし**: 既存 `/v1/reports/daily`・`/v1/reports/weekly`・`/v1/notes`・`/v1/configs`・`/v1/notifications` のみ。スキーマ追加は migration 0049（列追加 + CHECK 拡張）のみ。
- [x] **下位互換（原則7）**: 追加列は全て NOT NULL DEFAULT ''（既存行は空）。issueCategory/teamShareKind/goodPoints/teamShareNote は型で optional。旧データ・旧クライアントの送信欠落は '' 扱い。通知 kind 拡張は既存 kind に影響しない。
- [x] **設計判断（記録）**: (1) ぽいぽい通知は「入力原文」= テキスト登録（POST /v1/notes・mock useNotes.add）で発火。**ドキュメント取込（/import・mock importFile）は対象外 = 両モードとも非発火**（§54-y MINOR-2 で mock を API に合わせて是正）。(2) ぽいぽい必須は初回提出（onSubmit）のみ（下書き・提出済み更新は非強制）。**入力欄が空でも当日すでにぽいぽいが 1 件以上あれば要件を満たす扱い**（下書き保存時に投稿済み → 再提出で二重投稿になるのを防ぐ = §54-y MINOR）。(3) 「来週の最重要テーマ（最大3つ）」は自由記述 textarea + ラベルの入力ガイド（構造化はしない）。

### 54-x 反復レビュー（原則9）
- [x] **セルフレビュー（Push 前チェック）**: 手動ステップなし / 冪等（migration 0049 二重適用安全・saveSections/upsert は再実行安全）/ 既存パターン再利用（ApproverType/pickApprover 流儀・UiSelect/UiChipTabs・CUSTOMER_LOG_TAG_PRESETS のプリセット方式）/ 非ブロッキング（poipoi 通知失敗は登録を止めない）/ ドキュメント全件更新（functional-requirements F-06/F-06b/F-12/F-13 / data-design / api-design / screen-design / CONVENTIONS / 本 §54）/ 波及は Grep で確認（NotificationKind の網羅 map = inbox のトーン + labels を更新）/ SoT→キャッシュ順序遵守 / 下位互換確認済み / レスポンシブ（UiSelect/UiChipTabs は flex-wrap）・取消可能性（提出済み日報は本人編集可・ぽいぽいは取消/復元・週報は下書き編集）。

### 54-y 独立ロールによるレビュー反復（原則9。指摘ゼロまで是正）
54-1〜54-4 の実装後、独立ロール（コードレビュアー・システム監査官）で再レビュー/監査を実施。指摘（MAJOR 1・MINOR 2・NIT 1。重複含む）を全件是正:
- [x] **MAJOR（コードレビュー）/ MINOR-1（監査）: 提出ガードがアシストモードでエディタごと隠す**: `onSubmit` のぽいぽい未入力ガードが `confirmStep.value=false` を実行していたため、AI アシストモード（`showEditor = !assistActive || confirmStep`）では警告直後にエディタ（＝入力すべきぽいぽい欄）が消えて入力不能になっていた。→ ガード分岐から `confirmStep=false` を削除（成功パスの `confirmStep=false` のみ残す）。
- [x] **MINOR（コードレビュー）: 下書き投稿済みでも再提出で二重投稿を強要**: 必須判定が一時 ref `poipoiDraft` のみを見ていたため、下書き保存でぽいぽい投稿済み → 再オープン（poipoiDraft は空）→ 提出でブロックされ二重投稿していた。→ `hasPoipoiForDay`（当日の自分のぽいぽい登録有無）を追加し、`!poipoiDraft.trim() && !hasPoipoiForDay` のときのみブロック。
- [x] **MINOR-2（監査）: mock のみドキュメント取込で通知発火（API・文書と不一致）**: mock の `importFile` が `add` 再利用で poipoi 通知を発火していた（API `/import` は非発火・§54-5 の設計判断とも矛盾）。→ `add` に `opts.notifyPoipoi` を追加し `importFile` は `false` を渡して非発火に統一。
- [x] **NIT-1（監査）: 必須マーカーが提出済み編集でも常時表示**: ぽいぽい欄の `required`（アスタリスク）を `:required="!editingSubmitted"` にし、必須が実際に効く初回提出コンテキストでのみ表示（提出済み編集での誤った再投稿を防ぐ）。
- [x] **再検証**: `cd mockup && npm run typecheck` green・`npm test` **221 passed** / `cd api && npm run typecheck` green・unit **259**・integration **229**（挙動の是正のみでテスト件数不変。既存アサーションは全て緑）。以上で未解決の指摘ゼロ。

## 55. 顧客ログの議事録メモ廃止 + 議事録フォーム再構成（バッチ5 の一部。オペレーター指示 2026-08-03）の完了条件（Definition of Done）

> オペレーター指示 2026-08-03（3 件）のうち、②顧客ログ「議事録メモ」の廃止 と ③a 議事録フォームの再構成 + プロジェクト→顧客補完 を実装した。
> ①Akebono アプリのスプレッドシート取込・連携 と ③b Google Meet 連携（いずれも Google 外部連携を伴う大型機能）は
> 可否回答 + 設計提示の上でスコープ確認中（本 §55 の対象外）。ブランチ `claude/reports-customer-log-updates-k6on2x`。

### 55-1 ② 顧客ログ「議事録メモ」の入力・保管を廃止
- [x] **検証 SoT**: `shared/domain/customer-log.ts` `customerLogMemoError(body)` を単一引数（担当者メモ必須）へ変更。呼び出し 3 箇所（API POST/PATCH・mock validate）を追随。
- [x] **型**: `CustomerLog.minutesMemo` を削除（`shared/domain/types.ts`）。
- [x] **API**: `customer-logs.ts` の CLOG_COLS・POST/PATCH の INSERT/UPDATE から `minutes_memo` を除去。`ownLog` は CLOG_COLS 経由で追随。
- [x] **mock**: `useCustomerLogs.ts`（Input/validate/payload/add/update）から minutesMemo を除去。
- [x] **UI**: `CustomerLogPanel.vue` の議事録メモ入力欄・詳細表示・一覧プレビュー・検索対象・form state を除去。担当者メモを `required` 表示に。
- [x] **AI 検索インデックス**: `search-index.ts` の customer_logs SELECT と「議事録メモ」セグメント生成を除去。
- [x] **seed**: `data/seed/customer-logs.ts` から minutesMemo を除去。
- [x] **DB（migration 0050）**: `customer_logs DROP COLUMN IF EXISTS minutes_memo`（冪等）。**下位互換の注意（原則7）**: 議事録メモ本文を破棄する破壊的変更。0047 で追加された比較的新しい項目で、オペレーターの明示指示に基づく廃止。必要内容は担当者メモへ集約する運用（保全が必要なら適用前にバックアップ）。マイグレーション冒頭に明記。
- [x] **テスト**: `customer-log-validate.test.ts`（memo 検証を body 単独へ）・`api.test.ts`（顧客ログ項目拡張 2 テストを body 必須へ・minutesMemo 応答非含有と未知キー無視を確認）を更新。

### 55-2 ③a 議事録フォームの再構成 + プロジェクト→顧客補完（frontend のみ）
- [x] **フォーム上部化**: `NotesPanel.vue`（ぽいぽいポスト/議事録の共通パネル）で プロジェクト/顧客/業務種別のセレクトを本文の上へ移設。操作ボタン（プレビュー/ファイル選択/登録）は末尾行に分離。
- [x] **プロジェクト→顧客補完**: `form.projectId` を watch し、選択プロジェクトの `companyId`（Project.companyId = SoT）で `form.companyId` を補完（手動変更は妨げず、選び直し時のみ上書き）。API/DB 変更なし（既存の projectId/companyId をそのまま送る）。
- [x] **共通化の帰結（記録）**: 共通パネルのため ぽいぽいポストの入力モーダルも同じ並び・補完になる（両ノート種別で一貫。害なし）。

### 55-3 検証（実測値。この環境で実行）
- [x] `cd mockup && npm run typecheck` green / `npm test` **221 passed**（17 files。件数不変 = 既存テストが緑のまま追随）
- [x] `cd api && npm run typecheck` green / unit **259 passed** / `npm run test:integration`（使い捨て PostgreSQL・migration 0050 適用）**229 passed**
- [x] **migration 0050 冪等性**: `DROP COLUMN IF EXISTS` は再適用・未適用いずれでも安全（本質的に冪等）。

### 55-x 反復レビュー（原則9）
- [x] **セルフレビュー（Push 前チェック）**: 手動ステップなし / 冪等（0050 DROP IF EXISTS）/ 既存パターン再利用（CustomerLogPanel の watch 補完流儀・Project.companyId 直参照）/ 非ブロッキング該当なし / ドキュメント全件更新（functional-requirements F-18・F-06b / data-design / api-design / screen-design / 本 §55）/ 波及は Grep で確認（minutesMemo/minutes_memo の残存 = 廃止を説明するコメントと「無視される」検証のみ）/ 下位互換の破壊的変更（列 DROP）はオペレーター説明を migration に明記（原則7）/ 取消可能性（顧客ログの取消/復元は不変）。

## 56. Google スプレッドシート取込（データ取込・連携 F-32 の方式 `sheets_pull`。バッチ5 ①。オペレーター指示 2026-08-03）の完了条件（Definition of Done）

> オペレーター指示 2026-08-03 ①「/akebono の各セグメントのアプリで『データ取込・連携』のスプレッドシートを対象にできるか」への**フル実装**回答。
> 要望どおり **Google カレンダー同期と同様の連携認証 → 対象ブック検索・選択 → シート選択 → 開始行・列指定 → 列定義取得 → 各列をアプリ項目へマッピング → 取込** の操作感を、既存の取込基盤（F-32）へ新方式 `sheets_pull` として追加した。ブランチ `claude/reports-customer-log-updates-k6on2x`。

### 56-1 可否回答（記録）
- **可能**。既存 F-32 は取込元方式が拡張可能な設計（method 別に config を正規化し、実取込は shared/domain の抽出器へ流す）。Google スプレッドシートは「開始行=ヘッダ・開始列以降」でスライスした 2 次元配列を CSV 化すれば既存 CSV 抽出器をそのまま再利用でき（原則3）、OAuth はカレンダー/GA の実装（token 暗号化・state ノンス・email 突合）と同型で追加できる。

### 56-2 実装（API）
- [x] **OAuth 連携（`api/src/routes/sheets.ts`・新規）**: カレンダー/GA と同型の認可コードフロー。scope = `spreadsheets.readonly` + `drive.readonly`。**テナント単位の単一接続**（`sheets_tokens` id='default'）。`sheetsAccess`（期限切れは refresh）・`fetchSheetRows`（値取得 → 開始行/列スライス・MAX_SHEET_ROWS=50000）・`sheetsOauthCallback`（復帰 `/akebono/imports?sheets=connected|error`・email 突合）・`sheetsRoutes`（status / oauth/url〔admin〕/ disconnect〔admin〕/ spreadsheets 検索〔Drive files.list〕/ :id/tabs / :id/columns）。エラー AKO-SHEETS-001（未連携）/002（API 失敗）/003（対象未指定）。
- [x] **実取込（`akebono-imports.ts`）**: IMPORT_METHODS に `sheets_pull` を追加。`akebonoImportsRoutes(pool, env)` へ env を注入。run の材料取得で sheets_pull は `fetchSheetRows` → `rowsToCsv` → 既存 CSV 抽出（`extractCsvRecords`・hasHeader:true・区切り ','・utf8）へ流す。ファイル添付不要。
- [x] **shared 純関数（`shared/domain/import-parse.ts`）**: `a1ColToIndex`（A1 列 → 0 始まり index）・`rowsToCsv`（RFC4180 引用）・`normalizeImportSourceConfig` に sheets_pull 分岐（spreadsheetId/spreadsheetName/sheetName/headerRow〔1〜100000・既定1〕/startColumn〔/^[A-Z]{1,3}$/・既定A〕）。フロント/API 共有 = 両モード parity。
- [x] **DB（migration 0051）**: `sheets_tokens`（単一接続）・`sheets_oauth_states`（一回性 10 分 TTL）を新設（CREATE IF NOT EXISTS = 冪等）。**`import_sources.method` の CHECK 制約を 0035 のインライン定義から拡張**して `sheets_pull` を許容（DROP CONSTRAINT IF EXISTS → ADD。既存方式は不変 = 原則7）。
- [x] **配線（`app.ts`）**: OAuth コールバックを認証前に登録・`sheetsRoutes` を `/v1/akebono` へマウント・`akebonoImportsRoutes(pool, env)` へ env 追加。

### 56-3 実装（フロント）
- [x] **mock composable（`useSheetsImport.ts`・新規）**: status/refreshStatus/connect/disconnect/listSpreadsheets/listTabs/detectColumns。API モードは `/v1/akebono/sheets/*`・モックは疑似同意（即接続）+ 決定的なダミーのブック/シート/列（実 Google 通信なし・SSR 安全）。
- [x] **取込画面（`imports.vue`）**: マッピング編集モーダルの方式別設定に **sheets_pull** ブロックを追加（未設定=案内 / 未連携=連携ボタン / 連携済=ブック検索・選択 → シート選択 → 開始行/列 → 「列を取得」で左辺自動生成）。左辺は CSV と同じ列番号表現（開始列スライス済 = 0 始まり）。`saveMapping` は sheets_pull で columnIndex ロケータを保持し、ブック・シート未選択は保存前ガード。`?sheets=connected|error` のコールバック復帰をトースト表示。
- [x] **method ラベル（`useAkebonoImports.ts`）**: IMPORT_METHOD_LABELS に `sheets_pull: 'Google スプレッドシート'`。

### 56-4 検証（実測値。この環境で実行）
- [x] `cd mockup && npm run typecheck` green / `npm test` **221 passed**（件数不変 = 既存テストが緑のまま追随）
- [x] `cd api && npm run typecheck` green / unit **273 passed**（import-parse に a1ColToIndex/rowsToCsv/splitCsvRows/sheets_pull config・akebono-phase-d に複数行セル/空ヘッダ列の回帰 = 計 14 件を追加）/ `npm run test:integration`（使い捨て PostgreSQL・migration 0051 適用）**230 passed**（sheets_pull の status/URL/callback/config 往復/未連携実行 = AKO-SHEETS-001 を追加）
- [x] **migration 0051 冪等性**: CREATE IF NOT EXISTS + DROP CONSTRAINT IF EXISTS → ADD は再適用安全。テスト env（GOOGLE_OAUTH_* 未設定）は enabled=false で連携 UI を隠す経路を検証。

### 56-5 設計判断（記録）
- **接続はテナント単位の単一接続**（sheets_tokens id='default'）。取込は管理者運用のため per-user ではない（GA のリソース単位とも異なる）。連携ブラウズ・取込設定・実行は管理者のみ（AKO-AUTH-003 と両モード一致）。
- **CSV 抽出器の再利用**: 開始行/列スライス済みの値を `rowsToCsv` で CSV 化し `extractCsvRecords` へ流すことで、変換（trim/number/date/…）・参照解決・冪等 upsert・エラー行隔離を既存経路と完全共有（新規反映エンジンを書かない = 原則3・原則4）。
- **取消可能性（原則9.5）**: 取込元 = 論理削除+復元・マッピング = 新版で上書き（旧版は履歴）・連携 = disconnect で解除、はいずれも既存フローを継承。反映済みデータの是正は各アプリの既存フロー。

### 56-x 反復レビュー（原則9）
- [x] **セルフレビュー（Push 前チェック）**: 手動ステップなし（連携はUIボタン→OAuth）/ 冪等（0051・token upsert・config 正規化は再送安全）/ 既存コード再利用（calendar/GA の OAuth 型・extractCsvRecords・normalizeImportSourceConfig・useAppFields）/ 非ブロッキング（連携失敗・タブ復元失敗はトースト/無視で主要フロー継続 = 原則4）/ ドキュメント全件更新（akebono-menu-design §5・data-design・api-design・本 §56）/ 波及は Grep で確認（IMPORT_METHODS/IMPORT_METHOD_LABELS/rowGridClass/method 分岐の網羅）/ SoT→キャッシュ順序（sheets_tokens 書込 → status 反映）/ 下位互換（新方式追加・CHECK 拡張は既存非破壊 = 原則7）/ レスポンシブ（検索・選択リストは flex/max-h スクロール）/ 取消可能性（56-5）。
- [x] **独立レビュー / 監査の指摘是正（原則9・初回 = de8eb7a に対して）**: コードレビュアーとシステム監査官を並行実施し、MAJOR 3 件・NIT を是正。
  - **MAJOR-1（複数行セルで行崩れ）**: `rowsToCsv` が生成しうる引用符内改行を、行単位 split の `extractCsvRecords` が別レコードに割ってしまい幻の行/誤取込を生む欠陥。→ shared に **`splitCsvRows`**（引用符内の改行・区切りを保持する全文パーサ）を新設し、`extractCsvRecords`・`parseCsvColumns` を全文パースへ切替（file_csv も同時に堅牢化）。回帰テスト追加。
  - **MAJOR-2（空ヘッダ列で誤列取込）**: `/sheets/:id/columns` が `.filter(Boolean)` で空ヘッダセルを落とし、UI の `columnIndex=i`（filtered 位置）が実取込の絶対 index とズレる欠陥。→ エンドポイントを **空セルも「列N」として index を保存**（`parseCsvColumns` と同規約）へ修正。回帰テスト追加。
  - **MAJOR-3（本番デプロイ手当て漏れ = 原則1/5）**: 新 OAuth コールバック・新スコープ・Sheets API が deploy 自動化/手順書に未反映。→ `deploy.yml` に `sheets.googleapis.com` の自動有効化を追加、`deploy-guide.md` に **§1-9c**（コールバック URI・`spreadsheets.readonly` スコープ〔機微スコープ注記〕・Sheets API 有効化・トラブルシュート）を追加。
  - **NIT**: `MAX_SHEET_ROWS` のコメントを実挙動（フェッチ安全弁 = 受理上限 MAX_IMPORT_ROWS とは別）に修正。requireEnabled→requireAdmin 順序・status 非管理者可・disconnect 無確認は calendar/media と同型のため許容（原則3 の一貫性）。
- [x] **再検証**: 上記是正後に mockup 221 / API unit 273 / API integration 230 いずれも green（是正で新たな回帰なしを確認 = 原則9「直した結果も問題ない」）。

## 57. 議事録の Google Meet 連携（AI メモ/録画リンク。バッチ5 ③b。オペレーター指示 2026-08-03）の完了条件（Definition of Done）

> オペレーター指示 2026-08-03 ③b「Google MEET による AI メモや録画との連動機能を追加。カレンダー同期の認証と同様に連携し、
> 対象の保管フォルダを指定（デフォルトを初期表示し違う場合のみ任意指定）、対象ファイルを選ぶ」への**フル実装**。
> 議事録（notes.kind='minutes'）に Drive 上の Meet 生成物（AI メモ=Google ドキュメント / 録画=動画）を選んで参照リンクする。
> ブランチ `claude/reports-customer-log-updates-k6on2x`。

### 57-1 方針（記録）
- **連携認証はカレンダー連携を再利用**（0009 の calendar_tokens・`drive.readonly` スコープ）。ドキュメント管理の「ドライブから取込」と
  同型で、別途の connect は持たず未接続時は AI アシスタントのカレンダー連携へ誘導する（原則3 = 既存 Drive 基盤の再利用）。
- **API モード限定**（実 Drive 連携が必要）。モックは available=false で UI を隠す（documents のドライブ取込と同じ扱い）。
- リンクは**参照のみ保持**（meet_file_id/名称/webViewLink）。ファイル実体は複製しない（Drive が SoT）。

### 57-2 実装（API）
- [x] **DB（migration 0052）**: `notes` に meet_file_id / meet_file_name / meet_web_link を追加（ADD COLUMN IF NOT EXISTS =
  冪等・NULL 許容 = 既存議事録/ぽいぽいポスト非破壊 = 原則7）。NOTE_COLS へ 3 列を追加。
- [x] **notes.ts**: POST / import が meetLinkOf で検証した Meet リンクを保持（webViewLink は https の *.google.com のみ受理・
  id 空は全 null = 不整合を持ち込まない）。Meet ブラウズ endpoint 群を追加（`/:noteId/*` より前に登録 = 静的パス優先）:
  `GET /meet/status`（driveTokenState + 既定フォルダ）・`GET /meet/folders`・`GET /meet/files`（folderId 省略時は既定フォルダ・
  AI メモ/録画/その他を fileKind で分類）・`GET /meet/file-text`（Google ドキュメントを text/plain export = 本文取込の材料）・
  `PUT /meet/default-folder`（管理者のみ = app_configs `meet-default-folder`・id 空でクリア）。エラー AKO-NOTE-004/005・
  未接続は Drive 共通の AKO-DOC-006。
- [x] **documents.ts**: driveTokenState / requireDriveToken / DRIVE_FILES_URL を export（notes.ts と共用 = 原則3。
  googleErrorDetail / driveForbiddenHint は既存 export を再利用）。

### 57-3 実装（フロント）
- [x] **shared/domain/types.ts**: Note に meetFileId?/meetFileName?/meetWebLink? を追加（任意 = 原則7）。
- [x] **useMeetLink.ts（新規）**: status/refreshStatus/listFolders/listFiles/fetchFileText/setDefaultFolder。API モード限定
  （mock は available=false）。connect は持たず（カレンダー連携を再利用）。
- [x] **useNotes.ts**: NoteInput に meet フィールドを追加。mock add はそのまま保持（API モードのみ設定される）。
- [x] **NotesPanel.vue（議事録のみ・API モード）**: 入力モーダルに Meet 連携セクション（未接続=カレンダー連携誘導 /
  連携済=保管フォルダ〔既定を初期表示・別フォルダ選択・管理者は既定設定〕→ ファイル一覧から選択 → 選択チップ +
  「AI メモを本文へ取込」）。一覧行/詳細に Meet バッジ・詳細は webViewLink リンク。登録成功で選択をクリア。

### 57-4 検証（実測値。この環境で実行）
- [x] `cd mockup && npm run typecheck` green / `npm test` **221 passed**（件数不変）
- [x] `cd api && npm run typecheck` green / unit **273 passed**（件数不変）/ `npm run test:integration`（使い捨て
  PostgreSQL・migration 0052 適用）**231 passed**（Meet の status/folders/files 未接続・既定フォルダ管理者ゲート・
  meet リンクの往復と検証〔非 google URL は null 化・id 無しは全 null〕を追加）
- [x] **migration 0052 冪等性**: ADD COLUMN IF NOT EXISTS は再適用安全。テスト env（GOOGLE_OAUTH_* 未設定）は
  available=false で UI を隠す経路・未接続は AKO-DOC-006 を検証。

### 57-5 設計判断（記録）
- **API モード限定**: documents のドライブ取込の前例に合わせ、実 Drive 連携が必要な機能はモックで simulate せず
  available=false で隠す（① Sheets は疑似同意で simulate したが、③b は Drive 基盤〔calendar_tokens〕を全面再利用する
  ため実 API 前提の方が一貫。demo では非表示になる旨を画面挙動で明示）。
- **取消可能性（原則9.5）**: Meet リンクは議事録作成時に付与し、議事録自体の取消/復元（既存フロー）で立ち戻れる。
  作成前は選択チップの「リンクを解除」でクリア可能。既定フォルダの設定も id 空でクリア可能。
- **アクセス整合の留意（監査 MINOR-2 = 記録）**: ブラウズは**接続実行者本人の Drive トークン**（calendar_tokens.member_id）で行うため、
  選べるのは本人が閲覧権を持つファイル。一方リンク（meetWebLink・meetFileName）は C2 の議事録に保存され全メンバーに表示される。
  ファイル本体の可視性は Google が開封時に強制する（**内容漏洩はしない**）が、①ファイル名が全メンバーへ開示される ②Drive 権限の
  無いメンバーがリンクを開くと「アクセス権のリクエスト」になる、という残余がある。運用前提として **Meet の保管フォルダは
  チーム共有ドライブ/共有フォルダを既定に設定する**ことを推奨（全メンバーがブラウズ・開封できる）。本文取込（text/plain）は
  作成者の明示操作で C2 本文へ複製する設計判断。

### 57-x 反復レビュー（原則9）
- [x] **セルフレビュー（Push 前チェック）**: 手動ステップなし（連携はカレンダー再利用）/ 冪等（0052・default-folder upsert・
  meetLinkOf 正規化は再送安全）/ 既存コード再利用（driveTokenState/requireDriveToken/googleErrorDetail・calendar OAuth）/
  非ブロッキング（フォルダ/ファイル取得失敗はトースト・主フロー継続 = 原則4）/ ドキュメント全件更新（functional-requirements
  F-06b-8・data-design・api-design・screen-design・deploy-guide §1-9 step5・本 §57）/ 波及は Grep で確認（NOTE_COLS/POST/import
  の meet 列・/meet ルートと /:noteId の順序）/ SoT→キャッシュ（notes 書込 → 一覧再取得）/ 下位互換（列追加は NULL 許容 =
  原則7）/ レスポンシブ（フォルダ/ファイルリストは max-h スクロール・flex-wrap）/ 取消可能性（57-5）。
- [x] **独立レビュー / 監査（コードレビュアー + システム監査官・並行）**: **MAJOR 0 件**。MINOR/NIT を是正。
  - **MINOR（両者）: `/meet/*` が F-16 機能ガード未適用**（他の notes ハンドラは guardFeature 済み・/v1/notes は PATH_FEATURES 外で in-handler ガードが唯一の関門）。→ `/meet/status|folders|files|file-text|default-folder` に `guardFeature(pool, user, 'minutes')` を追加。
  - **MINOR（両者）: 共有 C2 議事録をユーザー個人の Drive トークンで参照する留意**（内容漏洩なし = Google が開封時に強制。ファイル名開示・非共有メンバーのリンク切れ）。→ §57-5 に留意と「保管フォルダは共有ドライブ推奨」を記載。
  - **MINOR（監査）: api-design のエラーコード表が AKO-NOTE-004/005 未掲載**。→ 表へ 2 行追加。
  - **NIT: 「AI メモを本文へ取込」が非ドキュメントでも表示**（録画/その他は AKO-NOTE-004）。→ `meetFile.fileKind === 'notes'` のみ表示に限定。
  - **NIT: poipoi にも手製リクエストで meet 列が入りうる**。→ POST/import で `kind === 'minutes'` のときのみ meet を保持。
  - **NIT（監査）: HANDOFF スナップショットに /meet 未反映**。→ 追記（全件反映）。
  - 許容（是正不要）: webViewLink 正規化の末尾スラッシュ要求（サフィックス攻撃防御として意図的・実リンクは必ずパスあり）/ documents→notes の Drive ヘルパ import（循環なし・calendar→documents の前例あり = 原則3）/ 既定フォルダ名空時の「（未選択）」表示（選択経由では常に name 設定・直 API のみ・体裁）/ Meet リンクの実在検証なし（google.com ホスト制約 + C2 同一チーム信頼）。
- [x] **再検証（是正後）**: mockup typecheck + `npm test` **221 passed** / api typecheck + unit **273 passed** / integration **231 passed**（新規回帰なし = 原則9「直した結果も問題ない」）。

## 58. バリアント軸取込（product_variant）＋ マスタ間連携キー（突合キー lookupField）（オペレーター指示 2026-08-07）の完了条件（Definition of Done）

> オペレーター指示 2026-08-07「①バリアント軸を含む取込の際に、グルーピングキーの列とバリアント軸を成す軸を指定して
> 取り込めるようにする（例: アパレルの 商品id / skuid / カラー / サイズ → skuid = レコード固有 ID・商品id = グルーピングキー・
> カラー / サイズ = バリアント軸として 2 次元表・2 次元データから取込）②マスタ間・マスタ×トランザクションのデータ連携を
> 指定できるようにする（別マスタのどの項目と取込対象のどの項目の一致を突合して連携するかの設定）」への実装。
> ブランチ `claude/akebono-import-linking-scsqkq`。

### 58-1 方針（記録）
- **共有カタログ `shared/domain/import-link.ts`（新規・純粋関数）** に ①参照項目カタログ（取込対象 × 対象項目 → 参照先マスタ +
  突合キー候補 = `IMPORT_REF_TARGETS`）②バリアント軸取込の対象項目カタログ（`VARIANT_IMPORT_FIELDS`）③保存前検証
  （`validateImportMapping`）④軸ラベル決定（`variantAxisLabelsOf` = axis1Value/axis2Value に割り当てた列の論理名）を集約。
  フロント（マッピング UI の選択肢・モック保存検証）と API（保存時検証・実行時解決）が同一関数を共有（原則3・6 = 両モード parity）。
- **① バリアント軸取込 = 新しい取込対象 `product_variant`（商品＋SKU バリアント展開）**: 既存の product（既定 SKU のみ）と
  sku（更新のみ・親商品を表現できない = §48-1 の明記済み制約）の間を埋める。グルーピングキー（productCode）で行を商品へ束ね、
  SKU コード（code）をレコード固有 ID として SKU を upsert。軸の指定は「カラー・サイズ列を axis1Value/axis2Value へ割り当てる」
  操作そのもので、列名がそのまま商品の軸ラベル（variant_axis1_label/2）になる（カラー×サイズの 2 次元バリアント表の縦持ちを想定）。
- **② マスタ間連携キー = マッピング行ごとの突合キー `lookupField`**: 参照項目（得意先・セグメント・カテゴリ・SKU・倉庫・業界・
  税区分・単位・仕入先）を「参照先マスタのどの項目と突合して解決するか」を設定可能に。未設定 = 従来の既定
  （ID → 有効行の名称完全一致 / SKU は ID → SKU コード）で**下位互換**（原則7 = 既存マッピングは挙動不変・データパッチ不要）。
  設定時は指定項目（id / name / SKU code / janCode / 取引先 custom.<key>）の**有効行完全一致・一意のときのみ**解決
  （0 件・複数一致は隔離 = 誤リンク防止）。

### 58-2 実装（API）
- [x] **DB（migration 0053）**: import_sources.target_entity の CHECK に 'product_variant' を追加（DROP IF EXISTS → ADD =
  0051 と同型・冪等）。lookupField は import_mappings.fields（既存 jsonb）の要素へ追加 = テーブル変更なし（0043 と同判断）。
- [x] **shared/domain/import-parse**: normalizeFieldLocators が lookupField を正規化（trim・120cp 切詰め・空 = null）
  → モック saveMapping / API importFieldsOf の双方が同一関数で保持（parity）。
- [x] **akebono-imports.ts**: 参照解決を `refLookupOf`（突合キー対応の解決器）へ集約。既定は従来の loadNameLookup +
  resolveByIdOrName を再利用（原則3）。custom.<key> はパラメータバインド・テーブル/列識別子はカタログ経由のみ（SQL 注入防止）。
  **許可リスト（id/name/custom.*）外・refEntity='sku' の誤用は暗黙フォールバックせず AKO-IMP-008 で遮断**（独立監査是正）。
  SKU 参照は `skuCondOf`（id / code / janCode = いずれも有効行のみ・既定 = id→code の従来挙動）で per-row 解決。
  重複割当の旧版マッピングでは lookupField を**最終行採用**（値の抽出 = 最後の行勝ちと整合。新規保存は重複割当自体を拒否）。
  apply 系（product/company/sales_record/inventory）を解決器経由に置換・隔離メッセージは突合キー名を明示（既定は従来文言 = 互換）。
- [x] **applyProductVariants（新規）**: 検証（AKO-IMP-008 = productCode/code 必須・軸2 は軸1 が前提・対象項目の重複禁止）→
  グルーピング（出現順・商品項目はグループ先頭の非空値 = 決定的）→ **行レベル事前検証（価格・SKU コード衝突）→ 商品 upsert →
  SKU upsert の順**（全行隔離のグループは商品を書かない = 検証起因の status='failed' はデータを変更しない。独立レビュー是正）。
  商品は (segment, code) 有効行キー = applyProducts と同一・空セルは既存値保持・軸ラベル更新。SKU 突合は**有効な実 SKU
  （NOT is_default）のみ** = 既定 SKU コード（商品コード）と衝突する行は実 SKU として新規作成し、後段の既定 SKU 無効化で
  置き換える（更新→無効化の非冪等を排除 = 独立レビュー MAJOR 是正）。グループ内の同一 SKU コード行は後勝ち更新に収束。
  実 SKU が新規に入った商品の既定 SKU を無効化（SKU マトリクス生成と同一挙動）。新規商品は既定 SKU を作らない。
  商品レベルの失敗はグループ全行を隔離・SKU レベルは行単位隔離（原則4）。再実行は upsert = 冪等（原則2）。
  **product_variant の run はエンティティ単位 advisory lock でも直列化**（取込元をまたぐ同一 SKU コードの並行 INSERT 防止。
  SKU コードに DB 一意 INDEX を張らない理由は §58-5）。
- [x] **POST /import-mappings**: 保存時に validateImportMapping（突合キー不正・バリアント構造不備 = AKO-IMP-008 400）。
  requireSource が target_entity を返すよう拡張。実行時にも refLookupSpec / applyProductVariants が再検証（旧データ防衛）。

### 58-3 実装（フロント）
- [x] **types/akebono.ts**: ImportTargetEntity に 'product_variant'・ImportFieldMap に lookupField?。
- [x] **useAkebonoImports.ts**: IMPORT_ENTITY_LABELS「商品＋SKU（バリアント展開）」・RELOAD_BY_ENTITY（products/productSkus）・
  saveMapping が保存前に validateImportMapping（API と同一関数・空行除外後の集合で検証 = サーバーと同じ対象）。
- [x] **imports.vue**: product_variant の右辺候補 = VARIANT_IMPORT_FIELDS ＋ 商品カスタム項目。バリアント軸取込の説明カード
  （グルーピングキー・固有 ID・軸割り当て = 列名が軸ラベルの例示）。参照項目の行下に**連携キー（突合項目）セレクト**
  （既定〔ID → 名称/SKUコード〕・参照先マスタの項目・取引先はカスタム項目も列挙 = useAppFields('company')）。右辺変更時に
  無効な突合キーを持ち越さない（onTargetItemChange）・保存時は参照項目のみ lookupField を保持（ロケータと同じ残骸防止）。
- [x] **utils/import-link.ts（新規）**: shared/domain/import-link の再エクスポート（utils/import-parse と同型）。

### 58-4 検証（実測値。この環境で実行）
- [x] `cd api && npm run typecheck` green / unit **288 passed**（import-link.test.ts 新規 = カタログ・検証・軸ラベル・参照項目の
  重複割当拒否 15 件＋ normalizeFieldLocators / importFieldsOf の lookupField 追試）
- [x] `cd api && npm run test:integration`（使い捨て PostgreSQL・migration 0053 適用）**234 passed**（+3）:
  - バリアント軸取込: 構造検証（AKO-IMP-008）→ アパレル形式 CSV（商品id/skuid/カラー/サイズ）取込 = 商品 1 件＋SKU 3 件・
    軸ラベル = 列名・固有 ID 欠落行は隔離（商品も作らない）・**再実行で商品/SKU が増えない（冪等）**・既存商品への実 SKU
    追加で既定 SKU 無効化・別商品に登録済みの SKU コードは隔離
  - 突合キー: 取引先 custom.extCode ＋ SKU janCode で売上明細を突合取込・不正キーは保存時 AKO-IMP-008・未解決行は
    突合キー名入りメッセージで隔離・**複数一致（同 extCode の 2 社）は解決せず隔離**
  - バリアント境界（独立レビュー是正の回帰）: **既定 SKU コード衝突行 = 実 SKU 新規作成 + 既定 SKU 無効化・再実行冪等**・
    未送信フィールド（JAN 空セル）の保持・グループ内重複 SKU コードの後勝ち収束・グループ全行隔離時は商品を作らない
- [x] `cd mockup && npm run typecheck` green / `npm test` **221 passed**（件数不変）
- [x] **migration 0053 冪等性**: DROP CONSTRAINT IF EXISTS → ADD は再適用安全。既存 target_entity 値はすべて許容 = 非破壊。

### 58-5 設計判断（記録）
- **「2 次元表・2 次元データ」の解釈**: 指示の例（商品id / skuid / カラー / サイズが**列**として存在）に基づき、
  カラー×サイズの 2 軸（= 2 次元）バリアントマトリクスの**縦持ち（long 形式）**を取込対象とした。行 = SKU（固有 ID）・
  2 軸の値列 = マトリクスの座標であり、取込結果は商品 × 軸1 × 軸2 の 2 次元表を構成する。ピボット済み（サイズが列見出しに
  展開された横持ち）の取込は固有 ID 列を持てないため対象外（必要になれば別方式として追加）。
- **軸ラベル = 列の論理名**: 「どの列が軸を成すか」の指定（axis1Value/axis2Value への割り当て）だけで軸ラベルまで決まる
  （追加入力なし = 原則1）。既存の variant_axis1_label/2（0032）・SKU axis1_value/2 をそのまま使い、スキーマ追加なし。
- **突合キーのカタログ制**: 参照先マスタに実在する列のみ許可（segments 等 = id/name・SKU = id/code/janCode・取引先 =
  id/name + custom.<key>）。companies に code 列は無いため、外部システムコードでの突合は**取引先カスタム項目**（F-31）で
  実現する（custom jsonb を持つのは取引先のみ = allowCustom を company に限定）。
- **取消可能性（原則9.5）**: 新設の取込対象・突合キーは既存の取消フローに乗る（取込元 = 論理削除/復元・マッピング = 新版
  上書きで旧版履歴・反映済み商品/SKU = 編集/無効化）。§48-1 の残課題（取込の一括取消）はスコープ外のまま変わらず。
- **SKU コードに DB 一意 INDEX を張らない判断（監査 MINOR-3 への対処記録）**: 商品コードの一意性は
  「セグメント × 有効行」（products_segment_code_active_idx）のため、**セグメント違いの同一商品コード = 同一の
  既定 SKU コードが正当な既存データとして存在しうる**（applySkus / applySalesRecords が「一意でない = 隔離」を
  持つのはこのため）。`product_skus (code) WHERE active` の一意 INDEX はこの正当データを破壊する（原則7 違反）ため
  採用せず、①アプリ層の LIMIT 2 検査（既存パターン）②product_variant run のエンティティ単位 advisory lock
  （取込元をまたぐ並行 INSERT の直列化）で防御する。**残余（記録）**: 手動 SKU 経路（マトリクス生成・
  PATCH /product-skus の code 変更）はコード重複検査・エンティティロックに参加しないため、取込×手動の競合では
  重複有効コードが生じうる（0053 以前から手動経路単独で生成可能 = 本変更による後退ではない。消費側の LIMIT 2
  隔離で機害は封じられている。第 2 巡監査 NIT-B）。

### 58-x 反復レビュー（原則9）
- [x] **セルフレビュー（Push 前チェック）**: 手動ステップなし（マッピング UI で完結）/ 冪等（0053 冪等・商品/SKU upsert・
  再実行で増殖しない = 統合テスト実測）/ 既存コード再利用（loadNameLookup/resolveByIdOrName・rowWrite・capCp・
  マトリクス生成の既定 SKU 無効化と同型）/ 非ブロッキング（既定 SKU 無効化の失敗は握りつぶし = 原則4）/
  ドキュメント全件更新（functional-requirements F-32-2・akebono-menu-design・api-design §2/§4・architecture・
  data-design・本 §58）/ 波及は Grep で確認（ImportTargetEntity・IMPORT_ENTITY_LABELS・normalizeFieldLocators 消費箇所）/
  SoT→キャッシュ（run 後に products/productSkus 再ロード）/ 下位互換（lookupField 未設定 = 従来解決・既存 5 対象の
  文言/挙動不変）/ レスポンシブ（追加 UI は flex-wrap・既存スクロール容器内）/ 取消可能性（§58-5）。
- [x] **独立レビュー / 監査（コードレビュアー + システム監査官・並行）第 1 巡**: MAJOR 1・MINOR 計 6（重複含む）・NIT 計 6。
  - **MAJOR（レビュー）: 既定 SKU コード衝突行の非冪等**（既定 SKU を UPDATE → 直後の無効化で消え、再実行と結果が分岐）
    → SKU 突合を `AND NOT is_default` に変更（衝突行は実 SKU として新規作成 → 無効化で置き換え = マトリクス生成と同じ収束）。
  - **MINOR（両者）: product_variant の counts/status が商品書込を反映しない**（全行隔離でも商品が書かれ status='failed' と
    実書込が乖離）→ 行レベル検証（価格・SKU 衝突・新規作成の前提）を商品書込前へ移動し、全行隔離グループは商品を書かない。
  - **MINOR（監査）: refLookupOf のカタログ外キーの暗黙 id フォールバック** → 許可リスト外・sku 誤用を AKO-IMP-008 で遮断。
  - **MINOR（レビュー）: 重複 targetItemKey 時の lookupField 先頭行採用 vs 値の最後行勝ちの不整合** → 保存時に参照項目の
    重複割当を全対象で拒否 + 実行時（旧版）は findLast で値抽出と整合。
  - **MINOR（レビュー）: skuCondOf('id') に active 条件がなく宣言と矛盾** → `AND s.active = true` を追加（既定パスの
    id 素通しは従来挙動のため不変 = 下位互換）。
  - **MINOR（監査）: product_skus.code の DB 一意制約なし（並行 INSERT の重複）** → 一意 INDEX は既存正当データを壊すため
    不採用（上記 §58-5 に判断を記録）。エンティティ単位 advisory lock で並行実行を直列化。
  - **MINOR（レビュー）: 未送信フィールド保持の回帰テスト欠落（CLAUDE.md Zod v4 節の方針）** → JAN 空セル再取込での保持・
    グループ隔離・グループ内重複コードの統合テストを追加（integration +1 = 234）。
  - **NIT（両者）: モック saveMapping の空行除外が trim なしで API と微差** → trim に統一。
  - **NIT（監査）: 消滅したカスタム項目キーが UI セレクトで空表示** → 「（候補に無いキー）」として可視化（黙って消さない）。
  - **NIT（監査）: セグメント未割当の新規商品グループの隔離メッセージが空鉤括弧** → 文言分岐（「事業セグメントが空のため隔離…」）。
  - 許容（是正不要）: custom.<key> の実在検証は行わない（定義削除後も companies.custom に実データが残存しうるため、
    保存拒否は正当な突合を塞ぐ。UI の可視化で対処）/ 既定解決（id 素通し）の active 非限定は従来挙動の維持（原則7）。
- [x] **再検証（是正後）**: api typecheck green・unit **288 passed**・integration **234 passed**・mockup typecheck green・
  **221 passed**（原則9「直した結果も問題ない」）。
- [x] **独立レビュー / 監査 第 2 巡（同一 2 ロールによる是正差分の再検証）**: 第 1 巡指摘は**全件解消**を両ロールが確認。
  新規指摘は MINOR 1・NIT 2 → 全件是正・記録:
  - **MINOR-A（監査）: NOT is_default 除外により「別商品の既定 SKU とのコード衝突」ガードが後退**（誤マッピングで
    別商品の既定 SKU コードと重複する実 SKU が作られうる）→ 事前突合を既定込みで取得し、別商品ヒットは既定/実を
    問わず隔離・自商品の既定ヒットのみ新規 INSERT（MAJOR 是正の効果は維持）。回帰統合テストを追加。
  - **NIT（両者）: 参照項目の重複割当エラーメッセージが生キー表記**（他エラーは和名）→ 参照先マスタ名＋項目キーの
    表記へ統一（「〇〇を参照する対象項目（key）が複数行に…」）。
  - **NIT-B（監査）: 取込×手動 SKU 経路の並行競合の残余**（既存クラス・本変更による後退ではない）→ §58-5 に記録。
- [x] **再検証（第 2 巡是正後）**: api typecheck green・unit **288 passed**・integration **234 passed**（別商品既定 SKU
  衝突の隔離を追加）・mockup typecheck green・**221 passed**。
- [x] **独立レビュー / 監査 第 3 巡（最終確認）**: 両ロールとも第 2 巡指摘の**全件解消**と是正差分の**副作用なし**を確認。
  コードレビュー = **指摘ゼロ**（既定 SKU 衝突の全 7 ケースをマトリクス検証・混在ケースの更新継続は冪等性上必要と判定）。
  監査 = 機能・セキュリティ・整合性の指摘ゼロ・文言 NIT 1 件（api-design §2 の「既定 SKU コード衝突」に自商品限定の修飾）
  → 即時是正（「自商品の既定 SKU コード衝突行のみ…別商品ヒットは既定/実を問わず隔離」へ追記）。
  **未解決指摘ゼロ = 原則9 の完了条件を充足し反復レビューを完了。**

## 59. マッピング「変換」の選択式化（オペレーター指示 2026-08-07 ②）の完了条件（Definition of Done）

> オペレーター指示 2026-08-07 ②「マッピングを設定の『変換』において、何を入力すべきなのか、入力すると何が起きるのかが
> わからない。選択式にして説明付きにして選びやすいようにしてください」への対応。
> ブランチ `claude/akebono-import-linking-scsqkq`（§58 マージ後に main から再作成）。

### 59-1 実装
- [x] **shared/domain/import-run.ts**: 変換カタログ `IMPORT_TRANSFORMS`（value/label/hint）を applyImportTransform と
  同居で新設（1:1 を保つ = 変換追加時は両方更新のコメント明記。'' = 変換なし / number = 数値化〔¥・カンマ除去〕/
  date = 日付化〔YYYY-MM-DD へ統一〕/ upper・lower = 大文字/小文字化。各選択肢に具体例つき説明）。
- [x] **imports.vue**: 変換の自由入力（input）→ **選択式（select）**へ置換。選択肢ラベルに要約・title に具体例つき説明
  （選択中の値の説明も select の title で表示）。モーダル冒頭の説明文も「変換 = 取込時に値を整形する処理」へ更新。
  **旧版マッピングのカタログ外自由入力値（trim/dateFormat 等）は「（旧設定の値）」として可視化**（黙って消さない =
  連携キーの消滅カスタムキー可視化と同型。実行時挙動は従来どおり素通し = 前後空白のみ除去で不変 = 原則7）。
- [x] **utils/import-run.ts（新規）**: shared 再エクスポート（utils/import-parse・import-link と同型）。
- [x] 単体テスト: IMPORT_TRANSFORMS の value 集合が applyImportTransform の分岐と一致・全選択肢に label/hint がある
  ことを検証（api unit **289 passed** = +1）。
### 59-2 検証（実測値）
- [x] api typecheck green / unit **289 passed** / mockup typecheck green / **221 passed**（挙動変更なし = UI と
  カタログのみ。取込エンジン・保存形は不変のため integration は §58 の 234 から変更なし）
### 59-x 反復レビュー（原則9）
- [x] **独立レビュー / 監査（コードレビュアー + システム監査官・並行）第 1 巡**: MAJOR 0・MINOR 4（両者重複含む）・NIT 4。
  全件是正:
  - **MINOR（両者）: モックシードのマッピングが旧自由入力値（dateFormat/trim/numberFormat = no-op）のまま**で、
    デモの初見が全行「（旧設定の値）」になる → カタログ値（date / '' / number / number）へ移行（設定系シードの整備。
    実データ保護の原則7 対象外）。
  - **MINOR（両者）: ImportFieldMap.transform の JSDoc が旧記述（dateFormat 等・空 = 恒等）** → カタログ参照＋実挙動
    （'' = 変換なし・前後空白は常に除去・カタログ外は素通し）へ更新。
  - **MINOR（両者）: akebono-menu-design §5.2 の変換値域（v1 構想 = zenhan/fixedValue/codeLookup 等）が実装と乖離** →
    「実装済みの値域（SoT = IMPORT_TRANSFORMS）」の注記を追加（codeLookup 構想は lookupField として実装済みと明記）。
    functional-requirements F-32-2 にも参照注記。
  - **MINOR（監査）: 説明の伝達が title 属性のみでモバイルに届かない** → 変換選択中は行下に説明キャプションを常時表示
    （可視テキスト。モーダル冒頭の散文列挙は要約へ縮約 = カタログとの二重管理も解消〔レビュー NIT〕）。
  - **MINOR（レビュー）: select 化で最長ラベルが列の min-content を支配し横スクロールが早まる** → 右辺/変換列を
    minmax(0, Nfr) 化（選択中は切詰め・ドロップダウンは全文）。
  - **NIT（レビュー）: 「1:1 検証」テストは逆方向（switch 追加のカタログ更新漏れ）を検出できない** → テスト名を
    「対応集合に固定」へ改め、変換追加時の 3 点同時更新（switch・カタログ・テスト）を注記。
  - **NIT（レビュー）: 旧値 fallback option に title なし** → transformHint を付与。
  - 許容（是正不要・記録）: 旧値からカタログ値へ切り替えると旧値 option が消える（キャンセルで復帰・版管理で旧版も
    残る = 連携キーの既存パターンと同型）。
- [x] **再検証（是正後）**: api typecheck green・unit **289 passed**・mockup typecheck green・**221 passed**。
- [x] **独立レビュー / 監査 第 2 巡（実績）**: 監査 = **指摘ゼロ**（是正 8 件すべて妥当・新規問題なし）。
  レビュー = 第 1 巡指摘の全件解消を確認・新規は NIT 2 件（①カタログコメントの同時更新注記が switch＋カタログの
  2 点のままでテストに触れていない → 3 点同時更新へ修正 ②本記録の「第 2 巡で指摘ゼロ」が検証実施前に既成事実として
  記載されていた → 実績記載へ改め、以後は検証確定後に記録する運用とする）→ 両件是正し、レビュアーの事前宣言
  「この 2 件の是正確認をもって未解決指摘ゼロ」に基づき第 3 巡で解消を確認。**未解決指摘ゼロ = 原則9 充足で完了。**

## 60. 取込・マスタ・棚卸のオペレーター指示（2026-08-09）の完了条件（Definition of Done）

> オペレーター指示 2026-08-09（4 件）:
> ① `/akebono/imports`「マッピングを設定」を**取込対象基準**（取込対象の項目を左辺に固定・右辺で取込元を割当）へ。
> ② 事業セグメントは各取込項目の列取込でなく「取込元を追加」で選択し、取込元配下の全定義で共通適用。
> ③ `/akebono/masters` にも `/akebono/imports` と同様の外部データ取込機能を持たせる。
> ④ 「項目カスタマイズ後、データ取込・連携で取込先の項目が選択できない」不具合の是正。

### 60-1 マッピングの取込対象基準化（①）
- `imports.vue` のマッピング編集を反転: 左辺 = 取込対象の項目（固定行 = `targetFields`。既定＋カスタム／
  company・product_variant・master_* を含む）・右辺 = 取込元の列/キー割当（CSV/Sheets/JSON は検出候補の
  `datalist` 付き入力、固定長はバイト範囲）。取込元の検出（CSV アップロード・Sheets 列検出・JSON キー抽出）は
  行生成でなく**検出候補**を貯め、名称一致（対象ラベル/キー = 列名/キー）で自動割当。
- 未割当の必須項目は保存前に警告（保存は可・実行時は該当行を隔離）。突合キー（連携キー）UI は参照項目のみ表示（従来同）。

### 60-2 事業セグメントの取込元単位化（②）
- 型 `ImportSource.segmentId` と `SEGMENT_SCOPED_IMPORT_ENTITIES`（product / product_variant / sales_record）を追加。
  「取込元を追加」でセグメントを持つ取込対象のみ選択欄を出し**必須**化。詳細ヘッダ・マッピング編集にも表示。
- API（0054）: `import_sources.segment_id` 追加。実行時、セグメントを持つ取込対象で `segment_id` 設定済みなら
  全レコードへ共通注入（`segments.resolve` は id 一致優先 = 実 ID 注入でそのまま解決）。**未設定 = 従来のマッピング列
  解決へフォールバック**（既存取込元は非破壊 = 原則7。データ更新パッチ不要 = NULL のまま従来動作）。
- 取込元にセグメント設定済みなら、マッピング左辺の `segmentId` は自動的に除外（列取込との二重設定を防ぐ）。

### 60-3 共通マスタの外部データ取込（③）
- `shared/domain/import-master.ts`（SoT）: 8 マスタ（事業セグメント/倉庫/商品カテゴリ/単位/税区分/回収支払条件/
  バリアント軸テンプレート/画像セクション）の取込カタログ（対象項目・DB 列・種別/値域・参照）。委託条件は複合キー・
  精算設定のため対象外（設計判断）。値解析 `parseMasterFieldValue`（数値/整数/真偽/enum/multiEnum・和名/内部値）。
- API: `IMPORT_ENTITIES` に `master_*` を追加、汎用反映エンジン `applyMasterEntity`（名称突合の upsert・空セルは
  変更しない・参照突合・保存時検証の再防衛・エンティティ単位の並行直列化）。CHECK 制約拡張（0054）。
- フロント: `imports.vue` が `master_*` を取込対象・マッピング左辺に対応（= ④の是正も内包）。`masters.vue` に
  「外部データ取込・連携（マスタ）」セクション（共有コンソール `/akebono/imports` への導線＝原則3。`?add=master`／
  `?source=<id>` の深いリンクで追加/選択を開く。マスタ取込元の一覧・実行回数を可視化）。

### 60-4 取込先項目が選択できない不具合の是正（④）
- 根因: `master_*` 取込対象に `targetFieldOptions` の分岐が無く、右辺の候補が空だった（③の途中配線）。
  取込対象基準化（60-1）で左辺を `targetFields`（master 分岐を含む）へ一本化して解消。
- 併せて `settings/items.vue` の項目カスタマイズ説明の陳腐化（「データ取込への反映は順次対応」）を是正
  （既定/カスタム項目はマッピング項目として選択可 = 実装済み。一覧表示反映のみ残課題）。

### 60-5 棚卸の対象拡張（オペレーター要望「棚卸機能がほしい」への対応）
- 既存の棚卸機能（在庫管理タブ・`useInventory.stocktake`・API `/inventory/stocktake`）は稼働済み。実運用の穴
  （システム上0だが実在する SKU = found を数えられない = `balancesOfWarehouse` が qty 0 を除外）を是正。
- `inventory.vue` 棚卸タブに「在庫0の SKU も表示」トグル（全アクティブ SKU を対象化）・SKU 名絞り込み・入力保持
  （絞り込み/表示切替で入力が消えない = 入力済み全件を確定対象に）を追加。API 変更不要（任意 SKU を受理済み）。
- 残課題（未対応・記録のみ）: 棚卸セッションの永続化（下書き保存/再開・棚卸差異表の出力）・カウントシート CSV 取込。

### 60-6 検証（実測値）
- API: typecheck green・unit **300 passed**（`import-master` 10 件追加・`import-link` カタログ検証更新）。
- mockup: typecheck green・unit **221 passed**。

### 60-7 未対応・別スコープ（記録）
- **ページング＋検索（設定可能な検索項目）**: 全アプリの一覧が全件取得のため、表示単位のページングと、項目
  カスタマイズで「検索に使うか」を設定できる検索機能を追加する指示（2026-08-09）。データ取得基盤の作り替え
  （集計ダッシュボード・横断参照が全件在庫を前提）を伴う大規模・高リスク変更のため、設計合意の上で別途対応する。
- **ai-office-suite（takahiro0428）の踏襲候補調査**: 別オーナーのため本セッション（tsunaguba）へ追加不可。
  TSUNAGUBA org へのフォーク/インポート後に着手可能。

### 60-x 反復レビュー（原則9）
- **独立レビュー / 監査 第 1 巡（実績）**: MAJOR/データ喪失/SQL インジェクション/デッドロックは無し。以下 MINOR/NIT を是正。
  - **MINOR-1**: `master_warehouse.kind` は DB NOT NULL・既定値なしなのにカタログが `requiredOnCreate` 未設定 →
    新規作成で空 INSERT が 23502 を漏らす。`requiredOnCreate: true` を付与（未割当は明示メッセージで隔離）。
  - **MINOR-2**: マスタ `name` がカタログ `maxLen` で切詰められていない（他項目・他エンティティと不整合）→
    `applyMasterEntity` で `capCp(name, maxLen)`。
  - **MINOR-3**: 取込元セグメント注入時、旧版マッピングが `segmentId` に名称突合キーを持つと注入 id が解決不能 →
    セグメント適用時はマッピングの `segmentId` 行を除外（既定 id→名称 解決に統一）。
  - **MINOR-4**: 取込対象基準化で左辺を固定行スナップショットにしたため、遅延ハイドレーションのカスタム項目が
    モーダル開後に反映されない → `targetFields` を watch し、入力を保ったまま新規対象項目行を追加。
  - **NIT-6**: multiEnum の区切り文字のみセル（"," 等）が `[]` になり既存値を潰す → 実値なしは null（無変更）。
  - **NIT-7**: 実行時にセグメントが無効化されていると行ごとに同一隔離が多発 → 実行前に単一エラー（AKO-IMP-009）で停止。
  - 許容（記録）: **NIT-5** 商品カテゴリの親参照は循環ガードなし = 既存 CRUD の設計（UI が階層提示）と一貫のため
    取込側だけに導入せず据え置き。
- **再検証（是正後）**: api typecheck green・unit **301 passed**（`import-master` に NIT-6/MINOR-1 の回帰を追加）・
  mockup typecheck green・**221 passed**。**未解決指摘ゼロ = 原則9 充足で完了。**

## 61. 一覧のサーバーページング＋検索の横展開・仕入先ビュー導線・在庫調整の取消（オペレーター指示 2026-08-09 ②）の完了条件（Definition of Done）

- **背景**: データ件数の増加に耐える一覧（検索＋ページング）を全一覧へ横展開する。方式はサーバー側ページングを基本とし、
  同一コレクションから集計・グラフ・横断導出を行う一覧は全件ハイドレーションを保ったままクライアント側ページングとする
  （原則6 = 派生・KPI を壊さない I/F ファースト）。併せて仕入先ビューの導線改善と、追記系（在庫台帳）の取消フロー（原則9.5）を補完する。

### 61-1 共通基盤（横展開の唯一の実装 = 原則3）
- [x] `components/ui/UiPagination.vue`: レスポンシブなページング UI（PC=横並び／モバイル=折返し・原則8）。`page`（1 始まり）・
  `pageSize`・`total` を props、`update:page`/`update:pageSize` を emit。件数 0 は非表示（空状態はテーブル側が担当）。
- [x] `composables/useListView.ts`: 検索＋ページングのデュアルモード共通コントローラ。
  - モック／`fetch` 未指定: `source`（全件 ref）をクライアント側で絞込・スライス。
  - API モードかつ `fetch` 指定: `q/limit/offset` をサーバーへ渡し `{ rows, total }` を反映（検索は 250ms デバウンス・
    ページ／件数変更は即時・遅延応答は seq ガードで破棄・取得失敗は非ブロッキング＝原則4）。
  - 検索語・表示件数の変更で 1 ページ目へ戻す（両モード共通）。ソース縮小時のページはみ出しを補正。

### 61-2 API（サーバーページング＋検索・下位互換）
- [x] `api/src/lib/list-query.ts` `runListQuery`: `limit/offset/q` の**いずれも無いとき**は従来どおり maxLimit までの
  bare 配列（`{ data }`）を返し、既存の全件ハイドレーション経路（`useApi.loadApiCollection`）を厳密に維持（原則7）。
  パラメータが来たときのみ `COUNT(*)` を伴うページ取得へ切り替え、`total` を**兄弟キー**として付与（配列は依然 `data`）。
  検索列はコード定義のみ・`q` はパラメータ化（インジェクション不可）。
- [x] 適用エンドポイント（記録系一覧）: purchase-orders / production-orders / inbound-plans / inbound-results /
  purchase-records / outbound-plans / outbound-results / inventory-transactions（trade）、sales-records / invoices /
  payment-notices / payment-receipts（billing）、import-runs（imports）。検索列は各テーブルの code・状態・日付（`::text`）等。
- [x] `useApi.ts`: `apiFetchList`（envelope から `total` を読む専用経路。`total` 無しは `rows.length` へフォールバック）＋
  `apiListPage(collection, params)`（`CUSTOM_COLLECTION_ENDPOINTS` からパス解決）。認証ヘッダ生成を `authHeaders()` に共通化。

### 61-3 フロント横展開
- [x] **サーバーページング**（純粋な記録系一覧・同一コレクションの同ページ集計なし）: 発注 / 仕入 / 生産 / 入荷予定 / 出荷指示。
  書込（作成・状態遷移・実績登録）後は `refresh()` で現在ページを取り直す（クライアントは自動追従）。
  - 位置づけ: 一覧の**描画をページ単位**に絞り、**検索は全行に対してサーバー側**で効く（ハイドレーション済みの
    可視分だけでなく全件対象）ことが主眼。詳細ドロワーや消込導出（`orderById`/`receivedQtyOf` 等）は従来どおり
    ハイドレーション済みコレクションを参照するため全件ロード自体は残る（この設計上の判断を明記＝原則5）。
    件数超大時に全件ロードを外すには詳細取得の単票 API 化が必要で、本バッチのスコープ外（同基盤の上に後続で対応可能）。
- [x] **クライアントページング**（同一コレクションの集計・グラフ・横断導出を保つ）: 商品 / 顧客(会社) / 共通マスタ /
  売上明細 / 在庫照会・受払台帳 / 取込実行履歴 / 請求（請求・マージン・支払通知・入金対象・入金履歴の 5 一覧）。
- [x] 意図的に非対象（件数が構造的に小さい・据え置きを記録）: 業態別サマリー（company）・設定/業態・設定/項目・
  取込元/マッピング一覧・ダッシュボード。今後件数が増える兆候が出た時点で同基盤で横展開する。

### 61-4 仕入先ビューの導線改善
- [x] 仕入先は別マスタではなく取引先（会社）に `partnerRoles='supplier'` で内包される。顧客(会社)マスタに
  **取引ロールフィルタ**を追加し、メニューに「仕入先」カード（`/masters/customers?role=supplier` のディープリンク）を新設。
  クエリ `role` は既知ロールのみ受理（不正値は無視）。「仕入先が別画面になくて分かりにくい」導線問題を解消。

### 61-5 在庫調整の取消（原則9.5・追記系の正しい取消 = 反対仕訳）
- [x] 在庫台帳は追記のみが SoT のため物理削除せず、**反対仕訳**（qty 反転・`ref_type='reverse'`・
  `ref_line_id=<元 refType:refLineId>`）を追記して残高を戻す。監査ログ付き＝記録系の取消の正しい形。
  移動は出/入の 2 行をまとめて反対仕訳。冪等 = UNIQUE(ref_type, ref_line_id, kind) + 二重取消は 409（AKO-INV-008）。
  実績・入出荷・仕入・生産は各画面の取消経路があるため対象外（reverse は 400 = AKO-INV-007）。
  API `POST /v1/akebono/inventory/reverse`・`useInventory.reverse/reverseStateOf`・受払台帳に取消ボタン／取消済みバッジ。
- [x] これにより §60 で新設した**棚卸**の取消フロー未整備（原則9.5 の残課題）を解消。調整・移動も同経路でカバー。

### 61-6 検証
- [x] api typecheck green・mockup typecheck green。
- [x] api unit **301 passed** / mockup unit **221 passed**。
- [x] api 統合 **240 passed**（新規: パラメータ無し=bare 配列で `total` 無し＝下位互換／`limit/offset/total`＝offset 不変・
  ページ跨ぎ非重複／検索 `q` で total 縮小・返却行の一致／在庫調整の取消で残高復帰・二重取消 409・反対仕訳の再取消 400／
  移動の 2 行取消で残高復帰）。
- [x] 独立レビュー / 監査の反復（原則9）: <!-- 反復レビュー結果をここに記載 -->

### 61-7 下位互換・データ影響
- [x] スキーマ変更なし（反対仕訳は既存 inventory_transactions への追記のみ・移行不要）。API 一覧はパラメータ無しで
  従来レスポンス（bare 配列）を厳密維持するため、既存クライアント・全件ハイドレーション・統合テストは無改修で動作。

## 62. バリアント軸取込に商品レベル属性（既定仕入先＝作家・税区分・単位・説明）を追加（オペレーター報告 2026-08-10）の完了条件（Definition of Done）

> オペレーター報告「項目設定で編集した『作家』が取込・連携のマッピングに出てこない」。作家 = 商品の既定仕入先
> （`defaultSupplierCompanyId`・item-settings のラベル差分で「作家」へリネーム）。原因は **バリアント軸取込
> （`product_variant`）のマッピング左辺が `VARIANT_IMPORT_FIELDS` の固定カタログ＋商品カスタム項目のみ**で、
> 既定項目（builtin）の `defaultSupplierCompanyId` が欠落していたこと（通常の `product` 取込は `appFields('product')`
> 経由で表示されるため事象は `product_variant` に固有）。同クラスの商品レベル属性（税区分・単位・説明）も未対応だったため一括で是正。
> ブランチ `claude/akebono-import-linking-scsqkq`（§61 マージ後に main から再作成）。

### 62-1 実装
- [x] **shared/domain/import-link.ts**: `VARIANT_IMPORT_FIELDS` に商品レベル属性 `defaultSupplierCompanyId`（既定仕入先）・
  `taxRateId`（税区分）・`unitId`（単位）・`description`（説明）を追加（`product` 取込と同集合。billingType＝IT サービス課金・
  variantAxes＝軸は列から導出、の 2 つは product_variant では対象外と明記）。`IMPORT_REF_TARGETS.product_variant` に
  `defaultSupplierCompanyId: COMPANY`・`taxRateId: TAX_RATE`・`unitId: UNIT` を追加し、商品取込と同じ連携キー（突合キー）機構に乗せる。
- [x] **api/src/routes/akebono-imports.ts（applyProductVariants）**: `importRefLookup` で作家/税区分/単位を解決（グループ先頭の
  非空値・未指定=変更しない・未解決=グループ隔離。`unresolvedRefMsg` は既定カタログ名『既定仕入先』等で表示 = applyProducts と一致）。
  商品 INSERT/UPDATE に `default_supplier_company_id`・`tax_rate_id`・`unit_id`・`description` を追加（空セルは変更しない = 既存値保護）。
  `assertKnownTargets` は `VARIANT_IMPORT_FIELDS` 由来のため追加キーを自動許容。
- [x] **imports.vue**: `product_variant` の左辺ラベルに**商品カタログのテナントラベル差分**（`builtinResolved('product')`）を重ねる
  （例: 既定仕入先→作家）。`code` は SKU 固有 ID（商品コードではない）ため商品カタログの `code` ラベルでは上書きしない。

### 62-2 検証
- [x] api typecheck green・mockup typecheck green。
- [x] api unit **301 passed**（import-link.test.ts に product_variant の参照＝company/tax_rate/unit・カタログ項目に商品レベル属性を追加）。
- [x] api 統合 **241 passed**（+1: 作家＝既定仕入先を**名称で突合**して商品へ反映・税区分/単位を ID で突合・**未解決作家グループは
  商品も作らず隔離**〔『既定仕入先』入りメッセージ〕）。既存のバリアント取込テスト（軸ラベル・冪等・別商品 SKU 衝突）は不変で通過。

### 62-3 下位互換・データ影響（原則7）
- [x] スキーマ変更なし（`products.default_supplier_company_id`/`tax_rate_id`/`unit_id`/`description` は既存列 = applyProducts が既に使用）。
  マッピングは追記のみ（既存 `product_variant` マッピングは追加項目未割当 = 従来どおり動作）。`VARIANT_IMPORT_FIELDS` への項目追加は
  カタログ拡張のみで既存の検証・保存・実行を破壊しない。フロントのラベル差分反映はテナント未リネーム時は既定カタログ名を表示（無影響）。

## 63. 日付変換の日時対応・棚卸のマイナス在庫許容（オペレーター報告 2026-08-10）の完了条件（Definition of Done）

> オペレーター報告 ①「取込・連携の日付変換が不完全。発生日『2026/08/09 19:40:48』が YYYY-MM-DD でないため隔離される」。
> ② 「在庫の取込・連携は棚卸として取り込むことがあり、その場合は実物理在庫数が取込元になる。マイナス在庫数も可とするため、
> 負の値への制約を排除する」。ブランチ `claude/akebono-import-linking-scsqkq`（§62/PR #107 マージ後に main から再作成）。

> **スコープ確定（オペレーター確認 2026-08-10）**: 「棚卸として実物理在庫数を取り込む」経路について確認したところ回答は
> **「両方」**。すなわち ⓐ 手動棚卸画面（在庫管理タブの実棚入力 → `/inventory/stocktake`）と ⓑ データ取込 F-32
> （`kind=stocktake` で実物理在庫数を取込む）の**両経路**で「実物理在庫数を絶対値として受け、理論在庫との差分を計上・
> マイナス可」とする。当初 §63-3 で ⓑ を別スコープとしていたが、確認結果に基づき**本 DoD に取り込み**、両経路を実装した。

### 63-1 実装：`date` 変換の日時（時刻付き）対応
- [x] **shared/domain/import-run.ts（applyImportTransform）**: `date` 変換の正規表現に**時刻/TZ 様文字列の切り落とし**を追加。
  `^(\d{4})[/.\-]?(\d{1,2})[/.\-]?(\d{1,2})(?:[T ][\d:.+\sZz-]*)?$` とし、日付部の後に**空白 or `T` の後に時刻/TZ 様の文字
  （数字・`:`・`.`・`+`・`-`・`Z`）**が続く値を日付部のみへ正規化する。例: 「2026/08/09 19:40:48」「2026-08-09T19:40:48+09:00」→
  「2026-08-09」。日付部を含まない値（例: 「19:40:48」）・**日付の後が時刻様でない値（自由記述・日付レンジ等）は変換せず素通し**
  = 呼び出し側の `DATE_RE`（akebono-imports.ts）で隔離（ゴミ列を黙って日付へ強制しない = レビュー MINOR 是正）。
- [x] **IMPORT_TRANSFORMS カタログの hint と docstring** を更新。hint は日時例に**自前の結果**を与える（`「2026/08/09 19:40:48」→
  「2026-08-09」`。4 入力を単一結果に束ねる誤案内を是正 = レビュー MINOR）。カタログの value 集合（`'' / number / date / upper /
  lower`）は不変 = UI 選択肢・対応集合テストは追加なしで維持（原則5）。
- **設計判断**: 隔離メッセージの案内どおり「列に `date` 変換を指定すれば通る」を成立させる層（＝変換）で解決する。
  `DATE_RE` 自体は緩めない（変換未指定で日時を暗黙受理すると、誤った列マッピングを検知できなくなるため = 選択式変換の設計と一貫）。

### 63-2 実装：棚卸確定（手動画面 ⓐ）のマイナス実棚数を許容
- [x] **api/src/routes/akebono-trade.ts（POST /inventory/stocktake）**: 実棚数 `actualQty` の受理条件を
  `actualQty < 0 || actualQty > 1_000_000` → `Math.abs(actualQty) > 1_000_000` へ変更（**負値許容・整数かつ絶対値上限のみ**）。
  差分計上（`diff = actualQty − 理論在庫`）・冪等・advisory lock 直列化は不変。台帳 `postInventory` は残高フロアを持たないため
  マイナス残高もそのまま反映（在庫調整 −2 等の既存挙動と一貫）。
- **parity（原則6）**: モック `useInventory.stocktake` は元から負値制約なし・フロント `inventory.vue` の実棚入力欄も `min` なし
  （`type=number step=1`）で負値入力可。従来は**API だけが `actualQty < 0` で厳しく parity が崩れていた**のを解消（API＝モック＝フロント一致）。

### 63-3 実装：F-32 在庫取込（ⓑ）を「実物理在庫数→理論差分」の意味論へ
- [x] **api/src/routes/akebono-imports.ts（applyInventory）**: `kind` 別に `qty` の意味を切り替える。
  - **adjust（調整）**: 従来どおり `qty` = **増減数（デルタ）**をそのまま台帳へ追記（`qty=0` は無意味なため隔離）。
  - **stocktake（棚卸）**: `qty` = **実物理在庫数（絶対値）**として受け、**理論在庫（残高）との差分（実棚数 − 残高）を計上**
    （手動棚卸 `/inventory/stocktake` と同一意味論）。実物理在庫数は**マイナスも 0 も可**。差分 0（実棚数＝残高）は
    `postInventory` が `qty=0` でスキップ。
- [x] **排他制御（C-1）**: 棚卸の差分計上は残高の read-then-post のため、`akebono-trade` から `lockInventoryKeys` を
  **export して再利用**（原則3）。第1パス（解決・検証・DB read）→ **棚卸キーのみ**を**ソート取得の advisory lock**
  （`lockInventoryKeys`。調整は残高非依存のデルタ追記のためロック不要）→ 棚卸キーの残高を**1 クエリで先読み**（`SUM(qty)
  GROUP BY sku_id, warehouse_id` = 行ごと SELECT の N+1 を回避）→ 第2パス（差分計上・追記）の順で、手動棚卸・出荷/移動
  および他取込元の在庫取込と直列化（キー順一致でデッドロック回避。ラン全体は `imprun:sourceId` ロック内 = 同一取込元は直列）。
  第2パスは**実際に追記された分（qty）だけメモリ上の残高を進める**ため、同一 SKU×倉庫の複数行・調整→棚卸の混在も
  トランザクション内で正しく収束（ON CONFLICT スキップ時は残高を進めない = 台帳と一致）。
- [x] **冪等（原則2）**: `refLineId` フィンガープリントに**取込値**（棚卸=実棚数/調整=増減数）を含める。同一ファイル再取込は
  同一フィンガープリント＋差分 0 でスキップ = 二重計上なし。**古い棚卸値による意図しない上書きも防ぐ**（再取込しても実棚数を再強制しない）。
- **意味論の注記**: 対象項目 `qty` の item-settings ラベルは「増減数」のままだが、`kind=stocktake` の取込では実物理在庫数として解釈する
  （kind 別解釈）。隔離メッセージも kind 別（stocktake=「実在庫数が整数でない」・adjust=「増減数が 0 以外の整数でない」）。
  UI ラベルの kind 別出し分けは UX 追補として §63-7 に残課題化。

### 63-4 検証（実測値）
- [x] api typecheck green・mockup typecheck green。
- [x] api unit **302 passed**：`applyImportTransform` に日時ケース（`2026/08/09 19:40:48`・ISO・区切り差・時刻のみ素通し・
  時刻様でない後続は素通し）を追加。
- [x] api 統合 **242 passed**：ⓐ 手動棚卸に**マイナス実棚数**（wh-01 実棚 −3〔理論 6〕→ −9 調整・残高 −3。後続用に 6 へ復元）・
  ⓑ **棚卸/調整 CSV 実取込**（棚卸: 実物理在庫数 50 → 残高 50・同一ファイル再取込は冪等スキップ・−5 取込で残高 −5／調整: +10 デルタ・
  再取込スキップ／同一 SKU×倉庫の複数行 20→7 で残高 7 に収束）を追加。
- [x] mockup typecheck green・unit **221 passed**（モック `runImport` 非APIは合成ラン記録のみで実 apply を持たない = applyInventory の
  parity 対象外。手動棚卸 `useInventory.stocktake` は元から差分計上・負値可でパリティ済み）。

### 63-5 下位互換・データ影響（原則7）
- [x] スキーマ変更なし。`date` 変換は**より多くの入力を受理する方向**の拡張（従来通る値の結果は不変・従来素通しだった日時が
  正しく変換され、時刻様でない後続文字列は素通しのまま）。棚卸（ⓐⓑ）は**受理域を負に広げる**のみ（既存の 0〜100 万の挙動は不変）。
- [x] **F-32 stocktake 取込の意味論変更（デルタ→絶対値）**は挙動変更を伴うが、対象は `kind=stocktake` 行のみ（adjust は不変）。
  従来 stocktake をデルタとして運用していた場合の影響を評価: 従来の stocktake 取込は「差分計上」ではなくデルタ追記だったため、
  同機能を絶対値運用へ寄せる本変更が正しい棚卸意味論。既存台帳データ（過去の stocktake 行）は不変・遡及なし。既存マッピングは
  追加項目なしでそのまま有効。

### 63-6 反復レビュー（原則9）
- **独立コードレビュー / システム監査 各1巡（実績）**: MAJOR 1・MINOR 複数を検出し是正。
  - **MAJOR（スコープ）**: 報告②「取込・連携における棚卸」は F-32 取込（ⓑ）を指す可能性が高く、当初の「ⓐ のみで充足」判断は
    取りこぼしの恐れ。→ **オペレーターへ確認し「両方」と回答**を得て ⓑ を実装（本 §63-3）。「静かに誤残高を生む」経路（デルタ二重計上）を解消。
  - **MINOR（誤案内 hint）**: date ヒントが 4 入力を単一結果に束ね、日時例の結果が誤り → 日時例に自前結果を付与（§63-1）。
  - **MINOR（正規表現の緩さ）**: 末尾 `.*` が時刻でない後続文字列も日付へ強制 → 時刻/TZ 様文字に限定（§63-1）。
  - **MINOR（ドキュメント）**: `api-design.md` にマイナス在庫許容・`akebono-trade.ts:104` の「残高≥0前提」注記の陳腐化を是正。
- **第2巡（F-32 並行処理コード専門レビュー・実績）**: デッドロック・C-1・冪等・正しさ・parity・回帰の**重大欠陥なし**を確認。MINOR/NIT を是正。
  - **MINOR（効率 N+1・ロック保持）**: 行ごと `balanceOf`（最大 5000 行）＋ 全キー advisory ロック → **棚卸キーの残高を 1 クエリで先読み**
    （`SUM GROUP BY`）・**ロック対象を棚卸キーのみに限定**・第2パスは実追記分だけメモリ残高を進める方式へ（正しさ維持・N+1 解消）。
  - **MINOR（テスト網羅）**: adjust 取込の回帰テストがなかった → **adjust CSV 取込**（デルタ・再取込スキップ）と**同一キー複数行の収束**を統合に追加。
  - **NIT（コメント）**: 「先勝ち収束」は挙動と逆 → 「最終行が最終残高を決定（＝実棚数へ収束）」に修正。`balanceOf` の export は不要になり撤回。
  - 許容（記録）: 入庫（inbound/purchase_in/production_in）は在庫ロックを取らないため、棚卸取込の残高読取と入庫 COMMIT の間に理論上の
    ずれがあり得るが、これは**手動棚卸と完全同一の既存性質**（運用は在庫移動停止中に棚卸）・本改修の新規欠陥ではない = 据え置き。
- **再検証（是正後）**: api typecheck green・unit 302・統合 242・mockup typecheck green・221。**未解決指摘ゼロ = 原則9 充足。**

### 63-7 未対応・別スコープ（記録）
- **UI: 在庫取込マッピングで `kind=stocktake` 時の `qty` ラベル出し分け**（「増減数」→「実在庫数」の文脈表示）は UX 追補として
  別途対応可能（現状はコード docstring・隔離メッセージ・本 DoD で意味論を明示）。棚卸タブの CSV 取込導線（F-27-4 要件の
  「実棚数入力（CSV 取込可）」）は F-32 の棚卸取込で実質担保されるが、棚卸タブ内からの直接導線は未設置。

## 64. 在庫一覧の商品識別性改善（オペレーター報告 2026-08-10）の完了条件（Definition of Done）

> オペレーター報告「在庫アプリの一覧表示項目でどの商品なのか識別できない」。原因は SKU 表示に `skuLabel` を用いており、
> バリアント SKU では**軸値（例「赤 / M」）のみ**で商品名が出ず、どの商品の SKU か判別できなかったこと（既定 SKU は商品名を返すため顕在化せず）。
> ブランチ `claude/akebono-import-linking-scsqkq`（§63/PR #108 マージ後に main から再作成）。

### 64-1 実装
- [x] **useProducts.ts**: `skuIdentity(sku) = { productName, detail }`（商品名＋SKU 詳細〔既定=コード / バリアント=軸値・コード〕）と
  `skuFullLabel(sku) = 「商品名（詳細）」` を追加（原則3 = 既存 `skuLabel` を壊さず識別用を新設。下位互換）。
- [x] **inventory.vue**: 在庫照会・受払（台帳）・棚卸の一覧／実棚入力を **商品名を主・SKU 詳細を従**の2段表示へ（サムネイル併記・
  `min-w-0`＋`truncate` でモバイル可読＝原則8）。列見出し「SKU」→「商品 / SKU」。SKU 選択ドロップダウンは `skuFullLabel`（商品名で選べる）。
  検索は商品名・SKU 詳細のどちらでも一致（プレースホルダも「商品名・SKU で検索」）。並びは商品名優先（同一商品のバリアントが隣接）。

### 64-2 検証・影響
- [x] mockup typecheck green・unit 221 passed。`skuLabel` は不変のため他アプリ（売上・出荷入力等）の既存表示に影響なし（原則7）。
- [x] API 変更なし（一覧はクライアントで SKU マスタ×残高から導出。商品名は既存の products キャッシュから取得）。

## 65. 項目カスタマイズ（F-31）の全業務アプリ展開（オペレーター指示 2026-08-10）の完了条件（Definition of Done）

> オペレーター指示「項目カスタマイズができないアプリがある。すべてのアプリの項目カスタマイズができるように」。
> 確定スコープ（オペレーター確認）: **フォーム＋一覧**を、**入力フォームを持つ業務アプリ**（商品・売上・生産・発注・仕入・入荷・出荷・在庫）で対応。
> 請求（invoice）は入力フォームが無いため**一覧のみ**（カスタム列は出さない）。SKU は商品ページ内・取引先/共通マスタは今回スコープ外。
> ブランチ `claude/akebono-import-linking-scsqkq`（§64/PR #109 マージ後に main から再作成）。

### 65-0 前提（調査で確定）
- **DB マイグレーション不要**: `0042_akebono_custom_fields.sql` が対象全テーブル（product_skus/purchase_orders/production_orders/
  inbound_results/purchase_records/outbound_results/inventory_transactions/sales_records/invoices・products は 0032）へ
  `custom jsonb NOT NULL DEFAULT '{}'` を追加済み。残作業は **API 経路（COLS/INSERT）** と **フロント（フォーム/一覧）** のみ。
- 項目定義 UI（`settings/items.vue`）は全10エンティティ対応済み（定義側の新規作業ゼロ）。
- custom の検証は既存規約（オブジェクトのみ採用・配列/非オブジェクトは `{}`・`JSON.stringify` で jsonb 保存）。ホワイトリスト enum 無し（キーはテナント定義）。

### 65-1 共通基盤
- [x] **useAppListView.ts（新規）**: `listColumns(entity, base, opts?)`（base 列を builtinResolved の listVisible/labelDisplay で解決＝表示 ON/OFF・
  表示名上書き・カスタム項目列を末尾付加。`opts.appendCustom:false` でカスタム列を出さない＝請求用）・`decorateRows(entity, rows)`
  （custom 値を型別整形して `row['custom.<key>']` へ平坦化＝UiDataTable 既定セルに載せる）・`fmtCustomValue`（boolean→はい/いいえ・date→fmtDate・
  multiselect→'・'結合・空→'—'）。既存 `#cell-*` スロット・行 id・派生列は不変（原則7）。
- [x] **useAppFields.missingRequiredCustom(entity, custom)**: 必須カスタム項目の未入力チェック（最初の未入力ラベルを返す）＝**今回配線した各ページ**（発注・生産・仕入・入荷・出荷・在庫）の保存前検証で共通利用。
  既存の products.vue／sales.vue は従来のインライン必須検証を保持（重複だが挙動は同一。将来 refactor 候補）。
- [x] **型（mockup/types/akebono.ts）**: PurchaseOrder/ProductionOrder/InboundResult/PurchaseRecord/OutboundResult/InventoryTransaction に `custom?: CustomValues`（Product/SalesRecord は既存）。`shared/domain` の CustomValues は既存。
- [x] **API（akebono-trade.ts）**: `customOf(body)` ヘルパー・PO/MFG/IBR/PUR/OBR/ITX の各 COLS へ `custom`・各 POST の INSERT に `custom`＋`JSON.stringify(customOf(body))`。
  `InventoryPostEntry.custom?`＋`postInventory` の INSERT に custom・`/inventory/adjust`・`/inventory/transfer`（両行に同一 custom）で受理。
  **赤黒訂正（purchase-records/:id/correct）・システム自動起票（入荷/出荷/仕入/生産→在庫）は custom を写さず DB 既定 `{}`**（sales と同方針）。

### 65-2 各アプリの配線
- [x] **フォーム（追加カスタム項目の入力・保存）**: 商品・売上（既存）＋発注・生産・仕入・入荷（直接/予定参照の両経路）・出荷・在庫（調整/移動）。
  各フォーム ref に `custom: {}`・`<WidgetsCustomFields entity="…" v-model="…" />`・`missingRequiredCustom` 検証・create/register へ custom を渡す。
  mock CRUD（usePurchaseOrders/useProduction/useInbound/usePurchases/useOutbound/useInventory）も input へ `custom?` を透過し生成レコードへ `custom: input.custom ?? {}`。
- [x] **一覧（表示 ON/OFF・表示名・カスタム列）**: 商品・売上・発注・仕入・生産・在庫（受払台帳）＋入荷実績・出荷実績。既定列に itemKey を付け
  `listColumns` で解決、`decorateRows` でカスタム列を描画。派生列（金額・消込・状態・明細数等）は itemKey 無し＝常時表示。
- [x] **入荷/出荷は実績一覧を新設**: 既存の一覧は予定（plan）一覧のみでカタログ対象（inbound/outbound＝実績）に対応する一覧が無かったため、
  実績（inbound_results/outbound_results）の一覧を予定一覧とは別枠で追加し、項目カスタマイズを適用（予定一覧は不変で温存）。
- [x] **在庫受払台帳**: `occurredAt/warehouseId/kind/qty/reason` に itemKey・「商品 / SKU」列は §64 の識別表示のため itemKey 無しで常時表示・カスタム列付加。
- [x] **請求（billing）**: `invoiceCols`/`receivableCols` を `listColumns('invoice', …, { appendCustom:false })` で解決（表示 ON/OFF・表示名のみ・カスタム列は出さない）。マージン/支払通知/入金は invoice 外エンティティのため対象外。

### 65-3 検証（実測値）
- [x] api typecheck green・mockup typecheck green・mockup unit **221 passed**。
- [x] api 統合 **243 passed**（発注 POST の custom 往復＋新規テスト「生産/仕入/入荷/出荷/在庫調整が custom を保存し GET で返す」）。

### 65-4 スコープ境界・独立レビュー是正（原則9）
- **独立コードレビュー・システム監査（2巡）: MAJOR/正しさ/parity/下位互換の欠陥なし**を確認。INSERT の列×プレースホルダ×パラメータ個数の一致、
  自動起票・赤黒訂正の custom 非引継ぎ、一覧ヘルパーの派生列温存・下位互換をレビュアーが実読で裏取り。MINOR/NIT を是正:
  - **棚卸フォームは custom 非対象（意図的）**: 在庫の調整/移動は custom 対応だが、棚卸（bulk の実棚入力＝SKU 複数行を1確定で差分計上）は
    1レコードのフォームでないため custom 非対象。棚卸由来の台帳行は custom = `{}`（必須カスタム項目の強制もされない）。同一 `inventory` 実体内の
    意図的な限定として明記（将来、棚卸セッション単位のメタが必要になれば別途）。
  - **SKU・請求の定義口をガード（レビュー MINOR 是正）**: `settings/items.vue` は SKU・請求タブでも「追加カスタム項目」を定義できてしまい反映先が無い
    デッドエンドだった → **`CUSTOM_FORM_ENTITIES`（フォームを持つ8アプリ）以外では追加カスタム項目セクションを無効化し理由を明示**（「宣言だけあって
    実態が伴わない」状態の解消 = 原則9.5 の趣旨）。SKU/請求は基本項目の表示・表示名調整のみ利用可。
  - **ドキュメント全件（原則5）**: `data-design.md` の対象実体（発注/生産/入荷実績/仕入/出荷実績/在庫/SKU/売上）へ `custom jsonb` を追記・
    `api-design.md` のトレード系エンドポイントに custom 永続化・返却の記述を追記。
  - 据え置き（記録）: custom jsonb のキー数/値長上限は既存 products/sales と同一規約（本変更の回帰ではない）。在庫台帳「商品/SKU」列は §64 の
    識別表示のため常時表示（skuId の一覧トグルは台帳に非反映＝設計判断・コードコメントに明記）。

### 65-5 下位互換・データ影響（原則7）
- [x] スキーマ変更なし（custom 列は 0042 で既存・既定 `{}`）。既存レコードは custom 未設定でも `{}` として整合。
  一覧ヘルパーはカスタム項目 0 件のエンティティでは実質ノーオペ（列も付かず decorate も素通し）。既存フォーム/一覧の挙動は
  カスタム項目・項目設定差分が無い限り不変。API 訂正/自動起票は custom 非引継ぎで既存挙動と一致。

## 66. 委託販売仲介の運用検証を受けた分析軸・整合検証の改修（P1/P2/P3。オペレーター指示 2026-08-10）の完了条件（Definition of Done）

> オペレーターの委託販売仲介（窯元＝作家/仕入先・販売店＝店舗/得意先・弊社＝中間マージン。上代を三者へ按分）の
> 運用検証を受け、既存の委託精算（三者精算）設計はそのまま耐えられることを確認したうえで、提案した 3 改修を実装。
> ブランチ `claude/akebono-import-linking-scsqkq`。

### 66-1 P3: 売上明細に供給元（作家/窯元）スナップショット列（0055）
- [x] **DB マイグレーション `0055_akebono_sales_supplier.sql`**: `sales_records.supplier_company_id text`（NULL 許容 = 後方互換・
  バックフィルなし）＋ `sales_records_supplier_idx`。FK なし（0032 の設計判断踏襲）。glob 自動検出（migrate.ts）。
- [x] **計上時に凍結（全4経路）**: 手入力（akebono-billing POST /sales-records）・出荷（akebono-trade postSales）・取込
  （akebono-imports applySalesRecords）・赤黒訂正（billing correct = 元行の値を引継ぎ）で、商品の `default_supplier_company_id`
  を解決して `supplier_company_id` に保存。SR_COLS に `supplierCompanyId` を追加。
- [x] **委託精算の作家帰属**: `COALESCE(sales_records.supplier_company_id, products.default_supplier_company_id)`（スナップショット優先・
  NULL はライブ解決へフォールバック）。API（akebono-billing consignment/close の byArtist）・モック（useConsignment closeConsignment）とも同一解決。
- [x] **型・共有**: `SalesRecord.supplierCompanyId?`（types/akebono.ts）・`ShipmentSaleLine.supplierCompanyId`＋`buildShipmentSaleLines`
  の resolve に supplierCompanyId を追加（shared/domain/akebono）。モック生成経路（useAkebonoSales.create・useOutbound）も凍結。

### 66-2 P2: 作家（窯元）別・販売先別の売上分析ビュー
- [x] **useAkebonoSales.supplierBreakdown**: 売上明細を供給元（作家/窯元）でロールアップ（Top5 + その他 + 未設定〔仕入先未登録〕）。
  供給元解決は `supplierIdOf`（supplierCompanyId 優先・未設定は商品ルックアップへフォールバック = 精算と同一方針）。
- [x] **sales.vue**: 既存「得意先別内訳」を「販売先（店舗・得意先）別内訳」に、加えて「仕入先（作家・窯元）別内訳」バーチャートを新設（レスポンシブ 2 分割）。

### 66-3 P1: 弊社取り分（残余）の可視化＋委託条件の整合検証
- [x] **共有純関数（shared/domain/akebono）**: `residualMarginRate(storeShare, artistRate)` = 1 − 店舗取り分 − 作家率
  （負 = 逆ざや）。utils/akebono で再エクスポート。整合検証（cross-row の逆ざや検出）は composable 側 settlementIntegrity が担う。
- [x] **useConsignment**: `settlementPreview(segmentId, month)`（締め前の試算 = 書込なし。closeConsignment と同一純関数・同一作家帰属解決で
  店舗別請求・作家別支払・当社粗利〔税抜〕を算定）・`settlementIntegrity(segmentId)`（店舗取り分 + 作家率〔sales_rate〕> 100% の逆ざや組を返す）。
- [x] **billing.vue（締めモーダル）**: 締め前プレビュー（委託売上・店舗へ請求・作家へ支払・**当社取り分**を提示。逆ざやは crit 表示）＋整合警告。
- [x] **masters.vue（委託条件タブ）**: 保存後に逆ざや組があれば非ブロッキング警告トースト（原則4）＋タブ上部に整合警告バナー。

### 66-4 検証（実測値）
- [x] api typecheck green・mockup typecheck green。
- [x] mockup unit **226 passed**（`residualMarginRate` の按分・逆ざや 2 ケース・`buildShipmentSaleLines` の供給元注入・null フォールバック）。
- [x] api unit **302 passed**・api 統合 **245 passed**（新規: 「計上時に既定仕入先を凍結し供給元変更後も精算は当時の作家へ支払う」・
  「既存行〔スナップショット NULL〕は現在値へフォールバックして帰属する」）。

### 66-5 下位互換・データ影響（原則7）・整合（原則6）
- [x] **後方互換**: `supplier_company_id` は追加列・NULL 許容。既存売上行は NULL のまま = 精算・分析ともライブ解決へフォールバックし従来挙動と一致
  （バックフィル不要 = データ更新パッチ不要）。
- [x] **SoT・整合（原則6）**: 作家帰属の SoT は「計上時点のスナップショット」。商品の既定仕入先を後日付け替えても計上済み売上の帰属は不変
  （統合テストで実証）。金額算定・帰属解決は両モード同一（shared/domain）。
- [x] **整合検証は非ブロッキング**（原則4）: 逆ざや設定は警告のみ（purchase_cost 方式の作家・移行期の設定を妨げない）。保存はブロックしない。

### 66-6 独立レビュー（原則9）
- [x] コードレビュアー・システム監査官の独立レビューを実施し、指摘ゼロまで反復（後述の是正を反映）。

## 67. 各アプリの構造化フィルタ検索 + マスタ項目のオートコンプリート（オペレーター指示 2026-08-10）の完了条件（Definition of Done）

> オペレーター指示「各アプリ内の検索をフリーテキストではなく項目別のフィルタフォームに。マスタ化項目は
> autocomplete、大文字小文字・全角半角は PG で吸収。検索対象は /akebono/settings/items で定義可能に。
> 合わせて登録・編集フォームのドロップダウンも可能な範囲で autocomplete に」。ブランチ `claude/akebono-import-linking-scsqkq`。

### 67-1 基盤（正規化・migration）
- [x] **共有正規化** `shared/domain/text-match.ts`: `normalizeSearch(s) = s.normalize('NFKC').toLowerCase()`・`normalizedIncludes`。
  大文字小文字・全角半角（全角ASCII↔半角・半角カナ→全角カナ〔濁点合成〕）を吸収。utils/search.ts で再エクスポート。
- [x] **migration 0056**: `app_office.akebono_norm(text) = lower(normalize(t, NFKC))`（IMMUTABLE・関数インデックス可）+
  `item_settings.filter_visible boolean`（NULL = カタログ既定）。**PG16 の normalize(NFKC) = JS String.normalize('NFKC') を実測一致確認**。

### 67-2 API（構造化フィルタ・filter_visible）
- [x] **list-query.ts**: `filterCols`（キー=項目キー）で per-field フィルタを追加。text = `strpos(akebono_norm(col), akebono_norm($v))>0`・
  ref/enum = 完全一致・date = `col::date` 範囲（timestamp 列は `(col AT TIME ZONE 'Asia/Tokyo')`）・number = 範囲。
  クエリは `f.<key>` / `.from`・`.to` / `.min`・`.max`。従来の `q`（ILIKE）と併存（後方互換）。
- [x] **各エンティティに filterCols 付与**: sales_records/invoices（billing）・purchase_orders/production_orders/inbound_results/
  purchase_records/outbound_results/inventory_transactions（trade）。
- [x] **item-settings に filter_visible を end-to-end**（akebono.ts: ItemSettingPatch/itemSettingPatchOf/COLS/PUT/INSERT）。

### 67-3 カタログ・設定 UI
- [x] **ITEM_CATALOG にフィルタメタ**（filterKind: text/ref/enum/date/number・filterRef・filterDefault）を全10エンティティへ付与。
  useItemSettings に `filterVisibleOf`（resolve に filterVisible）・`filterableItems(entity)`。ItemSetting 型に filterVisible。
- [x] **settings/items.vue**: 「検索対象（フィルタ）」トグル列を追加（form/list と同型。フィルタ不可項目は「—」）。

### 67-4 フロント基盤・コンポーネント
- [x] **useAppFilter(entity)**: フィルタ状態 + ref/enum のオプション解決（マスタ = useAkebonoMasters/useProducts、enum = 固定マップ）+
  ① mock 用 `matchRow`（正規化部分一致・範囲・完全一致）② API 用 `queryParams`。
- [x] **AppFilterBar.vue**: 種別ごとの入力（ref = UiMultiCombobox〔single〕autocomplete / enum = UiSelect / text / date 範囲 / number 範囲）。レスポンシブ。
- [x] **useListView 拡張**: `filterPredicate`（client）・`filterParams`（server）。両モードでフィルタ変更→1ページ目・デバウンス再取得。
- [x] **UiCombobox / UiMultiCombobox のオプション絞り込みを normalizeSearch 化**（全角半角吸収）= 既存フォームの autocomplete も表記ゆれ耐性を獲得。

### 67-5 各リスト画面への適用（全業務アプリ）
- [x] フリーテキスト検索 → AppFilterBar へ置換（全 9 リスト・全フィルタ種別を網羅）:
  **売上・商品・仕入・発注・生産・入荷実績・出荷実績・在庫受払台帳・請求（invoice タブ）**。
  在庫受払台帳は従来の SKU/倉庫セレクトを AppFilterBar に統合（ledgerOf() 全件 → matchRow で絞り込み）。
  売上・商品は業態スイッチャと二重操作を避けるため AppFilterBar に `exclude=['segmentId']`（レビュー MINOR 対応）。
- [x] **登録・編集フォームの master 参照ドロップダウンを autocomplete 化**: 単一 v-model のドロップイン
  `AppRefSelect`（UiCombobox 選択専用ラッパ）を新設し、得意先/仕入先/出荷先（company）・SKU の長いマスタ選択を置換
  （売上・発注・仕入・生産・出荷・請求締め）。事業セグメント/倉庫（短いリスト）は native select を維持。既存フォームの
  UiCombobox 系はオプション絞り込みの normalizeSearch 化で全角半角耐性を獲得済み。

### 67-6 検証（実測値）
- [x] api/mockup typecheck green・mockup unit **232 passed**（正規化 6 ケース）・api unit **302**・api 統合 **247**
  （akebono_norm の全角半角ヒット・eq・date/number 範囲・filter_visible 往復の新規テスト）。

### 67-7 後方互換（原則7）
- [x] filter_visible / akebono_norm は追加のみ。`q`（ILIKE）検索経路・レガシー bare 配列取得は不変。項目カタログのフィルタメタは任意
  （未指定 = フィルタ不可）。既存 seed（itemSettings は空）・既存フォームの挙動は不変。

### 67-8 独立レビュー（原則9）の指摘対応
- [x] **不正日付ガード（MINOR）**: `list-query.ts` の date フィルタを `isRealDate`（暦日検証・閏年考慮）に変更 =
  正規表現は通るが暦上あり得ない日（例 2026-13-45）で `col::date` が 22008 → 500 になるのを防ぎ、黙って無視（原則4）。
- [x] **JST/UTC 整合（MAJOR-latent）の確認と明文化**: モック日時は常に JST ISO（`+09:00` = nowJstIso）で保存されるため
  `slice(0,10)` が JST 日付 = サーバー（timestamp 列は `(col AT TIME ZONE 'Asia/Tokyo')::date`）と一致。useAppFilter に
  不変条件をコメントで明記（次弾の timestamp 系ページ〔入荷/出荷/在庫〕でも同一述語で齟齬なしを裏取り済み）。
- [x] **eq の trim 整合（NIT）**: mock の完全一致比較をサーバー同様 `v.trim()` に統一。
- [x] **カナ NFKC の PG 側テスト（MINOR）**: 統合テストに「半角カナ登録 × 全角カナクエリ」の akebono_norm 一致アサートを追加。
- [x] **二重セグメント操作（MINOR）**: AppFilterBar に `exclude` を追加し、業態スイッチャを持つ売上・商品で segmentId を除外。
- 据え置き（follow-up）: text フィルタの関数インデックス（akebono_norm(col)）は現状 20,000 件上限内で seq scan 許容 = 将来のボリューム増で検討。

## 68. トップ（ダッシュボード）のモバイル/PC シーン分離（オペレーター指示 2026-08-10）の完了条件（Definition of Done）

> モバイルで通知欄が最上部にあると、毎回スクロールしてからメニューを選ぶことになり操作体感が悪い、という指摘への対応。
> 通知欄の配置は **PC シーン専用の設定**とし、**モバイルはメニュー最優先**・通知はヘッダーのベル（未読バッジ付き）/下部ナビ
> 「通知」から開く導線に統一する。トップのレイアウト設定を「モバイルシーン / PC シーン」で明確に分けて考える。

- [x] **モバイル導線は既存の基盤を再利用（原則3・新規実装なし）**: ヘッダーのベル（`layouts/default.vue`。アイコン + 未読
  バッジのみ・押下で `/inbox` へ遷移）と下部ナビ「通知」タブ（`MOBILE_NAV`。未読バッジ付き・`/inbox`）は既に存在。
  オペレーター要望「ベルはバッジのみ表示・押下で通知ページへ」は現状で充足済み = ヘッダーは無改修。
- [x] **反映（`mockup/app/pages/index.vue`）= シーン分離の中核**:
  - `options.notifications`（side/bottom/hidden）は **PC シーン専用**として解釈。
  - **モバイルは通知欄をトップに出さない**（従来 `side` 配置が `order-1` でモバイル最上部に通知を積み、メニューが下へ
    押し出されていた = 指摘の直接原因）。順序反転（`order-2 lg:order-1` / `order-1 lg:order-2`）を撤去し、DOM 順で
    メニュー → 通知に固定（メニューが常に最上部）。
  - `side` の右カラム `<aside>` は `hidden lg:block`（PC = lg+ のみ）。`bottom` のメニュー下通知欄は `hidden md:block`
    （PC = md+ のみ）。いずれもモバイル/（side は）タブレットではベル/下部ナビが導線。
  - セクション構成（categorize）・密度（density）・AKEBONO 表示はモバイルにも従来どおり反映（単一カラムで成立）。
- [x] **設定 UI でシーン分離を明示（U-2 出力の直感性）**:
  - `OfficeDashboardLayoutPreview` を **PC / モバイルの 2 シーン**表示に刷新。PC は通知欄の位置（side/bottom/hidden）を
    図示、モバイルは疑似ヘッダーのベル（未読ドット）+ メニュー縦積み（通知欄なし）+「通知はヘッダーのベルから」注記。
  - `OfficeDashboardLayoutPicker` に注記を追加: 「モバイルはメニュー最優先・通知はヘッダーのベル/下部ナビから。テンプレート
    設定（通知欄の位置など）は主に PC 表示に適用（セクション構成・密度はモバイルにも反映）」。
- [x] **データ/永続化は不変（下位互換 = 原則7）**: `DashboardLayoutOptions` に新フィールドを追加しない（`notifications` の
  意味を「PC 専用」に限定するのみ）。保存値・resolve・テンプレート・4KB 上限・既存の 3 階層解決はすべて不変。既存の保存済み
  レイアウト（user/tenant）はそのまま有効で、モバイル表示のみメニュー最優先に変わる（データ移行パッチ不要）。
- [x] **ドキュメント整合（原則5）**: `dashboard-layout.ts` の `NotificationPlacement` doc・`index.vue` ヘッダ doc・
  `DashboardLayoutPreview` doc を「PC 専用配置 / モバイルはベル導線」に更新。§51（レイアウト）の通知位置記述と整合。
- [x] **検証（実測値）**: `cd mockup && npm run typecheck` green・`npm test` **232 passed**（純ロジック不変のため
  `dashboard-layout.test.ts` 47 件を含む全スイート green。表示層のみの変更で options 形状は不変）。
- [x] **既知の設計判断**: モバイルは「固定の最適シーン（メニュー最優先 + ベル導線）」とし、モバイル専用の可変設定は設けない
  （通知をトップに戻す選択肢を作らない = 指摘の再発防止）。タブレット（md–lg）は `side` 時にベル導線（340px 右カラムは lg+ のみ）。

## 69. 改善要望の記録 + AI 集約 + 改修プロンプト出力（F-42。オペレーター指示 2026-08-11）の完了条件（Definition of Done）

各ページから改善・改修の要望を記録し、AI が改修単位に集約、権限を持つ人のみが閲覧・ステータス管理し、フィルター条件に従って
コーディング AI 向けのプロンプトを出力する。**API+DB / フロント接続の両方を本バッチで実装**（マイグレーション 0057）。

- [x] **共有ドメイン（SoT・両モード共有）**: `shared/domain/improvement.ts` に型（`ImprovementRequest`／`ImprovementItem`）・
  単一ステータスの状態機械（`triage → accepted → resolved／rejected`・reopen 可）・決定的集約 `heuristicClusterRequests`・
  LLM 出力の正規化 `normalizeClusterPlan`（無効 id を捨て未割当は補完・判定済み item への追記を捨てる）・改修プロンプト組み立て
  `buildCodingPrompt`（対象パス・機能名・改修内容・元要望・受入基準を明記）・入力検証を集約。
- [x] **DB（0057）**: `improvement_requests`（追記系・SoT。取消 = `archived_at` 論理削除）／`improvement_items`（導出だが人手の
  ステータス・編集を持つ）。未集約抽出の部分索引・ステータス索引。FK は張らない（0032 と同判断）。記録系はシードしない。
- [x] **API（`/v1/improvements`）**: 投稿（`POST /requests` = 認証済み全員可・featureGuard 非対象）／管理系（一覧・`generate`・
  `status`・編集・`archive`/`restore`・`prompt`）は `requireManage`（`canManageImprovements` = deny-by-default + 管理者常時可）で
  ルート内ガード。集約は Vertex AI → 決定的ヒューリスティックにフォールバック（`env.vertexProjectId` 未設定は即ヒューリスティック）。
  **未集約の要望のみ処理し、判定済み item のステータス・編集は巻き戻さない（原則2）**。監査ログは非ブロッキング（原則4）。エラーは `AKO-REQ-*`／`AKO-PRM-001`。
- [x] **権限（F-16 連携）**: 機能キー `improvements` を `FEATURE_PERMISSION_KEYS`・`featureKeyOfPath` に追加。閲覧は
  **既定 deny（権限を持つ人のみ）・管理者は常時可**（`canManageImprovements`）。権限表（`PermissionMatrix`）は当該行を
  `defaultAllowOf`（timecard-all と同型）で「管理者=既定許可／他=既定不可」と実挙動に一致表示。オペレーターがロール/役職/個人へ allow を付与可。
- [x] **フロント（デュアルモード）**: `useImprovements`（mock = `useMockDb` + 決定的集約 / API = `apiWrite`/`apiFetch`。投稿は
  管理 GET を誤発火しない）。全ページ共通ヘッダーに `WidgetsImprovementSubmit`（投稿元パス・表示名を自動付与・UiModal）。
  管理ページ `pages/improvements.vue`（KPI・チップフィルタ〔未解決/解決済み/対応可否/取消済み〕・`UiDataTable`・ドロワー詳細で
  ステータス操作/編集/元要望/取消・プロンプト出力モーダル + コピー）。ナビ登録（`navigation`/`nav-map`/`menu-registry`）。
- [x] **取消可能性（原則9.5）**: 要望・改修単位とも取消（論理削除）/復元、ステータスは解決/見送りの reopen 可。投稿者は自分の要望を取消可。
- [x] **下位互換（原則7）**: 追加コレクションは MockDbShape 欠落キー補完で既存 localStorage を破壊しない（SEED_VERSION 据え置き）。
  新権限キー・ルールは加算的（既存ルールに影響なし）。既存 API・データへの破壊的変更なし。
- [x] **検証（実測値）**: API `npm run typecheck` green・`npm test` **313 passed**（`improvement` 11 件含む）・
  `npm run test:integration` **250 passed**（改善要望 3 件 + 0057 マイグレーション適用含む）。
  mockup `npx nuxi typecheck` green・`npm test` **242 passed**（`improvement` 10 件含む）・`npm run build` green。
- [x] **ドキュメント整合（原則5）**: functional-requirements（F-42）・data-design・api-design・screen-design・本節・
  `CONVENTIONS.md`（基盤 API 早見表 = useImprovements / UI 在庫 = WidgetsImprovementSubmit）を更新。

## 70. 改善要望のカンバン + 対応予定期間 + ガントチャート（F-42 追補・オペレーター指示 2026-08-11）の完了条件（Definition of Done）

改修要望の進捗・ステータスをカンバンで一望し、各改修案件に対応予定期間を任意登録してガントチャート（月次/週次/日次）で
可視化できるようにする（§69 の続き。マイグレーション 0058）。

- [x] **対応予定期間（0058）**: `improvement_items` へ `plan_start`・`plan_end`（date・任意）を追加（`IF NOT EXISTS`・下位互換）。
  共有型 `ImprovementItem` に planStart/planEnd、検証 `improvementPlanError`（実在日・終了>=開始・終了のみ不可）。
  API 編集エンドポイントで planStart/planEnd を部分更新（空文字 = NULL クリア・逆転は AKO-REQ-007）。date 列は 'YYYY-MM-DD' 文字列で返す（TZ 非依存）。
- [x] **ガント純関数（`shared/domain/gantt.ts`）**: `ganttColumns`（month=12/week=13/day=当月日数）・`ganttBar`（可視範囲へクランプ・
  単日/範囲外対応）・`ganttStep`（前後=表示範囲ぶん送り）・`ganttAnchorForToday`（今へスナップ）・`addMonths`/`mondayOf`・
  `ganttRangeLabel`。純粋・決定的（Date のローカル TZ に依存しない月/週演算）。
- [x] **カンバン（`ImprovementsKanban`）**: ステータス別カラム・カード（見出し/対象ページ/要望数/予定バッジ）・許可遷移のクイック操作・
  クリックで詳細ドロワー。列は横スクロール（原則8）。
- [x] **ガント（`ImprovementsGantt`）**: スケール切替（月次/週次/日次）+ `[前][今][次]` ページャ + 表示範囲ラベル。
  バーはステータス色。ラベル列 sticky・本体横スクロール。予定未定は別枠チップ。
- [x] **ページ統合**: `pages/improvements.vue` に `UiChipTabs` のビュー切替（一覧/カンバン/ガント）。ドロワーに対応予定期間
  （開始/終了 + 保存/クリア）。`useImprovements.editItem` を planStart/planEnd 対応に拡張（両モードで検証）。mock は
  `mockGenerate` の新規 item を plan 未定で作成、デモシード（改修単位 2 件・予定期間あり + 未集約要望）を追加（SEED_VERSION 18）。
- [x] **下位互換（原則7）**: 追加列のみ・既存 item は plan NULL。SEED_VERSION を 18 に上げデモ更新（モックは日次再シードのため軽微）。
- [x] **検証（実測値）**: API `npm run typecheck` green・`npm test` **327 passed**（`gantt` 14 含む）・`npm run test:integration` **251 passed**
  （予定期間の登録・検証 + 0058 適用含む）。mockup `npx nuxi typecheck` green・`npm test` **247 passed**（`gantt` 5 含む）・`npm run build` green。
- [x] **ドキュメント整合（原則5）**: functional-requirements（F-42-7〜9）・data-design（plan列）・api-design（AKO-REQ-007・編集）・
  screen-design（5.7 カンバン/ガント）・本節・CONVENTIONS（UI 在庫 = ImprovementsKanban/ImprovementsGantt）を更新。

## 71. アプリヘッダー設定の不具合修正＋設定のレイアウト集約＋通知タブの拡張・設定化（オペレーター指示 2026-08-12）の完了条件（Definition of Done）

オペレーター報告 4 点への対応: (1) ヘッダーの表示設定（クイックアクセス）を変更しても反映されない不具合の修正、
(2) アプリヘッダーの設定をヘッダーから撤去し、ダッシュボード導線のある「レイアウト」設定内へ集約、
(3) 通知に「日報」「顧客ログ」「議事録」カテゴリを追加、(4) 通知に何を表示するか（カテゴリタブ）を設定可能に。

- [x] **(1) 不具合修正（実障害）**: `parseQuickAccessIds`（`utils/header-quick-access.ts`）が **JSON 文字列のみ**を受理し、
  API モードで `/v1/me` の prefs（JSONB）が**配列**で渡ると `null` 扱い → 解決がテナント/既定へフォールバックし、
  ユーザーの表示設定が**反映されない**（在／セッション内・リロード後とも）。`parseDashboardLayout` と同じく
  **配列（API）と JSON 文字列（mock/localStorage）の両方を受理**するよう修正。回帰テストを追加。
- [x] **(2) 設定のレイアウト集約**: ヘッダー（`layouts/default.vue`）から「表示」ボタン（`SlidersHorizontal`）とクイックアクセス設定
  モーダルを撤去（クイックアクセス項目自体の表示・打刻は不変）。ダッシュボードの「レイアウト」モーダル
  （`OfficeDashboardLayoutPicker`）に **「アプリヘッダー」タブ**を追加し `OfficeHeaderQuickAccessPicker` をそこで開く。
- [x] **(3) 通知カテゴリ追加**: `notification-category.ts` の `NotificationCategory` に `report`/`customer-log`/`minutes` を追加。
  判定はリンク先（`/reports`・`/customer-log`・`/minutes` の先頭一致）。**リンク基準カテゴリ（workflow/report/customer-log/
  minutes）は `kind='approval'` 判定より先**に評価（機能別分類を種別より優先）。デモ通知を 2 件追加（顧客ログ・議事録。inbox seed）。
- [x] **(4) 通知タブの設定化**: 純ロジック `utils/notification-tabs.ts`（カタログ・`parse`〔配列/文字列両対応〕・`resolve`〔ユーザー>
  テナント>既定〕）+ 合成 `useNotificationTabs`（pref `notificationTabs` / configs `notification-tabs`。既存 key/value 利用で
  新 API・マイグレーション不要）+ ピッカー `OfficeNotificationTabsPicker`。レイアウトモーダルに **「通知タブ」タブ**を追加。
  `OfficeDashboardNotifications` と `/inbox` のカテゴリタブを設定駆動に（「すべて」は常時先頭固定・選択中タブが設定変更で
  消えたら「すべて」へ戻す防御）。**既定は全カテゴリ表示**（追加 3 種を含む）。/inbox の管理者タブは「エスカレーション対応」に改称
  （カテゴリ絞り込みの「エスカレーション」タブと区別）。
- [x] **3 階層・取消（原則9.5）**: ヘッダークイックアクセス・通知タブとも ユーザー > 全社（管理者のみ）> 既定 で解決し、各層に
  「既定に戻す（解除）」を提供。全社設定は管理者のみ・非管理者は警告して no-op（非ブロッキング。原則4）。
- [x] **下位互換（原則7）**: 追加のみで既存 I/F・データに破壊的変更なし。(1) は既存の壊れた挙動を修復する方向のみ（保存済み
  ユーザー設定が**やっと反映される**ようになる。誤設定が残る場合はレイアウト → アプリヘッダーで解除可）。新規 pref/config キーは
  未設定なら既定にフォールバック。データ移行パッチ不要。
- [x] **検証（実測値）**: mockup `npx nuxi typecheck` green・`npm test` **280 passed**（`header-quick-access` 11 / `notification-tabs` 11 /
  `notification-category` 8 を含む）・`npm run build` green。API は不変（`api/` 変更なし）。
- [x] **ドキュメント整合（原則5）**: screen-design（トップ通知フィード・レイアウトモーダルのタブ・5.6 選択 UI・/inbox タブ）・本節を更新。

## 72. 通知タブ順の共通化＋改修案件の時系列メモ＋ダッシュボードのタイムカードボタン（改善要望 3 件・オペレーター指示 2026-08-12）の完了条件（Definition of Done）

改善要望（F-42）から出た 3 改修単位への対応。

- [x] **(1) /inbox タブ順をダッシュボード通知カードに合わせる**: タブ並びを組み立てる純関数 `notificationTabViews(effectiveIds)`
  （「すべて」先頭 + 設定カテゴリをカタログ順）を `utils/notification-tabs.ts` に追加し、`OfficeDashboardNotifications` と
  `/inbox` の両方で使用（原則3）。両画面のカテゴリタブ順が構造的に一致し、将来のドリフトも防ぐ。/inbox は管理者の
  「エスカレーション対応」（管理ビュー）を末尾に付す点のみ従来どおり。
- [x] **(2) 改修案件の時系列メモ（F-42-10）**: 各改修単位に検討過程・保留/見送り理由を **1 件ずつ時系列で記録**できる。
  - **データ（0059 `improvement_notes`）**: 記録系・追記のみ（`item_id`／`member_id`／`member_name`／`body`／`kind`〔note/reject〕／
    `archived_at`／`created_at`）。取消は論理削除（原則9.5）。FK 非設定は 0057 と同方針。
  - **shared**: `ImprovementNote`／`ImprovementNoteKind`／`improvementNoteError`／`IMPROVEMENT_NOTE_CAP`。`PromptItemInput.notes` を
    追加し **`buildCodingPrompt` がメモを「担当者メモ（時系列）」節として出力**（reject は「対応しない理由」と明示）。空メモは節を出さない。
  - **API**: `GET /notes`（itemId/includeArchived・古い順）・`POST /items/:id/notes`（body/kind・存在item検証）・`POST /notes/:id/archive|restore`
    （記入者本人 or 管理）。`/prompt` はメモを join して加味。エラー `AKO-REQ-008`（本文未入力/上限）。監査ログ記録。
  - **フロント**: `useImprovements` に `notesForItem`／`addNote`／`setNoteArchived`（両モード）。`improvements.vue` 詳細ドロワーに
    メモ時系列 + 追加 + 取消（確認ダイアログ）。**「対応しない」への変更は任意の理由入力 → reject メモとして記録してから遷移**。
    プロンプト出力（mock/API とも）にメモを渡す。デモseed 2 件（SEED_VERSION 19）。
- [x] **(3) ダッシュボードのタイムカードボタン**: `pages/index.vue` の「レイアウト」ボタン左に「タイムカード」ボタンを追加。
  押下でヘッダーと同一挙動（`WidgetsPunchClock flat` のモーダル）。ヘッダーのモーダル状態はレイアウト側でページから
  参照不可のため、ページローカルに同一モーダルを持つ。`/attendance` 権限保持時のみ表示（ヘッダーのタイムカードと同じ絞り込み）。
- [x] **取消可能性（原則9.5）**: メモ追加の取消 = 確認ダイアログ + 論理削除（復元 API も提供）。改修案件の判断（対応しない）は
  理由メモで根拠を残せる。既存の要望/改修単位の取消・reopen は不変。
- [x] **下位互換（原則7）**: 追加のみ（新テーブル 0059・新 API・`notes` は省略可）。既存データ・I/F への破壊的変更なし。データ移行パッチ不要。
- [x] **検証（実測値）**: mockup `npx nuxi typecheck` green・`npm test` **283 passed**（`improvement` 10 / `notification-tabs` 14 含む）・`npm run build` green。
  API `npm run typecheck` green・`npm test` **330 passed**（`improvement` 単体にメモ検証/プロンプト加味を追加）・`npm run test:integration` **252 passed**
  （メモ追加/一覧/reject/プロンプト加味/取消・復元/権限 + 0059 適用を含む）。
- [x] **ドキュメント整合（原則5）**: functional-requirements（F-42-10・F-01-3）・data-design（improvement_notes）・api-design（notes 3 経路・AKO-REQ-008）・
  screen-design（5.7 メモ・トップのタイムカード・/inbox タブ順共通化）・CONVENTIONS（useImprovements・notificationTabViews）・本節を更新。

## 73. 改修プロンプトの「コピーして閉じる」修正＋ガントのステータスフィルタ/色分け（改善要望 2 件・オペレーター指示 2026-08-12）の完了条件（Definition of Done）

改善要望（F-42）から出た 2 改修単位への対応（mockup フロントのみ・API/DB/shared 変更なし）。

- [x] **(1) 「コピーして閉じる」がモーダルを閉じる**: `pages/improvements.vue` の改修プロンプト出力モーダルで、フッターの
  「コピーして閉じる」がコピー後に閉じなかった不具合を修正。`copyPrompt` を成否 boolean 化し、`copyAndClose` が
  **コピー成功時のみ `promptOpen=false`**（失敗時は手動選択できるよう開いたまま + 警告トースト = グレースフル）。
- [x] **(2) ガントのステータスフィルタ + 色分け**: `components/improvements/Gantt.vue`。
  - **フィルタ**: ツールバー下に `UiChipTabs`（選択肢・判定は一覧と共有 = `IMPROVEMENT_FILTER_OPTIONS`/`matchesImprovementFilter` = 原則3）。
    **既定 = 「対応する」（accepted = 実装が決まっていて未完了）**。フィルタは予定あり（バー）・予定未定チップの双方に適用。
  - **色分け**: ステータス別バー色（対応する=`bg-brand`／未判定=`bg-warn`／解決済み〔完了〕=`bg-muted`グレー／対応しない=`bg-crit`）。
    決着済み（完了・見送り）は `opacity-80` で退色し「終わった案件」を視覚的に沈める。表示中ステータスの**凡例**を範囲ラベル横に表示。
    バーの title に予定期間 + ステータス名を併記。空表示はフィルタ有無で文言を出し分け。レスポンシブ（原則8）= チップ/凡例は wrap・本体は横スクロール維持。
- [x] **フィードバック（原則）**: コピー成功/失敗はトースト。フィルタ切替は即時反映。
- [x] **下位互換（原則7）**: 表示・挙動の変更のみ（データ/型/API 不変）。データ移行パッチ不要。
- [x] **検証（実測値）**: mockup `npx nuxi typecheck` green・`npm test` **284 passed**（`improvement` に「ガント既定フィルタ = accepted」アサート追加）・
  `npm run build` green。API は不変（`api/` 変更なし）。
- [x] **ドキュメント整合（原則5）**: functional-requirements（F-42-9）・screen-design（5.7 ガント色分け/フィルタ・プロンプトのコピーして閉じる）・
  CONVENTIONS（ImprovementsGantt）・本節を更新。

## 74. 外部リンクアイコン設定の改善（プレビュー選択式 + 画像アップロード。改善要望・オペレーター指示 2026-08-12）の完了条件（Definition of Done）

設定（`/settings`）> 外部リンクのアイコン設定を、文字列指定からプレビュー選択式へ改善し、画像アップロードによるカスタムアイコンを追加する。
業態アプリ設定（segments の appIcon/appIconImage・0031）と同じデータモデル・allowlist を external_links にミラーする（原則3・再利用）。

- [x] **データモデル（下位互換 = 原則7）**: `shared/domain/types.ts` の `ExternalLink` に `iconImage?: string | null` を追加（任意 = 既存データ非破壊）。
  `MenuCard` にも `iconImage?` を追加（カードメニューの画像描画）。
- [x] **DB（0060）**: `external_links` に `icon_image text`（NULL 許容）を `ADD COLUMN IF NOT EXISTS`（冪等 = 原則2）。camel↔snake は masters の汎用マッピングが自動処理。
- [x] **API**: `masters/registry.ts` の `external-links` スキーマに `iconImage`（既存の `iconImage` ヘルパー = `data:image/(png|jpeg|webp);base64,…`・上限 400,000 字）。
  部分 PATCH は既存の hasOwn フィルタで未送信フィールドを保持（Zod v4 `.partial()` 対策は既存経路）。
- [x] **共通コンポーネント（原則3）**: `UiIconGlyph`（画像 or lucide を角丸枠で描画 = AkebonoSegmentIcon の汎用版）／
  `SettingsIconPicker`（v-model:icon/image/busy。プレビュー付きプリセット選択 `LINK_ICON_CHOICES` ＋ 画像アップロード〔160px 縮小・`imageToDataUri` 再利用〕＋「アイコンに戻す」取消）。
- [x] **画面**: `pages/settings.vue` の外部リンク追加/編集モーダルのアイコン欄を `SettingsIconPicker` に置換（従来の文字列入力を廃止）。
  処理中は保存ボタン無効化（フィードバック）。設定一覧の行アイコン・`/support`・ダッシュボード（`useExternalLinkCards`）・`UiCardMenu` を `UiIconGlyph` で画像優先描画。
- [x] **取消可能性（原則9.5）**: 画像設定後は「アイコンに戻す」で選択式アイコンへ戻せる。再編集で上書き可能。
- [x] **グレースフル（原則4）**: 画像以外/縮小後も上限超過は警告して中断（主フロー継続）。モック（localStorage）は容量超過時に警告（segments と同型）。
- [x] **レスポンシブ（原則8）**: プリセットグリッド・アップロード操作列は `flex-wrap`。375px で崩れない（プレビュー枠固定・グリッド折返し）。
- [x] **テスト**: mockup `tests/link-icons.test.ts`（`LINK_ICON_CHOICES` の lucide 実在性・重複なし・フォールバック）。
  API `test/integration/api.test.ts` に external-links の iconImage 検証（SVG=400・PNG=200・未指定作成=null・title 保持・null で取消）。
- [x] **検証（実測値）**: mockup `npx nuxi typecheck` green・`npm test` **287 passed**（+3）・`npm run build` green。
  API `npm run typecheck` green・`npm run test:integration` **253 passed**（+1・0060 適用含む）・`npm run build` green。
- [x] **ドキュメント整合（原則5）**: data-design（ExternalLink.iconImage）・api-design（external-links iconImage・useExternalLinkCards）・
  screen-design（5.x /settings 外部リンクのアイコンピッカー）・CONVENTIONS（UiIconGlyph・SettingsIconPicker・UiCardMenu）・本節を更新。
- [x] **独立レビュー（原則9）**: correctness バグなし。minor 3 件を反映 = ①保存の多重送信ガード（`linkSaving`・API モードの重複 POST 防止・segments と同型）／
  ②設定一覧の行アイコンを装飾扱い（alt 空・隣接タイトルがラベル = 二重読み上げ回避）／③プリセットグリッドに一覧外の現在アイコンを末尾追加（旧・文字列指定の下位互換・原則7）。

## 75. カンバンカードのはみ出し修正（改善要望・オペレーター指示 2026-08-12）の完了条件（Definition of Done）

改善要望（`/improvements`）のカンバンで、各改修案件カードがステータス枠（列）をはみ出す事象の修正（mockup フロントのみ・API/DB/shared 不変）。

- [x] **原因**: `ImprovementsKanban` のカード（`<article>`）は grid アイテムで既定 `min-width: auto`。タイトル（`truncate` = nowrap）の
  min-content が列幅（`w-64` = 256px）を超えると、カードが列幅より広がり枠外へはみ出していた（truncate が効かない典型パターン）。
- [x] **修正（`components/improvements/Kanban.vue`・CSS/テンプレートのみ）**:
  - カード `<article>` に `min-w-0` を付与 → grid トラック幅に収まり、タイトルの `truncate` が有効化。
  - 対象ページ名の span（`max-w-full truncate`）に `min-w-0` を追加 → nowrap の長い「名称（パス）」も確実に省略。
  - 列 `<section>` に `overflow-hidden` を付与 → 角丸枠にクリップし、万一の残余はみ出しも枠内に収める（多重防御）。
- [x] **表示の担保**: 長いタイトル・対象ページ名は `truncate` で省略し全文は `title` 属性（ホバーで確認）。予定チップ（日付 = `fmtDate` は短い）・
  遷移ボタン（`flex-wrap`）は従来どおり。フィードバック = カード/ボタンの hover・focus-within 状態は不変。
- [x] **レスポンシブ（原則8）**: 列は `w-64` 固定で親が横スクロール（既存）。375px でもカードは列内に収まり崩れない。
- [x] **下位互換（原則7）**: 表示（CSS）のみの変更。データ・型・API・ロジック不変。データ移行パッチ不要。
- [x] **テスト**: ロジック追加がないため新規単体テストなし（純 CSS/テンプレート修正・mockup の vitest は DOM レイアウトを持たず
  オーバーフローを判定できない）。回帰は `improvement`/`gantt` の既存テスト green + build/typecheck で担保。
- [x] **検証（実測値）**: mockup `npx nuxi typecheck` green・`npm test` **287 passed**・`npm run build` green。API は不変（`api/` 変更なし）。
- [x] **ドキュメント整合（原則5）**: screen-design（5.7 カンバンのカード折返し/クリップ）・本節を更新。
