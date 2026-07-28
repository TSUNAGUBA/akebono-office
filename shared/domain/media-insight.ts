/**
 * メディア分析 AI インサイト（Google Analytics 集計 → 洞察）。
 * 該当セグメント（業態）のサイトの GA メトリクス（MediaMetrics）から、
 * サイト構成・記事に対するインサイトと「次に起こすべきアクション」を導く。
 *
 * - 集計（MediaMetrics）はフロント（モック）/ API で同一型（media-metrics.ts）
 * - 洞察は API = Vertex AI（構造化出力）→ 失敗時 heuristicMediaInsight / モック = heuristic のみ（原則4）
 * - ヒューリスティックは metrics のみから決定的に生成する（推測で事実を作らない）
 */
import type { MediaMetrics } from './media-metrics'

/** インサイトの分類（勝ち筋 / 課題 / 機会）。UI のトーン分けに使う */
export type MediaFindingKind = 'win' | 'issue' | 'opportunity'

export interface MediaFinding {
  kind: MediaFindingKind
  title: string
  detail: string
}

export interface MediaAction {
  title: string
  detail: string
  priority: 'high' | 'mid' | 'low'
}

export interface MediaInsight {
  /** 全体サマリー（マークダウン） */
  executiveSummary: string
  /** サイト構成へのインサイト（セクション構成・導線） */
  siteStructure: MediaFinding[]
  /** 記事・コンテンツへのインサイト */
  articles: MediaFinding[]
  /** 次に起こすべきアクションの提案 */
  actions: MediaAction[]
}

/**
 * 保管されたメディアインサイト（導出キャッシュ = 再生成で上書き）。
 * scope = 'media'（メディア単体）/ 'integrated'（業務 × メディア）。
 * insight は scope により MediaInsight / IntegratedInsight のいずれか。
 */
export interface MediaInsightRecord {
  id: string
  segmentId: string
  scope: 'media' | 'integrated'
  /** 対象期間キー（例: '2026-07' や '2026-07-01_2026-07-28'） */
  periodKey: string
  metrics: unknown
  insight: unknown
  llm: boolean
  generatedBy: string
  generatedAt: string
}

const pct = (r: number): string => `${Math.round(r * 1000) / 10}%`
const fmtInt = (n: number): string => n.toLocaleString('ja-JP')
const delta = (cur: number, prev: number): number => (prev > 0 ? (cur - prev) / prev : 0)

/**
 * 決定的なメディアインサイト生成（LLM 無効・失敗時のフォールバック / モックの唯一のロジック）。
 * しきい値はコード内に明示（前期比 ±10%、直帰率 60%、CVR 1%、記事集中度など）。
 */
export function heuristicMediaInsight(m: MediaMetrics): MediaInsight {
  const siteStructure: MediaFinding[] = []
  const articles: MediaFinding[] = []
  const actions: MediaAction[] = []

  const sessionDelta = delta(m.sessions, m.prevSessions)
  const convDelta = delta(m.conversions, m.prevConversions)

  // ---- サイト構成へのインサイト ----
  const topSection = m.sections[0]
  const bestConvSection = [...m.sections].filter(s => s.pages > 0).sort((a, b) => b.convRate - a.convRate)[0]
  const worstEngSection = [...m.sections].filter(s => s.pages >= 2).sort((a, b) => a.avgEngagementSec - b.avgEngagementSec)[0]

  if (topSection) {
    const share = m.pageviews > 0 ? topSection.pageviews / m.pageviews : 0
    if (share >= 0.55) {
      siteStructure.push({
        kind: 'issue',
        title: `流入が「${topSection.section}」に集中（PV の ${pct(share)}）`,
        detail: 'サイト構成が単一セクションに依存しています。他セクションへの内部リンク・回遊導線を強化し、集中リスクを分散します。',
      })
    } else {
      siteStructure.push({
        kind: 'win',
        title: `セクション構成のバランスが良好（最大でも ${pct(share)}）`,
        detail: `「${topSection.section}」を軸に複数セクションへ流入が分散しています。現状の構成を維持しつつ回遊を伸ばせます。`,
      })
    }
  }
  if (bestConvSection && bestConvSection.convRate > 0) {
    siteStructure.push({
      kind: 'opportunity',
      title: `「${bestConvSection.section}」の CVR が最も高い（${pct(bestConvSection.convRate)}）`,
      detail: 'コンバージョンに近いセクションです。ブログ等の集客記事からこのセクションへ導く CTA・関連リンクを増やすと成果に直結します。',
    })
    actions.push({
      title: `集客記事から「${bestConvSection.section}」への導線を強化`,
      detail: `PV 上位の記事末尾に「${bestConvSection.section}」への CTA を設置し、CVR の高いセクションへ送客します。`,
      priority: 'high',
    })
  }
  if (worstEngSection && worstEngSection.avgEngagementSec < 45) {
    siteStructure.push({
      kind: 'issue',
      title: `「${worstEngSection.section}」の平均エンゲージメント時間が短い（${worstEngSection.avgEngagementSec}s）`,
      detail: '読了率が低い可能性があります。導入文・見出し構成・内部リンクを見直し、直帰を抑えます。',
    })
  }

  // ---- 記事へのインサイト ----
  const growing = [...m.topPages].filter(p => p.prevPageviews > 0 && delta(p.pageviews, p.prevPageviews) >= 0.15)
    .sort((a, b) => delta(b.pageviews, b.prevPageviews) - delta(a.pageviews, a.prevPageviews))[0]
  const declining = [...m.topPages].filter(p => p.prevPageviews > 0 && delta(p.pageviews, p.prevPageviews) <= -0.2)
    .sort((a, b) => delta(a.pageviews, a.prevPageviews) - delta(b.pageviews, b.prevPageviews))[0]
  const highTrafficLowConv = [...m.topPages]
    .filter(p => p.pageviews >= (m.topPages[0]?.pageviews ?? 0) * 0.5 && p.convRate < 0.01)
    .sort((a, b) => b.pageviews - a.pageviews)[0]
  const hidden = [...m.topPages].filter(p => p.convRate >= 0.04 && p.pageviews < (m.topPages[0]?.pageviews ?? 1) * 0.3)
    .sort((a, b) => b.convRate - a.convRate)[0]

  if (m.topPages[0]) {
    articles.push({
      kind: 'win',
      title: `最も読まれている記事: 「${m.topPages[0].title}」`,
      detail: `期間 PV ${fmtInt(m.topPages[0].pageviews)}・平均エンゲージメント ${m.topPages[0].avgEngagementSec}s。主力コンテンツとして関連記事・更新の優先度を高く保ちます。`,
    })
  }
  if (growing) {
    articles.push({
      kind: 'opportunity',
      title: `伸びている記事: 「${growing.title}」（前期比 +${pct(delta(growing.pageviews, growing.prevPageviews))}）`,
      detail: '上昇トレンドの記事です。関連テーマの記事を追加し、内部リンクで束ねてトピッククラスタを形成すると伸びを増幅できます。',
    })
    actions.push({
      title: `「${growing.title}」を起点に関連記事を追加`,
      detail: '伸びているテーマの周辺キーワードで記事を増やし、内部リンクで集約（トピッククラスタ）します。',
      priority: 'mid',
    })
  }
  if (declining) {
    articles.push({
      kind: 'issue',
      title: `下降している記事: 「${declining.title}」（前期比 ${pct(delta(declining.pageviews, declining.prevPageviews))}）`,
      detail: '情報の陳腐化・検索順位の低下が疑われます。内容のリライト・公開日更新（リフレッシュ）を検討します。',
    })
    actions.push({
      title: `「${declining.title}」をリライトして鮮度を回復`,
      detail: '古い情報を更新し、見出し・メタディスクリプションを最新の検索意図に合わせます。',
      priority: 'mid',
    })
  }
  if (highTrafficLowConv) {
    articles.push({
      kind: 'opportunity',
      title: `集客はあるが CV につながらない記事: 「${highTrafficLowConv.title}」`,
      detail: `PV ${fmtInt(highTrafficLowConv.pageviews)} に対し CVR ${pct(highTrafficLowConv.convRate)}。CTA の設置・関連サービスへの導線が不足しています。`,
    })
    actions.push({
      title: `「${highTrafficLowConv.title}」に CTA・関連導線を追加`,
      detail: '記事内に資料請求・問い合わせ・関連サービスへのリンクを設置し、集客を成果へ転換します。',
      priority: 'high',
    })
  }
  if (hidden) {
    articles.push({
      kind: 'opportunity',
      title: `伸びしろのある記事: 「${hidden.title}」（CVR ${pct(hidden.convRate)}・PV 少）`,
      detail: 'CVR は高いが露出が少ない記事です。内部リンク・SEO 強化で PV を増やせば成果が伸びます。',
    })
  }

  // ---- 全体トレンドのアクション ----
  if (sessionDelta <= -0.1) {
    actions.push({
      title: '流入の減少要因を特定する',
      detail: `セッションが前期比 ${pct(sessionDelta)}。チャネル別（特にオーガニック検索）の増減を確認し、下降記事のリライトを優先します。`,
      priority: 'high',
    })
  }
  if (m.conversionRate < 0.01 && m.sessions > 0) {
    actions.push({
      title: 'サイト全体の CVR 改善に着手する',
      detail: `全体 CVR ${pct(m.conversionRate)} は目安（1%）を下回ります。主要導線の CTA・フォーム離脱・LP の見直しを行います。`,
      priority: 'high',
    })
  }
  const paid = m.channels.find(c => c.channel === '有料広告')
  const organic = m.channels.find(c => c.channel === 'オーガニック検索')
  if (organic && m.sessions > 0 && organic.sessions / m.sessions < 0.25) {
    actions.push({
      title: 'オーガニック検索の比率を高める',
      detail: `検索流入が全体の ${pct(organic.sessions / m.sessions)} と低めです。検索意図に沿った記事の拡充と内部リンク設計で自然流入を育てます。`,
      priority: 'mid',
    })
  }
  if (paid && organic && paid.conversions > organic.conversions) {
    actions.push({
      title: '有料広告依存を緩和する',
      detail: 'コンバージョンが有料広告に偏っています。獲得効率の高いテーマをオーガニック記事化し、獲得単価を下げます。',
      priority: 'mid',
    })
  }
  if (actions.length === 0) {
    actions.push({ title: '現状の運用を継続する', detail: '主要指標に大きな課題は見られません。上位記事の更新と内部リンクの維持を続けます。', priority: 'low' })
  }
  if (siteStructure.length === 0) siteStructure.push({ kind: 'win', title: 'サイト構成に大きな偏りなし', detail: '各セクションへ流入が分散しています。' })
  if (articles.length === 0) articles.push({ kind: 'win', title: '記事の成果は安定', detail: '大きな増減はありません。' })

  // 重複アクションの排除 + 優先度順 + 上限
  const seen = new Set<string>()
  const rank = { high: 0, mid: 1, low: 2 }
  const dedupActions = actions.filter(a => (seen.has(a.title) ? false : (seen.add(a.title), true)))
    .sort((a, b) => rank[a.priority] - rank[b.priority]).slice(0, 6)

  const trendWord = sessionDelta >= 0.1 ? '増加' : sessionDelta <= -0.1 ? '減少' : '横ばい'
  const executiveSummary = [
    `**${m.siteName}** の直近 ${m.days} 日（${m.periodFrom}〜${m.periodTo}）のメディア分析。`,
    `セッション ${fmtInt(m.sessions)}（前期比 ${sessionDelta >= 0 ? '+' : ''}${pct(sessionDelta)}・${trendWord}）、`,
    `ユーザー ${fmtInt(m.users)}（うち新規 ${fmtInt(m.newUsers)}）、PV ${fmtInt(m.pageviews)}、`,
    `コンバージョン ${fmtInt(m.conversions)}（CVR ${pct(m.conversionRate)}・前期比 ${convDelta >= 0 ? '+' : ''}${pct(convDelta)}）。`,
    `平均エンゲージメント時間 ${m.avgEngagementSec}s、直帰率 ${pct(m.bounceRate)}。`,
    topSection ? `流入の中心は「${topSection.section}」セクション。` : '',
    bestConvSection && bestConvSection.convRate > 0 ? `成果に近いのは「${bestConvSection.section}」（CVR ${pct(bestConvSection.convRate)}）。` : '',
  ].filter(Boolean).join('')

  return { executiveSummary, siteStructure, articles, actions: dedupActions }
}
