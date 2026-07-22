# フルスタック E2E ハーネス

使い捨て PostgreSQL + 本実装 API（dev 認証）+ 静的配信した mockup（API モード / モックモード）を
1 コマンドで組み上げ、Playwright（chromium）で実クリックの E2E スイートを回すハーネス。
implementation-status の各バッチ検証にある「E2E 全スイート green」はこのハーネスの実行結果を指す。

## 前提

- PostgreSQL のサーバーバイナリ（`/usr/lib/postgresql/*/bin`。Debian/Ubuntu の `postgresql` パッケージ）
- Node.js 20+（リポジトリ本体と同じ）
- chromium: `CHROMIUM_PATH` 環境変数 → `/opt/pw-browsers/chromium` → playwright 同梱の順で解決。
  ローカルでは `npx playwright install chromium` で同梱版を入れれば環境変数は不要

## 実行

```bash
cd e2e && npm ci
./run-batch6b-stack.sh          # 全スイート（使い捨て DB を毎回構築・終了時に自動破棄）
```

- 対象リポジトリはスクリプト位置の親ディレクトリを既定とする。別の場所の clone を対象にする場合は
  `REPO=/path/to/akebono-office ./run-batch6b-stack.sh`
- クリーンアップは自プロセス群の kill に加えて保険の `pkill -f "tsx/dist/loader.mjs src/index.ts"` を
  実行する。**同一ホストで無関係な tsx プロセスを動かしている場合は注意**（専用環境での実行を推奨）

- API スイート（batch6b/6c/6d/chatbot-multiturn/team-visibility）は `:4174`（API モード静的配信）に対して実行
- モック回帰（mock-regression-e2e.cjs）は `:4173`（モックモード静的配信）に対して実行
- `perm-combobox-e2e.cjs` は権限設定 UI の単発スイート。スタック起動中に
  `BASE=http://127.0.0.1:4174 node perm-combobox-e2e.cjs` で個別実行できる
- スタックを残して手動確認したい場合は `./keep-stack.sh`

## 新バッチのスイート追加

`batchXX-e2e.cjs` を追加し、`run-batch6b-stack.sh` 末尾の `SUITES` に 1 行追記する
（`lib.cjs` の `check/withPage/summary` を利用。失敗があれば exit 1 でランナーが止まる）。
追加したスイートは CI（下記）でも自動的に実行される。

## CI での実行（シナリオテストゲート）

本ハーネスは GitHub Actions の `e2e-scenario` ジョブ（`.github/workflows/test-suite.yml`）として、
**PR 時（ci.yml）とデプロイ前（deploy.yml）の両方**で自動実行される。失敗するとマージ確認・デプロイが中断される。

- 環境変数 `E2E_LOG_EXPORT` にディレクトリを指定すると、終了時にスタックのログ
  （`api.log`・`gen-*.log`）をそこへコピーしてから作業ディレクトリを破棄する。
  CI では失敗時にこれを artifact `e2e-logs` として保存する（ローカルでは未設定 = 従来どおり）
