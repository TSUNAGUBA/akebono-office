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
| タイムカード（管理者/人事・フィルター付きテーブル） | F-04-8 | ✅ | ✅ `GET /v1/attendance/timecard` | ✅ | 期間（上限 62 日）× 部署 × 氏名。メンバー横断集計をサーバーサイドで実行 |
| 休暇管理（管理者/人事: 一覧/明細・個別/一括付与） | F-04-9 | ✅ | ✅ `POST /v1/leave/grants`（+ `/bulk`）`GET /v1/leave/grants` | ✅ | 冪等性は DB UNIQUE 制約（member × 種別 × 付与日）で保証 |
| 有給の周期自動付与（労基法 39 条テーブル） | F-04-5 | ✅（シードで表現） | ✅ `POST /v1/leave/periodic-grants/run`（管理者/人事）+ `/jobs/periodic-leave-grants`（Cloud Scheduler・CRON_SECRET） | ✅ 手動実行はサーバー / 定期実行は Cloud Scheduler | 入社日 + 6 ヶ月 + n 年で走査し UNIQUE 制約で冪等付与。当日付与分のみ本人へ通知 |

### 業務日報 `/reports`

| 画面 / 機能 | 機能ID | モックアップ | 本実装 API+DB | 本実装 フロント接続 | 備考 |
|---|---|:---:|:---:|:---:|---|
| 日報の作成・下書き・提出・提出後編集 | F-06-1 | ✅ | ✅ `PUT /v1/reports/daily` | ✅ | 提出済みは本人が編集可（PR #29・オペレーター指示 2026-07-17。提出状態・初回提出時刻は維持し編集を監査ログへ記録。下書きへ戻す操作のみ AKO-REP-001）。0.25h 刻み正規化をサーバー側で実施 |
| 自分の日報一覧・提出状況 | F-06-2 | ✅ | ✅ `GET /v1/reports/daily`（month / from-to 期間指定） | ✅ | 月単位の遅延ロードキャッシュ（画面の射影ロジックはモックと共通） |
| チーム提出状況・タイムライン（管理者） | F-06-5 | ✅ | ✅ `GET /v1/reports/daily?scope=team` | ✅ | AI 社員の日報は AI カンパニー（バッチ4）接続まで API モードのタイムラインに出ない |
| コメント・リアクション | F-06-6 | ✅ | ✅ `GET/POST /v1/reports/:id/comments`・`POST /v1/reports/comments/:id/reactions`（トグル） | ✅ | コメント時の作成者通知はサーバー発火 |
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
| 権限設定 | F-16 | —（バッチ5c で新設） | ✅ `/v1/masters/permission-rules`（0013）+ 機能ガード middleware（AKO-PRM-001）+ マスタ GET の表示項目剥がし（PR #32） | ✅ `/masters/permissions`（3 レイヤのルール CRUD）+ メニュー/ページ/カードの非表示 + ルートガード | 解決順 = 個人 > 役職 > ロール（同一レイヤは拒否優先・未設定は許可 = 下位互換）。既存ロールガードは緩められない制限レイヤ。/v1/masters・configs・notifications・escalations はデータ面のためガード対象外（設計判断）。フィールド剥がしは API モードで有効（モックは管理 UI と機能ガードのみ） |

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
| ワークフロー・稟議 `/workflow` | F-07 | ✅ | ✅ ワークフロー接続済み（PR #22）: 申請・経路凍結・承認/却下/差戻し（クレームファースト）・代理承認・承認ログ・通知 + 承認経路マスタ | PR #23 で下書きの可視性を本人と管理者のみに制限（レビュー指摘対応） |
| シフト表 `/shift` | F-05 | ✅ | ✅ シフト接続済み（PR #23） | 希望・割当の参照は管理者 = 全件 / 本人 = 自分のみのサーバースコープ |
| 意思決定支援 `/decision` | F-02 | ✅ | ✅ 意思決定接続済み（PR #28）: 判断テーマ = 汎用マスタ `/v1/masters/decision-themes`（0011 で mockup seed を移行）・判断ログ = `/v1/decisions/logs`（追記のみ = 記録系保護。テーマ・選択肢・理由をサーバーで強制） | シナリオ予測（決定的線形モデル）は表示射影としてクライアント側に維持（設計判断） |
| AKEBONO（3D オフィス） `/akebono` | F-03 | ✅ | 🚧 AKEBONO 接続（本 PR = バッチ6d）: 要望ボックス = `akebono_wishes`（0019・記録系 = 追記のみ・編集/削除なし）・`GET/POST /v1/akebono/wishes`（本文必須 = AKO-AKB-001・2000 cp 切詰め・全員参照可 = 社内 C2）・useAkebono デュアルモード化・機能ガード 'akebono'（F-16）・チャットボット文脈に AKEBONO ブロック追加。プレースホルダ（バナー・ロードマップ）は静的表示 = フロントの責務 | **本 PR で mock-status が空 = API モードのモックバッジ全廃（マイルストーン）** |
| AIネイティブカンパニー `/ai-company` | F-08 | ✅ | ✅ AI カンパニー接続済み（PR #35 = バッチ6a）: ロール/AI 社員 = 汎用マスタ（0015）・タスク依頼 → 分解（Vertex AI → 失敗時 shared/domain/ai-tasks の同一ヒューリスティック）→ 承認 → 実行 → 完了（FOR UPDATE 状態機械・活動ログ追記・依頼者へ通知・AI 社員 status 同期）・日次報告 = daily_reports（author_kind='ai'・冪等生成）・停滞/過負荷/低確信度エスカレーション・機能ガード 'ai-company'（F-16） | AI 社員の「実実行」（LLM がステップを自律実行）は将来拡張。現段階は進行操作を人が行うワークフロー |
| 業務支援ツール `/support` | F-09 | ✅ | ⏳ | ドキュメント・外部リンクは接続済みマスタを参照。チャットボット（F-09-3）は PR #27 で接続済み |
| 売上管理 `/sales` | F-15 | ✅ | ✅ 売上接続済み（PR #36 = バッチ6b）: 月次実績 = `sales_monthly`（0017・冪等キー month × company × projectType の upsert）・`GET/POST /v1/sales`（登録は管理者のみ・一括取込 500 件）・実績登録モーダル（管理者）・会計年度計算 = shared/domain/fiscal をフロント/API 共有・機能ガード 'sales'（F-16）・チャットボット文脈に売上サマリ追加 + **mart ETL**: `fact_sales` / `mart_load_runs`（app_office 内 mart 互換 = オペレーター判断 2026-07-18）へ一方向 ETL（`POST /v1/sales/etl/run` + `/jobs/sales-mart-etl`） | 実績データのためマスタ初期値シードなし（新規環境は管理者登録 or 取込から） |
| 提供システム稼働状況 `/status` | F-11 | ✅ | ✅ 稼働状況接続済み（PR #37 = バッチ6c）: サービス = `system_services`（0018・mockup と同一の 3 サービスをシード）・インシデント = `service_incidents`（記録系 = updates 追記のみ・正順の状態機械を FOR UPDATE で直列化・登録/更新で管理者通知）・uptime = `uptime_daily`（SoT はインシデント → shared/domain/uptime で日次導出・窓内 DELETE→INSERT で冪等。トリガ = 登録/更新時 + `/jobs/uptime-rollup` + 管理者の手動再計算）・`GET /v1/status` 一括ハイドレーション（90 日 operational 埋め）・機能ガード 'status'（F-16）・チャットボット文脈 + 決定的フォールバックも実データ化 | モックの乱数 uptime シードは本番へ持ち込まない（インシデント実績から導出） |
| チャットボット（画面内ヘルプ） | F-09-3 | ✅ | ✅ チャットボット接続済み（PR #27）+ ✅ セッション管理（PR #30/#31・オペレーター指示 2026-07-17）: 会話は chat_sessions / chat_messages（0012）で DB 管理・同一セッション内は直近履歴 12 件を LLM へ渡すマルチターン・過去セッションの再開/新規開始（履歴ドロワー + 新しい会話）・本人のみ参照（AKO-CHT-001）・メッセージは追記のみ。fallback 応答もセッションへ追記（履歴の忠実性） | 旧「会話履歴はセッションローカル」設計判断は PR #30/#31 で置換。ドキュメントの回答は移行前のためデモデータ（ページ説明に明示。稼働状況はバッチ6c で実データ化）。エスカレーション起票は PR #21 で接続済み |
| mart（分析基盤）ETL: fact_attendance / fact_leave / fact_effort ほか | data-design §2 | —（写像可能な型のみ） | 🚧 fact_sales のみ本 PR（バッチ6b）で実装（app_office 内 mart 互換テーブル + mart_load_runs。data-design §2.3 の実装状況注記参照）。他ファクトは ⏳ | app_office → mart の一方向 ETL。mart 本体（akebono-scm-platform）への接続はテーブル移送 + ETL 先切替で対応（オペレーター判断 2026-07-18） |

## 3. バッチ3d（PR #25・マージ済み）: AI業務アシスタント + 日報 AI アシストの完了条件（Definition of Done）

- [x] task_plans / assist_logs テーブル（0008。結果記録済み計画は不変・ログは追記のみ = 記録系保護）
- [x] `/v1/task-plans`: 一覧（本人スコープ）/ upsert（AKO-TPL-001〜004）/ 削除（planned のみ）/ AI レビュー（Vertex AI generateJson → 失敗時は shared/domain/task-plan-review の同一ヒューリスティック = 原則4）/ 結果記録（FOR UPDATE クレームで 1 回確定・AKO-TPL-005）/ インサイト（管理者・SQL 集計）
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
