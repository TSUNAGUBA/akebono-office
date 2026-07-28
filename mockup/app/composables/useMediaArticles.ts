/**
 * AI 記事生成スタジオ（目的・記事の質・雰囲気を指定して生成 / 過去分析からの生成 / 採用・取消）。
 * - 生成は決定的（shared/domain/media-article）。本実装では Vertex AI 呼び出しに置き換わる
 * - 生成物（generatedArticles）と依頼（articleBriefs）を保管。生成物は論理削除で取消・復元できる（原則9.5）
 * - 採用（採用ボタン）でサイトのコンテンツ資産（mediaArticles）へ登録 → 分析の入力に加わる。採用の取消も可
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
  /** 過去分析から生成する場合の参照（MediaInsightRecord.id） */
  fromInsightId?: string | null
}

export interface BriefSuggestion {
  topic: string
  keyword: string
  purpose: ArticlePurpose
  fromInsightId: string
  hint: string
}

export function useMediaArticles() {
  const { tbl, commit, nextId } = useMockDb()
  const briefsTbl = tbl('articleBriefs')
  const genTbl = tbl('generatedArticles')
  const articlesTbl = tbl('mediaArticles')
  const { currentUser } = useCurrentUser()
  const { segmentById } = useCurrentSegment()
  const { settingFor } = useMediaSettings()
  const { getById } = useMediaInsight()

  /** セグメントの生成記事（既定は有効分のみ。取消済みも含めるなら includeInactive） */
  function generatedFor(segmentId: string, includeInactive = false): GeneratedArticle[] {
    return (genTbl.value as GeneratedArticle[])
      .filter(g => g.segmentId === segmentId && (includeInactive || g.active !== false))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** 過去の分析（保管済みメディアインサイト）から記事のお題を提案する */
  function suggestionFromInsight(segmentId: string): BriefSuggestion | null {
    // scope='media' の保管レコードを取得
    const rec = (tbl('mediaInsights').value as { id: string; segmentId: string; scope: string; insight: unknown }[])
      .find(r => r.segmentId === segmentId && r.scope === 'media')
    if (!rec) return null
    const insight = rec.insight as MediaInsight
    const opp = [...insight.articles, ...insight.siteStructure].find(f => f.kind === 'opportunity')
      ?? insight.articles[0] ?? insight.siteStructure[0]
    if (!opp) return null
    const setting = settingFor(segmentId)
    const keyword = setting?.keywords[0] ?? ''
    return {
      topic: opp.title.replace(/^[^:：「]*[:：]\s*/, '').replace(/[「」]/g, '').slice(0, 40),
      keyword,
      purpose: setting?.analysisGoal === 'conversion' ? 'conversion' : setting?.analysisGoal === 'leadgen' ? 'leadgen' : 'seo',
      fromInsightId: rec.id,
      hint: opp.detail,
    }
  }

  /** インサイトからヒント文（生成の前提に添える）を取り出す */
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

  /** 記事を生成して保管する（依頼 + 生成物）。決定的 = 同じ入力なら同じ結果 */
  function generate(segmentId: string, req: ArticleGenRequest): { ok: boolean; article?: GeneratedArticle; error?: { code: string; message: string } } {
    const seg = segmentById(segmentId)
    if (!seg) return { ok: false, error: { code: 'AKO-MEDIA-010', message: '対象セグメントが見つかりません' } }
    if (!req.topic.trim() && !req.keyword.trim()) {
      return { ok: false, error: { code: 'AKO-MEDIA-011', message: 'お題またはキーワードを入力してください' } }
    }
    const setting = settingFor(segmentId)
    const audience = (req.audience ?? '').trim() || setting?.targetAudience || '読者'
    const brief: ArticleBrief = {
      id: nextId('articleBriefs', 'ab'),
      segmentId,
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
      audience, siteName: setting?.siteName ?? seg.name, segmentName: seg.name,
      insightHints: hintsFromInsight(brief.fromInsightId),
    }
    const draft = generateArticleDraft(genInput)
    const article: GeneratedArticle = {
      ...draft,
      id: nextId('generatedArticles', 'ga'),
      segmentId,
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

  /** 生成記事をサイトのコンテンツ資産へ採用する（分析の入力に加わる）。採用済みは二重採用しない */
  function adopt(generatedArticleId: string, section = 'ブログ'): { ok: boolean; error?: { code: string; message: string } } {
    const g = (genTbl.value as GeneratedArticle[]).find(x => x.id === generatedArticleId)
    if (!g || g.active === false) return { ok: false, error: { code: 'AKO-MEDIA-012', message: '対象の生成記事が見つかりません' } }
    if (g.adoptedArticleId) return { ok: false, error: { code: 'AKO-MEDIA-013', message: 'この記事は既に採用済みです' } }
    const articleId = nextId('mediaArticles', 'ma')
    const newArticle: MediaArticle = {
      id: articleId,
      segmentId: g.segmentId,
      path: `/blog/gen-${articleId}`,
      title: g.title,
      section,
      publishedAt: todayJst(),
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
  function unadopt(generatedArticleId: string): { ok: boolean; error?: { code: string; message: string } } {
    const g = (genTbl.value as GeneratedArticle[]).find(x => x.id === generatedArticleId)
    if (!g || !g.adoptedArticleId) return { ok: false, error: { code: 'AKO-MEDIA-014', message: '採用されていません' } }
    articlesTbl.value = (articlesTbl.value as MediaArticle[]).map(a => a.id === g.adoptedArticleId ? { ...a, active: false } : a)
    genTbl.value = (genTbl.value as GeneratedArticle[]).map(x => x.id === g.id ? { ...x, adoptedArticleId: null } : x)
    commit()
    return { ok: true }
  }

  /** 生成記事を取り消す（論理削除。採用済みなら採用も取り消してから） */
  function remove(generatedArticleId: string): { ok: boolean } {
    const g = (genTbl.value as GeneratedArticle[]).find(x => x.id === generatedArticleId)
    if (g?.adoptedArticleId) unadopt(generatedArticleId)
    genTbl.value = (genTbl.value as GeneratedArticle[]).map(x => x.id === generatedArticleId ? { ...x, active: false } : x)
    commit()
    return { ok: true }
  }

  /** 取消した生成記事を復元する */
  function restore(generatedArticleId: string): { ok: boolean } {
    genTbl.value = (genTbl.value as GeneratedArticle[]).map(x => x.id === generatedArticleId ? { ...x, active: true } : x)
    commit()
    return { ok: true }
  }

  return { generatedFor, suggestionFromInsight, generate, adopt, unadopt, remove, restore }
}
