/**
 * メディア分析の AI 週次レポートと改善施策（改善要望 2026-08-21・F-55/F-56）。
 * フロント（モック）/ API で共有する型・検証・決定的な生成ヒューリスティックの SoT。
 *
 * - AI 週次レポート: 週（月曜始まり = weekStartKeyOf。週報と同一定義 = 原則3）×チャンネル単位に
 *   「エグゼクティブサマリー / 重要な変化 / 原因仮説 / コンテンツ評価 / 推奨アクション」を生成・保管する。
 *   生成は **集計値からの決定的ヒューリスティック**（Math.random 非依存 = 同じ入力 → 同じレポート）。
 *   API/モックとも本関数で生成する（LLM 生成は将来拡張。media-insight の Vertex 経路と同型で足せる = 原則4 の
 *   フォールバックを先に SoT 化する設計判断）。
 * - 推奨アクションの判断（実行する / 継続検討 / 対象外）はレポート内に記録し、「実行する」は
 *   改善施策（MediaMeasure）として起票する。
 * - 改善施策: 施策 + 効果検証を 1 件として管理（ステータス 5 値・取消/復元 = 原則9.5）。
 *   効果検証の AI 評価も決定的ヒューリスティック（実施前後の週次比較）。
 */
import { addDays } from './jst'
import type { MediaMetrics } from './media-metrics'
import { weekStartKeyOf } from './report-reminder'

// ---------- 週キー ----------

/** 週の開始日（月曜。週報と同一定義 = weekStartKeyOf を re-export・原則3） */
export const mediaWeekStartOf = weekStartKeyOf

/** 週の終了日（日曜） */
export function mediaWeekEndOf(weekStart: string): string {
  return addDays(weekStart, 6)
}

// ---------- AI 週次レポート ----------

/** 推奨アクションの判断（値=ラベル方式。既定 = 未判断） */
export const MEDIA_REPORT_DECISIONS = ['未判断', '実行する', '継続検討', '対象外'] as const
export type MediaReportDecision = (typeof MEDIA_REPORT_DECISIONS)[number]

/** 重要な変化の 1 件（伸長 = up / 低下 = down） */
export interface MediaReportChange {
  direction: 'up' | 'down'
  label: string
  /** 変化率（例 '+18.2%'）。表示用の整形済み文字列 */
  value: string
  detail: string
}

/** コンテンツ評価の 1 行（集客/CV貢献 = ◎○△× ・成長 = ↗ー↘） */
export interface MediaReportRating {
  title: string
  path: string
  traffic: '◎' | '○' | '△' | '×'
  growth: '↗' | 'ー' | '↘'
  cv: '◎' | '○' | '△' | '×'
  comment: string
}

export interface MediaReportAction {
  title: string
  /** 理由（根拠となる集計値） */
  reason: string
  /** 期待効果 */
  expectedEffect: string
  priority: 'high' | 'mid' | 'low'
  /** 判断（未判断 → 実行する / 継続検討 / 対象外。実行する = 改善施策として起票） */
  decision: MediaReportDecision
  decidedAt?: string | null
  decidedByMemberId?: string | null
}

export interface MediaWeeklyReportContent {
  /** エグゼクティブサマリー（箇条書き） */
  executiveSummary: string[]
  changes: MediaReportChange[]
  hypotheses: string[]
  ratings: MediaReportRating[]
  actions: MediaReportAction[]
}

/** AI 週次レポート（チャンネル × 週開始で一意。生成 → 保管・判断はレポート内に記録） */
export interface MediaWeeklyReport {
  id: string
  channelId: string
  /** 週開始（月曜。YYYY-MM-DD） */
  weekStart: string
  periodFrom: string
  periodTo: string
  content: MediaWeeklyReportContent
  /** true = LLM 生成 / false = 決定的ヒューリスティック（現状は常に false。将来拡張用） */
  llm: boolean
  generatedAt: string
}

/** レポート一覧・サマリーの件数（重要変化 / 推奨アクション / 未判断） */
export function weeklyReportCounts(content: MediaWeeklyReportContent): {
  changes: number; actions: number; undecided: number
} {
  return {
    changes: content.changes.length,
    actions: content.actions.length,
    undecided: content.actions.filter(a => a.decision === '未判断').length,
  }
}

// ---------- 週次比較（前週比 / 4週平均比の材料） ----------

interface WeekTotals { sessions: number; users: number; conversions: number }

/** daily 系列の末尾 offsetWeeks 週目（0 = 直近 7 日）の合計。系列が足りない週は null */
export function weekTotalsOf(m: Pick<MediaMetrics, 'daily'>, offsetWeeks: number): WeekTotals | null {
  const daily = m.daily
  const end = daily.length - offsetWeeks * 7
  const start = end - 7
  if (start < 0 || end > daily.length || end <= start) return null
  const slice = daily.slice(start, end)
  if (slice.length < 7) return null
  return {
    sessions: slice.reduce((s, d) => s + d.sessions, 0),
    users: slice.reduce((s, d) => s + d.users, 0),
    conversions: slice.reduce((s, d) => s + d.conversions, 0),
  }
}

/** 比率（(cur - base) / base）。base<=0 は null（ゼロ除算・意味のない比を作らない） */
export function ratioOf(cur: number, base: number): number | null {
  if (!(base > 0)) return null
  return (cur - base) / base
}

/** 比率の表示（'+12.3%' / '-4.0%'。null は '—'） */
export function fmtRatio(r: number | null): string {
  if (r === null) return '—'
  const pct = r * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

/**
 * サマリーカード用の週次比較（改善要望 2026-08-21 = 前週比 / 4週平均比 / 前年同期比）。
 * - 前週比: 直近 7 日 vs その前の 7 日（daily 系列から導出）
 * - 4週平均比: 直近 7 日 vs 当該週を含む直近 4 週の週平均（daily 系列が 14 日以上 = 2 週以上取れるとき）
 * - 前年同期比: 直近 7 日 vs 52 週（364 日）前の同じ曜日並びの 7 日間（MediaMetrics.yoyWeek。API = GA 追加取得 /
 *   モック = 決定的導出。旧キャッシュ・取得不可は null = 「—」表示・原則7）
 */
export interface MediaWeeklyCompare {
  current: WeekTotals & { cvr: number | null }
  wow: { sessions: number | null; users: number | null; conversions: number | null; cvr: number | null }
  fourWeekAvg: { sessions: number | null; users: number | null; conversions: number | null; cvr: number | null }
  yoy: { sessions: number | null; users: number | null; conversions: number | null; cvr: number | null }
}

function cvrOf(t: WeekTotals | null): number | null {
  if (!t || !(t.sessions > 0)) return null
  return t.conversions / t.sessions
}

export function weeklyCompareOf(m: Pick<MediaMetrics, 'daily' | 'yoyWeek'>): MediaWeeklyCompare {
  const curTotals = weekTotalsOf(m, 0)
  // 直近 7 日の系列が短い（daily が 7 日未満）ときの防御。なお API の日別内訳**取得失敗**は daily が
  // ゼロ埋めで全長生成されるためここでは検知できない = その場合は ①サーバーが yoyWeek を外し
  // ②フロントが unavailable('daily') のとき比較カード自体を出さない、の二重防御で誤比較を防ぐ（レビュー R2 MAJOR）
  if (!curTotals) {
    const na = { sessions: null, users: null, conversions: null, cvr: null }
    return {
      current: { sessions: 0, users: 0, conversions: 0, cvr: null },
      wow: { ...na }, fourWeekAvg: { ...na }, yoy: { ...na },
    }
  }
  const cur = curTotals
  const prev = weekTotalsOf(m, 1)
  const curCvr = cvrOf(cur)

  // 4 週平均（直近 28 日 = **当該週を含む** 4 週分の週合計平均。系列が 28 日未満なら取れる週だけで平均。
  // 当該週を含める定義のため変化は約 3/4 に減衰する = 「直近 4 週の水準に対する位置」を見る指標という設計判断）
  const weeks: WeekTotals[] = []
  for (let i = 0; i < 4; i++) {
    const w = weekTotalsOf(m, i)
    if (w) weeks.push(w)
  }
  const avg = weeks.length >= 2
    ? {
        sessions: weeks.reduce((s, w) => s + w.sessions, 0) / weeks.length,
        users: weeks.reduce((s, w) => s + w.users, 0) / weeks.length,
        conversions: weeks.reduce((s, w) => s + w.conversions, 0) / weeks.length,
      }
    : null
  const avgCvr = avg && avg.sessions > 0 ? avg.conversions / avg.sessions : null

  const yoy = m.yoyWeek ?? null
  const yoyCvr = yoy && yoy.sessions > 0 ? yoy.conversions / yoy.sessions : null

  return {
    current: { ...cur, cvr: curCvr },
    wow: {
      sessions: prev ? ratioOf(cur.sessions, prev.sessions) : null,
      users: prev ? ratioOf(cur.users, prev.users) : null,
      conversions: prev ? ratioOf(cur.conversions, prev.conversions) : null,
      cvr: curCvr !== null && cvrOf(prev) !== null && cvrOf(prev)! > 0 ? (curCvr - cvrOf(prev)!) / cvrOf(prev)! : null,
    },
    fourWeekAvg: {
      sessions: avg ? ratioOf(cur.sessions, avg.sessions) : null,
      users: avg ? ratioOf(cur.users, avg.users) : null,
      conversions: avg ? ratioOf(cur.conversions, avg.conversions) : null,
      cvr: curCvr !== null && avgCvr !== null && avgCvr > 0 ? (curCvr - avgCvr) / avgCvr : null,
    },
    yoy: {
      sessions: yoy ? ratioOf(cur.sessions, yoy.sessions) : null,
      users: yoy ? ratioOf(cur.users, yoy.users) : null,
      conversions: yoy ? ratioOf(cur.conversions, yoy.conversions) : null,
      cvr: curCvr !== null && yoyCvr !== null && yoyCvr > 0 ? (curCvr - yoyCvr) / yoyCvr : null,
    },
  }
}

// ---------- AI 週次レポートの決定的生成 ----------

/** 重要変化とみなす変化率のしきい値（±5%） */
const CHANGE_THRESHOLD = 0.05
/** 記事の伸長・低下しきい値（±10%） */
const PAGE_TREND_THRESHOLD = 0.10

/**
 * 週次レポート本文の決定的生成。
 * 入力は「週の終了日（日曜）を基準日とした 28 日 MediaMetrics」（daily の末尾 7 日 = 対象週）。
 * 同じ metrics → 常に同じレポート（Math.random 非依存）。
 */
export function heuristicWeeklyMediaReport(metrics: MediaMetrics, weekStart: string): MediaWeeklyReportContent {
  const weekEnd = mediaWeekEndOf(weekStart)
  const cur = weekTotalsOf(metrics, 0) ?? { sessions: 0, users: 0, conversions: 0 }
  const prev = weekTotalsOf(metrics, 1)
  const wowSessions = prev ? ratioOf(cur.sessions, prev.sessions) : null
  const wowConversions = prev ? ratioOf(cur.conversions, prev.conversions) : null
  const curCvr = cur.sessions > 0 ? cur.conversions / cur.sessions : null
  const prevCvr = prev && prev.sessions > 0 ? prev.conversions / prev.sessions : null
  const wowCvr = curCvr !== null && prevCvr !== null && prevCvr > 0 ? (curCvr - prevCvr) / prevCvr : null

  // ---------- 重要な変化 ----------
  const changes: MediaReportChange[] = []
  if (wowSessions !== null && Math.abs(wowSessions) >= CHANGE_THRESHOLD) {
    changes.push({
      direction: wowSessions >= 0 ? 'up' : 'down',
      label: 'セッション（前週比）',
      value: fmtRatio(wowSessions),
      detail: `今週 ${cur.sessions.toLocaleString('ja-JP')} / 前週 ${prev!.sessions.toLocaleString('ja-JP')}`,
    })
  }
  if (wowConversions !== null && Math.abs(wowConversions) >= CHANGE_THRESHOLD) {
    changes.push({
      direction: wowConversions >= 0 ? 'up' : 'down',
      label: 'コンバージョン（前週比）',
      value: fmtRatio(wowConversions),
      detail: `今週 ${cur.conversions.toLocaleString('ja-JP')} / 前週 ${prev!.conversions.toLocaleString('ja-JP')}`,
    })
  }
  if (wowCvr !== null && Math.abs(wowCvr) >= CHANGE_THRESHOLD) {
    changes.push({
      direction: wowCvr >= 0 ? 'up' : 'down',
      label: 'CVR（前週比）',
      value: fmtRatio(wowCvr),
      detail: `今週 ${(curCvr! * 100).toFixed(2)}% / 前週 ${(prevCvr! * 100).toFixed(2)}%`,
    })
  }
  // 記事別の伸長・低下（28 日 vs 前 28 日の前期比。週次粒度の記事別は取得コストが高いため
  // 28 日ベースを「トレンド」として明記する設計判断）
  const trendPages = metrics.topPages
    .filter(p => p.prevPageviews > 0)
    .map(p => ({ p, trend: (p.pageviews - p.prevPageviews) / p.prevPageviews }))
  const risers = trendPages.filter(x => x.trend >= PAGE_TREND_THRESHOLD)
    .sort((a, b) => b.trend - a.trend).slice(0, 2)
  const fallers = trendPages.filter(x => x.trend <= -PAGE_TREND_THRESHOLD)
    .sort((a, b) => a.trend - b.trend).slice(0, 2)
  for (const { p, trend } of risers) {
    changes.push({
      direction: 'up', label: `記事「${p.title}」`, value: fmtRatio(trend),
      detail: `PV ${p.pageviews.toLocaleString('ja-JP')}（28日間の前期比）`,
    })
  }
  for (const { p, trend } of fallers) {
    changes.push({
      direction: 'down', label: `記事「${p.title}」`, value: fmtRatio(trend),
      detail: `PV ${p.pageviews.toLocaleString('ja-JP')}（28日間の前期比）`,
    })
  }

  // ---------- エグゼクティブサマリー ----------
  const executiveSummary: string[] = []
  executiveSummary.push(wowSessions === null
    ? `今週（${weekStart}〜${weekEnd}）のセッションは ${cur.sessions.toLocaleString('ja-JP')} です。`
    : `今週のセッションは前週比 ${fmtRatio(wowSessions)}（${cur.sessions.toLocaleString('ja-JP')}）。`)
  const topChannel = metrics.channels.slice().sort((a, b) => b.sessions - a.sessions)[0]
  if (topChannel && metrics.sessions > 0) {
    executiveSummary.push(
      `流入の中心は${topChannel.channel}（28日間のセッション比 ${Math.round(topChannel.sessions / metrics.sessions * 100)}%）です。`)
  }
  if (risers.length > 0) {
    executiveSummary.push(`「${risers.map(x => x.p.title).join('」「')}」の記事群が伸長しています。`)
  }
  if (wowCvr !== null && wowCvr <= -CHANGE_THRESHOLD) {
    executiveSummary.push('一方、CVR は低下しており、CV 導線の点検が必要です。')
  } else if (wowConversions !== null && wowConversions >= CHANGE_THRESHOLD) {
    executiveSummary.push('コンバージョンも伸びており、良い循環です。')
  }

  // ---------- 原因仮説 ----------
  const hypotheses: string[] = []
  if (risers.length > 0 && (wowSessions ?? 0) > 0) {
    hypotheses.push(`「${risers[0]!.p.title}」（${risers[0]!.p.section}）への流入増がセッション増加の主因と推測されます。`)
  }
  if (fallers.length > 0 && (wowSessions ?? 0) < 0) {
    hypotheses.push(`「${fallers[0]!.p.title}」の流入減がセッション減少に影響していると推測されます。`)
  }
  if (topChannel?.channel === 'オーガニック検索') {
    hypotheses.push('オーガニック検索が流入の中心のため、検索需要の季節変動が数値に反映されやすい構造です。')
  }
  if (hypotheses.length === 0) {
    hypotheses.push('大きな構造変化は検知されていません。前週からの継続トレンドと推測されます。')
  }

  // ---------- コンテンツ評価（PV 上位 5 記事） ----------
  const rated = metrics.topPages.slice(0, 5)
  const siteCvr = metrics.conversionRate
  const ratings: MediaReportRating[] = rated.map((p, i) => {
    const trend = p.prevPageviews > 0 ? (p.pageviews - p.prevPageviews) / p.prevPageviews : null
    const traffic = i === 0 ? '◎' : i <= 2 ? '○' : '△'
    const growth = trend === null ? 'ー' : trend >= PAGE_TREND_THRESHOLD ? '↗' : trend <= -PAGE_TREND_THRESHOLD ? '↘' : 'ー'
    const cv = siteCvr > 0
      ? (p.convRate >= siteCvr * 2 ? '◎' : p.convRate >= siteCvr ? '○' : p.convRate > 0 ? '△' : '×')
      : (p.convRate > 0 ? '○' : '×')
    const comment = growth === '↗'
      ? '流入が伸びています。関連記事への内部リンクで回遊を広げる好機です'
      : growth === '↘'
        ? '流入が減少しています。タイトル・導入の見直しやリライトを検討してください'
        : cv === '◎' || cv === '○'
          ? '安定した集客と CV 貢献があります。現在の構成を維持してください'
          : '集客はあるものの CV 貢献が弱めです。CTA・導線の改善余地があります'
    return { title: p.title, path: p.path, traffic, growth, cv, comment }
  })

  // ---------- 推奨アクション ----------
  const actions: MediaReportAction[] = []
  if (risers.length > 0) {
    const top = risers[0]!
    actions.push({
      title: `「${top.p.title}」から関連記事への内部リンクを追加`,
      reason: `対象記事への流入が前期比 ${fmtRatio(top.trend)}。回遊率には改善余地があります`,
      expectedEffect: 'PV/セッション・EC/CV 導線の改善',
      priority: 'high',
      decision: '未判断',
    })
  }
  if (fallers.length > 0) {
    const worst = fallers[0]!
    actions.push({
      title: `「${worst.p.title}」のリライト・タイトル改善`,
      reason: `流入が前期比 ${fmtRatio(worst.trend)} と低下しています`,
      expectedEffect: '検索順位・流入の回復',
      priority: 'mid',
      decision: '未判断',
    })
  }
  if (wowCvr !== null && wowCvr <= -CHANGE_THRESHOLD) {
    actions.push({
      title: 'CV 導線（CTA・フォーム）の点検',
      reason: `CVR が前週比 ${fmtRatio(wowCvr)} と低下しています`,
      expectedEffect: 'CVR の回復',
      priority: 'high',
      decision: '未判断',
    })
  }
  if (metrics.bounceRate >= 0.6) {
    actions.push({
      title: '直帰率の高いセクションの導線改善',
      reason: `サイト全体の直帰率が ${(metrics.bounceRate * 100).toFixed(1)}% と高めです`,
      expectedEffect: '回遊率・エンゲージ時間の向上',
      priority: 'mid',
      decision: '未判断',
    })
  }
  if (actions.length === 0) {
    actions.push({
      title: '好調を維持しつつ新規記事を投入',
      reason: '大きな悪化指標がなく、コンテンツ資産を積み増す好機です',
      expectedEffect: '検索流入の裾野拡大',
      priority: 'low',
      decision: '未判断',
    })
  }

  return { executiveSummary, changes, hypotheses, ratings, actions: actions.slice(0, 4) }
}

// ---------- 改善施策 ----------

/** 改善施策のステータス（値=ラベル方式） */
export const MEDIA_MEASURE_STATUSES = ['実施予定', '実施中', '効果観測中', '評価待ち', '完了'] as const
/** 人の最終評価（効果判定） */
export const MEDIA_MEASURE_EVALUATIONS = ['効果あり', '判断保留', '効果なし'] as const
export type MediaMeasureEvaluation = (typeof MEDIA_MEASURE_EVALUATIONS)[number] | ''

/** 効果検証（改善施策の下段。AI 生成 + ユーザー編集可） */
export interface MediaMeasureVerification {
  /** 実施日（YYYY-MM-DD・任意） */
  implementedOn: string | null
  /** 実施内容（実際に行ったこと） */
  implementedNote: string
  /** 比較期間（自由入力。例 '実施前後 7 日間'） */
  comparePeriod: string
  /** KPI 名（例 'セッション'） */
  kpiName: string
  beforeValue: string
  afterValue: string
  /** 変化（例 '+12.3%'） */
  change: string
  /** 目標 */
  goal: string
  /** AI 評価（ヒューリスティック生成 + 編集可） */
  aiEvaluation: string
  /** 人の最終評価（効果あり / 判断保留 / 効果なし。'' = 未評価） */
  humanEvaluation: MediaMeasureEvaluation
  learning: string
  nextAction: string
}

export function emptyVerification(): MediaMeasureVerification {
  return {
    implementedOn: null, implementedNote: '', comparePeriod: '', kpiName: '',
    beforeValue: '', afterValue: '', change: '', goal: '', aiEvaluation: '',
    humanEvaluation: '', learning: '', nextAction: '',
  }
}

/** 改善施策（AI 週次レポートの「実行する」アクション or 手動で起票） */
export interface MediaMeasure {
  id: string
  channelId: string
  /** 起票者（表示用。編集は全員可） */
  memberId: string
  /** 施策名（必須） */
  name: string
  /** 背景・目的 */
  background: string
  /** 実施内容（計画） */
  content: string
  /** 対象（記事・セクション・導線など） */
  target: string
  /** 期待する変化 */
  expectedChange: string
  /** 担当（Member 参照） */
  assigneeMemberId: string
  /** 期限（YYYY-MM-DD・任意） */
  dueDate: string | null
  /** ステータス（MEDIA_MEASURE_STATUSES） */
  status: string
  /** 発生元レポート（AI 週次レポート起票時のみ） */
  sourceReportId: string | null
  /** 発生元アクションの index（レポート内の推奨アクション位置。重複起票の防止キー） */
  sourceActionIndex: number | null
  /** 発生元の表示ラベル（例 '2026/8/10〜8/16 AI週次レポート'） */
  sourceLabel: string
  verification: MediaMeasureVerification
  createdAt: string
  updatedAt?: string
  /** 取消（論理削除）済みは false */
  active?: boolean
}

export const MEDIA_MEASURE_NAME_CAP = 200
export const MEDIA_MEASURE_TEXT_CAP = 8_000

export interface MediaMeasureInput {
  channelId: string
  name: string
  background: string
  content: string
  target: string
  expectedChange: string
  assigneeMemberId: string
  dueDate: string | null
  status: string
}

/** 改善施策の入力検証（宣言順 = API/モック共通の適用順） */
export function mediaMeasureError(input: MediaMeasureInput): string | null {
  if (!input.channelId.trim()) return '対象メディア（チャンネル）を指定してください'
  if (!input.name.trim()) return '施策名を入力してください'
  if (!(MEDIA_MEASURE_STATUSES as readonly string[]).includes(input.status)) return 'ステータスの値が正しくありません'
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) return '期限が正しくありません'
  return null
}

/** 効果検証の部分更新入力の検証（humanEvaluation の語彙のみ検証。他はフリーテキスト） */
export function measureVerificationError(v: Partial<MediaMeasureVerification>): string | null {
  if (v.humanEvaluation !== undefined && v.humanEvaluation !== ''
    && !(MEDIA_MEASURE_EVALUATIONS as readonly string[]).includes(v.humanEvaluation)) {
    return '人の最終評価の値が正しくありません'
  }
  if (v.implementedOn !== undefined && v.implementedOn !== null && v.implementedOn !== ''
    && !/^\d{4}-\d{2}-\d{2}$/.test(v.implementedOn)) {
    return '実施日が正しくありません'
  }
  return null
}

/** 発生元ラベル（例 '2026/8/10〜8/16 AI週次レポート'） */
export function reportSourceLabel(report: Pick<MediaWeeklyReport, 'periodFrom' | 'periodTo'>): string {
  const f = report.periodFrom
  const t = report.periodTo
  const fmt = (d: string, withYear: boolean): string =>
    `${withYear ? `${Number(d.slice(0, 4))}/` : ''}${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
  return `${fmt(f, true)}〜${fmt(t, f.slice(0, 4) !== t.slice(0, 4))} AI週次レポート`
}

/**
 * 「実行する」と判断した推奨アクションから改善施策のドラフトを組み立てる
 * （詳細を可能な限り AI〔レポート内容〕から生成し、ユーザーが編集できる = 改善要望 2026-08-21）。
 */
export function measureDraftFromAction(
  report: Pick<MediaWeeklyReport, 'id' | 'channelId' | 'periodFrom' | 'periodTo'>,
  action: MediaReportAction,
  actionIndex: number,
): Omit<MediaMeasure, 'id' | 'memberId' | 'createdAt' | 'updatedAt' | 'active' | 'assigneeMemberId'> {
  return {
    channelId: report.channelId,
    name: action.title,
    background: action.reason,
    content: action.title,
    target: '',
    expectedChange: action.expectedEffect,
    dueDate: null,
    status: '実施予定',
    sourceReportId: report.id,
    sourceActionIndex: actionIndex,
    sourceLabel: reportSourceLabel(report),
    verification: { ...emptyVerification(), goal: action.expectedEffect },
  }
}

/**
 * 効果検証の AI 評価（決定的）。実施日を境に daily 系列の前後 7 日を比較する。
 * 系列に前後 7 日が収まらない場合は「直近 7 日 vs その前の 7 日」で代替し、その旨を明記する。
 */
export function heuristicMeasureEvaluation(
  measure: Pick<MediaMeasure, 'name' | 'verification'>,
  metrics: Pick<MediaMetrics, 'daily'>,
): Pick<MediaMeasureVerification, 'comparePeriod' | 'kpiName' | 'beforeValue' | 'afterValue' | 'change' | 'aiEvaluation'> {
  const daily = metrics.daily
  const on = measure.verification.implementedOn
  let before: number | null = null
  let after: number | null = null
  let comparePeriod = ''
  if (on) {
    const idx = daily.findIndex(d => d.date === on)
    if (idx >= 7 && idx + 7 <= daily.length) {
      before = daily.slice(idx - 7, idx).reduce((s, d) => s + d.sessions, 0)
      after = daily.slice(idx, idx + 7).reduce((s, d) => s + d.sessions, 0)
      comparePeriod = `実施日（${on}）前後の各 7 日間`
    }
  }
  if (before === null || after === null) {
    const cur = weekTotalsOf(metrics, 0)
    const prev = weekTotalsOf(metrics, 1)
    if (cur && prev) {
      before = prev.sessions
      after = cur.sessions
      comparePeriod = '直近 7 日 vs その前の 7 日（実施日前後の集計が期間外のため代替）'
    }
  }
  if (before === null || after === null) {
    return {
      comparePeriod: '', kpiName: 'セッション', beforeValue: '', afterValue: '', change: '',
      aiEvaluation: '比較に必要な集計期間が確保できていません。実施から 7 日以上あけて再評価してください。',
    }
  }
  const change = ratioOf(after, before)
  const changeText = fmtRatio(change)
  const verdict = change === null
    ? '実施前の計測値がないため判断できません。'
    : change >= 0.05
      ? `セッションが ${changeText} と増加しており、「${measure.name}」の効果が出ている可能性があります。他要因（季節性・他施策）の影響も確認してください。`
      : change <= -0.05
        ? `セッションが ${changeText} と減少しています。施策の効果は確認できていません。継続観測または方針の見直しを検討してください。`
        : `セッションの変化は ${changeText} と軽微です。効果の判断にはもう少し観測期間が必要です。`
  return {
    comparePeriod,
    kpiName: 'セッション',
    beforeValue: before.toLocaleString('ja-JP'),
    afterValue: after.toLocaleString('ja-JP'),
    change: changeText,
    aiEvaluation: verdict,
  }
}
