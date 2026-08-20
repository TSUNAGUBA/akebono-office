/**
 * 外部投稿記事（media インサイト生成の材料）。外部媒体・SNS 等へ投稿した記事の原文を保管し、
 * AI 分析（media インサイト生成）に活用する（新機能。2026-08-03）。
 *
 * デュアルモード:
 * - モック: mediaExternalArticles コレクションが SoT
 * - API: SoT はサーバー（media_external_articles。GET/POST/PATCH /v1/media/external-articles・
 *   POST /:id/archive|restore）。channelId で keying。
 * - 取消可能性（原則9.5）: 論理削除で取消・復元できる
 */
import type { Result } from '~/types/domain'
import type { MediaExternalArticle } from '~/types/media'

export interface ExternalArticleInput {
  title: string
  url?: string
  source?: string
  publishedAt?: string | null
  body: string
  notes?: string
}

// ---------- API モードのキャッシュ（channelId → 取消済み含む全件） ----------

const apiExternal = ref<Record<string, MediaExternalArticle[]>>({})

function loadApiExternal(channelId: string, force = false): Promise<void> {
  if (!channelId) return Promise.resolve()
  return apiLoadOnce(`media:external:${channelId}`, async () => {
    const rows = await apiFetch<MediaExternalArticle[]>('/v1/media/external-articles', {
      query: { channelId, includeInactive: '1' },
    })
    apiExternal.value = { ...apiExternal.value, [channelId]: rows }
  }, force)
}

onApiReset(() => { apiExternal.value = {} })

/** 入力検証（title / body 必須・publishedAt は空可・YYYY-MM-DD）。両モード共通（API 側でも再検証される） */
function validate(input: ExternalArticleInput): { code: string; message: string } | null {
  if (!input.title.trim()) return { code: 'AKO-MEDIA-023', message: 'タイトルを入力してください' }
  if (!input.body.trim()) return { code: 'AKO-MEDIA-023', message: '記事の原文（本文）を入力してください' }
  const pub = (input.publishedAt ?? '').trim()
  if (pub && !/^\d{4}-\d{2}-\d{2}$/.test(pub)) return { code: 'AKO-MEDIA-023', message: 'publishedAt は YYYY-MM-DD 形式で指定してください' }
  return null
}

export function useMediaExternalArticles() {
  const { tbl, commit, nextId } = useMockDb()
  const externalTbl = tbl('mediaExternalArticles')
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()

  /** チャンネルの外部投稿記事（既定は有効分のみ。取消済みも含めるなら includeInactive） */
  function listFor(channelId: string, includeInactive = false): MediaExternalArticle[] {
    const rows = isApi
      ? (void loadApiExternal(channelId), apiExternal.value[channelId] ?? [])
      : (externalTbl.value as MediaExternalArticle[]).filter(x => x.channelId === channelId)
    return rows
      .filter(x => includeInactive || x.active !== false)
      .sort((a, b) => ((a.publishedAt ?? a.createdAt) < (b.publishedAt ?? b.createdAt) ? 1 : -1))
  }

  /** 追加（管理者のみ = 画面ゲート + API requireAdmin） */
  async function add(channelId: string, input: ExternalArticleInput): Promise<{ ok: boolean; article?: MediaExternalArticle; error?: { code: string; message: string } }> {
    const invalid = validate(input)
    if (invalid) return { ok: false, error: invalid }
    if (isApi) {
      try {
        const article = await apiFetch<MediaExternalArticle>('/v1/media/external-articles', {
          method: 'POST',
          body: {
            channelId, title: input.title.trim(), url: (input.url ?? '').trim(),
            source: (input.source ?? '').trim(), publishedAt: (input.publishedAt ?? '') || null,
            body: input.body.trim(), notes: (input.notes ?? '').trim(),
          },
        })
        await loadApiExternal(channelId, true)
        return { ok: true, article }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const article: MediaExternalArticle = {
      id: nextId('mediaExternalArticles', 'mx'),
      channelId,
      title: input.title.trim(),
      url: (input.url ?? '').trim(),
      source: (input.source ?? '').trim(),
      publishedAt: (input.publishedAt ?? '') || null,
      body: input.body.trim(),
      notes: (input.notes ?? '').trim(),
      createdAt: nowJstIso(),
      createdBy: currentUser.value.id,
      active: true,
    }
    externalTbl.value = [...externalTbl.value, article]
    commit()
    return { ok: true, article }
  }

  /** 編集（管理者のみ） */
  async function update(id: string, input: ExternalArticleInput): Promise<Result> {
    const invalid = validate(input)
    if (invalid) return { ok: false, error: invalid }
    if (isApi) {
      const g = Object.values(apiExternal.value).flat().find(x => x.id === id)
      try {
        await apiFetch(`/v1/media/external-articles/${id}`, {
          method: 'PATCH',
          body: {
            title: input.title.trim(), url: (input.url ?? '').trim(), source: (input.source ?? '').trim(),
            publishedAt: (input.publishedAt ?? '') || null, body: input.body.trim(), notes: (input.notes ?? '').trim(),
          },
        })
        if (g) await loadApiExternal(g.channelId, true)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    externalTbl.value = (externalTbl.value as MediaExternalArticle[]).map(x => x.id === id
      ? {
          ...x,
          title: input.title.trim(), url: (input.url ?? '').trim(), source: (input.source ?? '').trim(),
          publishedAt: (input.publishedAt ?? '') || null, body: input.body.trim(), notes: (input.notes ?? '').trim(),
        }
      : x)
    commit()
    return { ok: true }
  }

  /** 取消（論理削除） */
  async function archive(id: string): Promise<Result> {
    if (isApi) {
      const g = Object.values(apiExternal.value).flat().find(x => x.id === id)
      const res = await apiResult(() => apiFetch(`/v1/media/external-articles/${id}/archive`, { method: 'POST' }))
      if (res.ok && g) await loadApiExternal(g.channelId, true)
      return res
    }
    externalTbl.value = (externalTbl.value as MediaExternalArticle[]).map(x => x.id === id ? { ...x, active: false } : x)
    commit()
    return { ok: true }
  }

  /** 復元 */
  async function restore(id: string): Promise<Result> {
    if (isApi) {
      const g = Object.values(apiExternal.value).flat().find(x => x.id === id)
      const res = await apiResult(() => apiFetch(`/v1/media/external-articles/${id}/restore`, { method: 'POST' }))
      if (res.ok && g) await loadApiExternal(g.channelId, true)
      return res
    }
    externalTbl.value = (externalTbl.value as MediaExternalArticle[]).map(x => x.id === id ? { ...x, active: true } : x)
    commit()
    return { ok: true }
  }

  return { listFor, add, update, archive, restore }
}
