/**
 * メディア分析の AI 週次レポート・改善施策・週次比較（改善要望 2026-08-21・F-55/F-56）。
 * shared/domain/media-weekly-report は API（routes/media-reports.ts）とモック（useMediaReports）の
 * **パリティの SoT**。ここでの検証が両者の挙動を同時に固定する。
 * - weeklyCompareOf: 前週比 / 4週平均比 / 前年同期比（yoyWeek 無しは null = 「—」）
 * - heuristicWeeklyMediaReport: 決定性・サマリー/変化/仮説/評価/アクションの構成
 * - measureDraftFromAction / heuristicMeasureEvaluation / 入力検証
 */
import { describe, expect, it } from 'vitest'
import { deriveMediaMetrics, type MediaArticleInput, type MediaDailyPoint } from '../../shared/domain/media-metrics'
import {
  fmtRatio, heuristicMeasureEvaluation, heuristicWeeklyMediaReport,
  measureDraftFromAction, measureVerificationError, mediaMeasureError, mediaWeekEndOf, mediaWeekStartOf,
  ratioOf, reportSourceLabel, weekTotalsOf, weeklyCompareOf, weeklyReportCounts,
  emptyVerification,
} from '../../shared/domain/media-weekly-report'

/** テスト用の daily 系列（28 日。値は関数で指定） */
function dailyOf(days: number, f: (i: number) => { s: number; u: number; c: number }): MediaDailyPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, '0')}`,
    sessions: f(i).s, users: f(i).u, conversions: f(i).c,
  }))
}

const ARTICLES: MediaArticleInput[] = [
  { id: 'a1', title: '陶器市ガイド', path: '/blog/toukiichi', section: 'ブログ', publishedAt: '2026-01-10', wordCount: 2000, origin: 'seed' },
  { id: 'a2', title: 'サービス紹介', path: '/service', section: 'サービス', publishedAt: '2025-06-01', wordCount: 1500, origin: 'seed' },
  { id: 'a3', title: '導入事例A', path: '/case/a', section: '導入事例', publishedAt: '2026-05-01', wordCount: 1800, origin: 'seed' },
]

function metricsAt(asOf: string) {
  return deriveMediaMetrics(ARTICLES, { segmentId: 'ch-test', siteName: 'テストメディア', asOf, days: 28 })
}

describe('週キー（mediaWeekStartOf / mediaWeekEndOf）', () => {
  it('月曜始まり（週報と同一定義）・終了は日曜', () => {
    expect(mediaWeekStartOf('2026-08-21')).toBe('2026-08-17') // 金曜 → 同週の月曜
    expect(mediaWeekStartOf('2026-08-16')).toBe('2026-08-10') // 日曜 → 前週の月曜
    expect(mediaWeekEndOf('2026-08-10')).toBe('2026-08-16')
  })
})

describe('weekTotalsOf / ratioOf / fmtRatio', () => {
  it('末尾 7 日（offset 0）とその前の 7 日（offset 1）を正しく合計する', () => {
    const m = { daily: dailyOf(28, i => ({ s: i < 21 ? 10 : 20, u: 5, c: 1 })) }
    expect(weekTotalsOf(m, 0)).toEqual({ sessions: 140, users: 35, conversions: 7 })
    expect(weekTotalsOf(m, 1)).toEqual({ sessions: 70, users: 35, conversions: 7 })
  })

  it('系列が足りない週は null（誤った比較を作らない）', () => {
    const m = { daily: dailyOf(10, () => ({ s: 1, u: 1, c: 0 })) }
    expect(weekTotalsOf(m, 0)).not.toBeNull()
    expect(weekTotalsOf(m, 1)).toBeNull()
  })

  it('ratioOf は base<=0 で null・fmtRatio は null を「—」に整形', () => {
    expect(ratioOf(110, 100)).toBeCloseTo(0.1)
    expect(ratioOf(10, 0)).toBeNull()
    expect(fmtRatio(0.123)).toBe('+12.3%')
    expect(fmtRatio(-0.05)).toBe('-5.0%')
    expect(fmtRatio(null)).toBe('—')
  })
})

describe('weeklyCompareOf（前週比 / 4週平均比 / 前年同期比）', () => {
  it('前週比・4週平均比を daily 系列から導出する', () => {
    const m = {
      daily: dailyOf(28, i => ({ s: i < 21 ? 10 : 20, u: 5, c: i < 21 ? 1 : 2 })),
      days: 28,
      yoyWeek: { sessions: 70, users: 20, conversions: 7 },
    }
    const c = weeklyCompareOf(m)
    expect(c.current.sessions).toBe(140)
    expect(c.wow.sessions).toBeCloseTo(1.0) // 140 vs 70
    // 4 週平均 = (70+70+70+140)/4 = 87.5 → 140/87.5 - 1 = 0.6
    expect(c.fourWeekAvg.sessions).toBeCloseTo(0.6)
    expect(c.yoy.sessions).toBeCloseTo(1.0) // 140 vs 70
  })

  it('yoyWeek が無い（旧キャッシュ・取得不可）場合は前年同期比 null = 「—」（原則7）', () => {
    const m = { daily: dailyOf(28, () => ({ s: 10, u: 5, c: 1 })), days: 28 }
    const c = weeklyCompareOf(m)
    expect(c.yoy.sessions).toBeNull()
    expect(c.yoy.cvr).toBeNull()
    // 変化なしの前週比は 0
    expect(c.wow.sessions).toBeCloseTo(0)
  })
})

describe('deriveMediaMetrics の前年同期（モック導出）', () => {
  it('yoyWeek を決定的に導出する（同一入力 = 同一出力・前年 7 日間の総計）', () => {
    const m1 = metricsAt('2026-08-20')
    const m2 = metricsAt('2026-08-20')
    expect(m1.yoyWeek).toBeDefined()
    expect(m1.yoyWeek).toEqual(m2.yoyWeek)
    // 前年時点で公開済みの記事があるためゼロではない
    expect(m1.yoyWeek!.sessions).toBeGreaterThan(0)
  })
})

describe('heuristicWeeklyMediaReport', () => {
  const weekStart = mediaWeekStartOf('2026-08-16') // 2026-08-10 週
  const metrics = metricsAt(mediaWeekEndOf(weekStart))

  it('決定的（同一入力 = 同一レポート）で 5 構成が揃う', () => {
    const r1 = heuristicWeeklyMediaReport(metrics, weekStart)
    const r2 = heuristicWeeklyMediaReport(metrics, weekStart)
    expect(r1).toEqual(r2)
    expect(r1.executiveSummary.length).toBeGreaterThan(0)
    expect(r1.hypotheses.length).toBeGreaterThan(0)
    expect(r1.ratings.length).toBeGreaterThan(0)
    expect(r1.ratings.length).toBeLessThanOrEqual(5)
    expect(r1.actions.length).toBeGreaterThanOrEqual(1)
    expect(r1.actions.length).toBeLessThanOrEqual(4)
  })

  it('アクションの判断は既定「未判断」・weeklyReportCounts が件数を導く', () => {
    const r = heuristicWeeklyMediaReport(metrics, weekStart)
    for (const a of r.actions) expect(a.decision).toBe('未判断')
    const counts = weeklyReportCounts(r)
    expect(counts.actions).toBe(r.actions.length)
    expect(counts.undecided).toBe(r.actions.length)
    expect(counts.changes).toBe(r.changes.length)
  })

  it('コンテンツ評価の語彙（◎○△× / ↗ー↘）を守る', () => {
    const r = heuristicWeeklyMediaReport(metrics, weekStart)
    for (const rating of r.ratings) {
      expect(['◎', '○', '△', '×']).toContain(rating.traffic)
      expect(['↗', 'ー', '↘']).toContain(rating.growth)
      expect(['◎', '○', '△', '×']).toContain(rating.cv)
      expect(rating.comment.length).toBeGreaterThan(0)
    }
  })
})

describe('改善施策（measureDraftFromAction / 検証 / AI 評価）', () => {
  const report = { id: 'mwr-1', channelId: 'ch-test', periodFrom: '2026-08-10', periodTo: '2026-08-16' }
  const action = {
    title: '内部リンクを追加', reason: '流入 +31%', expectedEffect: 'PV/Session 改善',
    priority: 'high' as const, decision: '実行する' as const,
  }

  it('reportSourceLabel は「YYYY/M/D〜M/D AI週次レポート」形式', () => {
    expect(reportSourceLabel(report)).toBe('2026/8/10〜8/16 AI週次レポート')
    expect(reportSourceLabel({ periodFrom: '2025-12-29', periodTo: '2026-01-04' }))
      .toBe('2025/12/29〜2026/1/4 AI週次レポート')
  })

  it('measureDraftFromAction はレポート内容から詳細を引き継ぐ（AI 生成 → 編集可の初期値）', () => {
    const d = measureDraftFromAction(report, action, 0)
    expect(d.name).toBe('内部リンクを追加')
    expect(d.background).toBe('流入 +31%')
    expect(d.expectedChange).toBe('PV/Session 改善')
    expect(d.status).toBe('実施予定')
    expect(d.sourceReportId).toBe('mwr-1')
    expect(d.sourceActionIndex).toBe(0)
    expect(d.sourceLabel).toBe('2026/8/10〜8/16 AI週次レポート')
    expect(d.verification.goal).toBe('PV/Session 改善')
  })

  it('mediaMeasureError: 施策名必須・ステータス語彙・期限形式', () => {
    const base = {
      channelId: 'ch-test', name: '施策', background: '', content: '', target: '',
      expectedChange: '', assigneeMemberId: 'm-01', dueDate: null, status: '実施予定',
    }
    expect(mediaMeasureError(base)).toBeNull()
    expect(mediaMeasureError({ ...base, name: ' ' })).toContain('施策名')
    expect(mediaMeasureError({ ...base, status: '進行中' })).toContain('ステータス')
    expect(mediaMeasureError({ ...base, dueDate: '2026/09/01' })).toContain('期限')
  })

  it('measureVerificationError: 人の最終評価と実施日の語彙・形式', () => {
    expect(measureVerificationError({ humanEvaluation: '効果あり' })).toBeNull()
    expect(measureVerificationError({ humanEvaluation: '' })).toBeNull()
    expect(measureVerificationError({ humanEvaluation: '大成功' as never })).toContain('最終評価')
    expect(measureVerificationError({ implementedOn: '2026-08-20' })).toBeNull()
    expect(measureVerificationError({ implementedOn: 'x' })).toContain('実施日')
  })

  it('heuristicMeasureEvaluation: 実施日前後の各 7 日で比較し AI 評価文を返す（決定的）', () => {
    const daily = dailyOf(28, i => ({ s: i < 14 ? 10 : 15, u: 5, c: 1 }))
    const measure = { name: '内部リンク', verification: { ...emptyVerification(), implementedOn: '2026-08-15' } }
    const r1 = heuristicMeasureEvaluation(measure, { daily })
    expect(r1).toEqual(heuristicMeasureEvaluation(measure, { daily }))
    expect(r1.comparePeriod).toContain('2026-08-15')
    expect(r1.beforeValue).toBe('70')
    expect(r1.afterValue).toBe('105')
    expect(r1.change).toBe('+50.0%')
    expect(r1.aiEvaluation).toContain('増加')
  })

  it('heuristicMeasureEvaluation: 実施日が窓に収まらない場合は直近 7 日 vs 前の 7 日で代替する', () => {
    const daily = dailyOf(28, () => ({ s: 10, u: 5, c: 1 }))
    const measure = { name: '施策', verification: { ...emptyVerification(), implementedOn: '2026-08-02' } }
    const r = heuristicMeasureEvaluation(measure, { daily })
    expect(r.comparePeriod).toContain('代替')
    expect(r.beforeValue).toBe('70')
    expect(r.afterValue).toBe('70')
  })
})
