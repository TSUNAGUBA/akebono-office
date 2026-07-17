#!/usr/bin/env bash
# 統合テストランナー。
# - DATABASE_URL が設定済み（CI の services: postgres 等）ならそのまま実行
# - 未設定ならローカルに使い捨て PostgreSQL を initdb して起動（unix socket・要 postgresql 16）
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ]; then
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
  if [ -z "$PGBIN" ]; then
    echo "PostgreSQL が見つかりません。DATABASE_URL を設定するか postgresql をインストールしてください" >&2
    exit 1
  fi
  WORK="$(mktemp -d)"
  export PGDATA="$WORK/pgdata"
  SOCKDIR="$WORK/sock"
  mkdir -p "$SOCKDIR"

  # initdb は root で実行できないため、root の場合は postgres ユーザーへ降格して起動する
  RUN=""
  if [ "$(id -u)" = "0" ]; then
    if ! id postgres >/dev/null 2>&1; then
      echo "root 実行ですが postgres ユーザーが存在しません" >&2
      exit 1
    fi
    chown -R postgres:postgres "$WORK"
    RUN="setpriv --reuid=postgres --regid=postgres --init-groups"
  fi
  echo "==> 使い捨て PostgreSQL を初期化: $PGDATA"
  $RUN "$PGBIN/initdb" -D "$PGDATA" --auth=trust --username=postgres -E UTF8 >/dev/null
  $RUN "$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
  trap "$RUN \"$PGBIN/pg_ctl\" -D \"$PGDATA\" -m immediate stop >/dev/null 2>&1 || true; rm -rf \"$WORK\"" EXIT
  $RUN "$PGBIN/createdb" -h "$SOCKDIR" -U postgres akebono_test
  chmod 777 "$SOCKDIR" || true
  export DATABASE_URL="postgresql://postgres@/akebono_test?host=$SOCKDIR"
fi

echo "==> 統合テスト実行（DATABASE_URL=${DATABASE_URL%%\?*}）"
npx vitest run test/integration
