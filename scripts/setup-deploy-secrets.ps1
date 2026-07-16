<#
.SYNOPSIS
  GitHub Actions デプロイ（.github/workflows/deploy.yml）が参照する
  Repository secrets を PowerShell だけで設定するスクリプト。

.DESCRIPTION
  以下 2 つの Repository secrets を gh CLI 経由で設定します:
    - FIREBASE_SERVICE_ACCOUNT : Firebase Hosting デプロイ用サービスアカウント鍵 JSON
    - FIREBASE_PROJECT_ID      : Firebase プロジェクト ID

  前提:
    - GitHub CLI (gh) がインストール済みで `gh auth login` 済みであること
      （インストール: winget install GitHub.cli）
    - 対象リポジトリへの admin 権限があること

  サービスアカウント鍵の作成（初回のみ・GCP 側の操作）:
    gcloud CLI があれば以下で作成できます（PROJECT_ID は自分のものに置換）:
      gcloud iam service-accounts create github-actions-deploy --project PROJECT_ID
      gcloud projects add-iam-policy-binding PROJECT_ID `
        --member "serviceAccount:github-actions-deploy@PROJECT_ID.iam.gserviceaccount.com" `
        --role "roles/firebasehosting.admin"
      gcloud iam service-accounts keys create firebase-sa.json `
        --iam-account "github-actions-deploy@PROJECT_ID.iam.gserviceaccount.com"
    gcloud を使わない場合は Firebase Console > プロジェクトの設定 > サービスアカウント からも生成できます。

.EXAMPLE
  ./scripts/setup-deploy-secrets.ps1 -ProjectId my-firebase-project -ServiceAccountJsonPath ./firebase-sa.json

.EXAMPLE
  # 設定後にそのままデプロイを起動する
  ./scripts/setup-deploy-secrets.ps1 -ProjectId my-firebase-project -ServiceAccountJsonPath ./firebase-sa.json -TriggerDeploy
#>
[CmdletBinding()]
param(
  # Firebase プロジェクト ID（例: akebono-office-mock）
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  # サービスアカウント鍵 JSON ファイルのパス
  [Parameter(Mandatory = $true)]
  [string]$ServiceAccountJsonPath,

  # 対象リポジトリ（owner/repo）
  [string]$Repo = 'TSUNAGUBA/akebono-office',

  # 設定完了後に deploy ワークフローを手動起動する
  [switch]$TriggerDeploy
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
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
if (-not (Test-Path $ServiceAccountJsonPath)) {
  throw "ファイルが見つかりません: $ServiceAccountJsonPath"
}
$saRaw = Get-Content -Raw -Path $ServiceAccountJsonPath
try {
  $sa = $saRaw | ConvertFrom-Json
}
catch {
  throw 'サービスアカウント鍵が JSON として解析できません。ダウンロードした鍵ファイルを指定してください。'
}
if ($sa.type -ne 'service_account' -or -not $sa.client_email) {
  throw "指定されたファイルはサービスアカウント鍵ではないようです（type=$($sa.type)）。"
}
if ($sa.project_id -and $sa.project_id -ne $ProjectId) {
  Write-Warning "鍵の project_id ($($sa.project_id)) と -ProjectId ($ProjectId) が一致しません。意図したプロジェクトか確認してください。"
}

# ---------- Secrets 設定（冪等: 再実行すると同名 secret を上書き更新） ----------

Write-Step "Repository secrets を設定: $Repo"
$saRaw | gh secret set FIREBASE_SERVICE_ACCOUNT --repo $Repo
if ($LASTEXITCODE -ne 0) { throw 'FIREBASE_SERVICE_ACCOUNT の設定に失敗しました。' }
Write-Host '  ✓ FIREBASE_SERVICE_ACCOUNT'

gh secret set FIREBASE_PROJECT_ID --repo $Repo --body $ProjectId
if ($LASTEXITCODE -ne 0) { throw 'FIREBASE_PROJECT_ID の設定に失敗しました。' }
Write-Host '  ✓ FIREBASE_PROJECT_ID'

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
Write-Host '完了しました。main への push（mockup/ 配下の変更）または gh workflow run deploy.yml でデプロイされます。' -ForegroundColor Green
