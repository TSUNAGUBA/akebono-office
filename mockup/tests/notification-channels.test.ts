/**
 * 個人別マルチチャネル通知連携（改修依頼 2026-08-20）の純ロジック（shared/domain/notification-channels.ts）。
 * パース（JSON 文字列/オブジェクト両対応・壊れた値の無害化）、既定値（in_app=ON / 外部=OFF）、
 * serialize の最小化（既定値と同じセルの省略）と parse との往復不変を検証する。
 */
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_META, channelDefault, channelEnabled, CHAT_SERVICES, enabledExternalServices,
  NOTIFICATION_CHANNEL_TYPES, NOTIFICATION_MATRIX_KINDS,
  parseNotificationMatrix, serializeNotificationMatrix, setMatrixCell,
} from '../app/utils/notification-channels'

describe('parseNotificationMatrix', () => {
  it('JSON 文字列を受理する（mock / localStorage 経路）', () => {
    expect(parseNotificationMatrix('{"approval":{"slack":true,"in_app":false}}'))
      .toEqual({ approval: { slack: true, in_app: false } })
  })

  it('デシリアライズ済みオブジェクトをそのまま受理する（API モード / JSONB 経路）', () => {
    expect(parseNotificationMatrix({ reminder: { google_chat: true } }))
      .toEqual({ reminder: { google_chat: true } })
  })

  it('未設定・空文字・不正 JSON・非オブジェクトは {}（全セル既定値）', () => {
    expect(parseNotificationMatrix(undefined)).toEqual({})
    expect(parseNotificationMatrix(null)).toEqual({})
    expect(parseNotificationMatrix('')).toEqual({})
    expect(parseNotificationMatrix('{')).toEqual({})
    expect(parseNotificationMatrix('[1,2]')).toEqual({})
    expect(parseNotificationMatrix(42)).toEqual({})
  })

  it('未知の種別・チャネル・非 boolean 値は無害に落とす（原則7: 将来キー・壊れた値でも動く）', () => {
    expect(parseNotificationMatrix({
      approval: { slack: true, __future_channel__: true, in_app: 'yes' },
      __future_kind__: { slack: true },
      comment: 'broken',
      reminder: {},
    })).toEqual({ approval: { slack: true } })
  })
})

describe('channelEnabled（既定値）', () => {
  it('in_app は既定 ON / slack・google_chat は既定 OFF', () => {
    expect(channelDefault('in_app')).toBe(true)
    expect(channelDefault('slack')).toBe(false)
    expect(channelDefault('google_chat')).toBe(false)
    expect(channelEnabled({}, 'approval', 'in_app')).toBe(true)
    expect(channelEnabled({}, 'approval', 'slack')).toBe(false)
    expect(channelEnabled({}, 'poipoi', 'google_chat')).toBe(false)
  })

  it('設定済みセルは設定値を返す（in_app の明示 OFF も尊重）', () => {
    const m = { approval: { in_app: false, slack: true } }
    expect(channelEnabled(m, 'approval', 'in_app')).toBe(false)
    expect(channelEnabled(m, 'approval', 'slack')).toBe(true)
    // 他の種別は影響を受けない
    expect(channelEnabled(m, 'comment', 'in_app')).toBe(true)
    expect(channelEnabled(m, 'comment', 'slack')).toBe(false)
  })
})

describe('serializeNotificationMatrix（最小化）', () => {
  it('既定値と同じセルは書かない（4KB 上限対策）', () => {
    expect(serializeNotificationMatrix({
      approval: { in_app: true, slack: false, google_chat: false }, // 全て既定値 = 行ごと消える
      comment: { in_app: false, slack: true },
    })).toEqual({ comment: { in_app: false, slack: true } })
  })

  it('全セル既定値なら {} になる', () => {
    expect(serializeNotificationMatrix({ approval: { in_app: true }, system: { slack: false } })).toEqual({})
  })

  it('parse との往復で実効値（channelEnabled）が不変（オブジェクト・JSON 文字列の両経路）', () => {
    const original = { approval: { in_app: false, slack: true }, reminder: { google_chat: true, in_app: true } }
    for (const roundTripped of [
      parseNotificationMatrix(serializeNotificationMatrix(original)),
      parseNotificationMatrix(JSON.stringify(serializeNotificationMatrix(original))),
    ]) {
      for (const kind of NOTIFICATION_MATRIX_KINDS) {
        for (const channel of NOTIFICATION_CHANNEL_TYPES) {
          expect(channelEnabled(roundTripped, kind, channel)).toBe(channelEnabled(original, kind, channel))
        }
      }
    }
  })
})

describe('setMatrixCell', () => {
  it('セルを変更した新しいマトリクスを返す（元は不変・最小形へ正規化済み）', () => {
    const base = { approval: { slack: true } }
    const next = setMatrixCell(base, 'approval', 'google_chat', true)
    expect(next).toEqual({ approval: { slack: true, google_chat: true } })
    expect(base).toEqual({ approval: { slack: true } })
  })

  it('既定値へ戻す変更でセル（と空になった行）が消える = 取消フロー（原則9.5）', () => {
    expect(setMatrixCell({ approval: { slack: true } }, 'approval', 'slack', false)).toEqual({})
    expect(setMatrixCell({ approval: { in_app: false } }, 'approval', 'in_app', true)).toEqual({})
  })
})

describe('カタログ・配信判定', () => {
  it('行カタログは NotificationKind の全 7 種', () => {
    expect(NOTIFICATION_MATRIX_KINDS)
      .toEqual(['approval', 'comment', 'reminder', 'ai_report', 'system', 'escalation', 'poipoi'])
  })

  it('チャネルは in_app / slack / google_chat の 3 列でラベルを持つ', () => {
    expect(NOTIFICATION_CHANNEL_TYPES).toEqual(['in_app', 'slack', 'google_chat'])
    expect(CHAT_SERVICES).toEqual(['slack', 'google_chat'])
    expect(CHANNEL_META.in_app.label).toBe('アプリ内')
    expect(CHANNEL_META.slack.label).toBe('Slack')
    expect(CHANNEL_META.google_chat.label).toBe('Google Chat')
  })

  it('enabledExternalServices は ON の外部チャネルのみ返す（in_app は含めない）', () => {
    expect(enabledExternalServices({}, 'approval')).toEqual([])
    expect(enabledExternalServices({ approval: { slack: true, in_app: true } }, 'approval')).toEqual(['slack'])
    expect(enabledExternalServices({ approval: { slack: true, google_chat: true } }, 'approval'))
      .toEqual(['slack', 'google_chat'])
  })
})
