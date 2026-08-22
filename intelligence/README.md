# AKEBONO Intelligence

経営・各顧客・各案件に対する**分析・インサイト・提案**を得て、実行した**アクションと結果・フィードバック**を記録し、
次の分析にそのフィードバックが反映される**ループ構造**を体現する独立フロントエンドです。
共通基盤（AKEBONO Home の API）に蓄積されたデータを読み取り専用の RAG 入力として使います。

- 要件: [`../.ai-native/outputs/phase3/company-intelligence-requirements.md`](../.ai-native/outputs/phase3/company-intelligence-requirements.md)
- 設計: [`../.ai-native/outputs/phase5/company-intelligence-design.md`](../.ai-native/outputs/phase5/company-intelligence-design.md)
- 実装規約: [`../home/CONVENTIONS.md`](../home/CONVENTIONS.md) を踏襲（デザイントークン・決定的モック・JST 壁時計・エラーコード等）

## 画面

| パス | 内容 |
|------|------|
| `/` | ダッシュボード(カバレッジ KPI・ループ概況・最新インサイト・未完了アクション) |
| `/insights` | 分析の実行（経営 / 顧客 / 案件）と生成インサイト（要約・根拠・発見・提案）。提案のアクション化 |
| `/actions` | アクション管理（計画 → 実行 → 完了）+ 結果の記録 + フィードバック（5 段階 + コメント） |
| `/cycles` | フィードバックループ履歴（サイクルごとの入力スナップショット・反映フィードバック明細） |
| `/data` | データソース = 3 カテゴリのデータ基盤（自社コンテキスト / ナレッジ / ログ）+ 月別推移 |
| `/data/<item>` | データ項目の一覧（検索 + 20 件/ページ）→ 行押下で詳細ドロワー（共通 UI 構造 = 改善要望 2026-08-22） |

## データ基盤（3 カテゴリ。改善要望 2026-08-22）

すべてのデータ項目に共通 UI 構造「**データ項目 → 一覧 → 詳細**」を適用する（定義 SoT =
`app/utils/data-foundation.ts`）。

| カテゴリ | データ項目 |
|----------|-----------|
| 自社コンテキスト | 会社（自社）・プロジェクト・メンバー ※「文化」は Home に該当データが無いため対象外（担当者メモ） |
| ナレッジ | メディアレポート・ECレポート（AKEBONO ダッシュボード AI レポート）・委託販売レポート（支払通知書）・社内サポート（F-57）・月報 |
| ログ | 議事録・日報・週報・月報 |

## 参照データ（すべて既存 API・読み取り専用）

日報 / 週報 / 月報（`/v1/reports/*` scope=all）・サポート活動・営業活動・ビジネスパートナー活動・顧客活動・
月次売上（`/v1/sales`）・議事録（`/v1/notes?kind=minutes`）・メディアレポート（`/v1/media/weekly-reports`）・
ECレポート（`/v1/akebono/dashboard-insights/list`）・委託販売レポート（`/v1/akebono/payment-notices`）・
社内サポート（`/v1/internal-supports`）・マスタ（顧客・案件・メンバー）。
権限（F-16）によるサーバー側のフィルタはそのまま尊重します（見えるデータの範囲で分析・表示）。

## 動作モード（Home と同一の 3 モード）

| モード | 条件 | データ |
|--------|------|--------|
| モック | `NUXT_PUBLIC_API_BASE` 未設定 | アプリ内シード + localStorage（`aki.*`。日付が変わると再シード） |
| dev | API_BASE + `NUXT_PUBLIC_DEV_MEMBER_ID` | `x-dev-member-id` ヘッダ（ローカル/E2E 専用） |
| 本番 | API_BASE + `NUXT_PUBLIC_FIREBASE_CONFIG` | Firebase ID トークン → `/v1/me` 照合 |

## モック境界（2026-08-22 に本実装済み = 解消）

かつてモック境界だった 2 点は改善要望 2026-08-22 で本実装した:

- **分析エンジン**: API モードはサーバー実行（`POST /v1/intelligence/generate` = サーバーが DB から
  スナップショットを収集し Vertex AI で生成 → 失敗・無効環境は決定的ヒューリスティックへフォールバック）。
  スナップショット収集には**呼び出しユーザーの F-16 権限を適用**する（deny された機能キーのソースは
  分析材料から除外・日報/週報/月報は参照対象ルールでも絞る = 「見えるデータの範囲で分析」をサーバーでも強制）。
  決定的エンジンは `shared/domain/intelligence.ts` へ移設し、モックモードと API のフォールバックが
  同一関数を共有する（`app/utils/insight-engine.ts` はシム）。
- **インサイト・アクション・サイクルの記録**: SoT はサーバー（`/v1/intelligence/*` = `intel_*` テーブル。
  メンバー単位の所有・端末間同期あり）。旧ユーザー別 localStorage（`aki.store.v1.<メンバーID>`）の記録は
  初回ロード時に自動でサーバーへ移行される（サーバー側が空のときのみ = 再実行しても重複しない）。
- モックモード（`NUXT_PUBLIC_API_BASE` 未設定）は従来どおりデモシード + localStorage で完結する。
- 現在、API モードでモック動作のページはない（`app/utils/mock-status.ts` は空集合）。

## コマンド

```bash
npm install
npm run dev        # http://localhost:3000（モックモード）
npm run generate   # 静的出力（.output/public/）
npm run typecheck
npm run test       # 分析エンジン（フィードバックループ含む）のユニットテスト
```

## デプロイ

`main` へのプッシュ（`intelligence/**` ほかの変更）で GitHub Actions（`../.github/workflows/deploy.yml`）が
テストゲート通過後に Firebase Hosting の **専用サイト**へデプロイします。
サイト ID は repository secret `FIREBASE_HOSTING_SITE_INTELLIGENCE` で指定し、未登録の場合このアプリの
デプロイはスキップされます（他アプリのデプロイは継続）。API 接続には `API_CORS_ORIGINS` への
本サイトオリジンの追加が必要です。手順は
[`../.ai-native/outputs/phase7/deploy-guide.md`](../.ai-native/outputs/phase7/deploy-guide.md) §1-11 を参照。
