# AKEBONO Office モックアップ

TSUNAGUBA 社内オフィスアプリのモックアップ（Nuxt 4 SPA）。
**全ページの全機能が操作に反応する**ことを目的とした、体感検証用の実装です。

- 要件・設計の SoT: `../.ai-native/outputs/`（phase0〜5）
- 実装規約: [`CONVENTIONS.md`](./CONVENTIONS.md)

## 起動方法

```bash
cd mockup
npm install
npm run dev        # http://localhost:3000
```

静的ビルド（ハッシュルーティングのため、そのまま静的配信可能）:

```bash
npm run generate   # .output/public/ を任意の静的ホスティングへ
```

検証:

```bash
npm run test       # 純粋関数（勤怠計算・承認経路）の単体テスト
npm run typecheck  # vue-tsc
npm run build
```

## デモの歩き方

1. **ヘッダー右上のユーザー切替**で 管理者（葛西）/ 社員（澤村など）/ アルバイト（村瀬・有田）を切り替えると、権限・画面の違いを体感できます
2. ダッシュボードで**打刻** → 勤怠管理の日次/月次に反映されます
3. 日報の**課題欄に記入して提出** → 管理者の通知・エスカレーション（/inbox）に「暗黙の情報共有」が届きます → 管理者が「裁定記録 + ナレッジ還流」するとナレッジマスタに蓄積されます
4. ワークフローで**金額を変えて申請** → 承認経路が職務権限マトリクスで自動分岐します
5. AIネイティブカンパニーで **AI社員にタスクを依頼** → 分解 → 承認 → 実行 → 完了報告 → 日次報告が日報タイムラインに掲載されます
6. 意思決定支援で**制約により打ち手が潰れる様子**（✗のグレーアウト）と選択肢 A/B/C → 判断記録を体感できます
7. 設定（管理者）で**カスタム項目・汎用区分・外部リンク・機能トグル**を変更すると各画面に即反映されます（他社展開時のカスタマイズを体感）

## データについて

- モックデータは**決定的シード**で生成され、ブラウザの localStorage にのみ保存されます（サーバー送信なし）
- 「設定 → デモデータをリセット」でシード状態に戻せます
- 蓄積対象データは akebono-scm-platform のスタースキーマへ写像可能な構造で設計されています（`../.ai-native/outputs/phase5/data-design.md`）

## ディレクトリ

```
app/
├── assets/css/main.css   # デザイントークン（唯一の CSS SoT）
├── components/ui/        # 再利用 UI 部品（他社展開の共通パーツ）
├── components/widgets/   # 業務ウィジェット
├── components/charts/    # Chart.js ラッパー
├── components/office/    # AIネイティブカンパニー（アイソメトリック等）
├── components/masters/   # マスタ画面共通部品
├── composables/          # 状態とロジック（将来の API 差し替え境界）
├── utils/                # 純粋関数（計算・書式・ラベル）
├── data/seed/            # 決定的シードデータ
├── types/                # ドメイン型定義
└── pages/                # 画面
```
