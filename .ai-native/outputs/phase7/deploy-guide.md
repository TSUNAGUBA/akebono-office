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
               roles/iam.serviceAccountUser roles/secretmanager.admin \
               roles/serviceusage.serviceUsageAdmin roles/resourcemanager.projectIamAdmin; do
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

## 1-6. フロントエンドを API 接続版で配信する（バッチ2a 以降・任意）

既定の配信は**モックモード**（デモ）。実データ（RDS）に接続した画面を配信するには 2 段階で行う:

1. まず api をデプロイして Cloud Run URL を確認（1-3〜1-4）
2. Firebase Console > プロジェクトの設定 > マイアプリ（Web アプリ）から firebaseConfig JSON を取得し、
   Authentication でプロバイダ（メール/パスワード・Google 等）を有効化
3. secrets を追加して再デプロイ:
   ```powershell
   ./scripts/setup-deploy-secrets.ps1 -ProjectId <project> -ServiceAccountJsonPath ./deploy-sa.json `
     -ApiBaseUrl 'https://akebono-office-api-xxxx.a.run.app' `
     -FirebaseWebConfigJsonPath ./firebase-web-config.json -TriggerDeploy
   ```
   → 以後の `deploy-mockup` は `NUXT_PUBLIC_API_BASE` / `NUXT_PUBLIC_FIREBASE_CONFIG` 付きでビルドされ、
   ログイン必須の API 接続版が配信される（`API_BASE_URL` secret を削除すればモックモードへ戻る）
4. 利用者の email を メンバーマスタに登録する（API はログイン email と `members.email` を突合する）。
   最初の管理者だけは SQL で投入する:
   ```sql
   INSERT INTO app_office.members (id, name, email, role) VALUES ('m-admin', '管理者名', 'admin@your.co.jp', 'admin');
   ```
   以後のメンバーは画面（マスタメンテナンス > メンバー）から登録できる

## 1-7. 有給の周期自動付与（Cloud Scheduler・任意）

管理者/人事が画面外から `POST /v1/leave/periodic-grants/run` を叩けば手動実行できる（冪等）。
毎日自動実行する場合:

1. Cloud Run サービスに環境変数 `CRON_SECRET`（長いランダム文字列）を追加
2. Cloud Scheduler ジョブを作成:
   ```bash
   gcloud scheduler jobs create http periodic-leave-grants \
     --schedule "0 6 * * *" --time-zone "Asia/Tokyo" \
     --uri "https://<cloud-run-url>/jobs/periodic-leave-grants" \
     --http-method POST --headers "x-cron-key=<CRON_SECRET と同じ値>"
   ```
   付与は UNIQUE 制約（メンバー × 種別 × 付与日）で冪等のため、多重実行しても二重付与されない

## 1-7b. 売上 mart ETL の日次実行（Cloud Scheduler・任意。バッチ6b）

管理者が画面外から `POST /v1/sales/etl/run` を叩けば手動実行できる（冪等。実行履歴は
`GET /v1/sales/etl/runs`）。毎日自動実行する場合は 1-7 と同じ `CRON_SECRET` を使い:

```bash
gcloud scheduler jobs create http sales-mart-etl \
  --schedule "30 6 * * *" --time-zone "Asia/Tokyo" \
  --uri "https://<cloud-run-url>/jobs/sales-mart-etl" \
  --http-method POST --headers "x-cron-key=<CRON_SECRET と同じ値>"
```

ETL は `UNIQUE(tenant_key, source_txn_id)` の upsert で冪等のため、多重実行しても fact 行は増えない。

## 1-8. AI 機能（Vertex AI）

AI 機能（日報 AI アシスト・タスク計画の AI コメント等）は **Vertex AI**（オペレーター決定 2026-07-17）を
サーバーサイド（Cloud Run API）から呼び出す。**API キーの secret は不要** — Cloud Run 実行サービス
アカウントの ADC（Application Default Credentials）で認証する。

- **自動セットアップ:** deploy ワークフローが毎回冪等に実行する
  1. `aiplatform.googleapis.com` の有効化
  2. Cloud Run 実行 SA（Compute Engine 既定 SA）への `roles/aiplatform.user` 付与
  3. Cloud Run へ環境変数 `VERTEX_PROJECT_ID`（= GCP_PROJECT_ID）・`VERTEX_LOCATION`（既定 global）・
     `VERTEX_MODEL`（既定 gemini-2.5-flash）を設定
- **手動フォールバック:** デプロイ SA に権限がなく警告が出た場合、オーナー権限で 1 回だけ実行:
  ```bash
  PROJECT_ID=<your-project>
  gcloud services enable aiplatform.googleapis.com --project $PROJECT_ID
  PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role roles/aiplatform.user
  ```
- **モデル・ロケーションの変更:** `setup-deploy-secrets.ps1 -VertexLocation asia-northeast1 -VertexModel gemini-2.5-pro`
  のように secrets（VERTEX_LOCATION / VERTEX_MODEL）を設定して再デプロイ
- **フォールバック動作:** `VERTEX_PROJECT_ID` 未設定・権限不足・API エラー時、AI 機能は決定的
  ヒューリスティック（モックと同じ生成ロジック）へ自動フォールバックし、主要フローは止まらない（原則4）

## 1-9. カレンダー連携（Google OAuth・F-06-8）

日報 AI アシストのカレンダー材料取得と予定同期に使用する。トークンはサーバー側で AES-256-GCM
暗号化のうえ DB 保管（クライアントへ出さない。喪失時は再連携で回復）。

1. Cloud Console で OAuth クライアント（**ウェブアプリケーション**種別）を発行し、
   「承認済みのリダイレクト URI」に Cloud Run の URL + コールバックパスを登録:
   ```
   https://<cloud-run-url>/v1/calendar/oauth/callback
   ```
   **Google Calendar API の有効化も必要**（デプロイが `calendar-json.googleapis.com` を自動有効化する。
   権限不足で警告が出た場合はオーナー権限で `gcloud services enable calendar-json.googleapis.com` を実行）。
   OAuth のトークン交換は Calendar API 無効でも成功するため、「連携はできるが同期が失敗する」場合は
   まずこの有効化を確認する（§4 トラブルシュート参照）
2. secrets を設定（シークレットはファイル渡し = チャット・シェル履歴に残さない）:
   ```powershell
   ./scripts/setup-deploy-secrets.ps1 -ProjectId <project> -ServiceAccountJsonPath ./deploy-sa.json `
     -DatabaseUrl 'postgresql://...' `
     -GoogleOauthClientId '<client-id>.apps.googleusercontent.com' `
     -GoogleOauthClientSecretPath ./oauth-secret.txt -TriggerDeploy
   ```
   `TOKEN_ENCRYPTION_KEY` は初回のみ自動生成される（既存キーは変更しない = 保管済みトークンの保護）
3. デプロイが Secret Manager（`<service>-google-oauth-secret` / `<service>-token-encryption-key`）への
   登録と Cloud Run への注入まで冪等に行う。secrets 未設定の間、カレンダー連携機能は自動的に無効
   （画面に連携 UI が出ない）でその他の機能に影響しない

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
| ログイン後「メンバー未登録です」（`AKO-AUTH-002`） | ログインした email が `members.email`（在籍・`active = true`）に存在しない。突合は大文字小文字を無視した完全一致（前後の空白・全角文字は不一致になる）。`SELECT id, email, active FROM app_office.members WHERE lower(email) = lower('<ログイン email>');` で行の存在・`active` を確認する。行があるのに出る場合は、`DATABASE_URL` が指す**データベース名**と同じ DB へ INSERT したかを確認（別 DB・別スキーマへの投入が典型原因）。登録後は画面の「登録後に再確認」で再突合できる |
| ログイン後「API に接続できません」 | `/v1/me` が未登録以外の理由で失敗している。画面に表示されるコードで切り分ける: `AKO-GEN-NET` = API 未達（`API_BASE_URL` の URL が正しいか `curl <API_BASE_URL>/healthz` で確認。存在しない `*.run.app` ホストは Google の 404 ページになる）または CORS 拒否（`CORS_ORIGINS` secret に `https://<project>.web.app` が含まれるか。変更後は deploy を再実行）/ `AKO-AUTH-001` = トークン検証失敗（API の `FIREBASE_PROJECT_ID` と Web 側 firebaseConfig の `projectId` の一致を確認）/ `AKO-GEN-500` = Cloud Run ログを確認 |
| マイグレーション失敗でコンテナが起動しない | Cloud Run のログで `migrate: applying ...` のエラーを確認。修正 SQL を追加して再デプロイ（適用済みファイルはスキップされる） |
| `permission denied to create extension` 等 | 本マイグレーションは拡張不要（gen_random_uuid 不使用）。カスタム SQL を足す際は RDS の権限制約に注意 |
| Cloud Run から RDS への接続が遅い | 東京リージョン同士か確認（asia-northeast1 ⇄ ap-northeast-1）。恒常的に問題になる場合は production-architecture.md §5 の案 B / Cloud SQL 移行を検討 |

### カレンダー連携: エラー 400 redirect_uri_mismatch

OAuth クライアントの「承認済みのリダイレクト URI」とアプリが送る URI の不一致。Google のエラー画面の
「エラーの詳細」に表示される `redirect_uri` の値を**一字一句そのまま**登録する（Cloud Run の URL には
旧形式 `*-an.a.run.app` と新形式 `*-<番号>.<region>.run.app` があり、フロントの API_BASE_URL と同じ形式で
登録すること。末尾スラッシュ・http/https の違いも不一致になる）。登録後の反映に数分かかる場合がある。

### カレンダー連携: 連携は成功するが「Google から同期」が失敗する

典型原因は GCP プロジェクトで **Google Calendar API が未有効化**（OAuth のトークン交換は Calendar API
無効でも成功するため、連携済み表示と同期失敗が併存する）。オーナー権限で以下を実行して数分待つ:

```bash
gcloud services enable calendar-json.googleapis.com --project <project-id>
```

デプロイワークフローも自動で有効化を試みる（権限不足時は Actions に警告が出る）。有効化済みでも失敗する
場合は Cloud Run ログの `calendar sync failed:` 行で Google 側のステータスコードと本文を確認する。

## 5. セキュリティ上の申し送り

- API は公開 URL（`--allow-unauthenticated`）だが、`/v1/*` は Firebase ID トークン必須（アプリ層認証）。`/healthz` のみ匿名
- `DATABASE_URL` は Secret Manager 経由（Cloud Run の env に平文で置かない）。GitHub 側は Repository secrets
- RDS は TLS 必須（`rds.force_ssl=1`）+ SG 最小許可。パスワードは十分に長く（URL エンコード注意）
- フロント接続（バッチ2）完了までは、実データを投入する場合でも利用者はモック画面（localStorage）を見る点に注意（API と画面のデータは別物）
