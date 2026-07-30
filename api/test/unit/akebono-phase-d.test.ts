/**
 * Phase D の純粋関数の単体テスト（DB 非依存）:
 * - importFieldsOf / simulateRun（データ取込 F-32）
 * - normalizeDashboardInsight（ダッシュボード AI レポートの LLM 出力正規化 F-41）
 */
import { describe, expect, it } from 'vitest'
import { importFieldsOf, simulateRun } from '../../src/routes/akebono-imports'
import { normalizeDashboardInsight } from '../../src/routes/akebono-dashboard'

// 方式別ロケータの既定（未指定は全て null）
const NO_LOC = { columnIndex: null, byteStart: null, byteEnd: null, jsonKey: null }

describe('importFieldsOf（マッピング項目の検証・正規化）', () => {
  it('配列でなければ null', () => {
    expect(importFieldsOf('m1', null)).toBeNull()
    expect(importFieldsOf('m1', {})).toBeNull()
  })

  it('sourceField / targetItemKey が空の行は捨て、残りに連番 id を付与', () => {
    const out = importFieldsOf('m1', [
      { sourceField: 'code', targetItemKey: 'code', transform: 'trim' },
      { sourceField: '', targetItemKey: 'x' }, // 捨てる
      { sourceField: 'price', targetItemKey: 'unitPrice', transform: 'number' },
    ])
    expect(out).toEqual([
      { id: 'm1-f0', sourceField: 'code', targetItemKey: 'code', transform: 'trim', ...NO_LOC },
      { id: 'm1-f1', sourceField: 'price', targetItemKey: 'unitPrice', transform: 'number', ...NO_LOC },
    ])
  })

  it('有効行が 0 なら null（AKO-IMP-003 の契機）', () => {
    expect(importFieldsOf('m1', [{ sourceField: '', targetItemKey: '' }])).toBeNull()
    expect(importFieldsOf('m1', [])).toBeNull()
  })

  it('transform 未指定は空文字・空白はトリム', () => {
    const out = importFieldsOf('m1', [{ sourceField: '  a ', targetItemKey: ' b ' }])
    expect(out).toEqual([{ id: 'm1-f0', sourceField: 'a', targetItemKey: 'b', transform: '', ...NO_LOC }])
  })

  it('方式別ロケータ（CSV 列番号 / 固定長バイト範囲 / JSON キー）を保持', () => {
    const out = importFieldsOf('m1', [
      { sourceField: '売上日', targetItemKey: 'soldAt', columnIndex: 0 },
      { sourceField: '金額', targetItemKey: 'amount', byteStart: 11, byteEnd: 20 },
      { sourceField: 'code', targetItemKey: 'code', jsonKey: 'code' },
    ])
    expect(out).toEqual([
      { id: 'm1-f0', sourceField: '売上日', targetItemKey: 'soldAt', transform: '', columnIndex: 0, byteStart: null, byteEnd: null, jsonKey: null },
      { id: 'm1-f1', sourceField: '金額', targetItemKey: 'amount', transform: '', columnIndex: null, byteStart: 11, byteEnd: 20, jsonKey: null },
      { id: 'm1-f2', sourceField: 'code', targetItemKey: 'code', transform: '', columnIndex: null, byteStart: null, byteEnd: null, jsonKey: 'code' },
    ])
  })

  it('数値でないロケータ・空 jsonKey は null に落とす', () => {
    const out = importFieldsOf('m1', [{ sourceField: 'a', targetItemKey: 'b', columnIndex: 'x', byteStart: '', jsonKey: '  ' }])
    expect(out).toEqual([{ id: 'm1-f0', sourceField: 'a', targetItemKey: 'b', transform: '', ...NO_LOC }])
  })
})
// 注: normalizeImportSourceConfig の正規化テストは shared 直テストの import-parse.test.ts に集約（重複排除）

describe('simulateRun（取込実行の決定的シミュレート）', () => {
  it('runIndex ごとに staged/failed が決定的（applied = staged − failed・failed>0 で隔離行 1 件）', () => {
    expect(simulateRun(0)).toEqual({ counts: { staged: 10, applied: 10, skipped: 0, failed: 0 }, errors: [] })
    const r1 = simulateRun(1)
    expect(r1.counts).toEqual({ staged: 17, applied: 16, skipped: 0, failed: 1 })
    expect(r1.errors).toHaveLength(1)
    expect(simulateRun(2).counts).toEqual({ staged: 24, applied: 22, skipped: 0, failed: 2 })
    // runIndex=3 は staged が周回して 10・failed=0（境界: (3*7)%21=0）
    expect(simulateRun(3).counts).toEqual({ staged: 10, applied: 10, skipped: 0, failed: 0 })
  })
})

describe('normalizeDashboardInsight（LLM 出力 → DashboardInsight）', () => {
  it('executiveSummary 欠落は null（= ヒューリスティックへフォールバック）', () => {
    expect(normalizeDashboardInsight(null)).toBeNull()
    expect(normalizeDashboardInsight({ findings: [], actions: [] })).toBeNull()
    expect(normalizeDashboardInsight({ executiveSummary: '   ' })).toBeNull()
  })

  it('findings/actions を正規化（不正 kind/priority は既定へ・title 空は捨て・最大 6 件）', () => {
    const out = normalizeDashboardInsight({
      executiveSummary: 'レポート本文',
      findings: [
        { kind: 'win', title: '好調', detail: 'd1' },
        { kind: 'bogus', title: '不明種別は opportunity へ', detail: 'd2' },
        { kind: 'issue', title: '', detail: '空タイトルは捨てる' },
      ],
      actions: [
        { title: 'A', detail: 'da', priority: 'high' },
        { title: 'B', detail: 'db', priority: 'bogus' }, // 既定 mid
      ],
    })
    expect(out).not.toBeNull()
    expect(out!.executiveSummary).toBe('レポート本文')
    expect(out!.findings).toEqual([
      { kind: 'win', title: '好調', detail: 'd1' },
      { kind: 'opportunity', title: '不明種別は opportunity へ', detail: 'd2' },
    ])
    expect(out!.actions).toEqual([
      { title: 'A', detail: 'da', priority: 'high' },
      { title: 'B', detail: 'db', priority: 'mid' },
    ])
  })

  it('findings/actions が配列でなくても空配列で通す（本文があれば有効）', () => {
    const out = normalizeDashboardInsight({ executiveSummary: '本文のみ', findings: null, actions: 'x' })
    expect(out).toEqual({ executiveSummary: '本文のみ', findings: [], actions: [] })
  })
})
