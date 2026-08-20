/**
 * 通知カテゴリ判定（utils/notification-category.ts）。ダッシュボード通知欄と /inbox で共用する分類ロジック。
 */
import { describe, expect, it } from 'vitest'
import type { AppNotification } from '../app/types/domain'
import { notificationCategoryOf } from '../app/utils/notification-category'

function n(over: Partial<AppNotification>): AppNotification {
  return {
    id: 'nt-1', memberId: 'm-01', kind: 'approval', title: 't', body: 'b',
    link: '', read: false, at: '2026-08-01T09:00:00+09:00', ...over,
  }
}

describe('notificationCategoryOf', () => {
  it('kind=escalation はエスカレーション', () => {
    expect(notificationCategoryOf(n({ kind: 'escalation' }))).toBe('escalation')
  })

  it('リンク先が /workflow の通知は稟議（workflow）', () => {
    expect(notificationCategoryOf(n({ kind: 'approval', link: '/workflow' }))).toBe('workflow')
    expect(notificationCategoryOf(n({ kind: 'approval', link: '/workflow/wf-1' }))).toBe('workflow')
    expect(notificationCategoryOf(n({ kind: 'approval', link: '/workflow?tab=pending' }))).toBe('workflow')
  })

  it('それ以外の approval は承認依頼', () => {
    expect(notificationCategoryOf(n({ kind: 'approval', link: '/attendance?tab=requests' }))).toBe('approval')
    expect(notificationCategoryOf(n({ kind: 'approval', link: '' }))).toBe('approval')
  })

  it('リンク先が /reports の通知は日報（report）', () => {
    expect(notificationCategoryOf(n({ kind: 'comment', link: '/reports' }))).toBe('report')
    expect(notificationCategoryOf(n({ kind: 'reminder', link: '/reports?tab=weekly' }))).toBe('report')
  })

  it('リンク先が /weekly-report・/monthly-report の通知も report（改修依頼 2026-08-20: 独立パス）', () => {
    expect(notificationCategoryOf(n({ kind: 'reminder', link: '/weekly-report' }))).toBe('report')
    expect(notificationCategoryOf(n({ kind: 'reminder', link: '/weekly-report?tab=mine' }))).toBe('report')
    expect(notificationCategoryOf(n({ kind: 'reminder', link: '/monthly-report' }))).toBe('report')
    // 旧 /reports?kind=weekly リンクの既存通知も従来どおり report（下位互換）
    expect(notificationCategoryOf(n({ kind: 'reminder', link: '/reports?kind=weekly' }))).toBe('report')
  })

  it('リンク先が /customer-log の通知は顧客活動（customer-log）', () => {
    expect(notificationCategoryOf(n({ kind: 'comment', link: '/customer-log' }))).toBe('customer-log')
    expect(notificationCategoryOf(n({ kind: 'comment', link: '/customer-log/c-1' }))).toBe('customer-log')
  })

  it('リンク先が /minutes の通知は議事録（minutes）', () => {
    expect(notificationCategoryOf(n({ kind: 'reminder', link: '/minutes' }))).toBe('minutes')
  })

  it('リンク基準のカテゴリは approval 種別より優先する（日報の承認通知は report）', () => {
    expect(notificationCategoryOf(n({ kind: 'approval', link: '/reports' }))).toBe('report')
  })

  it('上記いずれにも該当しないものは other', () => {
    expect(notificationCategoryOf(n({ kind: 'ai_report', link: '/ai-company' }))).toBe('other')
    expect(notificationCategoryOf(n({ kind: 'poipoi', link: '/poipoi' }))).toBe('other')
  })
})
