/**
 * ヘッダーのクイックアクセス（ヘッダーカスタマイズ）の純ロジック（utils/header-quick-access.ts）。
 * 解決順（ユーザー > テナント > 既定）と保存値パース（カタログ外除去・重複除去・空配列の尊重）を検証する。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUICK_ACCESS_IDS, parseQuickAccessIds, quickAccessItemOf,
  quickAccessPermPath, resolveQuickAccessIds,
} from '../app/utils/header-quick-access'

describe('parseQuickAccessIds', () => {
  it('カタログに存在する id のみ・重複除去して返す', () => {
    expect(parseQuickAccessIds('["timecard","reports","timecard","__nope__"]'))
      .toEqual(['timecard', 'reports'])
  })

  it('未設定・空文字・不正 JSON・非配列は null', () => {
    expect(parseQuickAccessIds('')).toBeNull()
    expect(parseQuickAccessIds(undefined)).toBeNull()
    expect(parseQuickAccessIds('{')).toBeNull()
    expect(parseQuickAccessIds('{"a":1}')).toBeNull()
    expect(parseQuickAccessIds(42)).toBeNull()
  })

  it('空配列は「クイックアクセスを出さない」設定として尊重する（null ではない）', () => {
    expect(parseQuickAccessIds('[]')).toEqual([])
  })

  it('API モード（JSONB）でデシリアライズ済みの配列をそのまま受理する（実障害の回帰）', () => {
    // /v1/me の prefs は JSONB のため、文字列ではなく配列が渡る。
    // 文字列限定だと null 扱いになり「ヘッダーの表示設定が反映されない」不具合になっていた。
    expect(parseQuickAccessIds(['timecard', 'reports', 'timecard', '__nope__']))
      .toEqual(['timecard', 'reports'])
    expect(parseQuickAccessIds([])).toEqual([])
  })

  it('配列以外・null・undefined は null', () => {
    expect(parseQuickAccessIds(null)).toBeNull()
    expect(parseQuickAccessIds(undefined)).toBeNull()
    expect(parseQuickAccessIds({ a: 1 })).toBeNull()
  })
})

describe('resolveQuickAccessIds', () => {
  it('ユーザー設定を最優先する', () => {
    const r = resolveQuickAccessIds('["reports"]', '["workflow"]')
    expect(r).toEqual({ ids: ['reports'], scope: 'user' })
  })

  it('ユーザー未設定ならテナント設定', () => {
    const r = resolveQuickAccessIds('', '["workflow"]')
    expect(r).toEqual({ ids: ['workflow'], scope: 'tenant' })
  })

  it('どちらも未設定なら既定', () => {
    const r = resolveQuickAccessIds('', '')
    expect(r).toEqual({ ids: [...DEFAULT_QUICK_ACCESS_IDS], scope: 'default' })
  })

  it('ユーザーが空配列なら（テナントより優先して）何も表示しない', () => {
    const r = resolveQuickAccessIds('[]', '["workflow"]')
    expect(r).toEqual({ ids: [], scope: 'user' })
  })
})

describe('カタログ参照', () => {
  it('既定のタイムカードは打刻アクション + /attendance 権限判定', () => {
    const tc = quickAccessItemOf('timecard')
    expect(tc?.action).toBe('punch')
    expect(quickAccessPermPath(tc!)).toBe('/attendance')
  })

  it('ページ導線の権限パスは to を使う', () => {
    const rp = quickAccessItemOf('reports')
    expect(quickAccessPermPath(rp!)).toBe('/reports')
  })
})
