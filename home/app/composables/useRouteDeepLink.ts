import type { Ref } from 'vue'

/**
 * 通知ディープリンク（?open= / ?task= 等の対象 id クエリ）の共通取り込み（改修依頼 2026-08-18・原則3）。
 * workflow / inbox / ai-company / NotesPanel が同じ「クエリ → 対象を開く → URL から除去」を行うための単一実装。
 *
 * - 初期表示分は onMounted で取り込む（セットアップ中の router.replace は初期ナビゲーションと競合し、
 *   クエリ除去が破棄されて再読込で再度開いてしまうことがある = レビュー指摘）
 * - 滞在中の同一ページ内クエリ変化（通知欄 → 同一ページのディープリンク等）は watch で追従する
 * - 取り込んだら URL からそのクエリだけを除去する（再読込で再度開かない。他のクエリは残す）
 *
 * 使い方:
 *  - 即時に開ける対象（詳細 state に id を入れるだけ）: onValue で直接開く
 *      useRouteDeepLink('open', id => { selectedId.value = id })
 *  - データ到着を待つ対象（API モードの非同期ロード）: pending を監視し、見つかった時点で consume() して開く
 *      const dl = useRouteDeepLink('open')
 *      watchEffect(() => { const t = rows.value.find(r => r.id === dl.pending.value); if (t) { dl.consume(); openDetail(t) } })
 */

type AppRouter = ReturnType<typeof useRouter>
type AppRoute = ReturnType<typeof useRoute>

// 同一 tick に複数のクエリ消去要求（例: /inbox の ?tab= と ?open=）が来ても 1 回の replace に束ねる。
// それぞれが自分のスナップショットから即時 replace すると、後勝ちの replace が相手の消したクエリを
// 復元してしまい、リロードでタブ巻き戻し・モーダル再表示が起きる（レビュー R5）。
const pendingStripParams = new Set<string>()
let stripScheduled = false

function scheduleQueryStrip(router: AppRouter, route: AppRoute, basePath: string, param: string): void {
  pendingStripParams.add(param)
  if (stripScheduled) return
  stripScheduled = true
  void nextTick(() => {
    stripScheduled = false
    const params = [...pendingStripParams]
    pendingStripParams.clear()
    // 束ね待ちの間にページ遷移していたら何もしない（他ページの URL を書き換えない）
    if (route.path !== basePath) return
    const query = { ...route.query }
    let changed = false
    for (const p of params) {
      if (query[p] !== undefined) {
        delete query[p]
        changed = true
      }
    }
    if (changed) void router.replace({ query })
  })
}

export function useRouteDeepLink(param: string, onValue?: (id: string) => void) {
  const route = useRoute()
  const router = useRouter()
  /** 取り込み済み・未消費の対象 id（'' = なし） */
  const pending = ref('')
  // 呼び出し元ページのパス（NotesPanel のような共有コンポーネントは設置ページのパスになる）
  const basePath = route.path

  function take(v: unknown): void {
    if (typeof v !== 'string' || !v.trim()) return
    pending.value = v.trim()
    // URL を汚さない（再読込で再度開かない）。対象クエリのみ除去し、tab 等は残す
    scheduleQueryStrip(router, route, basePath, param)
    onValue?.(pending.value)
  }

  onMounted(() => take(route.query[param]))
  watch(() => route.query[param], (v) => {
    if (route.path === basePath) take(v)
  })

  /** 対象を開き終えたら呼ぶ（データ到着待ちの利用形。多重オープン防止） */
  function consume(): void {
    pending.value = ''
  }

  return { pending, consume }
}

/**
 * ?tab= クエリの取り込み（初期表示 + 滞在中の同一ページ内クエリ変化。改修依頼 2026-08-18・原則3）。
 * 一方向（URL → タブ）の共通実装。shift / inbox のディープリンクタブが対象。
 * タブ操作で URL も書き換える双方向同期が必要なページ（attendance）は従来実装のまま。
 * opts.valid を渡すとその値のみ受け付ける（権限で消えるタブの巻き戻しは呼び出し側の watch が担う）。
 * 取り込み後は ?tab= を URL から除去する（選び直したタブがリロード・タブ復元で巻き戻らない =
 * useRouteDeepLink の ?open= と同じ扱い。除去は初期ナビゲーション完了後 = onMounted 以降・
 * 同一 tick の他クエリ消去とは scheduleQueryStrip で 1 回の replace に束ねる）。
 */
export function useRouteTabSync(tab: Ref<string>, opts?: { valid?: readonly string[] }): void {
  const route = useRoute()
  const router = useRouter()
  const basePath = route.path

  function apply(v: unknown): void {
    if (typeof v !== 'string' || !v) return
    if (!opts?.valid || opts.valid.includes(v)) {
      if (v !== tab.value) tab.value = v
    }
  }
  function strip(): void {
    if (route.query.tab !== undefined) scheduleQueryStrip(router, route, basePath, 'tab')
  }

  // 初期表示: タブはセットアップ時に反映（初回描画のちらつき回避）・URL 除去は onMounted 以降
  apply(route.query.tab)
  onMounted(() => strip())
  watch(() => route.query.tab, (v) => {
    if (route.path !== basePath) return
    apply(v)
    strip()
  })
}
