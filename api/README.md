# akebono-office-api

アケボノオフィスの本実装 API サービス（Cloud Run + RDS PostgreSQL）。

- **スタック:** Hono + node-postgres + zod（Node 22 / TypeScript / ESM）
- **対象ドメイン（バッチ1）:** 勤怠（打刻・集計・タイムカード・36 協定・修正申請）/ 休暇（残数・申請・付与）/ 日報・週報 / マスタ CRUD / 設定・監査ログ
- **設計 SoT:** `.ai-native/outputs/phase7/production-architecture.md`（構成）・`phase7/implementation-status.md`（進捗）・`phase5/api-design.md` §4（エラーコード台帳）

## 開発

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # 単体テスト（ドメインロジック）
npm run test:integration # 統合テスト（使い捨て PostgreSQL を自動起動。要 postgresql 16）
DATABASE_URL=postgresql://... AUTH_MODE=dev npm run dev   # 開発サーバー（:8080）
```

- dev 認証: `curl -H 'x-dev-member-id: m-01' localhost:8080/v1/me`（本番は `AUTH_MODE=firebase` で Firebase ID トークン必須）
- マイグレーション: `db/migrations/*.sql`（起動時自動適用・冪等）。手動適用は `npm run db:migrate`
- 環境変数一覧: `src/env.ts`（production-architecture.md §8 に表あり）

## ディレクトリ

```
db/migrations/       # SQL マイグレーション（app_office スキーマ）
src/
├── index.ts         # エントリポイント（migrate → listen。SIGTERM でグレースフル停止）
├── app.ts           # Hono 組み立て（/healthz + /v1/*）
├── env.ts           # 環境変数の検証
├── auth.ts          # 認証（firebase / dev）+ ロールガード
├── db/              # プール・マイグレーションランナー
├── domain/          # 純粋な業務ロジック（休暇 FIFO・勤怠集計。shared/domain を利用）
├── masters/         # 汎用マスタ CRUD の台帳（zod スキーマ・テーブルマッピング・ガード）
├── routes/          # エンドポイント（attendance / leave / reports / masters / configs）
└── lib/             # エラー（AKO コード）・id 生成・監査ログ
test/
├── unit/            # ドメインロジックの単体テスト
├── integration/     # 実 PostgreSQL でのエンドツーエンドテスト
└── run-integration.sh
```

## 規約（抜粋。詳細は production-architecture.md §6）

- レスポンス: 成功 `{ data }` / 失敗 `{ error: { code: 'AKO-XXX-nnn', message } }`（コードは api-design §4 へ必ず起番）
- DB は snake_case・API は camelCase。記録系テーブルは追記のみ（UPDATE で状態列のみ変更、削除しない）
- 状態遷移は行ロック/advisory lock で直列化。休暇付与の冪等性は UNIQUE 制約で保証
- 監査ログは非ブロッキング（失敗しても主フローを止めない）
