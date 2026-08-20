# AKEBONO Company

AI ネイティブカンパニーの独立アプリ。AKEBONO Home（`../home/`）内の F-08「AIネイティブカンパニー」を
**別 URL の独立フロントエンド**として切り出したものです。共通基盤のデータを RAG として使いながら、
AI 社員がタスクを自律的に完遂し、トークン消費と予測費用の可視化・抑制・制限（トークン管理）を提供します。

- 要件: [`../.ai-native/outputs/phase3/company-intelligence-requirements.md`](../.ai-native/outputs/phase3/company-intelligence-requirements.md)
- 設計: [`../.ai-native/outputs/phase5/company-intelligence-design.md`](../.ai-native/outputs/phase5/company-intelligence-design.md)
- 実装規約: [`../home/CONVENTIONS.md`](../home/CONVENTIONS.md) を踏襲（デザイントークン・決定的モック・JST 壁時計・エラーコード等）

## 画面

| パス | 内容 |
|------|------|
| `/` | ダッシュボード（KPI・AI オフィス・タスク依頼・エスカレーション対応） |
| `/tasks` | タスクボード + タスク詳細（成果物・Q&A。`?task=` ディープリンク対応） |
| `/activity` | 活動ログ（トークン・概算コスト付きタイムライン） |
| `/reports` | AI 日次報告（冪等生成） |
| `/tokens` | トークン管理（可視化・月末予測・予算・抑制/制限）★本アプリの新設機能 |
| `/employees` `/roles` | AI 社員・ロール管理（admin） |

## 動作モード（Home と同一の 3 モード）

| モード | 条件 | データ |
|--------|------|--------|
| モック | `NUXT_PUBLIC_API_BASE` 未設定 | アプリ内シード + localStorage（`akc.*`。日付が変わると再シード） |
| dev | API_BASE + `NUXT_PUBLIC_DEV_MEMBER_ID` | `x-dev-member-id` ヘッダ（ローカル/E2E 専用） |
| 本番 | API_BASE + `NUXT_PUBLIC_FIREBASE_CONFIG` | Firebase ID トークン → `/v1/me` 照合 |

使用する API はすべて既存の共通 API（`/v1/ai-company/*`・`/v1/masters/*`・`/v1/me` ほか）で、**API への変更はありません**。

## モック境界（後日、共通 API で本実装）

- **トークン予算・制限設定**: SoT はブラウザ localStorage（`akc.tokenBudget.v1`）。端末間同期されません。
- **トークン実測値**: 活動ログの tokens/costUsd は現状決定的モック値です。
- **集計の打ち切り**: 既存 API の活動ログ取得は直近 200 件打ち切りのため、月間 200 件超では
  当月集計・予測・予算判定が過小になり得ます（画面に注記。月次集計 API が本実装課題）。
- 超過時の依頼・承認ブロックは UI 層の抑止です（サーバー強制は本実装時）。

詳細は要件ドキュメント §5「モック境界の宣言」を参照。

## コマンド

```bash
npm install
npm run dev        # http://localhost:3000（モックモード）
npm run generate   # 静的出力（.output/public/）
npm run typecheck
npm run test
```

## デプロイ

`main` へのプッシュ（`company/**` ほかの変更）で GitHub Actions（`../.github/workflows/deploy.yml`）が
テストゲート通過後に Firebase Hosting の **専用サイト**へデプロイします。
サイト ID は repository secret `FIREBASE_HOSTING_SITE_COMPANY` で指定し、未登録の場合このアプリの
デプロイはスキップされます（他アプリのデプロイは継続）。API 接続には `API_CORS_ORIGINS` への
本サイトオリジンの追加が必要です。手順は
[`../.ai-native/outputs/phase7/deploy-guide.md`](../.ai-native/outputs/phase7/deploy-guide.md) §1-11 を参照。
