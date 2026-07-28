/**
 * メディア分析シードデータ（決定的）。
 * - セグメント（業態）と 1:1 のメディア設定（GA 連携状態・AI 分析設定）
 * - サイトのコンテンツ資産（記事インベントリ）= GA 風メトリクスの導出元
 * - インサイト・生成記事・依頼は「生成時に保管」のため空シード（画面の生成操作で作られる）
 *
 * デモ: seg-01（陶磁器委託販売）と seg-03（SaaS 事業）は GA 連携済み・記事が充実。
 *       seg-02（SI 事業）は未連携（設定画面での連携フロー体験用）。seg-04（アパレル）は小規模。
 */
import type { ArticleBrief, GeneratedArticle, MediaArticle, MediaSetting } from '~/types/media'

const TODAY = todayJst()

/** N 日前の日付キー */
function daysAgo(n: number): string {
  return addDays(TODAY, -n)
}

// ---------- メディア設定（セグメント 1:1） ----------

export const seedMediaSettings: MediaSetting[] = [
  {
    id: 'ms-01', segmentId: 'seg-01', siteName: '暮らしの器マガジン', siteUrl: 'https://utsuwa.example.com',
    gaConnected: true, gaPropertyId: 'properties/380011001', gaPropertyName: '暮らしの器マガジン - GA4', gaConnectedAt: `${daysAgo(90)}T10:00:00+09:00`,
    analysisGoal: 'conversion', targetAudience: '手仕事の器に関心のある 30〜50 代', defaultTone: 'friendly',
    keywords: ['作家もの 器', '陶磁器 選び方', '和食器 コーディネート'], active: true,
  },
  {
    id: 'ms-02', segmentId: 'seg-02', siteName: 'SI 事業サイト', siteUrl: '',
    gaConnected: false, gaPropertyId: null, gaPropertyName: null, gaConnectedAt: null,
    analysisGoal: 'leadgen', targetAudience: '基幹システム刷新を検討する情報システム部門', defaultTone: 'expert',
    keywords: [], active: true,
  },
  {
    id: 'ms-03', segmentId: 'seg-03', siteName: 'SaaS プロダクトブログ', siteUrl: 'https://saas.example.com/blog',
    gaConnected: true, gaPropertyId: 'properties/380033003', gaPropertyName: 'SaaS Product - GA4', gaConnectedAt: `${daysAgo(120)}T10:00:00+09:00`,
    analysisGoal: 'leadgen', targetAudience: '業務効率化を進める中小企業のバックオフィス担当', defaultTone: 'expert',
    keywords: ['業務効率化', 'DX 中小企業', 'SaaS 比較', 'ペーパーレス'], active: true,
  },
  {
    id: 'ms-04', segmentId: 'seg-04', siteName: 'アパレル EC マガジン', siteUrl: 'https://apparel.example.com',
    gaConnected: false, gaPropertyId: null, gaPropertyName: null, gaConnectedAt: null,
    analysisGoal: 'awareness', targetAudience: 'トレンドに敏感な 20〜30 代', defaultTone: 'casual',
    keywords: ['季節コーデ', '素材 選び方'], active: true,
  },
]

// ---------- 記事インベントリ（GA メトリクスの導出元） ----------

function art(
  id: string, segmentId: string, path: string, title: string, section: string, age: number, wordCount: number,
): MediaArticle {
  return {
    id, segmentId, path, title, section, publishedAt: daysAgo(age), wordCount,
    status: 'published', origin: 'seed', generatedArticleId: null, active: true,
  }
}

export const seedMediaArticles: MediaArticle[] = [
  // seg-01 暮らしの器マガジン（連携済み・小売/委託）
  art('ma-0101', 'seg-01', '/', 'トップページ', 'トップ', 300, 400),
  art('ma-0102', 'seg-01', '/blog/utsuwa-erabi', '失敗しない作家ものの器の選び方', 'ブログ', 42, 2600),
  art('ma-0103', 'seg-01', '/blog/washoku-coordinate', '和食器で作る食卓コーディネート10選', 'ブログ', 18, 2200),
  art('ma-0104', 'seg-01', '/column/sakka-yamada', '作家インタビュー：山田陶房の仕事', 'コラム', 65, 3100),
  art('ma-0105', 'seg-01', '/case/ginza-gallery', '導入事例：銀座ギャラリー店の委託販売', '導入事例', 30, 1800),
  art('ma-0106', 'seg-01', '/service/itaku', '委託販売サービスのご案内', 'サービス', 200, 1200),
  art('ma-0107', 'seg-01', '/news/spring-fair', '春の器フェア開催のお知らせ', 'お知らせ', 10, 500),
  art('ma-0108', 'seg-01', '/blog/care-tips', '陶磁器のお手入れとlong-life活用術', 'ブログ', 120, 1900),

  // seg-03 SaaS プロダクトブログ（連携済み・情報サービス）
  art('ma-0301', 'seg-03', '/blog/', 'ブログトップ', 'トップ', 300, 300),
  art('ma-0302', 'seg-03', '/blog/paperless-start', 'ペーパーレス化の始め方【中小企業向け完全ガイド】', 'ブログ', 25, 3400),
  art('ma-0303', 'seg-03', '/blog/saas-hikaku', '業務効率化SaaS徹底比較2026', 'ブログ', 12, 2900),
  art('ma-0304', 'seg-03', '/blog/dx-jireishu', '中小企業のDX成功事例集', 'ブログ', 55, 2600),
  art('ma-0305', 'seg-03', '/service/features', '主要機能のご紹介', 'サービス', 220, 1400),
  art('ma-0306', 'seg-03', '/pricing', '料金プラン', '料金', 210, 700),
  art('ma-0307', 'seg-03', '/case/backoffice', '導入事例：バックオフィス業務を半減', '導入事例', 40, 1900),
  art('ma-0308', 'seg-03', '/blog/workflow-tips', '承認ワークフローを速くする5つのコツ', 'ブログ', 8, 2100),
  art('ma-0309', 'seg-03', '/news/release-2026', '新機能リリースのお知らせ', 'お知らせ', 15, 450),

  // seg-02 SI 事業（未連携・少数）
  art('ma-0201', 'seg-02', '/', 'トップページ', 'トップ', 200, 400),
  art('ma-0202', 'seg-02', '/service/si', 'システムインテグレーションサービス', 'サービス', 180, 1500),
  art('ma-0203', 'seg-02', '/case/kikan-sasshin', '導入事例：基幹システム刷新', '導入事例', 90, 2000),
  art('ma-0204', 'seg-02', '/column/legacy', 'レガシーシステム刷新の進め方', 'コラム', 60, 2400),

  // seg-04 アパレル（未連携・少数）
  art('ma-0401', 'seg-04', '/', 'トップページ', 'トップ', 150, 400),
  art('ma-0402', 'seg-04', '/blog/spring-coordinate', '春の新作コーディネート特集', 'ブログ', 20, 1600),
  art('ma-0403', 'seg-04', '/blog/material-guide', '素材から選ぶ大人カジュアル', 'ブログ', 45, 1800),
  art('ma-0404', 'seg-04', '/news/sale', 'シーズンセールのお知らせ', 'お知らせ', 5, 400),
]

// 生成物・依頼・インサイトは画面の生成操作で作られる（シードなし = 空）
export const seedMediaInsights: never[] = []
export const seedArticleBriefs: ArticleBrief[] = []
export const seedGeneratedArticles: GeneratedArticle[] = []
