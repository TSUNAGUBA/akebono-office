# mockup 実装規約（全実装者必読）

設計 SoT: `.ai-native/outputs/phase3/functional-requirements.md`（機能）/ `phase5/screen-design.md`（画面・デザイン）/ `phase5/data-design.md`（データ）/ `phase5/api-design.md`（I/F）。

## スタック

Nuxt 4 SPA（ssr:false, hashMode）/ TypeScript strict / Tailwind v4 + CSS 変数トークン / Chart.js 4 + vue-chartjs / lucide-vue-next。

## 絶対規則

1. **全操作が反応する**（X-1）: ボタン・行・カードは必ず 遷移 / ドロワー / モーダル / トースト / 状態変化 のいずれかを返す。飾りのボタンを作らない
2. **データは useMockDb 経由のみ**: `const { tbl, commit, nextId } = useMockDb()`。書込後は必ず `commit()`。ID は `nextId(collection, prefix)`
3. **記録系は追記のみ**: 打刻・承認ログ・活動ログ等を書き換え・削除しない。マスタは論理削除（`active:false`）のみ
4. **Math.random / v-html 禁止**: 乱数は `~/utils/rng`（決定的）。リッチ表示はテキスト分解で
5. **アイコンは lucide-vue-next のみ**。絵文字をアイコン代わりにしない
6. **区分値のラベルは `~/utils/labels.ts`** に追記して参照（ハードコード禁止）。書式は `~/utils/format.ts`
7. **選択肢は useCodeMaster / マスタ実データから**。フォーム選択肢のハードコードは避ける（画面固有の固定 enum は labels 経由なら可）
8. **通知・エスカレーションは非ブロッキング**: `useNotifications().notify/notifyAdmins`、`useEscalations().raise` は主フロー成功後に呼ぶ。失敗しても主フローは成立
9. **レスポンシブ必須**: 一覧は `UiDataTable`（自動カード化）。独自グリッドは `<768px` で縦積みかコンテナ内横スクロール。タッチターゲット 44px
10. **アクセシビリティ**: 対話 UI は role/aria を付与（UiModal/UiDrawer/UiTabBar は対応済み）。色だけに頼らずラベル併記

## ファイル所有権

自分の担当ファイル以外を**編集しない**（読み取りは自由）。共有ファイル（types/domain.ts, utils/labels.ts, data/seed/index.ts, assets/css/main.css, layouts/default.vue, components/ui/*, composables/useMockDb ほか基盤）は原則変更不可。どうしても必要な変更は最小限に（labels.ts への追記は可）。

## 基盤 API 早見表

```ts
// データ
const { tbl, commit, nextId } = useMockDb()
const projects = tbl('projects')            // Ref<Project[]>（MockDbShape のキー名）
projects.value = [...projects.value, x]; commit()

// マスタ CRUD（マスタ系画面はこれで統一）
const { list, activeList, byId, save, archive, restore } = useMasterCrud('companies', 'c')

// ユーザー・権限
const { currentUser, isAdmin } = useCurrentUser()

// フィードバック
useToast().show('保存しました', 'ok', { label: '確認', to: '/xxx' })
const ok = await useConfirm().ask('確認', '削除しますか？', { danger: true })

// 通知・エスカレーション
useNotifications().notify(memberId, 'approval', title, body, '/link')
useEscalations().raise({ reason: 'issue_reported', targetMemberId, context, dedupeKey: `issue:${id}:${date}` })

// カスタム項目（マスタフォームに合成）
const { formSchemaFor } = useCustomFields()   // → FieldDef[] を UiSchemaForm に渡す

// 設定
const { isEnabled } = useAppSettings()
```

## UI コンポーネント在庫（新規に作る前にここを見る）

| コンポーネント | 用途 / 主要 props |
|---|---|
| `UiPageHeader` | title, description + #actions |
| `UiSectionCard` | title, description, flush + #actions |
| `UiKpiCard` | label, value, sub, delta, inverse, icon(lucide名), to |
| `UiDataTable` | columns(TableColumn[]), rows, clickable, maxHeight + `#cell-<key>`。`@row-click` |
| `UiDrawer` | open, title, width + #footer。`@close` |
| `UiModal` | open, title, width + #footer。`@close` |
| `UiTabBar` | tabs(TabItem[]), v-model |
| `UiFilterBar` | slot + #trailing |
| `UiSearchInput` / `UiSelect` / `UiChipSelect` | v-model |
| `UiFormField` | label, required, error, hint |
| `UiSchemaForm` | fields(FieldDef[]), v-model(Record), errors |
| `UiStatusBadge` | tone, label, dot |
| `UiCardMenu` | items(MenuCard[]), cols |
| `UiAvatar` | name, kind('human'/'ai'), size |
| `UiEmptyState` | icon, title, hint + #action |
| `ChartsLineChartCard` / `ChartsBarChartCard` / `ChartsDonutChartCard` | title, labels/series or items, yFormatter |
| `WidgetsPunchClock` | 打刻（props なし） |

コンポーネントはディレクトリプレフィックス付きで自動インポートされる（例: `components/widgets/ApprovalFlow.vue` → `<WidgetsApprovalFlow>`）。

## スタイル規約

- クラスは Tailwind ユーティリティ + `main.css` の共通クラス（`.card .btn .btn-primary .btn-danger .btn-ghost .btn-lg .btn-sm .input .select .textarea .label .tbl .num .link`）のみ。**新しい色・影・角丸を発明しない**
- 色トークン: `text-ink/sub/muted/brand/ok/warn/serious/crit/info`、`bg-surface/page/brand-soft/ok-soft/...`、`border-line/line-strong/brand`
- 数値は `num` クラス（tabular-nums）。ステータス色をチャート系列に使わない
- ページ構造: `UiPageHeader` → （`UiTabBar`）→ `UiFilterBar` → 本体グリッド（`grid gap-3`）

## 品質確認（担当分の完了条件）

1. `npm run build` が通る
2. `npx nuxi typecheck` が通る
3. 画面上の全ボタン・全行が何かしら反応する（自分でシナリオ操作して確認）
4. モバイル幅（375px）で崩れない・操作できる
5. 主要操作にトースト等のフィードバックがある
