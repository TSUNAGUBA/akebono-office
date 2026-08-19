/**
 * 日報・週報の表示補助（改修依頼 2026-08-19）の単体テスト。
 * - 改修9: 週報の例文定数（WEEKLY_REPORT_EXAMPLE）が 4 欄すべて内容を持ち、SoT の文面が壊れていないこと
 * - 改修8: 改善のタネの日付絞り込み純関数（poipoiPostsOnDay）が本人×日付で絞り、古い順に並ぶこと
 */
import { describe, expect, it } from 'vitest'
import { WEEKLY_REPORT_EXAMPLE } from '~/utils/weekly-report-templates'
import { poipoiPostsOnDay } from '~/utils/report-poipoi'

describe('WEEKLY_REPORT_EXAMPLE（週報の例文）', () => {
  it('挿入対象の 4 欄すべてに内容がある', () => {
    for (const key of ['goalReview', 'issues', 'goodPoints', 'nextWeek'] as const) {
      expect(WEEKLY_REPORT_EXAMPLE[key].trim().length).toBeGreaterThan(0)
    }
  })

  it('各欄の文面が指定どおり（要旨のキーフレーズを含む）', () => {
    expect(WEEKLY_REPORT_EXAMPLE.goalReview).toContain('顧客マスタの登録作業を完了')
    expect(WEEKLY_REPORT_EXAMPLE.issues).toContain('設定手順が複数箇所に分散')
    expect(WEEKLY_REPORT_EXAMPLE.goodPoints).toContain('確認項目を一覧化')
    expect(WEEKLY_REPORT_EXAMPLE.nextWeek).toContain('システム稼働に向けた事前準備')
    expect(WEEKLY_REPORT_EXAMPLE.nextWeek).toContain('ECサイトのアップデート')
  })

  it('来週の最重要テーマは 2 項目（改行区切りの ①②）で構成される', () => {
    const lines = WEEKLY_REPORT_EXAMPLE.nextWeek.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]?.startsWith('①')).toBe(true)
    expect(lines[1]?.startsWith('②')).toBe(true)
  })
})

describe('poipoiPostsOnDay（改善のタネの日付絞り込み）', () => {
  const posts = [
    { id: 'a', memberId: 'm1', createdAt: '2026-08-19T09:00:00+09:00' },
    { id: 'b', memberId: 'm1', createdAt: '2026-08-19T14:30:00+09:00' },
    { id: 'c', memberId: 'm2', createdAt: '2026-08-19T10:00:00+09:00' }, // 別人
    { id: 'd', memberId: 'm1', createdAt: '2026-08-18T23:59:00+09:00' }, // 別日
  ]

  it('本人 × 指定日のみを抽出し、作成時刻の昇順（古い順）に並べる', () => {
    const result = poipoiPostsOnDay(posts, 'm1', '2026-08-19')
    expect(result.map(p => p.id)).toEqual(['a', 'b'])
  })

  it('該当がない日は空配列（元配列は破壊しない）', () => {
    const snapshot = [...posts]
    expect(poipoiPostsOnDay(posts, 'm1', '2026-08-01')).toEqual([])
    expect(posts).toEqual(snapshot)
  })

  it('日付は createdAt 先頭 10 文字（YYYY-MM-DD）で判定する', () => {
    const result = poipoiPostsOnDay(posts, 'm2', '2026-08-19')
    expect(result.map(p => p.id)).toEqual(['c'])
  })
})
