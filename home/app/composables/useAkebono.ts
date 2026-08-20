/**
 * AKEBONO（F-03）要望ボックス
 * - 要望は記録系（追記のみ・巻き戻し禁止）。編集・削除は設けない
 * - デュアルモード（バッチ6d）: モック = akebonoWishes（localStorage）/ API = /v1/akebono/wishes が SoT。
 *   API モードは書込 → キャッシュ取り直し（原則6）。可視性はモックと同一（社内 C2 = 全員参照可）
 * - プレースホルダ（要件定義中バナー・構想ロードマップ）は静的表示のためページ側の責務
 */
import type { AkebonoWish, Result } from '~/types/domain'

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiWishes = ref<AkebonoWish[]>([])

function loadWishes(force = false): Promise<void> {
  return apiLoadOnce('akebono:wishes', async () => {
    apiWishes.value = await apiFetch<AkebonoWish[]>('/v1/akebono/wishes')
  }, force)
}

onApiReset(() => {
  apiWishes.value = []
})

export function useAkebono() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const akebonoWishes = isApi ? apiWishes : tbl('akebonoWishes')
  if (isApi) void loadWishes()

  /** 要望の取り直し（ページ表示時に呼ぶ。他メンバーの投稿の取り込み） */
  async function refresh(): Promise<void> {
    if (!isApi) return
    await loadWishes(true)
  }

  /** 要望一覧（新しい順） */
  const wishes = computed<AkebonoWish[]>(() =>
    [...akebonoWishes.value].sort((a, b) => b.at.localeCompare(a.at)))

  /** 要望の投稿（追記のみ。API はサーバーが必須検証 = AKO-AKB-001） */
  async function submitWish(body: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch<{ id: string }>('/v1/akebono/wishes', {
        method: 'POST', body: { body },
      }))
      if (res.ok) await loadWishes(true)
      return res
    }
    const trimmed = body.trim()
    if (!trimmed) {
      return { ok: false, error: { code: 'AKO-AKB-001', message: '要望を入力してください' } }
    }
    const id = nextId('akebonoWishes', 'aw')
    akebonoWishes.value = [...akebonoWishes.value, {
      id,
      memberId: currentUser.value.id,
      body: trimmed,
      at: nowJstIso(),
    }]
    commit()
    return { ok: true, id }
  }

  return { wishes, submitWish, refresh }
}
