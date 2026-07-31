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
   - **API モード（バッチ2a〜）:** マイグレーション済みコレクション（マスタ 31 種 = useApi.ts の MIGRATED_MASTERS・専用エンドポイント 21 種 = CUSTOM_COLLECTION_ENDPOINTS（akebonoAppConfigs / itemSettings = Phase B + 記録系 16 = Phase C + 取込 importSources/importMappings/importRuns = Phase D）・監査ログ・設定）は `tbl()` が API キャッシュを返す（参照はそのまま）。**書込は `useMasterCrudAsync` / `useAppSettings` / 各ドメイン composable の API 経路（apiWrite = 書込 → 影響コレクション再ロード）のみ**。`tbl().value = ...` の直接書込やモック版 `useMasterCrud` での書込を追加しない（キャッシュ汚染 = SoT 逆流。原則6）。導出キャッシュ（mediaInsights / dashboardInsights）はコレクションでなくキー単位の遅延ロード（apiLoadOnce）= 各 composable が管理する（**Phase D で dashboardInsights もサーバー化 = API モードで localStorage 保管のモックコレクションは 0**）
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

// AI業務アシスタント（F-14。done も訂正可 = 監査ログ・他メンバーは F-16-7 許可制で readonly 参照）
const tp = useTaskPlans()   // plansOf / upsertPlan / removePlan / aiReview / recordResult / refresh(memberId?) / insights

// 部署（F-10-9。所属の SoT は Member.departmentId。CRUD は useMasterCrud('departments')）
const depts = useDepartments()   // nameOf / options / membersOf / tree

// 休暇（F-04-5/9。種別別残数。付与は管理者/人事のみ・同日同種別はスキップ=冪等）
const leave = useLeave()   // balance(memberId, leaveTypeId?) / request / decide / grant / bulkGrant / activeLeaveTypes

// メディア分析（F-40。Akebono セグメントと 1:1。純ロジックの SoT = shared/domain/media-*。
// デュアルモード: モック = 擬似 OAuth + 決定的導出 / API = Google OAuth 2.0（analytics.readonly・セグメント単位）+
// GA4 実データ（/v1/media/*）。save・connect 系・generate 系は async）
const ms = useMediaSettings()    // settingFor / save / disconnectGa（両モード）+ gaStatusFor / startGaConnect / listGaProperties / selectGaProperty（API の OAuth + プロパティ選択）/ connectGa（モック擬似 OAuth）
const ma = useMediaAnalytics()   // metricsFor(segId,28)（API はロード中 null）/ integratedMetricsFor(segId,6) / metricsReady / metricsWarningFor / refreshMetrics / integratedReady・integratedFailed・refreshMonthly（GA 月次の失敗表示 + 再試行）/ ensureIntegratedLoaded（false = 生成禁止）
const mi = useMediaInsight()     // loadMedia/generateMedia / loadIntegrated/generateIntegrated（async。生成→保管→再生成で上書き。API = Vertex AI → ヒューリスティック）/ storedMedia
const art = useMediaArticles()   // generate（async。API = Vertex AI → 決定的フォールバック）/ suggestionFromInsight / adopt / unadopt / remove / restore（取消可能）

// 業態別/会社全体ダッシュボード（F-41。業務×メディアを統合したサマリー+AIレポート+AIインサイト。純ロジック SoT = shared/domain/portfolio-insight）
const di = useDashboardInsight() // buildSegmentSummary/buildCompanySummary（常時ライブ集計）/ loadSegment・generateSegment / loadCompany・generateCompany（生成→保管→再生成で上書き）

// Akebono マスタ（Phase B で API 永続化 = /v1/masters/*。cruds は useMasterCrudAsync = save/archive/restore は Promise<Result>）
const am = useAkebonoMasters()  // segments / warehouses / units / taxRates / paymentTerms / consignmentTerms / variantAxisTemplates / productCategories / imageSections

// 業態×アプリ設定（F-20。API = PUT /v1/akebono/app-configs の複合キーバッチ upsert。行が無い業態は業種プリセットへフォールバック）
const apps = useAkebonoApps()   // isAppEnabled / appsForSegment / setEnabled・setLabel・applyPreset（async。変更行だけ送る）

// 項目カスタマイズ（F-31。カタログ = コード静的 SoT + テナント差分。API = PUT /v1/akebono/item-settings の部分 upsert）
const its = useItemSettings()   // resolve(entity) / upsert（渡したキーのみ更新）/ resetEntity（カタログ既定へ戻す取消フロー = 原則9.5)

// Akebono 記録系（F-21〜F-29。Phase C で API 永続化 = /v1/akebono/*。書込はすべて async = Promise<Result>。
// 記録系は追記のみ・訂正は赤黒/赤伝・在庫の SoT = inventoryTransactions（残高はモック = foldBalances で導出・
// API = サーバー全量集約 GET /inventory-balances = 台帳明細の表示打ち切りに依らず正しい残高 = Codex P1-2）。
// 金額算定（税・委託精算）は shared/domain/akebono の純関数を API と共有）
const prod = useProducts()      // saveProduct（既定 SKU 自動生成）/ saveMatrix / addImage / archive・restore 系
const inv2 = useInventory()     // balanceOf / ledgerOf / adjust / transfer / stocktake（post はモック専用）
const asl = useAkebonoSales()   // create（原価はサーバー解決）/ correct（赤黒。成功時 invalidateIntegratedFor）
const con = useConsignment()    // closeBilling / issue / voidInvoice / recordReceipt / voidReceipt / closeConsignment / cancelConsignment（Phase D = 取消 原則9.5）/ confirmNotice
const outb = useOutbound()      // createPlan / registerResult（Phase D: postSales で出荷→売上自動計上 source_kind='shipment'・店舗預けは対象外）/ cancelPlan

// Akebono データ取込（F-32。Phase D で API 永続化 = /v1/akebono/import-*。書込は async・管理者のみ）
const imp = useAkebonoImports() // addSource / archiveSource・restoreSource（論理削除で取消）/ saveMapping（版管理）/ runImport（記録系・追記）
// ダッシュボード AI レポート（F-41。Phase D で導出キャッシュをサーバー化 = media_insights 同型）
const di = useDashboardInsight() // buildSegmentSummary/buildCompanySummary（常時ライブ集計）/ loadSegment・generateSegment / loadCompany・generateCompany（async。生成→保管→再生成で upsert・API = Vertex AI → ヒューリスティック）
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
| `UiChipTabs` | v-model(string), options({value,label}[])。単一選択のチップ行（カードメニューのカテゴリ切替等。バッチ7h） |
| `UiMultiCombobox` | v-model(string[]), options({value,label,tag?,tagTone?}[]), single（単一選択モード）。論理名で検索する複数選択オートコンプリート（権限設定の項目指定等）。tag/tagTone は候補行・選択チップの区分バッジ（雇用区分等。バッチ7k）。候補リストの開閉方向・最大高は `useDropdownDirection` 共通ロジック（UiCombobox と共有 = 2026-07-31）で下に収まらないとき上方向に開く（モバイルのボトムシートモーダル対応） |
| `UiCombobox` | v-model(string = 選択 id・'' = 未選択/自由入力), v-model:text(string = 入力表示文字列), options({value,label}[]), allowCreate（自由入力の許可。既定 true）, createHint, disabled。**単一選択 + 自由入力**のオートコンプリート（顧客ログの会社・担当者 = 未登録名を「新規登録名」として呼び出し側へ渡す。2026-07-31）。ラベル完全一致は自動選択（重複マスタ防止）。開閉方向は `useDropdownDirection`（UiMultiCombobox と共有） |
| `UiFormField` | label, required, error, hint |
| `UiSchemaForm` | fields(FieldDef[]), v-model(Record), errors |
| `UiStatusBadge` | tone, label, dot |
| `UiCardMenu` | items(MenuCard[]), cols |
| `UiAvatar` | name, kind('human'/'ai'), size |
| `UiEmptyState` | icon, title, hint + #action |
| `ChartsLineChartCard` / `ChartsBarChartCard` / `ChartsDonutChartCard` | title, labels/series or items, yFormatter |
| `WidgetsPunchClock` | 打刻 = タイムカード（flat: モーダル内等でカード枠を外す） |
| `WidgetsCalendarConnectGate` | Google カレンダー連携ゲート（擬似 OAuth 同意・props なし）。連携済みバーに「同期カレンダー」選択モーダル（バッチ7b） |
| `MastersDeptOrgNode` | 組織図の再帰ノード（node: DeptNode, depth）。`@select` で部署詳細へ |
| `WidgetsNotesPanel` | kind('poipoi'/'minutes'), showAuthor。ノート共通パネル（**一覧が基本ビュー・登録/ファイル取込はヘッダーボタン → 入力モーダル（バッチ7h）**。マークダウンプレビュー・ステージ → 取込ボタン・サマリー一覧（押下で詳細モーダル）+ 行単位の取消/復元 + 管理者の全ポスト閲覧（poipoi）。バッチ7c/7d/7e/7h） |
| `WidgetsWeeklyInsight` | initialWeekStart。週次 AI インサイト（**保存済みを表示・「生成/再生成」で保管 = バッチ7j**。あなた向けインサイト（個別）+ 集計 KPI + チャート + エグゼクティブサマリー/SWOT/リスク/アクション。集計は前日（asOf）まで基準。週ナビ + 生成日時表示。バッチ7g/7j） |
| `UiMarkdown` | source。安全なサブセットのマークダウン描画（utils/markdown.ts の AST を VNode 直接生成 = v-html 不使用。見出し・リスト・引用・コード・強調・http(s) リンクのみ。バッチ7e） |
| `MastersPermissionMatrix` | 権限表モード（props なし = ruleCrud を内部利用）。ページ > 機能 > 項目 の 3 階層ツリー × ロール/役職/個人（バッチ7m）。セルは常に可否を表示（明示 = 濃色 / 上位一括・既定値 = 薄色破線）・クリックで反転・引き継ぎ値へ戻すと明示ルール解除。表ヘッダは内部スクロール + sticky |
| `SettingsMenuCategoryEditor` | props なし。メニューカテゴリのカスタマイズ（F-13-8。エリア切替 + カテゴリ CRUD/並び替え/カード割当 + 既定に戻す。バッチ7h） |
| `MediaSegmentBar` | props なし。メディア分析の対象セグメント（業態）切替バー（現在業態 + GA 連携バッジ + 設定導線）。全メディア画面の先頭に置く（F-40） |
| `MediaGaConnect` | segmentId?（未指定=現在業態）, variant（'gate'/'bar'）。Google Analytics 連携ゲート（モック = 擬似 OAuth / API = Google OAuth 2.0 リダイレクト + 復帰クエリ `?ga=` 処理 + GA4 プロパティ選択モーダル。needsProperty の中間状態も再開可）。連携済みは状態バー + 解除（F-40。CalendarConnectGate と同型） |
| `MediaFunnel` | stages（{label,value}[]）。流入→受注の簡易ファネル（幅バー + 前段比。Chart.js 不使用。F-40） |

**ページ間導線・メニュー定義の SoT（バッチ7h）:** 親ページへ戻る・関連ページは `app/utils/nav-map.ts`、
ダッシュボード / マスタハブのカード定義と既定カテゴリは `app/utils/menu-registry.ts` が SoT。
ページ個別のアドホックな戻るリンク・カードのハードコードを追加しない（レイアウトヘッダー・レジストリへ追記する）。
新ページ追加時は nav-map（parent/related）と、カードメニューに載せる場合は menu-registry へ登録すること。

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
