<#
.SYNOPSIS
  GitHub Actions デプロイ（.github/workflows/deploy.yml）が参照する
  Repository secrets を PowerShell だけで設定するスクリプト。

.DESCRIPTION
  [mockup（Firebase Hosting）用 — 必須]
    - FIREBASE_SERVICE_ACCOUNT : Firebase Hosting デプロイ用サービスアカウント鍵 JSON
    - FIREBASE_PROJECT_ID      : Firebase プロジェクト ID

  [api（Cloud Run + RDS PostgreSQL）用 — -DatabaseUrl 指定時に設定]
    - GCP_SERVICE_ACCOUNT      : Cloud Run デプロイ用サービスアカウント鍵 JSON
                                 （省略時は FIREBASE_SERVICE_ACCOUNT と同じ鍵を流用）
    - GCP_PROJECT_ID           : GCP プロジェクト ID（省略時は -ProjectId と同一）
    - GCP_REGION               : デプロイ先リージョン（既定: asia-northeast1）
    - CLOUD_RUN_SERVICE        : Cloud Run サービス名（既定: akebono-office-api）
    - DATABASE_URL             : RDS PostgreSQL 接続文字列
                                 例) postgresql://app:PASS@xxxx.ap-northeast-1.rds.amazonaws.com:5432/akebono_office
    - DB_SSL                   : disable / require / verify（既定: require。RDS は require 以上）
    - API_CORS_ORIGINS         : CORS 許可オリジン（既定: https://<GcpProjectId>.web.app）
    - VERTEX_LOCATION          : AI 機能（Vertex AI）のロケーション（任意。既定: global）
    - VERTEX_MODEL             : AI 機能の生成モデル ID（任意。既定: gemini-2.5-flash）
    - GOOGLE_OAUTH_CLIENT_ID   : カレンダー連携の OAuth クライアント ID（-GoogleOauthClientId）
    - GOOGLE_OAUTH_CLIENT_SECRET : 同シークレット（-GoogleOauthClientSecretPath でファイル渡し）
    - TOKEN_ENCRYPTION_KEY     : トークン暗号化鍵（初回のみ自動生成。既存は変更しない）
                                 ※ 認証は Cloud Run 実行 SA の ADC。API キーの secret は不要。
                                    aiplatform API 有効化と roles/aiplatform.user 付与は deploy
                                    ワークフローが冪等に実行する（権限不足時は deploy-guide.md の手順で付与）

  前提:
    - GitHub CLI (gh) がインストール済みで `gh auth login` 済みであること
      （インストール: winget install GitHub.cli）
    - 対象リポジトリへの admin 権限があること

  サービスアカウントの準備（初回のみ・GCP 側の操作。詳細は deploy-guide.md）:
    mockup 用ロール: roles/firebasehosting.admin
    api 用ロール:    roles/run.admin, roles/artifactregistry.admin,
                     roles/iam.serviceAccountUser, roles/secretmanager.admin,
                     roles/serviceusage.serviceUsageAdmin（Vertex AI の API 有効化用）,
                     roles/resourcemanager.projectIamAdmin（実行 SA への aiplatform.user 自動付与用。
                       付与しない場合は deploy が警告を出すので deploy-guide.md の手動手順で付与）
    1 つの SA に両方を付与して共用してもよい（小規模運用向け）:
      gcloud iam service-accounts create github-actions-deploy --project PROJECT_ID
      foreach ($role in @('roles/firebasehosting.admin','roles/run.admin',
                          'roles/artifactregistry.admin','roles/iam.serviceAccountUser',
                          'roles/secretmanager.admin','roles/serviceusage.serviceUsageAdmin',
                          'roles/resourcemanager.projectIamAdmin')) {
        gcloud projects add-iam-policy-binding PROJECT_ID `
          --member "serviceAccount:github-actions-deploy@PROJECT_ID.iam.gserviceaccount.com" `
          --role $role
      }
      gcloud iam service-accounts keys create deploy-sa.json `
        --iam-account "github-actions-deploy@PROJECT_ID.iam.gserviceaccount.com"

.EXAMPLE
  # mockup のみ（従来と同じ使い方。下位互換）
  ./scripts/setup-deploy-secrets.ps1 -ProjectId my-firebase-project -ServiceAccountJsonPath ./firebase-sa.json

.EXAMPLE
  # mockup + api（Cloud Run。SA 鍵は共用）
  ./scripts/setup-deploy-secrets.ps1 -ProjectId my-project -ServiceAccountJsonPath ./deploy-sa.json `
    -DatabaseUrl 'postgresql://app:PASS@mydb.xxxx.ap-northeast-1.rds.amazonaws.com:5432/akebono_office'

.EXAMPLE
  # 設定後にそのままデプロイを起動する
  ./scripts/setup-deploy-secrets.ps1 -ProjectId my-project -ServiceAccountJsonPath ./deploy-sa.json `
    -DatabaseUrl 'postgresql://...' -TriggerDeploy
#>
[CmdletBinding()]
param(
  # Firebase / GCP プロジェクト ID（例: akebono-office-mock）
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  # サービスアカウント鍵 JSON ファイルのパス（Firebase Hosting 用。-GcpServiceAccountJsonPath 省略時は api 用にも流用）
  [Parameter(Mandatory = $true)]
  [string]$ServiceAccountJsonPath,

  # 対象リポジトリ（owner/repo）
  [string]$Repo = 'TSUNAGUBA/akebono-office',

  # ---------- api（Cloud Run）用。-DatabaseUrl を指定すると API 用 secrets も設定する ----------

  # RDS PostgreSQL 接続文字列。未指定の場合 API 用 secrets は設定しない（deploy-api はスキップ動作）
  [string]$DatabaseUrl = '',

  # Cloud Run デプロイ用 SA 鍵 JSON（省略時は $ServiceAccountJsonPath を流用）
  [string]$GcpServiceAccountJsonPath = '',

  # GCP プロジェクト ID（省略時は $ProjectId と同一）
  [string]$GcpProjectId = '',

  # デプロイ先リージョン
  [string]$GcpRegion = 'asia-northeast1',

  # Cloud Run サービス名
  [string]$CloudRunService = 'akebono-office-api',

  # DB 接続の SSL モード（disable / require / verify。RDS は require 以上を推奨）
  [ValidateSet('disable', 'require', 'verify')]
  [string]$DbSsl = 'require',

  # API の CORS 許可オリジン（カンマ区切り。省略時は https://<GcpProjectId>.web.app）
  [string]$CorsOrigins = '',

  # AI 機能（Vertex AI）のロケーション（省略時は global。デプロイ側の既定を使用）
  [string]$VertexLocation = '',

  # AI 機能（Vertex AI）の生成モデル ID（省略時は gemini-2.5-flash。デプロイ側の既定を使用）
  [string]$VertexModel = '',

  # カレンダー連携: Google OAuth クライアント ID（Cloud Console で発行したウェブアプリ種別）
  [string]$GoogleOauthClientId = '',

  # カレンダー連携: クライアントシークレットを 1 行で書いたファイルのパス（チャット・履歴に残さないためファイル渡し）
  [string]$GoogleOauthClientSecretPath = '',

  # フロントエンドを API 接続版でビルドする場合の API URL（Cloud Run の URL。初回 api デプロイ後に設定）
  [string]$ApiBaseUrl = '',

  # Firebase Web アプリ設定 JSON のパス（Console > プロジェクトの設定 > マイアプリ の firebaseConfig）
  [string]$FirebaseWebConfigJsonPath = '',

  # 設定完了後に deploy ワークフローを手動起動する
  [switch]$TriggerDeploy
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

# gh secret set の共通ラッパー（stdin 経由・UTF-8。PS 5.1 の引数エスケープ問題と旧 gh の --body-file 非対応を回避）
function Set-RepoSecret([string]$Name, [string]$Value) {
  $prevOutputEncoding = $OutputEncoding
  try {
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $Value | gh secret set $Name --repo $Repo
  }
  finally {
    $OutputEncoding = $prevOutputEncoding
  }
  if ($LASTEXITCODE -ne 0) { throw "$Name の設定に失敗しました。" }
  Write-Host "  ✓ $Name"
}

# サービスアカウント鍵 JSON の読込と検証
function Read-ServiceAccountJson([string]$Path) {
  if (-not (Test-Path $Path)) {
    throw "ファイルが見つかりません: $Path"
  }
  $raw = Get-Content -Raw -Path $Path
  try {
    $sa = $raw | ConvertFrom-Json
  }
  catch {
    throw 'サービスアカウント鍵が JSON として解析できません。ダウンロードした鍵ファイルを指定してください。'
  }
  if ($sa.type -ne 'service_account' -or -not $sa.client_email) {
    throw "指定されたファイルはサービスアカウント鍵ではないようです（type=$($sa.type)）。"
  }
  return @{ Raw = $raw; Parsed = $sa }
}

# ---------- 前提チェック ----------

Write-Step 'gh CLI の確認'
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GitHub CLI (gh) が見つかりません。`winget install GitHub.cli` でインストールしてください。'
}

gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'gh が未認証です。`gh auth login` を実行してから再度お試しください。'
}

Write-Step 'サービスアカウント鍵 JSON の検証'
$firebaseSa = Read-ServiceAccountJson $ServiceAccountJsonPath
if ($firebaseSa.Parsed.project_id -and $firebaseSa.Parsed.project_id -ne $ProjectId) {
  Write-Warning "鍵の project_id ($($firebaseSa.Parsed.project_id)) と -ProjectId ($ProjectId) が一致しません。意図したプロジェクトか確認してください。"
}

# ---------- mockup 用 Secrets（冪等: 再実行すると同名 secret を上書き更新） ----------

Write-Step "Repository secrets を設定（mockup / Firebase Hosting）: $Repo"
Set-RepoSecret 'FIREBASE_SERVICE_ACCOUNT' $firebaseSa.Raw
Set-RepoSecret 'FIREBASE_PROJECT_ID' $ProjectId

# ---------- api 用 Secrets（-DatabaseUrl 指定時のみ） ----------

if ($DatabaseUrl) {
  if ($DatabaseUrl -notmatch '^postgres(ql)?://') {
    throw "-DatabaseUrl は postgresql:// 形式で指定してください（例: postgresql://app:PASS@host:5432/akebono_office）"
  }
  $gcpSa = $firebaseSa
  if ($GcpServiceAccountJsonPath) {
    Write-Step 'Cloud Run 用サービスアカウント鍵 JSON の検証'
    $gcpSa = Read-ServiceAccountJson $GcpServiceAccountJsonPath
  }
  $effectiveGcpProject = if ($GcpProjectId) { $GcpProjectId } else { $ProjectId }
  $effectiveCors = if ($CorsOrigins) { $CorsOrigins } else { "https://$effectiveGcpProject.web.app" }

  Write-Step "Repository secrets を設定（api / Cloud Run + RDS PostgreSQL）: $Repo"
  Set-RepoSecret 'GCP_SERVICE_ACCOUNT' $gcpSa.Raw
  Set-RepoSecret 'GCP_PROJECT_ID' $effectiveGcpProject
  Set-RepoSecret 'GCP_REGION' $GcpRegion
  Set-RepoSecret 'CLOUD_RUN_SERVICE' $CloudRunService
  Set-RepoSecret 'DATABASE_URL' $DatabaseUrl
  Set-RepoSecret 'DB_SSL' $DbSsl
  Set-RepoSecret 'API_CORS_ORIGINS' $effectiveCors
  # AI 機能（Vertex AI）: 既定値以外を使う場合のみ secrets を設定（未設定時は global / gemini-2.5-flash）
  if ($VertexLocation) { Set-RepoSecret 'VERTEX_LOCATION' $VertexLocation }
  if ($VertexModel) { Set-RepoSecret 'VERTEX_MODEL' $VertexModel }

  # カレンダー連携（F-06-8）: OAuth クライアント + トークン暗号化鍵。
  # 鍵は初回のみ自動生成（既存の TOKEN_ENCRYPTION_KEY があれば触らない = 保管済みトークンを壊さない）
  if ($GoogleOauthClientId -and $GoogleOauthClientSecretPath) {
    if (-not (Test-Path $GoogleOauthClientSecretPath)) { throw "ファイルが見つかりません: $GoogleOauthClientSecretPath" }
    $oauthSecret = (Get-Content -Raw -Path $GoogleOauthClientSecretPath).Trim()
    if (-not $oauthSecret) { throw 'クライアントシークレットのファイルが空です。' }
    Write-Step "Repository secrets を設定（カレンダー連携）: $Repo"
    Set-RepoSecret 'GOOGLE_OAUTH_CLIENT_ID' $GoogleOauthClientId
    Set-RepoSecret 'GOOGLE_OAUTH_CLIENT_SECRET' $oauthSecret
    $hasKey = (gh secret list --repo $Repo) -match 'TOKEN_ENCRYPTION_KEY'
    if (-not $hasKey) {
      $bytes = New-Object byte[] 32
      [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      Set-RepoSecret 'TOKEN_ENCRYPTION_KEY' ([Convert]::ToBase64String($bytes))
      Write-Host 'TOKEN_ENCRYPTION_KEY を自動生成しました（初回のみ）。' -ForegroundColor Yellow
    }
    else {
      Write-Host 'TOKEN_ENCRYPTION_KEY は設定済みのため変更しません（保管済みトークンの保護）。' -ForegroundColor Yellow
    }
    Write-Host '※ OAuth クライアントの「承認済みのリダイレクト URI」に <Cloud Run URL>/v1/calendar/oauth/callback を登録してください。' -ForegroundColor Yellow
  }
  elseif ($GoogleOauthClientId -or $GoogleOauthClientSecretPath) {
    Write-Warning '-GoogleOauthClientId と -GoogleOauthClientSecretPath は両方指定してください（カレンダー連携 secrets は未設定のまま）。'
  }
}
else {
  Write-Host ''
  Write-Warning ('-DatabaseUrl が未指定のため API（Cloud Run）用 secrets は設定していません。' +
    'deploy ワークフローの deploy-api ジョブは警告を出してスキップされます（mockup のみデプロイ）。')
}

# ---------- フロントエンドの API 接続ビルド用（任意。未設定なら従来どおりモックモードで配信） ----------

if ($ApiBaseUrl) {
  if ($ApiBaseUrl -notmatch '^https?://') {
    throw "-ApiBaseUrl は URL 形式で指定してください（例: https://akebono-office-api-xxxx.a.run.app）"
  }
  Write-Step "Repository secrets を設定（フロント API 接続ビルド）: $Repo"
  Set-RepoSecret 'API_BASE_URL' $ApiBaseUrl
  if ($FirebaseWebConfigJsonPath) {
    if (-not (Test-Path $FirebaseWebConfigJsonPath)) { throw "ファイルが見つかりません: $FirebaseWebConfigJsonPath" }
    $webConfigRaw = Get-Content -Raw -Path $FirebaseWebConfigJsonPath
    try { $null = $webConfigRaw | ConvertFrom-Json } catch { throw 'Firebase Web 設定が JSON として解析できません。' }
    Set-RepoSecret 'FIREBASE_WEB_CONFIG' $webConfigRaw
  }
  else {
    Write-Warning '-FirebaseWebConfigJsonPath が未指定です。API 接続ビルドではログインに Firebase Web 設定が必要です（dev 認証を除く）。'
  }
}

Write-Step '設定結果の確認'
gh secret list --repo $Repo

# ---------- 任意: デプロイの手動起動 ----------

if ($TriggerDeploy) {
  Write-Step 'deploy ワークフローを起動'
  gh workflow run deploy.yml --repo $Repo
  if ($LASTEXITCODE -ne 0) { throw 'ワークフローの起動に失敗しました（main ブランチに deploy.yml がマージ済みか確認してください）。' }
  Write-Host '起動しました。進行状況: ' -NoNewline
  Write-Host "https://github.com/$Repo/actions/workflows/deploy.yml" -ForegroundColor Green
}

Write-Host ''
Write-Host '完了しました。main への push（mockup/ api/ shared/ 配下の変更）または gh workflow run deploy.yml でデプロイされます。' -ForegroundColor Green
Write-Host 'RDS 側のネットワーク設定（Cloud Run からの到達性・SSL）は .ai-native/outputs/phase7/deploy-guide.md を参照してください。'
