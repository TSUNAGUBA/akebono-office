/**
 * 通知タブ設定（何を表示するか）の純ロジック（utils/notification-tabs.ts）。
 * 解決順（ユーザー > テナント > 既定）とパース（カタログ外除去・重複除去・カタログ順整列・
 * 空配列の尊重・API モードの配列受理）を検証する。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_TAB_IDS, NOTIFICATION_TAB_CATALOG,
  notificationTabOf, notificationTabViews, parseNotificationTabIds, resolveNotificationTabIds,
} from '../app/utils/notification-tabs'

describe('parseNotificationTabIds', () => {
  it('カタログに存在する id のみ・重複除去し、カタログ順に整列して返す', () => {
    // 入力の並び（report が先）に関わらずカタログ順（approval → report）で返す
    expect(parseNotificationTabIds('["report","approval","report","__nope__"]'))
      .toEqual(['approval', 'report'])
  })

  it('未設定・空文字・不正 JSON・非配列は null', () => {
    expect(parseNotificationTabIds('')).toBeNull()
    expect(parseNotificationTabIds(undefined)).toBeNull()
    expect(parseNotificationTabIds(null)).toBeNull()
    expect(parseNotificationTabIds('{')).toBeNull()
    expect(parseNotificationTabIds('{"a":1}')).toBeNull()
    expect(parseNotificationTabIds(42)).toBeNull()
  })

  it('空配列は「カテゴリタブを出さない（= すべて のみ）」として尊重する（null ではない）', () => {
    expect(parseNotificationTabIds('[]')).toEqual([])
  })

  it('API モード（JSONB）でデシリアライズ済みの配列をそのまま受理する', () => {
    expect(parseNotificationTabIds(['minutes', 'customer-log', 'minutes']))
      .toEqual(['customer-log', 'minutes'])
    expect(parseNotificationTabIds([])).toEqual([])
  })
})

describe('resolveNotificationTabIds', () => {
  it('ユーザー設定を最優先する', () => {
    const r = resolveNotificationTabIds('["report"]', '["workflow"]')
    expect(r).toEqual({ ids: ['report'], scope: 'user' })
  })

  it('ユーザー未設定ならテナント設定', () => {
    const r = resolveNotificationTabIds('', '["workflow","minutes"]')
    expect(r).toEqual({ ids: ['workflow', 'minutes'], scope: 'tenant' })
  })

  it('どちらも未設定なら既定（カタログ全件）', () => {
    const r = resolveNotificationTabIds('', '')
    expect(r).toEqual({ ids: [...DEFAULT_NOTIFICATION_TAB_IDS], scope: 'default' })
  })

  it('ユーザーが空配列なら（テナントより優先して）カテゴリタブなし', () => {
    const r = resolveNotificationTabIds('[]', '["workflow"]')
    expect(r).toEqual({ ids: [], scope: 'user' })
  })
})

describe('カタログ', () => {
  it('既定は今回追加の 3 種（日報・顧客ログ・議事録）を含む', () => {
    expect(DEFAULT_NOTIFICATION_TAB_IDS).toEqual(
      expect.arrayContaining(['report', 'customer-log', 'minutes']))
  })

  it('notificationTabOf はカタログのラベルを返す', () => {
    expect(notificationTabOf('report')?.label).toBe('日報')
    expect(notificationTabOf('customer-log')?.label).toBe('顧客ログ')
    expect(notificationTabOf('minutes')?.label).toBe('議事録')
    expect(notificationTabOf('__nope__')).toBeUndefined()
  })

  it('カタログ id は NotificationCategory と一致（other を除く全カテゴリ）', () => {
    expect(NOTIFICATION_TAB_CATALOG.map(t => t.id))
      .toEqual(['escalation', 'approval', 'workflow', 'report', 'customer-log', 'minutes'])
  })
})

describe('notificationTabViews（通知欄と /inbox で順序共有）', () => {
  it('「すべて」を先頭に + 設定 id をそのまま並べる', () => {
    expect(notificationTabViews(['report', 'minutes'])).toEqual([
      { key: 'all', label: 'すべて' },
      { key: 'report', label: '日報' },
      { key: 'minutes', label: '議事録' },
    ])
  })
  it('空設定なら「すべて」のみ', () => {
    expect(notificationTabViews([])).toEqual([{ key: 'all', label: 'すべて' }])
  })
  it('ダッシュボード通知カードと /inbox が同じ入力から同じタブ順を得る（順序一致の保証）', () => {
    const ids = [...DEFAULT_NOTIFICATION_TAB_IDS]
    // 両画面ともこの純関数でタブ並びを組み立てるため、キー列は必ず一致する
    const keys = notificationTabViews(ids).map(v => v.key)
    expect(keys).toEqual(['all', 'escalation', 'approval', 'workflow', 'report', 'customer-log', 'minutes'])
  })
})
