/**
 * AI 記事生成スタジオ（目的・記事の質・雰囲気を指定して生成 / 過去分析からの生成 / 採用・取消）。
 * メディアチャンネル単位（channelId で keying）。
 *
 * デュアルモード:
 * - モック: 決定的生成（shared/domain/media-article）+ モックコレクション（articleBriefs / generatedArticles）
 * - API: SoT はサーバー（media_article_briefs / media_generated_articles。POST /v1/media/articles/generate =
 *   Vertex AI → 失敗時は同じ決定的生成へサーバー側フォールバック。llm フラグで区別）。
 *   採用・取消・復元もサーバー（トランザクション + 論理削除）。SoT 書込 → キャッシュ再取得の順序（原則6）
 * - 生成物は論理削除で取消・復元できる（原則9.5）。採用でサイトのコンテンツ資産（記事インベントリ）へ登録
 */
import type { MediaInsight } from '../../../shared/domain/media-insight'
import {
  generateArticleDraft, type ArticleGenInput, type ArticlePurpose, type ArticleQuality, type ArticleTone,
} from '../../../shared/domain/media-article'
import type { ArticleBrief, GeneratedArticle, MediaArticle } from '~/types/media'

export interface ArticleGenRequest {
  topic: string
  keyword: string
  purpose: ArticlePurpose
  quality: ArticleQuality
  tone: ArticleTone
  audience?: string
  /** 過去分析から生成する場合の参照（保管済みメディアインサイトの id） */
  fromInsightId?: string | null
}

export interface BriefSuggestion {
  topic: string
  keyword: string
  purpose: ArticlePurpose
  fromInsightId: string
  hint: string
}

// ---------- API モードのキャッシュ（channelId → 生成物全件。取消済み含む） ----------

const apiGenerated = ref<Record<string, GeneratedArticle[]>>({})

function loadApiGenerated(channelId: string, force = false): Promise<void> {
  if (!channelId) return Promise.resolve()
  return apiLoadOnce(`media:generated:${channelId}`, async () => {
    const rows = await apiFetch<GeneratedArticle[]>('/v1/media/generated', { query: { channelId } })
    apiGenerated.value = { ...apiGenerated.value, [channelId]: rows }
  }, force)
}

onApiReset(() => { apiGenerated.value = {} })

export function useMediaArticles() {
  const { tbl, commit, nextId } = useMockDb()
  const briefsTbl = tbl('articleBriefs')
  const genTbl = tbl('generatedArticles')
  const articlesTbl = tbl('mediaArticles')
  const { currentUser } = useCurrentUser()
  const { settingFor } = useMediaChannels()
  const { getById, storedMedia } = useMediaInsight()
  const analytics = useMediaAnalytics()
  const isApi = useApiMode()

  /** チャンネルの生成記事（既定は有効分のみ。取消済みも含めるなら includeInactive） */
  function generatedFor(channelId: string, includeInactive = false): GeneratedArticle[] {
    const rows = isApi
      ? (void loadApiGenerated(channelId), apiGenerated.value[channelId] ?? [])
      : (genTbl.value as GeneratedArticle[]).filter(g => g.channelId === channelId)
    return rows
      .filter(g => includeInactive || g.active !== false)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** 過去の分析（保管済みメディアインサイト）から記事のお題を提案する（両モード = storedMedia が SoT を吸収） */
  function suggestionFromInsight(channelId: string): BriefSuggestion | null {
    const rec = storedMedia(channelId)
    if (!rec) return null
    const insight = rec.insight
    const opp = [...insight.articles, ...insight.siteStructure].find(f => f.kind === 'opportunity')
      ?? insight.articles[0] ?? insight.siteStructure[0]
    if (!opp) return null
    const setting = settingFor(channelId)
    const keyword = setting?.keywords[0] ?? ''
    return {
      topic: opp.title.replace(/^[^:：「]*[:：]\s*/, '').replace(/[「」]/g, '').slice(0, 40),
      keyword,
      purpose: setting?.analysisGoal === 'conversion' ? 'conversion' : setting?.analysisGoal === 'leadgen' ? 'leadgen' : 'seo',
      fromInsightId: rec.id,
      hint: opp.detail,
    }
  }

  /** インサイトからヒント文を取り出す（モック生成用。API モードはサーバーが from_insight_id から抽出する） */
  function hintsFromInsight(insightId: string | null | undefined): string[] {
    if (!insightId) return []
    const rec = getById(insightId)
    if (!rec || rec.scope !== 'media') return []
    const insight = rec.insight as MediaInsight
    return [...insight.articles, ...insight.siteStructure]
      .filter(f => f.kind === 'opportunity' || f.kind === 'issue')
      .map(f => f.title)
      .slice(0, 3)
  }

  /**
   * 記事を生成して保管する（依頼 + 生成物）。
   * モック = 決定的（同じ入力なら同じ結果）/ API = Vertex AI → 失敗時サーバー側で決定的生成
   */
  async function generate(channelId: string, req: ArticleGenRequest): Promise<{ ok: boolean; article?: GeneratedArticle; error?: { code: string; message: string } }> {
    const channel = settingFor(channelId)
    if (!channel) return { ok: false, error: { code: 'AKO-MEDIA-021', message: '対象のメディアチャンネルが見つかりません' } }
    if (!req.topic.trim() && !req.keyword.trim()) {
      return { ok: false, error: { code: 'AKO-MEDIA-011', message: 'お題またはキーワードを入力してください' } }
    }
    if (isApi) {
      try {
        const article = await apiFetch<GeneratedArticle>('/v1/media/articles/generate', {
          method: 'POST',
          body: {
            channelId,
            topic: req.topic, keyword: req.keyword,
            purpose: req.purpose, quality: req.quality, tone: req.tone,
            audience: req.audience ?? '',
            fromInsightId: req.fromInsightId ?? null,
            // チャンネル名は表示・文面用途で渡す
            segmentName: channel.name,
          },
          timeoutMs: 60_000, // LLM 記事生成（既定 15s では正常応答を打ち切る = レビュー R1）
        })
        apiGenerated.value = {
          ...apiGenerated.value,
          [channelId]: [article, ...(apiGenerated.value[channelId] ?? [])],
        }
        return { ok: true, article }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const audience = (req.audience ?? '').trim() || channel.targetAudience || '読者'
    const brief: ArticleBrief = {
      id: nextId('articleBriefs', 'ab'),
      channelId,
      topic: req.topic.trim(),
      keyword: req.keyword.trim(),
      purpose: req.purpose, quality: req.quality, tone: req.tone,
      audience,
      fromInsightId: req.fromInsightId ?? null,
      createdAt: nowJstIso(),
      createdBy: currentUser.value.id,
    }
    const genInput: ArticleGenInput = {
      topic: brief.topic, keyword: brief.keyword,
      purpose: brief.purpose, quality: brief.quality, tone: brief.tone,
      audience, siteName: channel.siteName || channel.name, segmentName: channel.name,
      insightHints: hintsFromInsight(brief.fromInsightId),
    }
    const draft = generateArticleDraft(genInput)
    const article: GeneratedArticle = {
      ...draft,
      id: nextId('generatedArticles', 'ga'),
      channelId,
      briefId: brief.id,
      createdAt: brief.createdAt,
      createdBy: currentUser.value.id,
      adoptedArticleId: null,
      active: true,
    }
    briefsTbl.value = [...briefsTbl.value, brief]
    genTbl.value = [...genTbl.value, article]
    commit()
    return { ok: true, article }
  }

  /** API: 変更系の後にサーバー SoT からキャッシュを取り直す（生成物 + インベントリ + GA 集計） */
  async function refreshAfterMutation(channelId: string): Promise<void> {
    await Promise.all([
      loadApiGenerated(channelId, true),
      loadMediaArticles(channelId, true),
    ])
    void analytics.refreshMetrics(channelId, 28)
  }

  /** 生成記事をサイトのコンテンツ資産へ採用する（分析の入力に加わる） */
  async function adopt(generatedArticleId: string, section = 'ブログ'): Promise<{ ok: boolean; warning?: string; error?: { code: string; message: string } }> {
    if (isApi) {
      const g = Object.values(apiGenerated.value).flat().find(x => x.id === generatedArticleId)
      try {
        const r = await apiFetch<{ id: string; articleId: string; warning?: string }>(
          `/v1/media/generated/${generatedArticleId}/adopt`, { method: 'POST', body: { section } })
        if (g) await refreshAfterMutation(g.channelId)
        return { ok: true, warning: r.warning }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const g = (genTbl.value as GeneratedArticle[]).find(x => x.id === generatedArticleId)
    if (!g || g.active === false) return { ok: false, error: { code: 'AKO-MEDIA-012', message: '対象の生成記事が見つかりません' } }
    if (g.adoptedArticleId) return { ok: false, error: { code: 'AKO-MEDIA-013', message: 'この記事は既に採用済みです' } }
    const articleId = nextId('mediaArticles', 'ma')
    const newArticle: MediaArticle = {
      id: articleId,
      channelId: g.channelId,
      path: `/blog/gen-${articleId}`,
      title: g.title,
      section,
      // 分析の集計基準は前日（asOf）。採用直後にその期間へ入るよう公開日を前日にする
      publishedAt: addDays(todayJst(), -1),
      wordCount: g.estWordCount,
      status: 'published',
      origin: 'generated',
      generatedArticleId: g.id,
      active: true,
    }
    articlesTbl.value = [...articlesTbl.value, newArticle]
    genTbl.value = (genTbl.value as GeneratedArticle[]).map(x => x.id === g.id ? { ...x, adoptedArticleId: articleId } : x)
    commit()
    return { ok: true }
  }

  /** 採用を取り消す（原則9.5。採用で作った資産を論理削除し、生成記事の採用リンクを解除） */
  async function unadopt(generatedArticleId: string): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    if (isApi) {
      const g = Object.values(apiGenerated.value).flat().find(x => x.id === generatedArticleId)
      const res = await apiResult(() => apiFetch(`/v1/media/generated/${generatedArticleId}/unadopt`, { method: 'POST' }))
      if (res.ok && g) await refreshAfterMutation(g.channelId)
      return res
    }
    const g = (genTbl.value as GeneratedArticle[]).find(x => x.id === generatedArticleId)
    if (!g || !g.adoptedArticleId) return { ok: false, error: { code: 'AKO-MEDIA-014', message: '採用されていません' } }
    articlesTbl.value = (articlesTbl.value as MediaArticle[]).map(a => a.id === g.adoptedArticleId ? { ...a, active: false } : a)
    genTbl.value = (genTbl.value as GeneratedArticle[]).map(x => x.id === g.id ? { ...x, adoptedArticleId: null } : x)
    commit()
    return { ok: true }
  }

  /** 生成記事を取り消す（論理削除。採用済みなら採用も取り消してから） */
  async function remove(generatedArticleId: string): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    if (isApi) {
      const g = Object.values(apiGenerated.value).flat().find(x => x.id === generatedArticleId)
      const res = await apiResult(() => apiFetch(`/v1/media/generated/${generatedArticleId}/remove`, { method: 'POST' }))
      if (res.ok && g) await refreshAfterMutation(g.channelId)
      return res
    }
    const g = (genTbl.value as GeneratedArticle[]).find(x => x.id === generatedArticleId)
    if (g?.adoptedArticleId) await unadopt(generatedArticleId)
    genTbl.value = (genTbl.value as GeneratedArticle[]).map(x => x.id === generatedArticleId ? { ...x, active: false } : x)
    commit()
    return { ok: true }
  }

  /** 取消した生成記事を復元する */
  async function restore(generatedArticleId: string): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    if (isApi) {
      const g = Object.values(apiGenerated.value).flat().find(x => x.id === generatedArticleId)
      const res = await apiResult(() => apiFetch(`/v1/media/generated/${generatedArticleId}/restore`, { method: 'POST' }))
      if (res.ok && g) await loadApiGenerated(g.channelId, true)
      return res
    }
    genTbl.value = (genTbl.value as GeneratedArticle[]).map(x => x.id === generatedArticleId ? { ...x, active: true } : x)
    commit()
    return { ok: true }
  }

  return { generatedFor, suggestionFromInsight, generate, adopt, unadopt, remove, restore }
}
