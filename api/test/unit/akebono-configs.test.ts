/**
 * Akebono 設定系の純粋関数（routes/akebono.ts エクスポート）の単体テスト（Phase B = 0031）。
 * - appConfigRowsOf: 業態×アプリ設定のバッチ upsert 入力。重複 (segmentId, appKey) の後勝ち畳み込み
 *   （単一 upsert 文の「cannot affect row a second time」防止）と件数・長さの境界を検証する
 * - itemSettingPatchOf: 部分 upsert は「body に実在するキーのみ」（Object.hasOwn。CLAUDE.md の
 *   Zod v4 注意と同型 = 送っていないフィールドが更新対象に**含まれない**ことをアサートする）。
 *   null は「カタログ既定へ戻す」明示値として通す
 */
import { describe, expect, it } from 'vitest'
import { appConfigRowsOf, itemSettingPatchOf } from '../../src/routes/akebono'

describe('appConfigRowsOf（業態×アプリ設定のバッチ入力検証）', () => {
  it('正常系: 正規化して返す（enabled は === true のみ true・labelOverride は trim・source 既定 manual）', () => {
    const rows = appConfigRowsOf({
      rows: [
        { segmentId: 'seg-01', appKey: 'sales', enabled: true, labelOverride: '  受注管理  ', source: 'preset' },
        { segmentId: 'seg-02', appKey: 'inventory', enabled: 'yes', labelOverride: '', source: 'unknown' },
      ],
    })
    expect(rows).toEqual([
      { segmentId: 'seg-01', appKey: 'sales', enabled: true, labelOverride: '受注管理', source: 'preset' },
      { segmentId: 'seg-02', appKey: 'inventory', enabled: false, labelOverride: null, source: 'manual' },
    ])
  })

  it('同一 (segmentId, appKey) の重複行は後勝ちで 1 行に畳む', () => {
    const rows = appConfigRowsOf({
      rows: [
        { segmentId: 'seg-01', appKey: 'sales', enabled: false },
        { segmentId: 'seg-01', appKey: 'sales', enabled: true, labelOverride: '後勝ち' },
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows?.[0]).toMatchObject({ enabled: true, labelOverride: '後勝ち' })
  })

  it('labelOverride は 60 コードポイントで打ち切る', () => {
    const rows = appConfigRowsOf({
      rows: [{ segmentId: 'seg-01', appKey: 'sales', enabled: true, labelOverride: 'あ'.repeat(100) }],
    })
    expect(rows?.[0]?.labelOverride).toBe('あ'.repeat(60))
  })

  it('不正入力は null（= AKO-GEN-001）: rows 欠落・空配列・201 件・キー欠落・長さ超過・非オブジェクト行', () => {
    expect(appConfigRowsOf({})).toBeNull()
    expect(appConfigRowsOf({ rows: [] })).toBeNull()
    expect(appConfigRowsOf({ rows: 'x' })).toBeNull()
    const many = Array.from({ length: 201 }, (_, i) => ({ segmentId: `seg-${i}`, appKey: 'a', enabled: true }))
    expect(appConfigRowsOf({ rows: many })).toBeNull()
    expect(appConfigRowsOf({ rows: [{ segmentId: '', appKey: 'sales' }] })).toBeNull()
    expect(appConfigRowsOf({ rows: [{ segmentId: 'seg-01', appKey: '' }] })).toBeNull()
    expect(appConfigRowsOf({ rows: [{ segmentId: 's'.repeat(65), appKey: 'sales' }] })).toBeNull()
    expect(appConfigRowsOf({ rows: [{ segmentId: 'seg-01', appKey: 'a'.repeat(41) }] })).toBeNull()
    expect(appConfigRowsOf({ rows: [null] })).toBeNull()
  })

  it('200 件ちょうどは許容する（境界）', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ segmentId: `seg-${i}`, appKey: 'a', enabled: true }))
    expect(appConfigRowsOf({ rows: many })).toHaveLength(200)
  })
})

describe('itemSettingPatchOf（項目カスタマイズの部分 upsert キーフィルタ）', () => {
  it('body に実在するキーのみを返す = 送っていないフィールドは更新対象に含まれない', () => {
    const patch = itemSettingPatchOf({ formVisible: false })
    expect(patch).toEqual({ formVisible: false })
    expect(Object.hasOwn(patch!, 'listVisible')).toBe(false)
    expect(Object.hasOwn(patch!, 'formRequired')).toBe(false)
    expect(Object.hasOwn(patch!, 'displayOrder')).toBe(false)
    expect(Object.hasOwn(patch!, 'labelOverride')).toBe(false)
  })

  it('null は「カタログ既定へ戻す」明示値として通す（差分テーブルの意味論）', () => {
    expect(itemSettingPatchOf({ formVisible: null, labelOverride: null, displayOrder: null }))
      .toEqual({ formVisible: null, labelOverride: null, displayOrder: null })
  })

  it('labelOverride は trim + 60 コードポイント打ち切り。空白のみは null（= 既定へ戻す）', () => {
    expect(itemSettingPatchOf({ labelOverride: '  品名  ' })).toEqual({ labelOverride: '品名' })
    expect(itemSettingPatchOf({ labelOverride: '   ' })).toEqual({ labelOverride: null })
    expect(itemSettingPatchOf({ labelOverride: 'あ'.repeat(100) })).toEqual({ labelOverride: 'あ'.repeat(60) })
  })

  it('displayOrder は整数（絶対値 10000 以下）のみ許容', () => {
    expect(itemSettingPatchOf({ displayOrder: 3 })).toEqual({ displayOrder: 3 })
    expect(itemSettingPatchOf({ displayOrder: -10_000 })).toEqual({ displayOrder: -10_000 })
    expect(itemSettingPatchOf({ displayOrder: 10_001 })).toBeNull()
    expect(itemSettingPatchOf({ displayOrder: 1.5 })).toBeNull()
    expect(itemSettingPatchOf({ displayOrder: 'x' })).toBeNull()
  })

  it('bool フィールドの型崩れは null（= AKO-GEN-001）。文字列 "true" は通さない', () => {
    expect(itemSettingPatchOf({ formVisible: 'true' })).toBeNull()
    expect(itemSettingPatchOf({ listVisible: 1 })).toBeNull()
    expect(itemSettingPatchOf({ labelOverride: 5 })).toBeNull()
  })

  it('空 body は空 patch（キー無し）を返す（呼び出し側で「変更なし」を判定できる）', () => {
    const patch = itemSettingPatchOf({})
    expect(patch).toEqual({})
  })
})
