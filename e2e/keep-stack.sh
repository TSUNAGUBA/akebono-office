#!/usr/bin/env bash
# デバッグ用: スタックを起動したまま維持（run-batch6b-stack.sh のスイート実行なし版）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO:-/home/user/akebono-office}"
WORK=/tmp/e2e-debug-work
rm -rf "$WORK"; mkdir -p "$WORK"
API_PORT=8788
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
export PGDATA="$WORK/pgdata"
SOCKDIR="$WORK/sock"; mkdir -p "$SOCKDIR"
RUN=""
if [ "$(id -u)" = "0" ]; then chown -R postgres:postgres "$WORK"; RUN="setpriv --reuid=postgres --regid=postgres --init-groups"; fi
$RUN "$PGBIN/initdb" -D "$PGDATA" --auth=trust --username=postgres -E UTF8 >/dev/null
$RUN "$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
$RUN "$PGBIN/createdb" -h "$SOCKDIR" -U postgres akebono_e2e
chmod 777 "$SOCKDIR" || true
export DATABASE_URL="postgresql://postgres@/akebono_e2e?host=$SOCKDIR"
(cd "$REPO/api" && DATABASE_URL="$DATABASE_URL" AUTH_MODE=dev PORT=$API_PORT CORS_ORIGINS="http://127.0.0.1:4174" npx tsx src/index.ts >"$WORK/api.log" 2>&1) &
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
$RUN "$PGBIN/psql" -h "$SOCKDIR" -U postgres -d akebono_e2e -q -c \
  "INSERT INTO app_office.members (id, name, email, role) VALUES ('m-e2e', 'E2E 管理者', 'e2e@example.com', 'admin') ON CONFLICT (id) DO NOTHING;"
curl -sf -X POST "http://127.0.0.1:$API_PORT/v1/masters/companies" -H 'x-dev-member-id: m-e2e' -H 'content-type: application/json' -d '{"kind":"self","name":"E2E 自社","fiscalStartMonth":4}' >/dev/null
curl -sf -X POST "http://127.0.0.1:$API_PORT/v1/masters/companies" -H 'x-dev-member-id: m-e2e' -H 'content-type: application/json' -d '{"kind":"customer","name":"E2E商事"}' >/dev/null
curl -sf -X POST "http://127.0.0.1:$API_PORT/v1/masters/companies" -H 'x-dev-member-id: m-e2e' -H 'content-type: application/json' -d '{"kind":"customer","name":"E2Eシステムズ"}' >/dev/null
(cd "$REPO/mockup" && NUXT_PUBLIC_API_BASE="http://127.0.0.1:$API_PORT" NUXT_PUBLIC_DEV_MEMBER_ID=m-e2e npx nuxt generate >"$WORK/gen-api.log" 2>&1 && cp -r .output/public "$WORK/dist-api")
node "$HERE/serve.cjs" "$WORK/dist-api" 4174 >/dev/null 2>&1 &
echo "stack ready (WORK=$WORK)"
wait
