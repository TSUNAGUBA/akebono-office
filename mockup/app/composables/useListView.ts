/**
 * 一覧の検索 + ページング共通コントローラ（開発原則3: 横展開の唯一の実装）。
 *
 * デュアルモード:
 * - モックモード / fetch 未指定: `source`（全件の反応性配列）を **クライアント側**で絞込・ページング。
 * - API モードかつ `fetch` 指定: `q/limit/offset` を渡して **サーバー側**でページング（total はサーバー総件数）。
 *   同一の呼び出しで両モードに対応するため、ページ側は `source`（モック用）と `fetch`（API 用）の
 *   両方を渡す。API モードでは source を参照しない = 全件ハイドレーションを誘発しない。
 *
 * 設計上の注意:
 * - サーバー取得は検索語をデバウンス（250ms）。ページ/件数変更は即時。
 * - 遅延応答は seq ガードで破棄し「最新の要求のみ反映」（取り違え防止）。
 * - 取得失敗は非ブロッキング（直前の内容を保持 = 原則4）。
 * - 検索語・表示件数を変えたら 1 ページ目へ戻す（両モード共通）。
 */
import type { Ref } from 'vue'

export interface ListPageParams {
  /** trim 済みの検索語（'' = 検索なし） */
  q: string
  limit: number
  offset: number
}

export interface UseListViewOptions<T> {
  /** クライアント側の全件ソース（モックモード / fetch 未指定時に使用） */
  source?: Ref<T[]>
  /** クライアント側検索の一致判定（q は trim + 小文字化済み。未指定なら検索ボックスは全件通過） */
  match?: (row: T, q: string) => boolean
  /** API モードのページ取得（指定かつ API モードのときサーバーページングになる） */
  fetch?: (params: ListPageParams) => Promise<{ rows: T[]; total: number }>
  /** 1 ページの既定表示件数（既定 20） */
  pageSize?: number
}

export interface ListView<T> {
  /** 検索ボックスの v-model */
  query: Ref<string>
  /** 現在ページ（1 始まり） */
  page: Ref<number>
  /** 1 ページの表示件数 */
  pageSize: Ref<number>
  /** 現在ページの行 */
  rows: Ref<T[]>
  /** 現在の検索条件での総件数 */
  total: Ref<number>
  /** 総ページ数（最低 1） */
  pageCount: Ref<number>
  /** サーバー取得中か（サーバーモードのみ true になりうる） */
  loading: Ref<boolean>
  /** サーバーページングで動作しているか */
  isServer: boolean
  /** 検索語クリア + 1 ページ目へ */
  reset: () => void
  /** サーバーモードで再取得（書込後の反映などに使う。クライアントは自動追従のため no-op） */
  refresh: () => void
}

export function useListView<T>(opts: UseListViewOptions<T>): ListView<T> {
  const isServer = Boolean(opts.fetch) && useApiMode()
  const query = ref('')
  const page = ref(1)
  const pageSize = ref(opts.pageSize ?? 20)

  // ---- クライアントモード ----
  const clientFiltered = computed<T[]>(() => {
    const src = opts.source?.value ?? []
    const q = query.value.trim().toLowerCase()
    if (!q || !opts.match) return src
    return src.filter(r => opts.match!(r, q))
  })
  const clientRows = computed<T[]>(() => {
    const start = (page.value - 1) * pageSize.value
    return clientFiltered.value.slice(start, start + pageSize.value)
  })

  // ---- サーバーモード ----
  const serverRows = ref<T[]>([]) as Ref<T[]>
  const serverTotal = ref(0)
  const loading = ref(false)
  let seq = 0
  let debounceT: ReturnType<typeof setTimeout> | null = null

  async function doFetch(): Promise<void> {
    if (!opts.fetch) return
    const my = ++seq
    loading.value = true
    try {
      const res = await opts.fetch({
        q: query.value.trim(),
        limit: pageSize.value,
        offset: (page.value - 1) * pageSize.value,
      })
      if (my !== seq) return // 遅延応答は破棄（最新のみ反映）
      serverRows.value = res.rows
      serverTotal.value = res.total
    } catch {
      // 取得失敗は非ブロッキング（直前の内容を保持 = 原則4）
    } finally {
      if (my === seq) loading.value = false
    }
  }

  if (isServer) {
    // 1 ページ目へ戻して取得する。page が既に 1 なら watch が発火しないので直接取得し、
    // そうでなければ page=1 の変更で page watch 経由の取得に一本化する（二重取得を作らない）。
    const resetAndFetch = (): void => {
      if (page.value === 1) void doFetch()
      else page.value = 1
    }
    // 検索語はデバウンス
    watch(query, () => {
      if (debounceT) clearTimeout(debounceT)
      debounceT = setTimeout(resetAndFetch, 250)
    })
    // 件数変更は 1 ページ目へ戻して取得
    watch(pageSize, resetAndFetch)
    // ページ送り（および resetAndFetch による page=1 変更）で取得
    watch(page, () => { void doFetch() })
    void doFetch() // 初回
  } else {
    // クライアント: 検索・件数変更で 1 ページ目へ。ソース縮小時のページはみ出しを補正
    watch([query, pageSize], () => { page.value = 1 })
    watch(clientFiltered, () => {
      const pc = Math.max(1, Math.ceil(clientFiltered.value.length / pageSize.value))
      if (page.value > pc) page.value = pc
    })
  }

  const rows = computed<T[]>(() => (isServer ? serverRows.value : clientRows.value))
  const total = computed(() => (isServer ? serverTotal.value : clientFiltered.value.length))
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

  function reset(): void {
    query.value = ''
    if (!isServer) page.value = 1
    // サーバー: query watch のデバウンス経由で page=1 + 取得（既に '' なら変化なし）
  }
  function refresh(): void {
    if (isServer) void doFetch()
  }

  return { query, page, pageSize, rows, total, pageCount, loading, isServer, reset, refresh }
}
