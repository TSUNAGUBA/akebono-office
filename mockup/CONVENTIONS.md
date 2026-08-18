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
   - **一覧のページング必須（X-7 = 改修依頼 2026-08-18）**: データが蓄積する一覧は `useListView`（既定 20 件/ページ）+ `UiPagination` を適用する。モックはクライアントページング（`source` に絞込済み computed・ページ独自フィルタは page=1 リセット watch）・API モードでサーバーページングにする場合は `fetch: apiListPage(collection, p)` を併用。対象外 = 直近 N 件の意図的ウィジェット・カンバン/ガント/マトリクス/グリッド/グラフ/会話 UI・件数が構造的に小さい設定 UI
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

// 通知ディープリンク（?open= / ?task= 等）の共通取り込み（2026-08-18・原則3。workflow/inbox/ai-company/NotesPanel で共用）
// 初期表示 = onMounted・滞在中の同一ページ内クエリ変化 = watch で取り込み、URL から対象クエリのみ除去（再読込で再度開かない）
const dlk = useRouteDeepLink('open', id => { /* 即時に開く */ })  // or: dlk.pending を監視 → データ到着で dlk.consume() して開く
useRouteTabSync(tab, { valid: ['confirmed', 'wish'] })  // ?tab= の一方向取り込み（shift/inbox。双方向同期が必要な attendance は従来実装）

// カスタム項目（マスタフォームに合成）
const { formSchemaFor } = useCustomFields()   // → FieldDef[] を UiSchemaForm に渡す

// 設定
const { isEnabled, getConfig, setConfig } = useAppSettings()

// メニューカテゴリ（F-13-8。SoT = configs `menu-categories-<area>`。categorize/save/reset。純ロジックは utils/dashboard-layout.ts と共有）
const mcat = useMenuCategories('dashboard')   // categories / categorize(cards) / save(defs) / reset()

// ダッシュボードのレイアウト（表示・配置 + セクション配置。F-13-9・2026-08-03。純ロジック/型/テンプレート SoT = utils/dashboard-layout.ts）
// 解決順 = ユーザー設定 > テナント設定 > デフォルト（セクション配置も同 3 階層 = #25）。ユーザー層=/v1/me pref 'dashboardLayout'（mock=localStorage 'ako.dashboard-layout.v1'）/ テナント層=configs 'dashboard-layout'（未設定は menu-categories-dashboard 下位互換）
// 2026-08-18 分離: レイアウト設定 = 通知の配置（上/右/下/非表示）に特化・セクション設定 = テンプレート + 自由設定。
// 通知配置は**レイアウト本体と別の専用キー**（user pref 'dashboardNotificationPlacement'〔mock=localStorage
// 'ako.dashboard-notification-placement.v1'〕/ configs 'dashboard-notification-placement'）に保存し、
// 解決 = 層整合: ユーザー配置キー > ユーザー層レイアウト由来（**分離前の保存値のみ**。分離後の保存は options.notificationsInherit=true で配置をキー・下位層へ委譲 = フォールバック値を層に固定しない）> テナント配置キー > テナント層レイアウト由来（分離前のみ）> アプリ既定（既存レイアウトの配置選択を新キーが上書きしない = 原則7。レイアウト本体へ書くと配置変更でセクション構成が層に固定される = レビュー対応）
const dl = useDashboardLayout()   // effectiveLayout〔配置キーの上書き適用済み〕 / resolvedScope / placementSource / activeTemplateId / templates / userPlacement / tenantPlacement / baseLayoutForScope(scope) / applyTemplate(id, scope)〔通知配置は変更しない〕 / saveNotificationPlacement(placement, scope)・resetNotificationPlacement(scope)〔配置キーのみ・取消 = 原則9.5〕 / saveSections(sections, scope)〔保存先層自身の options 維持で sections 差替・templateId=custom〕 / resetLayout(scope)（取消・原則9.5。tenant は管理者のみ。配置キーは触らない）

// セクション構成のお気に入り（自由設定の保存・呼び出し。ユーザー個人・上限 10 件・2026-08-18。純ロジック SoT = utils/dashboard-layout.ts の parseSectionFavorites/upsertSectionFavorite/removeSectionFavorite）
// 永続化 = /v1/me pref 'dashboardSectionFavorites'（mock=localStorage 'ako.dashboard-section-favorites.v1'）。同名は上書き（確認後）・壊れたエントリは 1 件だけ落とす
const sf = useSectionFavorites()  // favorites / saveFavorite(name, sections) / deleteFavorite(id)（取消 = 原則9.5）

// ヘッダーのクイックアクセス（ヘッダーカスタマイズ = 全ページ共通）。解決順 = ユーザー > 組織 > 既定（ユーザー優先）。
// 純ロジック（候補カタログ・パース・解決）の SoT = utils/header-quick-access.ts。永続化はデュアルモード
// （ユーザー層=/v1/me pref 'headerQuickAccess'（mock=localStorage 'ako.header-quick-access.v1'）/ 組織層=configs 'header-quick-access'）。
// 新 API ルート/マイグレーションは不要（既存の汎用 key/value を利用）。設定 UI = OfficeHeaderQuickAccessPicker（scope=自分/全社）。
// 設定導線はダッシュボード → レイアウト → 「アプリヘッダー」タブ（2026-08-12。従来ヘッダー「表示」ボタンは撤去）。
// 注意: parse は配列（API の JSONB）と JSON 文字列（mock/localStorage）の両方を受理する（片方限定にすると API モードで反映されない実障害）。
// 2026-08-18: 候補に「通知（inbox）」を追加（既定 = タイムカード + 通知）。ヘッダーの通知ベル（未読バッジ付き）は本設定の
// 'inbox' で表示制御される（レイアウトヘッダーが特別描画。モバイル下部ナビの「通知」は独立）。保存形式は v2（{ v: 2, ids }）で、
// v1（素の id 配列 = inbox が候補になる前の保存値）は parse が inbox を補完する下位互換（原則7）。
const hqa = useHeaderQuickAccess()  // effectiveIds / resolvedScope / userIds / tenantIds / isAdmin / persist(ids, scope) / reset(scope)（取消・原則9.5。tenant は管理者のみ）

// 通知タブ（通知欄・/inbox に出すカテゴリタブの設定）。解決順 = ユーザー > 組織 > 既定（既定 = 全カテゴリ）。「すべて」は常時表示。
// 純ロジック SoT = utils/notification-tabs.ts（カタログ・parse〔配列/文字列両対応〕・resolve・notificationTabViews）。永続化 = ユーザー層 /v1/me pref 'notificationTabs'
// （mock=localStorage 'ako.notification-tabs.v1'）/ 組織層 configs 'notification-tabs'。設定 UI = OfficeNotificationTabsPicker（レイアウト → 「通知タブ」タブ）。
// タブの並びは notificationTabViews(effectiveIds)（「すべて」先頭 + カテゴリ）で組み立て、通知欄（OfficeDashboardNotifications）と /inbox のタブ順を一致させる（2026-08-12）。
const nt = useNotificationTabs()  // effectiveIds / resolvedScope / userIds / tenantIds / isAdmin / persist(ids, scope) / reset(scope)（取消・原則9.5。tenant は管理者のみ）

// カードメニュー写像（ダッシュボードのメニューカテゴリ配置用。基本メニュー MENU_CARDS.dashboard と同じ MenuCard 形へ）
const { externalCards } = useExternalLinkCards()  // F-13-3 の外部リンク → MenuCard（id=`el-*`・href で別タブ）
const { akebonoCards } = useAkebonoAppCards()      // #24 の active 業態 → MenuCard（id=`akebono-seg:<segmentId>`。写像純関数 = utils/akebono.akebonoSegmentCard）
// 二重表示防止は純関数 planDashboardCards（utils/dashboard-layout.ts）: 割当済み業態=セクション配置 / 未割当=専用「AKEBONO 業務」セクション

// カレンダー連携（F-06-8。google 発の SoT は Google・アプリ発の SoT は本アプリ）
const cal = useCalendar()   // isConnected / connect / syncFromGoogle / addTask / pushToGoogle

// 日報 AI アシスト（F-06-7。ログは追記のみ・ドラフトは保存せずフォームへ流し込む）
const assist = useReportAssist()   // inputMode / questionsFor / recordAnswer / poipoiMemo / generateDraft

// AI業務アシスタント（F-14。done も訂正可 = 監査ログ・他メンバーは F-16-7 許可制で readonly 参照）
const tp = useTaskPlans()   // plansOf / upsertPlan / removePlan / aiReview / recordResult / refresh(memberId?) / insights

// 部署（F-10-9。所属の SoT は Member.departmentId。CRUD は useMasterCrud('departments')）
const depts = useDepartments()   // nameOf / options / membersOf / tree

// 顧客活動（旧: 顧客ログ = F-18。一覧は全メンバー閲覧可・編集/取消は本人のみ・AI 参照は本人スコープ。2026-08-18）
const cl = useCustomerLogs()   // allLogs / archivedOf(自分) / ensureLoaded / add / update / archive / restore / refresh

// 活動記録 3 種（F-43/F-44/F-45。チーム共有 = 全員が閲覧・登録・編集可・取消/復元 = 原則9.5。検証 SoT = shared/domain/activity。2026-08-18）
const sup = useSupportActivities()   // list / archivedList / save(id|null, input) / archive / restore / refresh
const sal = useSalesActivities()     // 同上 + byId（パートナー活動の関連商談リンク解決）
const pact = usePartnerActivities()  // 同上（関連商談 relatedSalesActivityId は営業活動への任意リンク）
// 顧客(会社)コンボボックスの名寄せ・新規登録（モック側の共通実装。API 側は api/src/lib/company-resolve）
const { lookupCompany, createCompany } = useCompanyResolve()

// 休暇（F-04-5/9。種別別残数。付与は管理者/人事のみ・同日同種別はスキップ=冪等）
const leave = useLeave()   // balance(memberId, leaveTypeId?) / request / decide / grant / bulkGrant / activeLeaveTypes

// メディア分析（F-40。独立メディアチャンネル + 任意の業態連携（2026-08-03）。純ロジックの SoT = shared/domain/media-*。
// デュアルモード: モック = 擬似 OAuth + 決定的導出 / API = Google OAuth 2.0（analytics.readonly・チャンネル単位）+
// GA4 実データ（/v1/media/*）。save・connect 系・generate 系は async。全 API は channelId keying）
const mc = useMediaChannels()    // channels / settingFor(channelId) / save / createChannel(name必須・segmentId任意) / archiveChannel・restoreChannel（取消/復元）/ channelForSegment(segmentId)（業態→連携チャンネル解決）/ disconnectGa / gaStatusFor / startGaConnect / listGaProperties / selectGaProperty / connectGa（モック擬似 OAuth）
const cc = useCurrentChannel()   // 現在のメディアチャンネル（mock=localStorage / API=/v1/me pref 'currentChannelId'。無効 id は先頭へフォールバック）
const mx = useMediaExternalArticles() // listFor(channelId) / add / update / archive / restore（外部投稿記事の原文保管 = media インサイトの材料。取消/復元 = 原則9.5）
const ma = useMediaAnalytics()   // metricsFor(channelId,28)（API はロード中 null）/ integratedMetricsFor(channelId,6) / metricsReady / metricsWarningFor / refreshMetrics / integratedReady・integratedFailed・refreshMonthly（GA 月次の失敗表示 + 再試行）/ ensureIntegratedLoaded（false = 生成禁止）
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

// 改善要望（F-42。各ページからの投稿 → 生要望の選別〔採用/不採用〕→ 採用分のみ AI 集約 → 権限を持つ人のみ管理 → 改修プロンプト出力。純ロジック SoT = shared/domain/improvement）
// 投稿は全員可（submit は管理 GET を誤発火しない）。閲覧・管理は canManageImprovements（deny-by-default + 管理者常時可 = usePermissions）。
// 集約は「採用済み（adoption='adopted'）かつ未集約」の要望のみ処理・判定済み item のステータスは巻き戻さない（原則2）。API = Vertex AI → 決定的ヒューリスティック（heuristicClusterRequests）
const imp = useImprovements()  // submit（body + 対象ページ〔既定=開いているページ・全体/新設ページ可〕+ 任意添付 links〔URL 最大5〕・images〔縮小 data URI 最大4〕= 0061 + 任意タグ tags〔壁打ち brainstorm/お任せ entrust = 0065・F-42-17。ラベル SoT = IMPROVEMENT_REQUEST_TAG_META・プロンプトに〔壁打ち〕〔お任せ〕反映〕。mock は persisted=false で容量超過を通知）/ refresh / loadRequestImages(itemId)・loadRequestImagesFor(request)（添付画像の遅延ロード = API の全件 GET は images を含まない。未集約は ?unclustered=1）/ setRequestStatus(id, 'open'|'resolved'|'dismissed')（要望単位の進捗タグ = 0062。プロンプト再生成に【対応済み】【見送り】で反映）/ setRequestAdoption(id, 'pending'|'adopted'|'declined')（生要望の選別 = 0063。採用のみ集約対象・集約済みは変更不可〔AKO-REQ-013〕）/ setRequestAdoptionBulk(ids, adoption)（受付箱の一括選別 = F-42-18・2026-08-18。既存 1 件 API の逐次呼び + 反映 1 回・部分成功は done/failed で報告 = 原則4）/ unclusterRequest(id)（集約の解除 = F-42-19・2026-08-18。改修単位から外し「採用済み（集約待ち）」へ戻す = 再度 AI 集約の対象。解除した item は excludedItemIds（履歴・蓄積 = クリアしない）に記録し次回以降の集約でそこへは再追記しない〔往復 + detail 重複・「対象外」メモとの矛盾防止〕・元 item へ「対象から外れた」修正メモを自動追記〔buildUnclusterNoteBody = プロンプトに反映〕。ガード = 共有 improvementUnclusterError〔未集約 AKO-REQ-017・取消済み AKO-REQ-018・決着済み item AKO-REQ-021 = 先に reopen・取消済み item AKO-REQ-022 = 先に復元〕。選別は取消済み不可 = AKO-REQ-019）/ editRequest(id, body)（生要望本文の編集 = 0064・2026-08-18。本人or管理権限者・取消済み不可〔AKO-REQ-015〕・editedAt 記録で「編集済み」明示 = 原則9.5）/ addRequestComment(requestId, body)・setRequestCommentArchived(id, bool)・commentsForRequest(requestId)（生要望コメント = 選別のやり取り・古い順 = 0063）/ activeItems・archivedItems・unclusteredRequests・adoptedUnclustered（集約待ち）・pendingRequests（未選別）・allRequests / requestsForItem / notesForItem（時系列メモ・古い順）/ generate（集約 = 採用分のみ）/ setStatus / editItem（title/summary/detail + planStart/planEnd 対応予定期間 = ガント）/ setItemArchived・setRequestArchived（取消/復元）/ addNote(itemId, body, kind?='note'|'reject')・setNoteArchived（メモ追加・取消/復元 = 0059。buildCodingPrompt に加味）/ buildPrompt(filter)（添付リンク・画像件数も加味）
```

## UI コンポーネント在庫（新規に作る前にここを見る）

| コンポーネント | 用途 / 主要 props |
|---|---|
| `UiPageHeader` | title, description + #actions |
| `UiSectionCard` | title, description, flush + #actions |
| `UiKpiCard` | label, value, sub, delta, inverse, icon(lucide名), to |
| `UiDataTable` | columns(TableColumn[]), rows, clickable, maxHeight + `#cell-<key>`。`@row-click`。TableColumn.sortable:false = 行データにキーの無い仮想列（選択・操作等）を非ソート描画（2026-08-18） |
| `UiDrawer` | open, title, width + #footer。`@close` |
| `UiModal` | open, title, width, topmost（確認ダイアログ用: 親モーダルより前面 z-70） + #footer。`@close` |
| `UiTabBar` | tabs(TabItem[]), v-model |
| `UiFilterBar` | slot + #trailing |
| `UiSearchInput` / `UiSelect` / `UiChipSelect` | v-model |
| `UiChipTabs` | v-model(string), options({value,label}[])。単一選択のチップ行（カードメニューのカテゴリ切替等。バッチ7h） |
| `UiMultiCombobox` | v-model(string[]), options({value,label,tag?,tagTone?}[]), single（単一選択モード）。論理名で検索する複数選択オートコンプリート（権限設定の項目指定等）。tag/tagTone は候補行・選択チップの区分バッジ（雇用区分等。バッチ7k）。候補リストの開閉方向・最大高は `useDropdownDirection` 共通ロジック（UiCombobox と共有 = 2026-07-31）で下に収まらないとき上方向に開く（モバイルのボトムシートモーダル対応） |
| `UiCombobox` | v-model(string = 選択 id・'' = 未選択/自由入力), v-model:text(string = 入力表示文字列), options({value,label}[]), allowCreate（自由入力の許可。既定 true）, createHint, disabled。**単一選択 + 自由入力**のオートコンプリート（顧客活動・サポート/営業活動の会社 = 未登録名を「新規登録名」として呼び出し側へ渡す。2026-07-31）。ラベル完全一致は自動選択（重複マスタ防止）。開閉方向は `useDropdownDirection`（UiMultiCombobox と共有） |
| `UiFormField` | label, required, error, hint |
| `UiSchemaForm` | fields(FieldDef[]), v-model(Record), errors |
| `UiStatusBadge` | tone, label, dot |
| `UiCardMenu` | items(MenuCard[]), cols, dense（compact でカード余白を詰める = ダッシュボード density 用）。MenuCard.iconImage があれば画像優先（UiIconGlyph） |
| `UiIconGlyph` | icon(lucide名), image(data URI・優先), size, alt, fallback。画像 or アイコンを角丸枠で描画（外部リンクの設定一覧/カードメニュー/ピッカーで共有 = AkebonoSegmentIcon の汎用版・原則3） |
| `UiAvatar` | name, kind('human'/'ai'), size |
| `UiEmptyState` | icon, title, hint + #action |
| `ChartsLineChartCard` / `ChartsBarChartCard` / `ChartsDonutChartCard` | title, labels/series or items, yFormatter |
| `WidgetsPunchClock` | 打刻 = タイムカード（flat: モーダル内等でカード枠を外す） |
| `WidgetsCustomerLogPanel` | props なし。顧客活動（/customer-log）の実体（一覧 20 件ページング + 検索/顧客/記録者フィルタ・登録/編集モーダル〔活動目的チップ + 活動手段 UiChipTabs + 会社/担当者コンボボックス〕・詳細モーダル・取消/復元。全メンバー閲覧可・編集は本人のみ。2026-08-18 改修） |
| `WidgetsSupportActivityPanel` | props なし。サポート活動（/support-activity）の実体（一覧 20 件ページング〔API = サーバーページング〕+ 検索/ステータス/種別フィルタ・詳細ドロワー view/edit/create・取消/復元。F-43・2026-08-18） |
| `WidgetsSalesActivityPanel` | props なし。営業活動（/sales-activity）の実体（フェーズバッジ・金額/確度・Next Action。構成は SupportActivityPanel と同型。F-44・2026-08-18） |
| `WidgetsPartnerActivityPanel` | props なし。ビジネスパートナー活動（/partner-activity）の実体（関連商談 = 営業活動への任意リンク表示付き。構成は SupportActivityPanel と同型。F-45・2026-08-18） |
| `WidgetsCalendarConnectGate` | Google カレンダー連携ゲート（擬似 OAuth 同意・props なし）。連携済みバーに「同期カレンダー」選択モーダル（バッチ7b） |
| `MastersDeptOrgNode` | 組織図の再帰ノード（node: DeptNode, depth）。`@select` で部署詳細へ |
| `WidgetsNotesPanel` | kind('poipoi'/'minutes'), showAuthor。ノート共通パネル（**一覧が基本ビュー・登録/ファイル取込はヘッダーボタン → 入力モーダル（バッチ7h）**。マークダウンプレビュー・ステージ → 取込ボタン・サマリー一覧（押下で詳細モーダル）+ 行単位の取消/復元 + 管理者の全ポスト閲覧（poipoi）。バッチ7c/7d/7e/7h） |
| `WidgetsWeeklyInsight` | initialWeekStart。週次 AI インサイト（**保存済みを表示・「生成/再生成」で保管 = バッチ7j**。あなた向けインサイト（個別）+ 集計 KPI + チャート + エグゼクティブサマリー/SWOT/リスク/アクション。集計は前日（asOf）まで基準。週ナビ + 生成日時表示。バッチ7g/7j） |
| `UiMarkdown` | source。安全なサブセットのマークダウン描画（utils/markdown.ts の AST を VNode 直接生成 = v-html 不使用。見出し・リスト・引用・コード・強調・http(s) リンクのみ。バッチ7e） |
| `MastersPermissionMatrix` | 権限表モード（props なし = ruleCrud を内部利用）。ページ > 機能 > 項目 の 3 階層ツリー × ロール/役職/個人（バッチ7m）。セルは常に可否を表示（明示 = 濃色 / 上位一括・既定値 = 薄色破線）・クリックで反転・引き継ぎ値へ戻すと明示ルール解除。表ヘッダは内部スクロール + sticky |
| `SettingsMenuCategoryEditor` | props なし。メニューカテゴリのカスタマイズ（F-13-8。エリア切替 + カテゴリ CRUD/並び替え/カード割当 + 既定に戻す。バッチ7h。編集 UI は `UiMenuSectionEditor` 共用・ダッシュボードタブは外部リンク/AKEBONO も割当候補 + 3 階層はレイアウトへ案内） |
| `UiMenuSectionEditor` | modelValue(MenuCategoryDef[]) / cardOptions / emptyHint。メニューセクション編集の共通 UI（追加・削除・改名・並び替え・カード割当 = UiMultiCombobox。**セクション内カードの並び替え = D&D + ↑/↓ ボタン〔cardIds 配列順 = 表示順〕2026-08-17**）。保存/リセット/スコープは呼び出し側（#25。原則3。MenuCategoryEditor と DashboardSectionEditor が共用） |
| `SettingsNotifyRecipientsEditor` | modelValue(NotifyRecipientTarget[])。通知の宛先を「ロール/役職/個人」で複数指定（ApproverSteps と同 3 種・順序/モードなし）。各行に解決人数プレビュー・空許容。設定「改善のタネの通知先」で使用（F-12-5・F-13-10・2026-08-03。解決 = 共有 resolveNotifyRecipientIds） |
| `SettingsIconPicker` | v-model:icon(lucide名) / v-model:image(data URI or null) / v-model:busy。外部リンクのアイコン設定（プレビュー付きプリセット選択 = LINK_ICON_CHOICES ／ 画像アップロード = 160px 縮小 data URI ／「アイコンに戻す」で取消）。segments のインライン実装を共通化（改善要望・2026-08-12。原則3/9.5） |
| `OfficeDashboardNotifications` | props なし。ダッシュボードの通知欄（「すべて」+ 設定されたカテゴリタブ〔エスカレーション/承認依頼/稟議/日報/顧客活動/議事録〕 + 未読のみフィルタ・直近 8 件）。表示タブは useNotificationTabs 駆動。index.vue から分離し通知位置（side/bottom）で配置切替可能に（2026-08-03 / タブ設定化 2026-08-12） |
| `OfficeDashboardLayoutPreview` | layout(DashboardLayout)。レイアウトの軽量プレビュー（実データ不要。セクション見出し + カード数チップ + 通知位置図示 + AKEBONO/密度反映。F-13-9） |
| `OfficeDashboardLayoutPicker` | props なし。ダッシュボードのレイアウト設定モーダル。「レイアウト（通知の配置）」/「セクション設定」/「アプリヘッダー」/「通知タブ」タブ切替（**2026-08-18 分離: レイアウト = 通知の配置〔上/右/下/非表示〕に特化・テンプレートはセクション設定へ移設**）+ 適用スコープ〔自分/全社〕+ 現在有効層表示。ヘッダの「レイアウト」ボタン → UiModal 内で使用（F-13-9・2026-08-03。アプリヘッダー/通知タブ 追加 2026-08-12） |
| `OfficeHeaderQuickAccessPicker` | props なし。ヘッダーのクイックアクセス設定（ヘッダーカスタマイズ = 全ページ共通）。候補カタログから表示メニューを選択 + 適用スコープ〔自分/全社〕+ 既定に戻す。**候補に「通知」（ベルの表示制御・既定 ON = 2026-08-18）**。純ロジック SoT = utils/header-quick-access.ts・解決/保存 = useHeaderQuickAccess。**レイアウトモーダルの「アプリヘッダー」タブ内で使用**（2026-08-12。従来のヘッダー「表示」ボタンは撤去） |
| `OfficeNotificationTabsPicker` | props なし。通知タブ（通知欄・/inbox に出すカテゴリタブ）の設定。カタログから表示タブを選択 + 適用スコープ〔自分/全社〕+ 既定に戻す。純ロジック SoT = utils/notification-tabs.ts・解決/保存 = useNotificationTabs。レイアウトモーダルの「通知タブ」タブ内で使用（2026-08-12） |
| `OfficeDashboardSectionEditor` | props なし。ダッシュボードのセクション設定を 3 階層（自分/全社/アプリ既定）で編集・保存（saveSections）。**サブモード「テンプレート」（6 種から適用。通知の配置は保存先層の現行値を維持）/「自由設定」（手動編集 + お気に入り保存・呼び出し・削除 = useSectionFavorites。2026-08-18）**。割当候補 = 基本メニュー + 外部リンク + AKEBONO 業態アプリ。UiMenuSectionEditor を利用（#25・2026-08-03） |
| `MediaChannelBar` | props なし。メディア分析の対象チャンネル切替バー（現在チャンネル + 連携業態バッジ + GA 連携バッジ + 設定導線）。全メディア画面の先頭に置く（F-40。2026-08-03 で MediaSegmentBar から改称・チャンネル化） |
| `MediaGaConnect` | channelId?（未指定=現在チャンネル）, variant（'gate'/'bar'）。Google Analytics 連携ゲート（モック = 擬似 OAuth / API = Google OAuth 2.0 リダイレクト + 復帰クエリ `?ga=` 処理 + GA4 プロパティ選択モーダル。needsProperty の中間状態も再開可）。連携済みは状態バー + 解除（F-40。CalendarConnectGate と同型） |
| `MediaFunnel` | stages（{label,value}[]）。流入→受注の簡易ファネル（幅バー + 前段比。Chart.js 不使用。F-40） |
| `WidgetsImprovementSubmit` | props なし。全ページ共通ヘッダーの「要望を送る」導線（F-42）。**対象ページを選択可（既定 = 開いているページ。「全体」「新設ページ」+ 全ページ = `listKnownPages`。2026-08-17）**。投稿は認証済み全員可（layouts/default.vue に 1 つ設置で全ページに出る）。**添付（F-42-11・2026-08-17）: 参考リンク（複数・行削除可）+ 画像（複数・`imageToDataUri` 縮小・プレビュー/個別削除）。画像はファイル選択に加え、ドロップエリアへのドラッグ&ドロップとクリップボード貼り付け（Ctrl+V / ⌘V。入力ビュー全体で受ける）でも添付可（2026-08-18）。参照はリンク=別タブ・画像=押下で拡大（/improvements ドロワー）。**タグ（任意・F-42-17・2026-08-18）: 「壁打ち」（壁打ちを経て案件化したい）「お任せ」（開発側の解釈で進めてよい）を UiChipSelect で複数付与できる**。**送信後ビューに「内容を修正する」= 投稿者本人の本文編集（F-42-16・editRequest。2026-08-18）** |
| `ImprovementsAttachmentList` | links, images。要望添付の表示共通部品（参考リンク = 別タブ・画像サムネイル = @preview で拡大 emit。F-42-11。/improvements の改修単位ドロワー元要望と生要望ドロワーで共用 = 原則3・2026-08-18） |
| `ImprovementsTagBadges` | tags（ImprovementRequestTag[]・省略可）, wrapperClass（タグがあるときだけ描画する外枠クラス。未指定 = contents = 素通し）。要望タグ（壁打ち/お任せ = F-42-17）のバッジ列（title で意味表示。SoT = IMPROVEMENT_REQUEST_TAG_META。空判定・normalize は部品側 = 未知値は落とす）。受付箱一覧・要望詳細・改修単位ドロワーの元要望で共用（原則3・2026-08-18） |
| `ImprovementsBodyEditForm` | initial（編集開始時の本文）, busy。要望本文の編集フォーム共通部品（textarea + 文字数カウンタ + 保存/キャンセル emit。F-42-16。/improvements の生要望ドロワーと ImprovementSubmit の送信直後修正で共用 = 原則3・2026-08-18） |
| `ImprovementsKanban` | items（ImprovementItem[]）・reqCount(id)。ステータス別カラムのカンバン（F-42）。emit: open(item)・status(id,to)。許可遷移のクイック操作・横スクロール |
| `ImprovementsGantt` | items（ImprovementItem[]）。対応予定期間のガント（F-42。月次/週次/日次切替・前後送り・今スナップ）。列/バーは `shared/domain/gantt` 純関数。**ステータスフィルタ（既定=accepted=実装決定・未完了。選択肢/判定は `IMPROVEMENT_FILTER_OPTIONS`/`matchesImprovementFilter` 共有）+ バー色分け（対応する=brand/未判定=warn/解決済み=muted〔完了グレー〕/対応しない=crit・決着済みは退色）+ 凡例。2026-08-12** emit: open(item) |

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
