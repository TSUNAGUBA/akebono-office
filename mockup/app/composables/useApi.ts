/**
 * API 接続の基盤（バッチ2a）。
 * - API モード: NUXT_PUBLIC_API_BASE が設定されている場合のみ有効。未設定なら全機能が従来どおり
 *   モック（useMockDb）で動作する（デモ環境の下位互換）
 * - 認証: Firebase ID トークン（本番）または x-dev-member-id ヘッダ（NUXT_PUBLIC_DEV_MEMBER_ID。ローカル/E2E 専用）
 * - エラー: API の { error: { code, message } } を Result 形式へ正規化（apiResult）
 * SPA（ssr:false）専用の設計: 状態はモジュールスコープで単一。
 */
import type { Ref } from 'vue'
import type { MemberRole, Result } from '~/types/domain'
import { getFirebaseIdToken } from '~/utils/firebase-auth'

export interface ApiUser {
  id: string
  name: string
  email: string
  role: MemberRole
  /** プロフィール画像（data URI。空文字 = 未設定） */
  avatar?: string
  /**
   * 本人の UI 設定（端末間で同期する個人設定。/v1/me が user_preferences から返す）。
   * 現状 currentSegmentId（現在の業態）。SoT はサーバー（0039）。
   */
  prefs?: Record<string, unknown>
}

interface PublicApiConfig {
  apiBase: string
  devMemberId: string
  firebaseConfig: string
}

let cachedConfig: PublicApiConfig | null = null

/**
 * NUXT_PUBLIC_FIREBASE_CONFIG は JSON 文字列として渡すが、Nuxt の env 解釈（destr）により
 * ランタイム設定へは**オブジェクト**として届く。どちらで来ても JSON 文字列へ正規化する
 * （String(object) は "[object Object]" になり JSON.parse が壊れる = 実バグ事例）。
 */
function asJsonString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}

/** ランタイム設定（初回はプラグインが setup 文脈でプライムする） */
export function apiPublicConfig(): PublicApiConfig {
  if (!cachedConfig) {
    const pub = useRuntimeConfig().public
    cachedConfig = {
      apiBase: String(pub.apiBase ?? ''),
      devMemberId: String(pub.devMemberId ?? ''),
      firebaseConfig: asJsonString(pub.firebaseConfig),
    }
  }
  return cachedConfig
}

/** API モードか（true のときマイグレーション済みコレクションは API が SoT） */
export function useApiMode(): boolean {
  return Boolean(apiPublicConfig().apiBase)
}

// ---------- 認証済みユーザー（/v1/me） ----------

const me = ref<ApiUser | null>(null)
const meError = ref<{ code: string; message: string } | null>(null)
let mePromise: Promise<ApiUser | null> | null = null

export function useApiMe(): Ref<ApiUser | null> {
  return me
}

/**
 * /v1/me の直近の失敗理由（成功で null）。
 * ログイン画面が「メンバー未登録（AKO-AUTH-002）」と「API 未達・サーバーエラー等」を
 * 区別して表示するために公開する（未登録以外を未登録と誤表示しない）。
 */
export function useApiMeError(): Ref<{ code: string; message: string } | null> {
  return meError
}

/** /v1/me を一度だけ取得（ログイン直後・dev モード起動時）。失敗時は null（理由は useApiMeError） */
export function ensureMeLoaded(): Promise<ApiUser | null> {
  if (me.value) return Promise.resolve(me.value)
  mePromise ??= apiFetch<ApiUser>('/v1/me')
    .then((u) => {
      me.value = u
      meError.value = null
      resetApiData() // 認証確立後にコレクションを取り直す（未認証時の空フェッチを解消）
      return u
    })
    .catch((e) => {
      meError.value = apiErrorOf(e)
      mePromise = null
      return null
    })
  return mePromise
}

export function clearMe(): void {
  me.value = null
  meError.value = null
  mePromise = null
}

/**
 * 本人の UI 設定を保存する（端末間同期。PUT /v1/me/preferences/:key）。
 * 楽観反映（me.prefs 更新）を呼び出し順で**同期的に**確定させてからサーバーへ保管する。
 * これで反映順が呼び出し順（= クリック順）に一致し、round-trip 後の遅延書き戻しによる
 * last-write-wins の取り違え（早い値が後着で上書き）を作らない。SoT は依然サーバーで、
 * 次回 /v1/me 再取得でサーバー値が正となる（UI 反映が先行するだけ = 原則4 の非ブロッキング）。
 * 保存失敗時はキャッシュを巻き戻さない（当該端末では反映済み・自己修復は次回ロード）。結果は Result で返す。
 */
export async function saveMePreference(key: string, value: unknown): Promise<Result> {
  if (me.value) me.value = { ...me.value, prefs: { ...(me.value.prefs ?? {}), [key]: value } }
  return apiResult(() => apiFetch(`/v1/me/preferences/${encodeURIComponent(key)}`, {
    method: 'PUT', body: { value },
  }))
}

// ---------- HTTP ----------

export interface ApiCallError extends Error {
  code: string
}

/** 認証ヘッダ（dev = x-dev-member-id / 本番 = Firebase ID トークン）。apiFetch/apiFetchList で共用 */
async function authHeaders(): Promise<Record<string, string>> {
  const config = apiPublicConfig()
  const headers: Record<string, string> = {}
  if (config.devMemberId) {
    headers['x-dev-member-id'] = config.devMemberId
  } else {
    const token = await getFirebaseIdToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }
  return headers
}

/**
 * 既定のリクエストタイムアウト（ms）。従来はタイムアウト無しで、API のコールドスタートや接続断のとき
 * 「登録ボタンを押しても無反応」に見える実障害があった（改修依頼 2026-08-20 バグ修正 H4）。
 * 応答が返らない呼び出しは中断して AKO-GEN-NET へ正規化する（長時間かかる処理は timeoutMs で個別延長）。
 */
const API_TIMEOUT_MS = 15_000

/** API 呼び出し（{ data } を展開して返す。失敗は code 付き Error を throw） */
export async function apiFetch<T = unknown>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const config = apiPublicConfig()
  const headers = await authHeaders()
  try {
    const res = await $fetch<{ data: T }>(path, {
      baseURL: config.apiBase,
      method: opts.method ?? 'GET',
      body: opts.body as Record<string, unknown> | undefined,
      query: opts.query,
      headers,
      timeout: opts.timeoutMs ?? API_TIMEOUT_MS,
    })
    return res.data
  } catch (e) {
    const data = (e as { data?: { error?: { code?: string; message?: string } } }).data
    const error = new Error(data?.error?.message ?? 'API との通信に失敗しました。ネットワークをご確認ください') as ApiCallError
    error.code = data?.error?.code ?? 'AKO-GEN-NET'
    throw error
  }
}

/**
 * サーバーページング用の一覧取得（q/limit/offset を渡し { rows, total } を返す）。
 * apiFetch は res.data のみを返すため、兄弟キー total を読むにはこの専用経路を使う。
 * total が無いレスポンス（レガシー bare 配列）でも rows.length にフォールバックして壊れない。
 */
export async function apiFetchList<T = unknown>(
  path: string, params: { q: string; limit: number; offset: number; filter?: Record<string, string> },
): Promise<{ rows: T[]; total: number }> {
  const config = apiPublicConfig()
  const query: Record<string, string> = { limit: String(params.limit), offset: String(params.offset) }
  if (params.q) query.q = params.q
  // 構造化フィルタ（f.<key> 系）を透過（0056。空値は付与しない）
  if (params.filter) for (const [k, v] of Object.entries(params.filter)) if (v !== '') query[k] = v
  try {
    const res = await $fetch<{ data: T[]; total?: number }>(path, {
      baseURL: config.apiBase, method: 'GET', query, headers: await authHeaders(), timeout: API_TIMEOUT_MS,
    })
    const rows = res.data ?? []
    return { rows, total: res.total ?? rows.length }
  } catch (e) {
    const data = (e as { data?: { error?: { code?: string; message?: string } } }).data
    const error = new Error(data?.error?.message ?? 'API との通信に失敗しました。ネットワークをご確認ください') as ApiCallError
    error.code = data?.error?.code ?? 'AKO-GEN-NET'
    throw error
  }
}

/**
 * コレクション名からエンドポイントを解決してサーバーページング取得する（useListView の fetch に渡す）。
 * 未マイグレーション名は空ページを返す（API モードでも安全側にフォールバック = 原則4）。
 */
export function apiListPage<T = unknown>(
  collection: string, params: { q: string; limit: number; offset: number; filter?: Record<string, string> },
): Promise<{ rows: T[]; total: number }> {
  const path = CUSTOM_COLLECTION_ENDPOINTS[collection]
  if (!path) return Promise.resolve({ rows: [], total: 0 })
  return apiFetchList<T>(path, params)
}

/** 例外を Result のエラー形式へ正規化する（apiResult を経由しない拡張レスポンス用） */
export function apiErrorOf(e: unknown): { code: string; message: string } {
  const error = e as Partial<ApiCallError>
  return { code: error.code ?? 'AKO-GEN-NET', message: error.message ?? '通信に失敗しました' }
}

/** API 呼び出しをモック互換の Result 形式へ正規化する（画面側の分岐を変えないため） */
export async function apiResult(fn: () => Promise<{ id?: string } | void | unknown>): Promise<Result> {
  try {
    const data = (await fn()) as { id?: string } | undefined
    return data?.id ? { ok: true, id: data.id } : { ok: true }
  } catch (e) {
    return { ok: false, error: apiErrorOf(e) }
  }
}

// ---------- マイグレーション済みコレクション（API ハイドレーション） ----------

/** mockup コレクション名 → API マスタスラッグ */
const MIGRATED_MASTERS: Record<string, string> = {
  members: 'members',
  departments: 'departments',
  leaveTypes: 'leave-types',
  industries: 'industries',
  villages: 'villages',
  workCategories: 'work-categories',
  companies: 'companies',
  contacts: 'contacts',
  relationTypes: 'relation-types',
  companyRelations: 'company-relations',
  contactRelations: 'contact-relations',
  projects: 'projects',
  knowledge: 'knowledge',
  customFieldDefs: 'custom-field-defs',
  codeMaster: 'code-masters',
  externalLinks: 'external-links',
  attendanceRules: 'attendance-rules',
  holidays: 'holidays',
  workflowRoutes: 'workflow-routes',
  decisionThemes: 'decision-themes',
  permissionRules: 'permission-rules',
  attendanceRoutes: 'attendance-routes',
  aiRoles: 'ai-roles',
  aiEmployees: 'ai-employees',
  // Akebono 設定系（Phase B = 0031）
  businessSegments: 'business-segments',
  warehouses: 'warehouses',
  units: 'units',
  taxRates: 'tax-rates',
  paymentTerms: 'payment-terms',
  consignmentTerms: 'consignment-terms',
  variantAxisTemplates: 'variant-axis-templates',
  productCategories: 'product-categories',
  productImageSections: 'product-image-sections',
}

/**
 * masters 以外の専用エンドポイントでハイドレーションするコレクション（Phase B）。
 * 複合キー（akebonoAppConfigs）・差分 upsert（itemSettings）は汎用マスタ CRUD に合わないため、
 * 読み取りだけここで API 化し、書込は各 composable（useAkebonoApps / useItemSettings）の専用経路が担う
 */
const CUSTOM_COLLECTION_ENDPOINTS: Record<string, string> = {
  akebonoAppConfigs: '/v1/akebono/app-configs',
  itemSettings: '/v1/akebono/item-settings',
  // Phase C（0032）: 記録系 15 コレクション。読み取りは一覧 GET・書込は各 composable の専用経路
  products: '/v1/akebono/products',
  productSkus: '/v1/akebono/product-skus',
  productImages: '/v1/akebono/product-images',
  purchaseOrders: '/v1/akebono/purchase-orders',
  productionOrders: '/v1/akebono/production-orders',
  inboundPlans: '/v1/akebono/inbound-plans',
  inboundResults: '/v1/akebono/inbound-results',
  purchaseRecords: '/v1/akebono/purchase-records',
  outboundPlans: '/v1/akebono/outbound-plans',
  outboundResults: '/v1/akebono/outbound-results',
  inventoryTransactions: '/v1/akebono/inventory-transactions',
  // 在庫残高（全量集約）: 台帳明細（inventoryTransactions）は表示打ち切りありのため、残高は
  // サーバー集約値を別途ハイドレーションする（明細打ち切りに依らず正しい残高 = Codex P1-2）
  inventoryBalances: '/v1/akebono/inventory-balances',
  salesRecords: '/v1/akebono/sales-records',
  invoices: '/v1/akebono/invoices',
  paymentNotices: '/v1/akebono/payment-notices',
  paymentReceipts: '/v1/akebono/payment-receipts',
  // Phase D（0035）: データ取込（F-32）。取込元/マッピング/実行履歴の読み取りは一覧 GET・書込は
  // useAkebonoImports の専用経路（dashboardInsights はセグメント×scope キーのため composable 側で個別ロード）
  importSources: '/v1/akebono/import-sources',
  importMappings: '/v1/akebono/import-mappings',
  importRuns: '/v1/akebono/import-runs',
  // F-42（0057）: 改善要望。管理系の読み取り（一覧 GET）は管理権限者のみ = 非権限者は 403 で空フォールバック。
  // 実際の管理ページは useImprovements が専用 ref（includeArchived 付き）でロードし tbl() を経由しない。
  // ここに登録するのは①投稿の apiWrite/②isMigratedCollection でモックコレクション扱いを外すため
  // （API モードで tbl('improvementItems') を触っても localStorage の空データでなくサーバー値〔管理者〕/403 空になる）
  improvementRequests: '/v1/improvements/requests',
  improvementItems: '/v1/improvements/items',
  // 活動記録 3 種（0067。改修依頼 2026-08-18）: チーム共有の記録系。読み取りは一覧 GET
  // （パラメータ無し = 取消済み込みの全件ハイドレーション・useListView の fetch = apiListPage で
  // サーバーページング）・書込は各 composable（useSupportActivities 等）の apiWrite 経路
  supportActivities: '/v1/support-activities',
  salesActivities: '/v1/sales-activities',
  partnerActivities: '/v1/partner-activities',
  // 活動ログ（salesActivityLogs / partnerActivityLogs。改修依頼 2026-08-20）は**意図的に載せない**:
  // 案件にネストする資源（/v1/sales-activities/:id/logs）で全量ハイドレーションに向かないため、
  // API モードでは案件詳細ページが都度フェッチする（useActivityLogs の pageFetch/loadArchived）。
  // モックモードのみ MockDbShape のコレクションを使う（この設計判断の詳細は useActivityLogs.ts の docblock）
  // 顧客コンテキスト（0076。改修依頼 2026-08-20）: 定性情報（1社1行 = 顧客数が上限）とメモを
  // 全量ハイドレーションする設計判断。メモは会社横断でも「顧客ごとの経営メモ」で件数が緩やかにしか
  // 伸びないため全量を採る（活動ログのような案件ネスト資源とは性質が異なる。将来件数が問題になったら
  // useActivityLogs と同じ会社単位の遅延フェッチへ切替える）。書込は useCustomerContext の専用経路
  customerContexts: '/v1/customer-contexts',
  customerContextNotes: '/v1/customer-contexts/notes',
}

/**
 * 記録系書込の共通ヘルパー（Phase C）: 書込 → 成功時に影響コレクションを force 再ロードして返す。
 * 実績登録は複数コレクション（実績 + 在庫台帳 + 予定ステータス等）へ波及するため、
 * 部分的なキャッシュ手術ではなく影響コレクションの再取得で SoT → キャッシュの整合を保つ（原則6）
 */
export async function apiWrite<T = unknown>(
  path: string,
  opts: { method?: 'POST' | 'PATCH' | 'PUT'; body?: unknown; reload?: string[]; idempotent?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: true; id?: string; data: T } | { ok: false; error: { code: string; message: string } }> {
  const method = opts.method ?? 'POST'
  try {
    let data: T
    try {
      data = await apiFetch<T>(path, { method, body: opts.body, timeoutMs: opts.timeoutMs })
    } catch (e) {
      // 冪等な書込のみ、ネットワーク層の失敗（応答なし = AKO-GEN-NET。コールドスタートのタイムアウト・
      // 接続断等）を 1 回だけ再試行する。非冪等な新規作成（POST）は二重作成の危険があるため再試行しない。
      if (opts.idempotent && apiErrorOf(e).code === 'AKO-GEN-NET') {
        await new Promise(resolve => setTimeout(resolve, 700))
        data = await apiFetch<T>(path, { method, body: opts.body, timeoutMs: opts.timeoutMs })
      } else {
        throw e
      }
    }
    await Promise.all((opts.reload ?? []).map(name => loadApiCollection(name, true)))
    const id = (data as { id?: string } | null | undefined)?.id
    return { ok: true, ...(id ? { id } : {}), data }
  } catch (e) {
    return { ok: false, error: apiErrorOf(e) }
  }
}

/** API モード時に API が SoT となるコレクション（tbl() が API キャッシュを返す） */
export function isMigratedCollection(name: string): boolean {
  return name in MIGRATED_MASTERS || name in CUSTOM_COLLECTION_ENDPOINTS || name === 'auditLogs'
}

export function apiEntityOf(name: string): string {
  return MIGRATED_MASTERS[name] ?? name
}

const stores = new Map<string, Ref<unknown[]>>()
const loadedCollections = new Set<string>()
const inflight = new Map<string, Promise<void>>()

/** コレクションストアの取得（なければ作成）。apiCollection / loadApiCollection の両入口で共有する */
function ensureStore(name: string): Ref<unknown[]> {
  let store = stores.get(name)
  if (!store) {
    store = ref<unknown[]>([])
    stores.set(name, store)
  }
  return store
}

/** コレクションのリアクティブキャッシュ（初回アクセスで遅延ロード） */
export function apiCollection<T>(name: string): Ref<T[]> {
  const store = ensureStore(name)
  void loadApiCollection(name)
  return store as Ref<T[]>
}

export async function loadApiCollection(name: string, force = false): Promise<void> {
  if (!force && (loadedCollections.has(name) || inflight.has(name))) return inflight.get(name)
  const promise = (async () => {
    try {
      const rows = name === 'auditLogs'
        ? await apiFetch<unknown[]>('/v1/configs/audit-logs', { query: { limit: '200' } })
        : name in CUSTOM_COLLECTION_ENDPOINTS
          ? await apiFetch<unknown[]>(CUSTOM_COLLECTION_ENDPOINTS[name]!)
          : await apiFetch<unknown[]>(`/v1/masters/${MIGRATED_MASTERS[name]}`, { query: { includeInactive: '1' } })
      // ストア未作成でも必ず作成して格納する。従来は tbl() 未アクセスのコレクションを先に
      // ロードすると結果が捨てられ「ロード済み・中身は空」で固定される実バグがあった
      // （オペレーター報告 2026-07-18 #2「会社について答えられない」の根本原因）
      ensureStore(name).value = rows
      loadedCollections.add(name)
    } catch {
      // 未認証・権限なし・ネットワーク断は空のまま（ログイン後に resetApiData() で再取得）
    } finally {
      inflight.delete(name)
    }
  })()
  inflight.set(name, promise)
  return promise
}

// ---------- キー単位の一度きりロード（ドメイン別キャッシュ共通ヘルパー） ----------

const onceLoaded = new Set<string>()
const onceInflight = new Map<string, Promise<void>>()

/**
 * キー単位の遅延ロード（同一キーは一度だけ。force で取り直し）。
 * 失敗は握りつぶしてキーを未ロードに戻す（再訪・resetApiData で再試行）。
 */
export function apiLoadOnce(key: string, fetcher: () => Promise<void>, force = false): Promise<void> {
  if (!force && (onceLoaded.has(key) || onceInflight.has(key))) {
    return onceInflight.get(key) ?? Promise.resolve()
  }
  const p = fetcher()
    .then(() => { onceLoaded.add(key) })
    .catch(() => { onceLoaded.delete(key) })
    .finally(() => { onceInflight.delete(key) })
  onceInflight.set(key, p)
  return p
}

/**
 * 認証確立後・ログイン切替後の再取得フック。
 * useApi 管轄外のキャッシュ（通知・日報等のドメイン別キャッシュ）はここに登録する。
 */
const resetHooks: (() => void)[] = []
export function onApiReset(hook: () => void): void {
  resetHooks.push(hook)
}

/** 認証確立後・ログイン切替後にコレクションを取り直す */
export function resetApiData(): void {
  loadedCollections.clear()
  onceLoaded.clear()
  for (const name of stores.keys()) void loadApiCollection(name, true)
  for (const hook of resetHooks) hook()
}

/**
 * ログアウト時の破棄（値のクリアのみで再取得しない = サインアウト後に未認証リクエストを発生させない。
 * 次のログイン確立時に resetApiData() が取り直す）
 */
export function clearApiData(): void {
  loadedCollections.clear()
  onceLoaded.clear()
  for (const store of stores.values()) store.value = []
  for (const hook of resetHooks) hook()
}

/** 変更 API のレスポンス行をキャッシュへ反映する（SoT 書込 → キャッシュ更新の順序。原則6） */
export function setApiRow(name: string, row: { id: string }): void {
  const store = stores.get(name)
  if (!store) return
  const rows = store.value as { id: string }[]
  const idx = rows.findIndex(r => r.id === row.id)
  store.value = idx >= 0 ? [...rows.slice(0, idx), row, ...rows.slice(idx + 1)] : [...rows, row]
}

export function patchApiRow(name: string, id: string, patch: Record<string, unknown>): void {
  const store = stores.get(name)
  if (!store) return
  store.value = (store.value as { id: string }[]).map(r => (r.id === id ? { ...r, ...patch } : r))
}

export function removeApiRow(name: string, id: string): void {
  const store = stores.get(name)
  if (!store) return
  store.value = (store.value as { id: string }[]).filter(r => r.id !== id)
}
