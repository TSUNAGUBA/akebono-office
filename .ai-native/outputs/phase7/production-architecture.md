# Phase 7: 本番アーキテクチャ（Cloud Run + RDS PostgreSQL）

- **作成日:** 2026-07-17
- **決定:** API を **Cloud Run** で運用し、**重い処理はすべてサーバーサイド**で実行する。データベースは **AWS RDS の PostgreSQL** を使用する（オペレーター指示 2026-07-17）
- **SoT:** 本書は本番構成（インフラ・API・認証・データフロー）の SoT。phase4/tech-stack-decision.md の「インフラ・将来構成（宣言のみ）」を本書で確定に更新した

## 1. 全体構成

```mermaid
flowchart LR
    subgraph Client["利用者"]
        B[ブラウザ / モバイル]
    end
    subgraph GCP["Google Cloud"]
        H[Firebase Hosting<br/>Nuxt SPA（静的配信）]
        A[Firebase Auth<br/>ID トークン発行]
        R[Cloud Run<br/>akebono-office-api<br/>Hono + Node 22]
        SM[Secret Manager<br/>DATABASE_URL]
        AR[Artifact Registry<br/>コンテナイメージ]
    end
    subgraph AWS["AWS"]
        DB[(RDS PostgreSQL<br/>app_office スキーマ)]
    end
    subgraph GH["GitHub"]
        GA[GitHub Actions<br/>deploy.yml]
    end
    B -->|静的アセット| H
    B -->|ログイン| A
    B -->|"/v1/* + Bearer ID トークン"| R
    R -->|JWKS 検証（securetoken）| A
    R -->|SQL（TLS）| DB
    R -.->|起動時に参照| SM
    GA -->|イメージ push| AR
    GA -->|gcloud run deploy| R
    GA -->|静的ビルド deploy| H
```

- **フロントエンド:** Nuxt 4 SPA（`mockup/` → 将来 `app/` へ改名予定）。Firebase Hosting で静的配信（現行どおり）
- **API:** `api/`（Hono + node-postgres）。Cloud Run（min 0 / max 3、8080）。コンテナは distroless 相当の node:22-slim・非 root 実行
- **DB:** RDS PostgreSQL。業務データは `app_office` スキーマ（分析は akebono-scm-platform `mart` へ将来 ETL。逆流禁止）
- **共有ドメイン層:** `shared/domain/`（型定義・勤怠計算・JST ユーティリティ）をフロント/API で共有し、業務ロジックの二重実装を防ぐ

## 2. 「重い処理はサーバーサイド」方針（オペレーター指示）

| 処理 | 実装場所 | 対応 API |
|---|---|---|
| 勤怠の日次/月次集計（6 バケット・60h 超繰越） | サーバー | `GET /v1/attendance/day` `/month` |
| タイムカード（全メンバー × 期間の横断集計） | サーバー | `GET /v1/attendance/timecard` |
| 36 協定判定（6 ヶ月・全平均組合せ） | サーバー | `GET /v1/attendance/alerts` |
| 休暇残数（FIFO 引当・失効・上限） | サーバー | `GET /v1/leave/balance` |
| 打刻の状態機械・修正打刻の置換解決 | サーバー | `POST /v1/attendance/punches` ほか |
| 日報の正規化・提出保護・工数乖離チェック | サーバー | `PUT /v1/reports/daily` |
| LLM 呼び出し（AI コメント・日報ドラフト・チャットボット） | サーバー（バッチ3 以降） | 予定: `POST /v1/assist/*` |
| mart ETL・周期有給付与などのバッチ | サーバー（Cloud Scheduler + Cloud Run jobs。バッチ2 以降） | — |
| 表示射影（フィルタ済みデータの整形・グラフ描画・組織図ツリー化） | フロント | —（API のデータを純粋関数で射影） |

クライアントは「表示と入力」に限定する。モックで composables に実装した計算ロジックは、フロント接続（バッチ2）の完了をもって API 呼び出しへ置き換え、クライアント側の計算実装は削除する（暫定期間の二重実装は implementation-status.md で追跡）。

## 3. 認証・認可

- **認証:** Firebase Authentication。SPA がログインで取得した **ID トークン**を `Authorization: Bearer` で送付し、API が Google の JWKS（`securetoken@system.gserviceaccount.com`）で署名・`iss`/`aud` を検証する。検証後、トークンの email と `members.email`（在籍者・一意）を突合して業務ユーザーを解決する
- **認可:** `members.role`（`admin` / `hr` / `member`）による API 側ガード。他人の勤怠・休暇参照は管理者/人事のみ（C3 データ保護）。マスタ変更は管理者のみ（休暇種別・勤怠ルールは人事も可）
- **開発・テスト:** `AUTH_MODE=dev` では `x-dev-member-id` ヘッダで成りすまし（ローカル・CI 専用。本番は必ず `firebase`）
- **エラーコード:** AKO-AUTH-001（未認証/トークン不正）/ 002（メンバー未登録）/ 003（権限不足）
- Cloud Run は `--allow-unauthenticated`（IAM ではなくアプリ層で認証）。CORS は Hosting のオリジンのみ許可（`CORS_ORIGINS`）

## 4. データベース設計（実装済み分）

- スキーマ: `app_office`（`api/db/migrations/0001_init.sql`）。マイグレーションはファイル名昇順 + `schema_migrations` 管理。**起動時自動適用**（pg_advisory_lock で多重起動でも二重適用しない = 冪等）
- 設計判断:
  - **id は text**（プレフィックス + UUID）。モックの決定的 id とも互換で、シードデータの移送が可能
  - **業務日付は `date` 型**（アプリ層では 'YYYY-MM-DD' 文字列。pg の型パーサで文字列固定）
  - **業務時刻（打刻・提出時刻）は JST ウォールクロックの ISO 文字列（text）**。shared/domain の壁時計計算（実行環境 TZ 非依存）と同一解釈を保つための判断。DB 内でのタイムゾーン変換を排除する
  - マスタ系は**論理削除**（active）。記録系（打刻・付与・日報等）は**追記のみ**（開発原則2）
  - **休暇付与の冪等性は DB 制約**（`UNIQUE (member_id, leave_type_id, grant_date)` + `ON CONFLICT DO NOTHING`）。アプリ層チェックより強い保証
  - 参照データ（法定有給 `lt-paid`・既定勤怠ルール・設定既定値）はマイグレーションで投入（`ON CONFLICT DO NOTHING` = 冪等）。**デモデータは本番 DB に投入しない**
- モックからの移行: モック（localStorage）は個人ブラウザ内のデモデータであり**本番へ移送しない**（下位互換への影響なし = 開発原則7 の評価結果）。運用開始時のマスタ初期投入はマスタ API（または SQL）で行う

## 5. ネットワーク（GCP ⇄ AWS のクロスクラウド接続）

Cloud Run（GCP）から RDS（AWS）への接続は次の 2 案。**v1 は案 A で開始し、負荷・セキュリティ要件に応じて案 B へ移行**する。

| 案 | 構成 | 特徴 |
|---|---|---|
| **A. パブリック + TLS + IP 制限（v1 採用）** | RDS を publicly accessible にし、SG で Cloud Run の**固定エグレス IP のみ許可**（Direct VPC egress + Cloud NAT の静的 IP）。`rds.force_ssl=1` + `DB_SSL=verify`（RDS CA バンドル） | 構築が速い。TLS 必須・SG 最小許可・強パスワードが前提 |
| B. Site-to-Site VPN / 専用線 | GCP HA VPN ⇄ AWS VPN Gateway でプライベート接続 | 露出ゼロだが構築・運用コスト増。利用者増加時に検討 |

> **留意（クロスクラウドのレイテンシ）:** 東京リージョン同士（asia-northeast1 ⇄ ap-northeast-1）で RTT 数 ms 程度。API は 1 リクエスト内のクエリ数を絞る設計（横断集計は一括取得 → サーバー内計算）でこの前提に耐える。将来、レイテンシまたは転送コストが問題になる場合は Cloud SQL for PostgreSQL への移行も選択肢（スキーマ・API は接続文字列以外無変更で移行可能なよう、RDS 固有機能に依存しない）

- 接続文字列は **Secret Manager** 経由で注入（`DATABASE_URL`。CI が値の変更時のみ新バージョン追加）。Cloud Run の環境変数に平文で置かない
- `DB_SSL`: `require`（暗号化のみ）で開始し、RDS CA バンドルを配布して `verify` へ引き上げる（deploy-guide.md 参照）

## 6. API 規約（api/ 配下の実装ルール）

- **レスポンス:** 成功 `{ data: … }` / 失敗 `{ error: { code: 'AKO-XXX-nnn', message } }`（モックの Result 型と同型。台帳は phase5/api-design.md §4）
- **バリデーション:** マスタは zod スキーマ（`api/src/masters/registry.ts`）。公開 I/F になるためバリデーションは API の責務（モックでは画面側の責務だった）
- **トランザクション:** 状態遷移（打刻・承認・提出）は `BEGIN` + 行ロック（`FOR UPDATE` / advisory lock）で直列化。二重操作は AKO コード付き 409
- **監査ログ:** 変更系はすべて `audit_logs` へ記録（失敗しても主フローを止めない = 開発原則4）
- **命名:** DB は snake_case、API 入出力は camelCase（`rowToCamel` / `camelToSnake` で機械変換）
- **id:** サーバー生成 `prefix-UUID`（`api/src/lib/ids.ts`）

## 7. CI/CD

```mermaid
flowchart LR
    P[main へ push<br/>mockup/ api/ shared/] --> T1[deploy-mockup<br/>test + typecheck + generate]
    P --> T2[api-test<br/>typecheck + 単体 + 統合（PostgreSQL 16）+ build]
    T1 --> H[Firebase Hosting]
    T2 --> D[deploy-api]
    D -->|イメージ build/push| AR[Artifact Registry]
    D -->|Secret 登録（変更時のみ）| SM[Secret Manager]
    D -->|gcloud run deploy| CR[Cloud Run]
```

- API 用 secrets 未設定時は `deploy-api` を**警告付きスキップ**（mockup のみの運用を止めない = 開発原則4）
- secrets の設定は `scripts/setup-deploy-secrets.ps1`（手順: deploy-guide.md）
- DB マイグレーションは**コンテナ起動時に自動適用**（CI から DB へ直接接続しない = RDS を GitHub Actions へ開放しない）

## 8. 環境変数（api）

| 変数 | 必須 | 説明 |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL 接続文字列（Secret Manager 経由） |
| `AUTH_MODE` | ✅ | `firebase`（本番）/ `dev`（ローカル・CI） |
| `FIREBASE_PROJECT_ID` | firebase 時 | ID トークンの iss/aud 検証対象 |
| `DB_SSL` | — | `disable` / `require`（既定推奨）/ `verify`（CA 検証） |
| `DB_SSL_CA` | verify 時 | RDS CA バンドル PEM の内容 |
| `CORS_ORIGINS` | — | 許可オリジン（カンマ区切り） |
| `PORT` | — | 既定 8080（Cloud Run が注入） |
| `MIGRATE_ON_START` | — | `0` で起動時マイグレーションを無効化（既定は有効） |
| `DB_POOL_MAX` | — | プール上限（既定 5。Cloud Run 並行数と掛け算になるため控えめ） |

## 9. 段階移行計画（モック → 本番）

1. **バッチ1（本 PR）:** API+DB・認証基盤・CI/CD — 完了
2. **バッチ2:** フロント接続。`useMockDb` 依存の composable を API クライアントへ差し替え（対象: 勤怠・休暇・日報・マスタ・設定）。Firebase Auth ログイン UI。通知/エスカレーション API。周期有給付与バッチ
3. **バッチ3:** AI業務アシスタント・カレンダー連携・ワークフロー・シフト（LLM/OAuth はサーバーサイド）
4. **バッチ4:** 意思決定支援・AI カンパニー・売上・稼働状況・チャットボット・mart ETL

進捗の SoT: `implementation-status.md`（実装 PR ごとに更新）
