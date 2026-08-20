import { describe, expect, it } from 'vitest'
import { resolveNotificationLink } from '../app/utils/notification-link'

describe('resolveNotificationLink（R1 #1: API モード通知の Home パス写像）', () => {
  it('/ai-company のタスクディープリンクを /tasks へ写像する', () => {
    expect(resolveNotificationLink('/ai-company?task=at-0001')).toBe('/tasks?task=at-0001')
    expect(resolveNotificationLink('/ai-company')).toBe('/tasks')
  })

  it('エスカレーション通知（/inbox?tab=escalations）をダッシュボードの対応パネルへ写像する', () => {
    expect(resolveNotificationLink('/inbox?tab=escalations&open=esc-0001')).toBe('/?open=esc-0001')
    expect(resolveNotificationLink('/inbox?tab=escalations')).toBe('/')
  })

  it('本アプリ内パス（モックモードの notify）はそのまま通す', () => {
    expect(resolveNotificationLink('/tasks?task=at-0002')).toBe('/tasks?task=at-0002')
    expect(resolveNotificationLink('/?open=esc-0002')).toBe('/?open=esc-0002')
    expect(resolveNotificationLink('/tokens')).toBe('/tokens')
  })

  it('Home 側ドメインの通知は null（呼び出し側が案内表示。404 遷移を作らない）', () => {
    expect(resolveNotificationLink('/inbox')).toBeNull()
    expect(resolveNotificationLink('/workflow?open=wf-1')).toBeNull()
    expect(resolveNotificationLink('/attendance')).toBeNull()
    // Home の /reports（日報）は本アプリの /reports（AI 日次報告）と同名別物のため写像しない
    expect(resolveNotificationLink('/reports')).toBeNull()
    expect(resolveNotificationLink('')).toBeNull()
  })
})
