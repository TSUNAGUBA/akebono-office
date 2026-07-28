/**
 * AI 記事生成（目的・記事の質・雰囲気を指定して記事ドラフトを生成する）。
 * - API（本実装）は Vertex AI（構造化出力）で本文を生成し、LLM 無効・失敗時は本ファイルの
 *   決定的テンプレート合成へフォールバックする（原則4。api/src/routes/media.ts）。モックは決定的合成のみ。
 * - 過去の分析結果（insightHints）を材料に、成果に近いテーマの記事も生成できる。
 * - 生成物は「ドラフト」であり、採用（サイトのコンテンツ資産へ登録）・取消は呼び出し側で管理する（原則9.5）。
 */

/** 記事の目的 */
export type ArticlePurpose = 'awareness' | 'leadgen' | 'nurturing' | 'conversion' | 'seo' | 'branding'
/** 記事の質（生成の深さ・分量） */
export type ArticleQuality = 'draft' | 'standard' | 'premium'
/** 記事の雰囲気（トーン） */
export type ArticleTone = 'formal' | 'friendly' | 'expert' | 'casual' | 'storytelling'

export const ARTICLE_PURPOSES: ArticlePurpose[] = ['awareness', 'leadgen', 'nurturing', 'conversion', 'seo', 'branding']
export const ARTICLE_QUALITIES: ArticleQuality[] = ['draft', 'standard', 'premium']
export const ARTICLE_TONES: ArticleTone[] = ['formal', 'friendly', 'expert', 'casual', 'storytelling']

export interface ArticleGenInput {
  /** お題（空なら keyword / purpose から補完） */
  topic: string
  keyword: string
  purpose: ArticlePurpose
  quality: ArticleQuality
  tone: ArticleTone
  /** ターゲット読者像（設定 or フォーム入力） */
  audience: string
  siteName: string
  segmentName: string
  /** 過去分析からの生成時のヒント（例: 「サービス配下の CVR が高い」） */
  insightHints?: string[]
}

export interface ArticleSectionDraft { heading: string; points: string[] }

export interface GeneratedArticleDraft {
  title: string
  metaDescription: string
  outline: ArticleSectionDraft[]
  /** 本文（マークダウン。UiMarkdown 対応サブセット: 見出し・リスト・引用・強調） */
  body: string
  suggestedKeywords: string[]
  estWordCount: number
  /** 自己評価スコア（0..100。指定の充足度から算出） */
  qualityScore: number
  purpose: ArticlePurpose
  quality: ArticleQuality
  tone: ArticleTone
}

const PURPOSE_LABEL: Record<ArticlePurpose, string> = {
  awareness: '認知拡大', leadgen: 'リード獲得', nurturing: '顧客育成', conversion: 'コンバージョン', seo: 'SEO 強化', branding: 'ブランディング',
}
const QUALITY_LABEL: Record<ArticleQuality, string> = { draft: 'ドラフト', standard: '標準', premium: '高品質' }
const TONE_LABEL: Record<ArticleTone, string> = {
  formal: 'フォーマル', friendly: '親しみやすい', expert: '専門的', casual: 'カジュアル', storytelling: 'ストーリー',
}

export function articlePurposeLabel(p: ArticlePurpose): string { return PURPOSE_LABEL[p] }
export function articleQualityLabel(q: ArticleQuality): string { return QUALITY_LABEL[q] }
export function articleToneLabel(t: ArticleTone): string { return TONE_LABEL[t] }

/** 質 → セクション数・目安分量 */
const QUALITY_SPEC: Record<ArticleQuality, { sections: number; words: number }> = {
  draft: { sections: 3, words: 900 },
  standard: { sections: 5, words: 1800 },
  premium: { sections: 7, words: 3200 },
}

/** 目的別のタイトル雛形（{topic} を差し込む） */
const TITLE_TEMPLATES: Record<ArticlePurpose, (topic: string) => string> = {
  awareness: t => `${t}とは？基礎から分かるやさしい入門ガイド`,
  leadgen: t => `${t}の始め方｜失敗しないためのチェックリスト`,
  nurturing: t => `${t}を成果につなげる実践ステップと運用のコツ`,
  conversion: t => `${t}で成果を出す方法｜導入前に知っておきたいポイント`,
  seo: t => `【徹底解説】${t}の完全ガイド（メリット・手順・注意点）`,
  branding: t => `私たちが考える${t}｜大切にしている価値と取り組み`,
}

/** トーン別の一人称・語尾の味付け */
const TONE_INTRO: Record<ArticleTone, (audience: string, topic: string) => string> = {
  formal: (a, t) => `本稿では、${a}の皆様に向けて「${t}」について体系的に解説いたします。`,
  friendly: (a, t) => `この記事では、${a}のあなたに向けて「${t}」をわかりやすくご紹介します。`,
  expert: (a, t) => `${a}を対象に、「${t}」を実務の観点から掘り下げて解説します。`,
  casual: (a, t) => `今回は「${t}」について、${a}にもサクッと分かるようにまとめてみました。`,
  storytelling: (a, t) => `ある${a}が「${t}」に向き合ったとき、何が起きたのか——その物語から始めます。`,
}

const PURPOSE_SECTIONS: Record<ArticlePurpose, string[]> = {
  awareness: ['{topic}の基本', 'なぜ今{topic}が注目されるのか', 'よくある誤解と正しい理解', '最初の一歩', 'まとめ'],
  leadgen: ['{topic}が解決する課題', '始める前の準備', '導入ステップ', '成功のためのチェックリスト', 'よくある質問', 'お問い合わせ・資料請求'],
  nurturing: ['{topic}運用の全体像', 'つまずきやすいポイント', '成果を出す運用のコツ', '事例に学ぶ改善', '次に取り組むこと'],
  conversion: ['{topic}導入のメリット', '費用対効果の考え方', '導入までの流れ', '他社比較で見る選び方', '導入事例', '無料相談のご案内'],
  seo: ['{topic}とは', '{topic}のメリット・デメリット', '具体的な手順', '注意点とよくある失敗', '関連ツール・比較', 'まとめと次のアクション'],
  branding: ['私たちの考える{topic}', '大切にしている価値観', '具体的な取り組み', 'お客様の声', 'これからのビジョン'],
}

function pointsFor(topic: string, keyword: string): string[] {
  return [
    `${topic}の要点を、${keyword ? `「${keyword}」を軸に` : ''}具体例とともに整理します。`,
    '読者が次に取るべき行動を明確に示します。',
    '専門用語はかみ砕き、根拠となるデータや基準を添えます。',
  ]
}

function toneClose(tone: ArticleTone, purpose: ArticlePurpose, segmentName: string): string {
  const cta = purpose === 'conversion' || purpose === 'leadgen'
    ? `\n\n> ${segmentName}では無料のご相談・資料請求を承っています。お気軽にお問い合わせください。`
    : ''
  const closing: Record<ArticleTone, string> = {
    formal: '以上、ご参考になれば幸いです。',
    friendly: '最後まで読んでいただきありがとうございました！',
    expert: '実務での適用にあたっては、自社の状況に合わせて調整してください。',
    casual: 'それでは、また次の記事で！',
    storytelling: 'あなたの現場でも、この物語の続きが始まりますように。',
  }
  return `\n\n${closing[tone]}${cta}`
}

/** 決定的なハッシュ（キーワード候補の並び等に使う） */
function hashStr(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

/**
 * 自己評価スコア（0..100）: 質ベース + 指定の充足（topic/keyword/audience/hints）。
 * LLM 生成時もスコアはこの決定的式で付与する（LLM の自己申告に依存しない = API と共有。原則3）
 */
export function articleQualityScore(input: ArticleGenInput): number {
  const qualityBase = { draft: 55, standard: 72, premium: 86 }[input.quality]
  const bonus = (input.topic.trim() ? 4 : 0) + (input.keyword.trim() ? 4 : 0)
    + (input.audience.trim() ? 3 : 0) + ((input.insightHints?.length ?? 0) > 0 ? 3 : 0)
  return Math.min(100, qualityBase + bonus)
}

/**
 * 記事ドラフトを決定的に生成する。
 * 同じ入力 → 常に同じ出力（モックの一貫性）。API は Vertex AI を一次とし、失敗時にここへフォールバックする。
 */
export function generateArticleDraft(input: ArticleGenInput): GeneratedArticleDraft {
  const topic = (input.topic || '').trim() || (input.keyword || '').trim() || `${input.segmentName}の活用`
  const keyword = (input.keyword || '').trim() || topic
  const spec = QUALITY_SPEC[input.quality]

  const title = TITLE_TEMPLATES[input.purpose](topic)
  const headings = PURPOSE_SECTIONS[input.purpose].map(h => h.replace('{topic}', topic))
  // 質に応じてセクション数を調整（不足時は補助見出しを追加）
  const trimmed = headings.slice(0, spec.sections)
  while (trimmed.length < spec.sections) trimmed.push(`${topic}をさらに深掘りする（${trimmed.length + 1}）`)

  const outline: ArticleSectionDraft[] = trimmed.map(h => ({ heading: h, points: pointsFor(topic, keyword) }))

  const introLine = TONE_INTRO[input.tone](input.audience || '読者', topic)
  const hintLine = input.insightHints && input.insightHints.length > 0
    ? `\n\n> 本記事は直近のアクセス分析（${input.insightHints.slice(0, 2).join(' / ')}）を踏まえて構成しています。`
    : ''

  const bodyParts: string[] = [`# ${title}`, '', introLine + hintLine, '']
  for (const sec of outline) {
    bodyParts.push(`## ${sec.heading}`, '')
    for (const p of sec.points) bodyParts.push(`- ${p}`)
    bodyParts.push('')
  }
  bodyParts.push(toneClose(input.tone, input.purpose, input.segmentName).trim())
  const body = bodyParts.join('\n')

  const metaDescription = `${topic}について、${PURPOSE_LABEL[input.purpose]}を目的に${TONE_LABEL[input.tone]}な語り口で解説。`
    + `${input.audience ? `${input.audience}向け。` : ''}${keyword} の要点と次のアクションが分かります。`

  // 提案キーワード（keyword を軸に決定的に派生）
  const suffixes = ['とは', 'メリット', '始め方', '事例', '費用', '比較', '注意点', 'コツ']
  const start = hashStr(`${keyword}:${input.purpose}`) % suffixes.length
  const suggestedKeywords = [keyword, ...Array.from({ length: 4 }, (_, i) => `${keyword} ${suffixes[(start + i) % suffixes.length]}`)]

  const qualityScore = articleQualityScore(input)

  return {
    title, metaDescription, outline, body, suggestedKeywords,
    estWordCount: spec.words, qualityScore,
    purpose: input.purpose, quality: input.quality, tone: input.tone,
  }
}
