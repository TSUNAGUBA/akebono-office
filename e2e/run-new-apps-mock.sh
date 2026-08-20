#!/usr/bin/env bash
# 新アプリ（company / intelligence）モックモード E2E ランナー。
# 各アプリを nuxt generate（モックモード = NUXT_PUBLIC_API_BASE 未設定）でビルドし、
# 静的配信（:4181 / :4182）して E2E スイートを実行する。API・PostgreSQL は不要。
# 使い方: bash e2e/run-new-apps-mock.sh
#   SKIP_BUILD=1 でビルド済み .output/public を再利用（スイート反復時の時短）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO:-$(dirname "$HERE")}"
COMPANY_PORT=4181
INTELLIGENCE_PORT=4182

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== company をビルド（モックモード）"
  ( cd "$REPO/company" && npm run generate )
  echo "== intelligence をビルド（モックモード）"
  ( cd "$REPO/intelligence" && npm run generate )
fi

[ -d "$REPO/company/.output/public" ] || { echo "company のビルド成果物がありません" >&2; exit 1; }
[ -d "$REPO/intelligence/.output/public" ] || { echo "intelligence のビルド成果物がありません" >&2; exit 1; }

node "$HERE/serve.cjs" "$REPO/company/.output/public" "$COMPANY_PORT" &
PIDS+=($!)
node "$HERE/serve.cjs" "$REPO/intelligence/.output/public" "$INTELLIGENCE_PORT" &
PIDS+=($!)
sleep 1

FAILED=0
echo ""
echo "== company-mock-e2e"
BASE="http://127.0.0.1:$COMPANY_PORT" node "$HERE/company-mock-e2e.cjs" || FAILED=1
echo ""
echo "== intelligence-mock-e2e"
BASE="http://127.0.0.1:$INTELLIGENCE_PORT" node "$HERE/intelligence-mock-e2e.cjs" || FAILED=1

exit "$FAILED"
