# Phase 7: デプロイ手順（mockup: Firebase Hosting / api: Cloud Run + RDS PostgreSQL）

- **作成日:** 2026-07-17
- **対象読者:** オペレーター（初回セットアップ）・開発者（日常デプロイ）
- **原則:** 手動手順は初回セットアップとフォールバックのみ。日常デプロイは main への push で全自動（開発原則1）

## 0. 全体像

| コンポーネント | デプロイ先 | トリガー |
|---|---|---|
| `mockup/`（Nuxt SPA） | Firebase Hosting | main へ push（`mockup/` `shared/` 変更時）or 手動 |
| `api/`（Hono API） | Cloud Run | main へ push（`api/` `shared/` 変更時）or 手動 |
| DB マイグレーション | RDS PostgreSQL | API コンテナ起動時に自動適用（冪等） |

日常運用で必要な操作は **main へのマージのみ**。以下は初回セットアップ手順。

## 1. 初回セットアップ（オペレーター作業）

### 1-1. RDS PostgreSQL の作成（AWS 側・初回のみ）

1. RDS で PostgreSQL 16 インスタンスを作成（例: `db.t4g.micro`、東京 `ap-northeast-1`）
   - DB 名: `akebono_office` / マスターユーザーではなく**アプリ専用ユーザー**を推奨（下記）
   - パラメータグループで `rds.force_ssl = 1`（TLS 必須化）
2. アプリ用ロールと DB を作成:
   ```sql
   CREATE ROLE app LOGIN PASSWORD '<強いパスワード>';
   CREATE DATABASE akebono_office OWNER app;
   ```
   スキーマ（app_office）とテーブルは**API の起動時マイグレーションが自動作成**するため手動作成は不要。
3. ネットワーク（v1 = パブリック + TLS + IP 制限。production-architecture.md §5）:
   - パブリックアクセス: あり
   - セキュリティグループ: インバウンド 5432 を **Cloud Run の固定エグレス IP のみ**許可
     （固定 IP は 1-2 の後、Cloud Run に Direct VPC egress + Cloud NAT 静的 IP を設定して取得。
      それまでの動作確認は作業者のグローバル IP を一時許可でも可）
4. 接続文字列を控える:
   ```
   postgresql://app:<パスワード>@<エンドポイント>:5432/akebono_office
   ```

### 1-2. GCP プロジェクトの準備（初回のみ）

1. Firebase プロジェクト（mockup で使用中のもの）で以下の API を有効化:
   ```bash
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
   ```
2. デプロイ用サービスアカウントを作成しロールを付与（mockup 用と共用する場合）:
   ```bash
   PROJECT_ID=<your-project>
   gcloud iam service-accounts create github-actions-deploy --project $PROJECT_ID
   for ROLE in roles/firebasehosting.admin roles/run.admin roles/artifactregistry.admin \
               roles/iam.serviceAccountUser roles/secretmanager.admin; do
     gcloud projects add-iam-policy-binding $PROJECT_ID \
       --member "serviceAccount:github-actions-deploy@$PROJECT_ID.iam.gserviceaccount.com" \
       --role $ROLE
   done
   gcloud iam service-accounts keys create deploy-sa.json \
     --iam-account "github-actions-deploy@$PROJECT_ID.iam.gserviceaccount.com"
   ```
3. Firebase Authentication を有効化（バッチ2 のログイン UI で使用。Google ログイン等のプロバイダを設定し、
   利用者の email を `members.email` に登録しておく — API は email で業務ユーザーを突合する）

### 1-3. Repository secrets の設定（PowerShell 1 コマンド）

```powershell
./scripts/setup-deploy-secrets.ps1 `
  -ProjectId <your-project> `
  -ServiceAccountJsonPath ./deploy-sa.json `
  -DatabaseUrl 'postgresql://app:<パスワード>@<エンドポイント>:5432/akebono_office' `
  -TriggerDeploy
```

設定される secrets（再実行で上書き = 冪等）:

| Secret | 用途 | 既定値 |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_PROJECT_ID` | mockup（従来どおり） | — |
| `GCP_SERVICE_ACCOUNT` | Cloud Run デプロイ | `-GcpServiceAccountJsonPath` 省略時は Firebase と共用 |
| `GCP_PROJECT_ID` | 〃 | `-ProjectId` と同一 |
| `GCP_REGION` | 〃 | `asia-northeast1` |
| `CLOUD_RUN_SERVICE` | 〃 | `akebono-office-api` |
| `DATABASE_URL` | RDS 接続文字列（Secret Manager へ中継） | — |
| `DB_SSL` | TLS モード | `require` |
| `API_CORS_ORIGINS` | CORS 許可オリジン | `https://<project>.web.app` |

> `-DatabaseUrl` を省略すると mockup 用 secrets のみ設定される（従来の使い方と完全互換）。
> その場合 deploy-api ジョブは警告を出してスキップされ、mockup のデプロイは通常どおり動く。

### 1-4. 動作確認

1. Actions の `deploy` ワークフローが green になったら、ログ末尾の Cloud Run URL を確認
2. ヘルスチェック: `curl https://<cloud-run-url>/healthz` → `{"status":"ok","db":"ok"}`
   - `db: "error"` の場合は RDS の SG / 接続文字列 / SSL 設定を確認（下記トラブルシュート）
3. API 認証の確認（メンバー登録後）:
   ```bash
   curl -H "Authorization: Bearer <FirebaseのIDトークン>" https://<cloud-run-url>/v1/me
   ```

### 1-5. TLS の強化（推奨・任意）

`DB_SSL=require` は暗号化のみで CA 検証を行わない。RDS の CA バンドルを配布して `verify` へ引き上げる:

1. [RDS グローバルバンドル](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) を取得
2. Cloud Run の環境変数 `DB_SSL=verify`・`DB_SSL_CA=<PEM の内容>` を設定
   （量が多い場合は Secret Manager に格納し `--set-secrets DB_SSL_CA=...` で注入）

## 2. 日常デプロイ（開発者）

- **自動:** main へマージ → 変更パスに応じて mockup / api が自動デプロイ
  - api は `api-test`（typecheck + 単体 + 統合テスト + build）が green の場合のみデプロイされる
- **手動:** `gh workflow run deploy.yml` または Actions 画面から `Run workflow`
- **ロールバック:** Cloud Run はリビジョン単位で保持される
  ```bash
  gcloud run services update-traffic akebono-office-api --region asia-northeast1 \
    --to-revisions <前リビジョン>=100
  ```
  DB マイグレーションは前方互換（追加のみ）を原則とし、破壊的変更は別バッチで段階適用する（開発原則7）

## 3. ローカル開発（api）

```bash
cd api
npm install
# 使い捨て PostgreSQL で統合テスト（postgresql 16 が必要。root の場合 postgres ユーザーへ自動降格）
npm run test:integration
# 開発サーバー（DATABASE_URL を用意して）
DATABASE_URL=postgresql://... AUTH_MODE=dev npm run dev
# 認証は dev モード: curl -H 'x-dev-member-id: m-01' localhost:8080/v1/me
```

## 4. トラブルシュート

| 症状 | 原因と対処 |
|---|---|
| deploy-api が「secrets 未設定のためスキップ」 | `setup-deploy-secrets.ps1 -DatabaseUrl ...` を実行して API 用 secrets を設定 |
| `/healthz` が `db: "error"` | RDS の SG に Cloud Run のエグレス IP が許可されているか・`DATABASE_URL` のホスト/パスワード・`rds.force_ssl` と `DB_SSL` の整合を確認 |
| `AKO-AUTH-002 メンバー未登録` | ログインした email が `members.email`（在籍者）に存在しない。メンバーマスタに登録する |
| マイグレーション失敗でコンテナが起動しない | Cloud Run のログで `migrate: applying ...` のエラーを確認。修正 SQL を追加して再デプロイ（適用済みファイルはスキップされる） |
| `permission denied to create extension` 等 | 本マイグレーションは拡張不要（gen_random_uuid 不使用）。カスタム SQL を足す際は RDS の権限制約に注意 |
| Cloud Run から RDS への接続が遅い | 東京リージョン同士か確認（asia-northeast1 ⇄ ap-northeast-1）。恒常的に問題になる場合は production-architecture.md §5 の案 B / Cloud SQL 移行を検討 |

## 5. セキュリティ上の申し送り

- API は公開 URL（`--allow-unauthenticated`）だが、`/v1/*` は Firebase ID トークン必須（アプリ層認証）。`/healthz` のみ匿名
- `DATABASE_URL` は Secret Manager 経由（Cloud Run の env に平文で置かない）。GitHub 側は Repository secrets
- RDS は TLS 必須（`rds.force_ssl=1`）+ SG 最小許可。パスワードは十分に長く（URL エンコード注意）
- フロント接続（バッチ2）完了までは、実データを投入する場合でも利用者はモック画面（localStorage）を見る点に注意（API と画面のデータは別物）
