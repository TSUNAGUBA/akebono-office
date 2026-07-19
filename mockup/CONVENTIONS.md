# mockup 実装規約（全実装者必読）

設計 SoT: `.ai-native/outputs/phase3/functional-requirements.md`（機能）/ `phase5/screen-design.md`（画面・デザイン）/ `phase5/data-design.md`（データ）/ `phase5/api-design.md`（I/F）。

> **shared/domain（2026-07-17〜）:** ドメイン型（`types/domain.ts`）・勤怠計算（`utils/attendance-calc.ts`）・
> JST/日付キー関数（`utils/format.ts` の該当分）の実装 SoT はリポジトリ直下 `../shared/domain/` へ移設した
> （本実装 API と共有）。mockup 側の同名ファイルは再エクスポートのシムであり、**ロジック・型の変更は shared 側で行う**。
> import パス（`~/types/domain` / `~/utils/attendance-calc`）と auto-import はこれまでどおり使える。

## スタック

Nuxt 4 SPA（ssr:false, hashMode）/ TypeScript strict / Tailwind v4 + CSS 変数トークン / Chart.js 4 + vue-chartjs / lucide-vue-next。

## 絶対規則

1. **全操作が反応する**（X-1）: ボタン・行・カードは必ず 遷移 / ドロワー / モーダル / トースト / 状態変化 のいずれかを返す。飾りのボタンを作らない
2. **データは useMockDb 経由のみ**: `const { tbl, commit, nextId } = useMockDb()`。書込後は必ず `commit()`。ID は `nextId(collection, prefix)`
   - **API モード（バッチ2a〜）:** マイグレーション済みコレクション（マスタ 21 種 = useApi.ts の MIGRATED_MASTERS・監査ログ・設定）は `tbl()` が API キャッシュを返す（参照はそのまま）。**書込は `useMasterCrudAsync` / `useAppSettings` の API 経路のみ**。`tbl().value = ...` の直接書込やモック版 `useMasterCrud` での書込を追加しない（キャッシュ汚染 = SoT 逆流。原則6）
3. **記録系は追記のみ**: 打刻・承認ログ・活動ログ等を書き換え・削除しない。マスタは論理削除（`active:false`）のみ
4. **Math.random / v-html 禁止**: 乱数は `~/utils/rng`（決定的）。リッチ表示はテキスト分解で
5. **アイコンは lucide-vue-next のみ**。絵文字をアイコン代わりにしない
6. **区分ラベルの SoT**: 複数ドメインで共有する区分ラベルは `~/utils/labels.ts` が SoT。単一ドメイン固有のラベル・トーンは当該ドメインの composable に定数定義してよい（労務: useShifts 等が例）。ハードコードの散在は禁止。書式は `~/utils/format.ts`
7. **選択肢は useCodeMaster / マスタ実データから**。フォーム選択肢のハードコードは避ける（画面固有の固定 enum は labels 経由なら可）
   - 設計判断: 汎用区分マスタ（useCodeMaster）の選択肢 value は現状 **label 文字列を保存**する（モック簡略化）。本実装では **code 参照 + 表示時 label 解決**に変更する
8. **通知・エスカレーションは非ブロッキング**: `useNotifications().notify/notifyAdmins`、`useEscalations().raise` は主フロー成功後に呼ぶ。失敗しても主フローは成立
9. **レスポンシブ必須**: 一覧は `UiDataTable`（自動カード化）。独自グリッドは `<768px` で縦積みかコンテナ内横スクロール。タッチターゲット 44px
10. **アクセシビリティ**: 対話 UI は role/aria を付与（UiModal/UiDrawer/UiTabBar は対応済み）。色だけに頼らずラベル併記
11. **エラーコード**: composable 層の想定エラーは `AKO-{領域}-{番号}` を必須付与（`error: { code, message }`）。画面内のフォーム必須チェック等 UI 完結のバリデーションはコード不要
12. **動的コンポーネントで `resolveComponent('NuxtLink')` を使わない**: 本番ビルドで解決されず `<nuxtlink>` という無反応なカスタム要素になる（実バグ事例）。`import { NuxtLink } from '#components'` で実体を import して `:is` に渡すか、`v-if/v-else` でタグを静的に分岐する

## 時刻の扱い（JST ウォールクロック）

業務時刻（打刻・申請・ログ等）は **JST の壁時計時刻**が正。閲覧者・実行環境の TZ に依存させない。

- 保存: `nowJstIso()`（`+09:00` 付き ISO 文字列）/ 今日の日付キーは `todayJst()`。`new Date().toISOString()` や `toDateKey(new Date())` を保存系に使わない
- 表示: `fmtTime`/`fmtDate`/`fmtDateLong` は文字列の壁時計をそのまま表示する（TZ 変換しない）
- 時刻帯判定（深夜等）: `Date#getHours` 禁止。文字列の時刻部分から判定する（attendance-calc.ts 参照）
- 経過時間の計算は `getTime()` 差分で行ってよい（オフセット付き ISO は正しく比較される）

## ファイル所有権

自分の担当ファイル以外を**編集しない**（読み取りは自由）。共有ファイル（types/domain.ts, utils/labels.ts, data/seed/index.ts, assets/css/main.css, layouts/default.vue, components/ui/*, composables/useMockDb ほか基盤）は原則変更不可。どうしても必要な変更は最小限に（labels.ts への追記は可）。

## 基盤 API 早見表

```ts
// データ
const { tbl, commit, nextId } = useMockDb()
const projects = tbl('projects')            // Ref<Project[]>（MockDbShape のキー名）
projects.value = [...projects.value, x]; commit()

// マスタ CRUD（マスタ系・設定画面はこれで統一。save/archive/restore/remove は Promise<Result>）
// API モードでは /v1/masters/* を呼ぶ。remove は関係エッジ専用の物理削除
const { list, activeList, byId, save, archive, restore, remove } = useMasterCrudAsync('companies', 'c')
// 未移行ドメイン内部（useWorkflow/useDocuments 等）は従来の同期版 useMasterCrud を継続使用

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
const { isEnabled, getConfig, setConfig } = useAppSettings()

// カレンダー連携（F-06-8。google 発の SoT は Google・アプリ発の SoT は本アプリ）
const cal = useCalendar()   // isConnected / connect / syncFromGoogle / addTask / pushToGoogle

// 日報 AI アシスト（F-06-7。ログは追記のみ・ドラフトは保存せずフォームへ流し込む）
const assist = useReportAssist()   // inputMode / questionsFor / recordAnswer / poipoiMemo / generateDraft

// AI業務アシスタント（F-14。done 後の計画は編集不可 = 記録系）
const tp = useTaskPlans()   // plansOf / upsertPlan / removePlan / aiReview / recordResult / insights

// 部署（F-10-9。所属の SoT は Member.departmentId。CRUD は useMasterCrud('departments')）
const depts = useDepartments()   // nameOf / options / membersOf / tree

// 休暇（F-04-5/9。種別別残数。付与は管理者/人事のみ・同日同種別はスキップ=冪等）
const leave = useLeave()   // balance(memberId, leaveTypeId?) / request / decide / grant / bulkGrant / activeLeaveTypes
```

## UI コンポーネント在庫（新規に作る前にここを見る）

| コンポーネント | 用途 / 主要 props |
|---|---|
| `UiPageHeader` | title, description + #actions |
| `UiSectionCard` | title, description, flush + #actions |
| `UiKpiCard` | label, value, sub, delta, inverse, icon(lucide名), to |
| `UiDataTable` | columns(TableColumn[]), rows, clickable, maxHeight + `#cell-<key>`。`@row-click` |
| `UiDrawer` | open, title, width + #footer。`@close` |
| `UiModal` | open, title, width, topmost（確認ダイアログ用: 親モーダルより前面 z-70） + #footer。`@close` |
| `UiTabBar` | tabs(TabItem[]), v-model |
| `UiFilterBar` | slot + #trailing |
| `UiSearchInput` / `UiSelect` / `UiChipSelect` | v-model |
| `UiMultiCombobox` | v-model(string[]), options({value,label}[]), single（単一選択モード）。論理名で検索する複数選択オートコンプリート（権限設定の項目指定等） |
| `UiFormField` | label, required, error, hint |
| `UiSchemaForm` | fields(FieldDef[]), v-model(Record), errors |
| `UiStatusBadge` | tone, label, dot |
| `UiCardMenu` | items(MenuCard[]), cols |
| `UiAvatar` | name, kind('human'/'ai'), size |
| `UiEmptyState` | icon, title, hint + #action |
| `ChartsLineChartCard` / `ChartsBarChartCard` / `ChartsDonutChartCard` | title, labels/series or items, yFormatter |
| `WidgetsPunchClock` | 打刻 = タイムカード（flat: モーダル内等でカード枠を外す） |
| `WidgetsCalendarConnectGate` | Google カレンダー連携ゲート（擬似 OAuth 同意・props なし） |
| `MastersDeptOrgNode` | 組織図の再帰ノード（node: DeptNode, depth）。`@select` で部署詳細へ |
| `MastersPermissionMatrix` | 権限表モード（props なし = ruleCrud を内部利用）。機能 + マスタ項目 × ロール/役職/個人のマトリクス。セルクリックで 未設定→拒否→許可→未設定 |

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
