/**
 * 個人別マルチチャネル通知連携（改修依頼 2026-08-20）の純ロジック。
 * - 配信エンジンのバックオフ計算（lib/notify backoffDelays。外部 HTTP はテストしない設計 =
 *   送信関数は fetch へ薄く委譲し、判定・遅延計算を純関数へ分離してテストする）
 * - チャネル判定（shared/domain/notification-channels。in_app 既定 ON / 外部 既定 OFF）
 */
import { describe, expect, it } from 'vitest'
import {
  channelEnabled, enabledExternalServices, parseNotificationMatrix, serializeNotificationMatrix,
} from '../../../shared/domain/notification-channels'
import { backoffDelays } from '../../src/lib/notify'

describe('backoffDelays（5xx / 429 の指数バックオフ）', () => {
  it('既定は 1s→2s→4s の計 3 回', () => {
    expect(backoffDelays()).toEqual([1000, 2000, 4000])
  })

  it('回数指定に応じて 2 倍ずつ伸びる', () => {
    expect(backoffDelays(1)).toEqual([1000])
    expect(backoffDelays(4)).toEqual([1000, 2000, 4000, 8000])
    expect(backoffDelays(0)).toEqual([])
  })
})

describe('配信チャネル判定（通知マトリクス）', () => {
  it('未設定（空マトリクス）はアプリ内のみ = 外部配信なし（既定 ON/OFF）', () => {
    const matrix = parseNotificationMatrix(undefined)
    expect(channelEnabled(matrix, 'approval', 'in_app')).toBe(true)
    expect(enabledExternalServices(matrix, 'approval')).toEqual([])
  })

  it('user_preferences（JSONB = デシリアライズ済みオブジェクト）の保存値で外部チャネルが有効化される', () => {
    const matrix = parseNotificationMatrix({ approval: { slack: true, in_app: false } })
    expect(channelEnabled(matrix, 'approval', 'in_app')).toBe(false) // in_app の明示 OFF = INSERT スキップ
    expect(enabledExternalServices(matrix, 'approval')).toEqual(['slack'])
    // 設定していない種別は既定のまま
    expect(channelEnabled(matrix, 'system', 'in_app')).toBe(true)
    expect(enabledExternalServices(matrix, 'system')).toEqual([])
  })

  it('壊れた保存値は {} = fail-safe にアプリ内のみへフォールバック', () => {
    const matrix = parseNotificationMatrix('{broken json')
    expect(channelEnabled(matrix, 'reminder', 'in_app')).toBe(true)
    expect(enabledExternalServices(matrix, 'reminder')).toEqual([])
  })

  it('serialize は既定値セルを落とし、実効値は往復で不変（PUT /matrix の正規化と同じ経路）', () => {
    const saved = serializeNotificationMatrix({ reminder: { in_app: true, google_chat: true, slack: false } })
    expect(saved).toEqual({ reminder: { google_chat: true } })
    const restored = parseNotificationMatrix(JSON.stringify(saved))
    expect(channelEnabled(restored, 'reminder', 'google_chat')).toBe(true)
    expect(channelEnabled(restored, 'reminder', 'in_app')).toBe(true)
    expect(channelEnabled(restored, 'reminder', 'slack')).toBe(false)
  })
})
