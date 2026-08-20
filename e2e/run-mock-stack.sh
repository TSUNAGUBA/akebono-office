#!/usr/bin/env bash
# モックモード専用 E2E ランナー（PR テストゲート用。改修依頼 2026-08-20）。
# 使い捨て PostgreSQL / API を使わず、mockup をモックモードで generate → 静的配信して
# モックモードのスイートだけを実行する（フルスタック検証は run-batch6b-stack.sh）。
#
# - モックモードのスイート一覧の SoT は本ファイルの MOCK_SUITES（run-batch6b-stack.sh からも呼ばれる = 原則3）。
#   新スイートは MOCK_SUITES に 1 行追記する。
# - BASE 環境変数が与えられた場合はビルド・配信をスキップし、その URL に対してスイートのみ実行する
#   （フルスタックランナーが配信済みの :4173 を再利用する経路）。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO:-$(dirname "$HERE")}"

MOCK_SUITES=(
  "mock-regression-e2e.cjs"
  "activity-pages-e2e.cjs"
  "batch2-e2e.cjs"
  "batch3-e2e.cjs"
  "improvements6-e2e.cjs"
  "activity-cases-e2e.cjs"
)

run_suites() {
  local base="$1"
  for s in "${MOCK_SUITES[@]}"; do
    echo "==> ${s}（モックモード）"
    (cd "$HERE" && BASE="$base" node "$s")
  done
}

if [ -n "${BASE:-}" ]; then
  run_suites "$BASE"
  echo "==> モックモード スイート green（外部配信 ${BASE}）"
  exit 0
fi

MOCK_STATIC_PORT="${MOCK_STATIC_PORT:-4173}"
WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> フロントをビルド（モックモード → :$MOCK_STATIC_PORT）"
(cd "$REPO/mockup" \
  && npx nuxt generate >"$WORK/gen-mock.log" 2>&1 \
  && cp -r .output/public "$WORK/dist-mock") \
  || { echo "generate 失敗"; tail -30 "$WORK/gen-mock.log"; exit 1; }

node "$HERE/serve.cjs" "$WORK/dist-mock" "$MOCK_STATIC_PORT" >/dev/null 2>&1 &
PIDS+=($!)
sleep 1

run_suites "http://127.0.0.1:$MOCK_STATIC_PORT"
echo "==> モックモード スイート green"
