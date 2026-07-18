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

// ---------- HTTP ----------

export interface ApiCallError extends Error {
  code: string
}

/** API 呼び出し（{ data } を展開して返す。失敗は code 付き Error を throw） */
export async function apiFetch<T = unknown>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const config = apiPublicConfig()
  const headers: Record<string, string> = {}
  if (config.devMemberId) {
    headers['x-dev-member-id'] = config.devMemberId
  } else {
    const token = await getFirebaseIdToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }
  try {
    const res = await $fetch<{ data: T }>(path, {
      baseURL: config.apiBase,
      method: opts.method ?? 'GET',
      body: opts.body as Record<string, unknown> | undefined,
      query: opts.query,
      headers,
    })
    return res.data
  } catch (e) {
    const data = (e as { data?: { error?: { code?: string; message?: string } } }).data
    const error = new Error(data?.error?.message ?? 'API との通信に失敗しました。ネットワークをご確認ください') as ApiCallError
    error.code = data?.error?.code ?? 'AKO-GEN-NET'
    throw error
  }
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
  workflowRoutes: 'workflow-routes',
  decisionThemes: 'decision-themes',
  permissionRules: 'permission-rules',
  aiRoles: 'ai-roles',
  aiEmployees: 'ai-employees',
}

/** API モード時に API が SoT となるコレクション（tbl() が API キャッシュを返す） */
export function isMigratedCollection(name: string): boolean {
  return name in MIGRATED_MASTERS || name === 'auditLogs'
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
