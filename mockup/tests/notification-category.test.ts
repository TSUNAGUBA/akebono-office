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

  it('承認・稟議・エスカ以外は other', () => {
    expect(notificationCategoryOf(n({ kind: 'comment', link: '/reports' }))).toBe('other')
    expect(notificationCategoryOf(n({ kind: 'poipoi', link: '/poipoi' }))).toBe('other')
  })
})
