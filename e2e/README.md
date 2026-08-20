# フルスタック E2E ハーネス

使い捨て PostgreSQL + 本実装 API（dev 認証）+ 静的配信した home（API モード / モックモード）を
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
- モックモードのスイート（`run-mock-stack.sh` の `MOCK_SUITES` 全件）は `:4173`（モックモード静的配信）に対して実行
- `perm-combobox-e2e.cjs` は権限設定 UI の単発スイート。スタック起動中に
  `BASE=http://127.0.0.1:4174 node perm-combobox-e2e.cjs` で個別実行できる
- スタックを残して手動確認したい場合は `./keep-stack.sh`

## 新アプリ（company / intelligence）のモックモード E2E（2026-08-20）

```bash
./run-new-apps-mock.sh          # 両アプリを nuxt generate → :4181/:4182 で配信 → 2 スイート実行
SKIP_BUILD=1 ./run-new-apps-mock.sh   # ビルド済み .output/public を再利用（反復時の時短）
```

- `company-mock-e2e.cjs`（`:4181`）: AKEBONO Company。依頼 → 承認 → 自動実行・トークン管理
  （予算保存 → 超過ブロック AKC-TOK-001 → 既定値リセット = 取消フロー）・日次報告生成・モバイル 375px
- `intelligence-mock-e2e.cjs`（`:4182`）: AKEBONO Intelligence。インサイト生成のフィードバックループ反映
  （reinforce / alternative / dedupe）・提案のアクション化・フィードバック記録・サイクル明細・モバイル 375px
- PostgreSQL・API は不要（モックモードのみ）。API モードの E2E は共通 API に対する既存スイートが担う

## 新バッチのスイート追加

`batchXX-e2e.cjs` を追加し（`lib.cjs` の `check/withPage/summary` を利用。失敗があれば exit 1 でランナーが止まる）、
実行モードに応じて登録する（2026-08-20 改修で一覧を分離）:

- **API モードのスイート** → `run-batch6b-stack.sh` の `SUITES` に 1 行追記
- **モックモードのスイート** → `run-mock-stack.sh` の `MOCK_SUITES` に 1 行追記（一覧の SoT。
  フルスタックランナーと PR テストゲートの両方がこの一覧を使う）

## PR テストゲート（CI）

`.github/workflows/test-gate.yml` が PR ごとに 単体+typecheck / 結合（実 PostgreSQL）/
ビルド検証 / **モックモード E2E（`run-mock-stack.sh`）** を実行する。従来の deploy.yml の
ゲート（main への push 後）より前倒しで、登録フロー等の実クリック回帰をマージ前に検知する。
モックモード E2E は DB 不要（`nuxt generate` + 静的配信のみ）なので単独でも
`bash e2e/run-mock-stack.sh` でローカル実行できる。

## UI 網羅検査プローブ（UnitI・2026-08-20）

CI には組み込まず、UI 改修時に手動で回す回帰検査ハーネス（検出ありは exit 1）:

- `probe-ui-sweep.cjs <baseUrl> <outDir> <routesJson>` — 全ルートを 375px / 1366px で巡回し、
  横スクロール（`scrollWidth` 超過）・はみ出し要素・エラーページ（500 等の描画）を検出 +
  フルページスクリーンショットを保存
- `probe-truncate-break.cjs <baseUrl> <routesJson> [label]` — nowrap 要素（truncate・バッジ・ボタン）が
  overflow-hidden のカード境界を超えてぶつ切りされる型（grid/flex の min-width:auto 伝播）を検出。
  横スクロールに現れないため sweep では拾えない。**両方をセットで実行する**

ルート一覧は `ui-sweep-routes/`（home.json / company.json / intel.json）に収録。ページを増やしたら追記する。

```bash
# 例: home を検査（company/intel はポートと JSON を読み替え）
( cd ../home && npm run generate && python3 -m http.server 4173 -d .output/public & )
node probe-ui-sweep.cjs http://127.0.0.1:4173 /tmp/sweep-home ui-sweep-routes/home.json
node probe-truncate-break.cjs http://127.0.0.1:4173 ui-sweep-routes/home.json home
```
