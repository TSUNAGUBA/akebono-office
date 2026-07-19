#!/usr/bin/env bash
# バッチ6b フルスタック E2E ランナー（旧セッションの run-batch2a-stack.sh を再構築）。
# 使い捨て PostgreSQL + API（dev 認証・:8788）+ API モード静的配信（:4174）+ モック静的配信（:4173）で
# E2E スイート（batch6b-e2e.cjs）とモック回帰（mock-regression-e2e.cjs）を実行する。
# 新バッチの E2E は batchXX-e2e.cjs を追加し、末尾の SUITES に 1 行追記する。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO:-/home/user/akebono-office}"
WORK="$(mktemp -d)"
API_PORT=8788
API_STATIC_PORT=4174
MOCK_STATIC_PORT=4173

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
[ -n "$PGBIN" ] || { echo "PostgreSQL が見つかりません" >&2; exit 1; }
export PGDATA="$WORK/pgdata"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"

RUN=""
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$WORK"
  RUN="setpriv --reuid=postgres --regid=postgres --init-groups"
fi

PIDS=()
cleanup() {
  pkill -f "tsx/dist/loader.mjs src/index.ts" >/dev/null 2>&1 || true
  pkill -f "serve.cjs" >/dev/null 2>&1 || true
  for pid in "${PIDS[@]:-}"; do kill "$pid" >/dev/null 2>&1 || true; done
  $RUN "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> 使い捨て PostgreSQL を初期化: $PGDATA"
$RUN "$PGBIN/initdb" -D "$PGDATA" --auth=trust --username=postgres -E UTF8 >/dev/null
$RUN "$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
$RUN "$PGBIN/createdb" -h "$SOCKDIR" -U postgres akebono_e2e
chmod 777 "$SOCKDIR" || true
export DATABASE_URL="postgresql://postgres@/akebono_e2e?host=$SOCKDIR"

echo "==> API 起動（dev 認証・:$API_PORT）"
(cd "$REPO/api" && DATABASE_URL="$DATABASE_URL" AUTH_MODE=dev PORT=$API_PORT CORS_ORIGINS="http://127.0.0.1:4174" \
  npx tsx src/index.ts >"$WORK/api.log" 2>&1) &
PIDS+=($!)
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "API が起動しません"; tail -30 "$WORK/api.log"; exit 1; }
  sleep 1
done
# healthz は DB エラーでも 200（非ブロッキング設計）のため「最終マイグレーションの適用完了」を待つ
LAST_MIG="$(ls "$REPO/api/db/migrations" | sort | tail -1)"
for i in $(seq 1 120); do
  APPLIED="$($RUN "$PGBIN/psql" -h "$SOCKDIR" -U postgres -d akebono_e2e -qtAc \
    "SELECT 1 FROM app_office.schema_migrations WHERE name = '$LAST_MIG'" 2>/dev/null || true)"
  [ "$APPLIED" = "1" ] && break
  [ "$i" = 120 ] && { echo "マイグレーションが完了しません（$LAST_MIG 未適用）"; tail -30 "$WORK/api.log"; exit 1; }
  sleep 1
done

echo "==> E2E メンバー・会社をシード"
$RUN "$PGBIN/psql" -h "$SOCKDIR" -U postgres -d akebono_e2e -q -c \
  "INSERT INTO app_office.members (id, name, email, role) VALUES ('m-e2e', 'E2E 管理者', 'e2e@example.com', 'admin') ON CONFLICT (id) DO NOTHING;"
api() {
  local res
  res=$(curl -s -X "$1" "http://127.0.0.1:$API_PORT$2" -H 'x-dev-member-id: m-e2e' -H 'content-type: application/json' ${3:+-d "$3"})
  echo "$res" | grep -q '"id"' || { echo "seed API 失敗: $1 $2 -> $res" >&2; tail -40 "$WORK/api.log" >&2; exit 1; }
}
api POST /v1/masters/companies '{"kind":"self","name":"E2E 自社","fiscalStartMonth":4}'
api POST /v1/masters/companies '{"kind":"customer","name":"E2E商事"}'
api POST /v1/masters/companies '{"kind":"customer","name":"E2Eシステムズ"}'
# チャットボット文脈 E2E 用: 業界 + 関係種別 + 会社間の関係（供給網羅の検証データ）
IND_ID=$(curl -s -X POST "http://127.0.0.1:$API_PORT/v1/masters/industries" -H 'x-dev-member-id: m-e2e' -H 'content-type: application/json' -d '{"name":"E2Eアパレル"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
RT_ID=$(curl -s -X POST "http://127.0.0.1:$API_PORT/v1/masters/relation-types" -H 'x-dev-member-id: m-e2e' -H 'content-type: application/json' -d '{"label":"E2E取引先","appliesTo":"company"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
SELF_ID=$(curl -s "http://127.0.0.1:$API_PORT/v1/masters/companies" -H 'x-dev-member-id: m-e2e' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
CUST_ID=$(curl -s "http://127.0.0.1:$API_PORT/v1/masters/companies" -H 'x-dev-member-id: m-e2e' | python3 -c "import sys,json; rows=json.load(sys.stdin)['data']; print(next(r['id'] for r in rows if r['name']=='E2E商事'))")
curl -s -X PATCH "http://127.0.0.1:$API_PORT/v1/masters/companies/$CUST_ID" -H 'x-dev-member-id: m-e2e' -H 'content-type: application/json' -d "{\"industryIds\":[\"$IND_ID\"],\"primaryIndustryId\":\"$IND_ID\"}" >/dev/null
SELF_ID=$(curl -s "http://127.0.0.1:$API_PORT/v1/masters/companies" -H 'x-dev-member-id: m-e2e' | python3 -c "import sys,json; rows=json.load(sys.stdin)['data']; print(next(r['id'] for r in rows if r['kind']=='self'))")
api POST /v1/masters/company-relations "{\"fromCompanyId\":\"$SELF_ID\",\"toCompanyId\":\"$CUST_ID\",\"relationTypeId\":\"$RT_ID\"}"

echo "==> フロントをビルド（API モード → :$API_STATIC_PORT / モック → :$MOCK_STATIC_PORT）"
(cd "$REPO/mockup" \
  && NUXT_PUBLIC_API_BASE="http://127.0.0.1:$API_PORT" NUXT_PUBLIC_DEV_MEMBER_ID=m-e2e \
     npx nuxt generate >"$WORK/gen-api.log" 2>&1 \
  && cp -r .output/public "$WORK/dist-api" \
  && npx nuxt generate >"$WORK/gen-mock.log" 2>&1 \
  && cp -r .output/public "$WORK/dist-mock") \
  || { echo "generate 失敗"; tail -30 "$WORK"/gen-*.log; exit 1; }

node "$HERE/serve.cjs" "$WORK/dist-api" $API_STATIC_PORT >/dev/null 2>&1 &
PIDS+=($!)
node "$HERE/serve.cjs" "$WORK/dist-mock" $MOCK_STATIC_PORT >/dev/null 2>&1 &
PIDS+=($!)
sleep 1

echo "==> E2E スイート実行"
SUITES=(
  "batch6b-e2e.cjs"
  "batch6c-e2e.cjs"
  "batch6d-e2e.cjs"
  "chatbot-multiturn-e2e.cjs"
)
for s in "${SUITES[@]}"; do
  (cd "$HERE" && BASE="http://127.0.0.1:$API_STATIC_PORT" node "$s")
done

echo "==> モック回帰"
(cd "$HERE" && BASE="http://127.0.0.1:$MOCK_STATIC_PORT" node mock-regression-e2e.cjs)

echo "==> 全スイート green"
