# AKEBONO Intelligence

経営・各顧客・各案件に対する**分析・インサイト・提案**を得て、実行した**アクションと結果・フィードバック**を記録し、
次の分析にそのフィードバックが反映される**ループ構造**を体現する独立フロントエンドです。
共通基盤（AKEBONO Office の API）に蓄積されたデータを読み取り専用の RAG 入力として使います。

- 要件: [`../.ai-native/outputs/phase3/company-intelligence-requirements.md`](../.ai-native/outputs/phase3/company-intelligence-requirements.md)
- 設計: [`../.ai-native/outputs/phase5/company-intelligence-design.md`](../.ai-native/outputs/phase5/company-intelligence-design.md)
- 実装規約: [`../mockup/CONVENTIONS.md`](../mockup/CONVENTIONS.md) を踏襲（デザイントークン・決定的モック・JST 壁時計・エラーコード等）

## 画面

| パス | 内容 |
|------|------|
| `/` | ダッシュボード(カバレッジ KPI・ループ概況・最新インサイト・未完了アクション) |
| `/insights` | 分析の実行（経営 / 顧客 / 案件）と生成インサイト（要約・根拠・発見・提案）。提案のアクション化 |
| `/actions` | アクション管理（計画 → 実行 → 完了）+ 結果の記録 + フィードバック（5 段階 + コメント） |
| `/cycles` | フィードバックループ履歴（サイクルごとの入力スナップショット・反映フィードバック明細） |
| `/data` | データソース状況（日報・週報・月報・活動 4 種・月次売上の件数/期間/月別推移） |

## 参照データ（すべて既存 API・読み取り専用）

日報 / 週報 / 月報（`/v1/reports/*` scope=all）・サポート活動・営業活動・ビジネスパートナー活動・顧客活動・
月次売上（`/v1/sales`）・マスタ（顧客・案件・メンバー）。**API への変更はありません**。
権限（F-16）によるサーバー側のフィルタはそのまま尊重します（見えるデータの範囲で分析）。

## 動作モード（Office と同一の 3 モード）

| モード | 条件 | データ |
|--------|------|--------|
| モック | `NUXT_PUBLIC_API_BASE` 未設定 | アプリ内シード + localStorage（`aki.*`。日付が変わると再シード） |
| dev | API_BASE + `NUXT_PUBLIC_DEV_MEMBER_ID` | `x-dev-member-id` ヘッダ（ローカル/E2E 専用） |
| 本番 | API_BASE + `NUXT_PUBLIC_FIREBASE_CONFIG` | Firebase ID トークン → `/v1/me` 照合 |

## モック境界（後日、共通 API で本実装）

- **分析エンジン**: `app/utils/insight-engine.ts` の決定的ヒューリスティック。本実装では共通 API の
  AI 推論（Vertex AI + RAG + WebSearch）へ置き換える。
- **インサイト・アクション・サイクルの記録**: SoT はブラウザ localStorage（API モードは
  `aki.store.v1.<メンバーID>` = ユーザー別に名前空間化。再シードされず利用者の記録を保護。
  ただし端末間同期されず、ブラウザデータの消去で失われる。各画面に注記あり）。
- 詳細は要件ドキュメント §5「モック境界の宣言」を参照。

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
