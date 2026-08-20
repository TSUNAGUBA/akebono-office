/**
 * ヘッダーのクイックアクセス（ヘッダーカスタマイズ）の純ロジック（utils/header-quick-access.ts）。
 * 解決順（ユーザー > テナント > 既定）と保存値パース（カタログ外除去・重複除去・空配列の尊重）を検証する。
 * 2026-08-18: 「通知（inbox）」ベルを候補・既定へ追加。保存形式を v2（{ v: 2, ids }）へ拡張し、
 * v1（素の id 配列 = inbox が候補になる前の保存値）は inbox を補完して下位互換とする（原則7）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUICK_ACCESS_IDS, parseQuickAccessIds, quickAccessItemOf,
  quickAccessPermPath, resolveQuickAccessIds, serializeQuickAccessIds,
} from '../app/utils/header-quick-access'

describe('parseQuickAccessIds（v1 = 素の配列。inbox 補完の下位互換）', () => {
  it('カタログに存在する id のみ・重複除去し、inbox を末尾に補完する', () => {
    expect(parseQuickAccessIds('["timecard","reports","timecard","__nope__"]'))
      .toEqual(['timecard', 'reports', 'inbox'])
  })

  it('v1 で既に inbox を含む場合は二重補完しない', () => {
    expect(parseQuickAccessIds('["inbox","timecard"]')).toEqual(['inbox', 'timecard'])
  })

  it('未設定・空文字・不正 JSON・非配列は null', () => {
    expect(parseQuickAccessIds('')).toBeNull()
    expect(parseQuickAccessIds(undefined)).toBeNull()
    expect(parseQuickAccessIds('{')).toBeNull()
    expect(parseQuickAccessIds('{"a":1}')).toBeNull()
    expect(parseQuickAccessIds(42)).toBeNull()
    expect(parseQuickAccessIds(null)).toBeNull()
  })

  it('v1 の空配列は「ベルのみ」= 保存当時の見え方を維持する（ベルは常時表示だった）', () => {
    expect(parseQuickAccessIds('[]')).toEqual(['inbox'])
  })

  it('API モード（JSONB）でデシリアライズ済みの配列をそのまま受理する（実障害の回帰）', () => {
    // /v1/me の prefs は JSONB のため、文字列ではなく配列が渡る。
    // 文字列限定だと null 扱いになり「ヘッダーの表示設定が反映されない」不具合になっていた。
    expect(parseQuickAccessIds(['timecard', 'reports', 'timecard', '__nope__']))
      .toEqual(['timecard', 'reports', 'inbox'])
  })
})

describe('parseQuickAccessIds（v2 = { v: 2, ids }。通知を外す選択を保存できる）', () => {
  it('v2 は補完せず保存値をそのまま尊重する（inbox なし = ベル非表示）', () => {
    expect(parseQuickAccessIds('{"v":2,"ids":["timecard","reports"]}'))
      .toEqual(['timecard', 'reports'])
    expect(parseQuickAccessIds({ v: 2, ids: ['timecard'] })).toEqual(['timecard'])
  })

  it('v2 の空配列は「何も表示しない」設定として尊重する', () => {
    expect(parseQuickAccessIds({ v: 2, ids: [] })).toEqual([])
  })

  it('v2 でもカタログ外 id・重複は除去する', () => {
    expect(parseQuickAccessIds({ v: 2, ids: ['inbox', '__nope__', 'inbox', 'reports'] }))
      .toEqual(['inbox', 'reports'])
  })

  it('v が数値でない・ids が配列でないオブジェクトは null', () => {
    expect(parseQuickAccessIds({ v: '2', ids: [] })).toBeNull()
    expect(parseQuickAccessIds({ v: 2, ids: 'timecard' })).toBeNull()
  })

  it('未知の将来バージョン（v3 等）は null = 既定へフォールバック（誤読して空扱いにしない）', () => {
    expect(parseQuickAccessIds({ v: 3, ids: [{ id: 'timecard' }] })).toBeNull()
    expect(parseQuickAccessIds({ v: 3, ids: ['timecard'] })).toBeNull()
  })
})

describe('serializeQuickAccessIds', () => {
  it('v2 形式（{ v: 2, ids }）でカタログ外除去・重複除去して返す', () => {
    expect(serializeQuickAccessIds(['timecard', '__nope__', 'timecard']))
      .toEqual({ v: 2, ids: ['timecard'] })
  })

  it('serialize → parse で保存値が往復する（inbox を外す選択が保持される）', () => {
    const saved = serializeQuickAccessIds(['timecard', 'reports'])
    expect(parseQuickAccessIds(JSON.stringify(saved))).toEqual(['timecard', 'reports'])
  })
})

describe('resolveQuickAccessIds', () => {
  it('ユーザー設定を最優先する', () => {
    const r = resolveQuickAccessIds({ v: 2, ids: ['reports'] }, { v: 2, ids: ['workflow'] })
    expect(r).toEqual({ ids: ['reports'], scope: 'user' })
  })

  it('ユーザー未設定ならテナント設定', () => {
    const r = resolveQuickAccessIds('', { v: 2, ids: ['workflow'] })
    expect(r).toEqual({ ids: ['workflow'], scope: 'tenant' })
  })

  it('どちらも未設定なら既定（タイムカード + 通知ベル）', () => {
    const r = resolveQuickAccessIds('', '')
    expect(r).toEqual({ ids: [...DEFAULT_QUICK_ACCESS_IDS], scope: 'default' })
    expect(DEFAULT_QUICK_ACCESS_IDS).toContain('inbox')
  })

  it('ユーザーが v2 空配列なら（テナントより優先して）何も表示しない', () => {
    const r = resolveQuickAccessIds({ v: 2, ids: [] }, { v: 2, ids: ['workflow'] })
    expect(r).toEqual({ ids: [], scope: 'user' })
  })

  it('v1（旧）保存のユーザー設定は inbox 補完付きで解決される（下位互換）', () => {
    const r = resolveQuickAccessIds('["reports"]', '')
    expect(r).toEqual({ ids: ['reports', 'inbox'], scope: 'user' })
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

  it('通知（inbox）は /inbox への導線としてカタログに存在する（2026-08-18）', () => {
    const ib = quickAccessItemOf('inbox')
    expect(ib?.to).toBe('/inbox')
    expect(quickAccessPermPath(ib!)).toBe('/inbox')
  })
})
