/**
 * Phase D の純粋関数の単体テスト（DB 非依存）:
 * - importFieldsOf / 実取込の抽出・復号（データ取込 F-32。実取込 = 監査指摘 2026-07-30 ①）
 * - normalizeDashboardInsight（ダッシュボード AI レポートの LLM 出力正規化 F-41）
 */
import { describe, expect, it } from 'vitest'
import {
  applyImportTransform, extractCsvRecords, extractFixedRecords, extractJsonRecords, IMPORT_TRANSFORMS,
} from '../../../shared/domain/import-run'
import { decodeImportBytes, importFieldsOf, splitLineBytes } from '../../src/routes/akebono-imports'
import { normalizeDashboardInsight } from '../../src/routes/akebono-dashboard'

// 方式別ロケータ・突合キーの既定（未指定は全て null）
const NO_LOC = { columnIndex: null, byteStart: null, byteEnd: null, jsonKey: null, lookupField: null }

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
      { id: 'm1-f0', sourceField: '売上日', targetItemKey: 'soldAt', transform: '', ...NO_LOC, columnIndex: 0 },
      { id: 'm1-f1', sourceField: '金額', targetItemKey: 'amount', transform: '', ...NO_LOC, byteStart: 11, byteEnd: 20 },
      { id: 'm1-f2', sourceField: 'code', targetItemKey: 'code', transform: '', ...NO_LOC, jsonKey: 'code' },
    ])
  })

  it('数値でないロケータ・空 jsonKey は null に落とす', () => {
    const out = importFieldsOf('m1', [{ sourceField: 'a', targetItemKey: 'b', columnIndex: 'x', byteStart: '', jsonKey: '  ' }])
    expect(out).toEqual([{ id: 'm1-f0', sourceField: 'a', targetItemKey: 'b', transform: '', ...NO_LOC }])
  })

  it('突合キー lookupField を保持（空は null。0053 マスタ間連携キー）', () => {
    const out = importFieldsOf('m1', [
      { sourceField: 'customer', targetItemKey: 'companyId', lookupField: 'custom.extCode' },
      { sourceField: 'sku', targetItemKey: 'skuId', lookupField: '' },
    ])
    expect(out).toEqual([
      { id: 'm1-f0', sourceField: 'customer', targetItemKey: 'companyId', transform: '', ...NO_LOC, lookupField: 'custom.extCode' },
      { id: 'm1-f1', sourceField: 'sku', targetItemKey: 'skuId', transform: '', ...NO_LOC },
    ])
  })
})
// 注: normalizeImportSourceConfig の正規化テストは shared 直テストの import-parse.test.ts に集約（重複排除）

describe('applyImportTransform（値変換）', () => {
  it('number は ¥・カンマ・空白を除去、date は区切り差を YYYY-MM-DD へ正規化', () => {
    expect(applyImportTransform(' ¥12,300 ', 'number')).toBe('12300')
    expect(applyImportTransform('2026/7/3', 'date')).toBe('2026-07-03')
    expect(applyImportTransform('20260703', 'date')).toBe('2026-07-03')
    expect(applyImportTransform('2026.07.03', 'date')).toBe('2026-07-03')
    expect(applyImportTransform('not-a-date', 'date')).toBe('not-a-date')
  })
  it('date は時刻付き（日時）でも日付部分だけを取り出す（発生日 = timestamptz 由来の隔離を解消）', () => {
    expect(applyImportTransform('2026/08/09 19:40:48', 'date')).toBe('2026-08-09')
    expect(applyImportTransform('2026-08-09T19:40:48+09:00', 'date')).toBe('2026-08-09')
    expect(applyImportTransform('2026.8.9 0:00', 'date')).toBe('2026-08-09')
    expect(applyImportTransform('20260809 194048', 'date')).toBe('2026-08-09')
    // 時刻だけ・不正形式は素通し（呼び出し側の DATE_RE で隔離される = 従来どおり）
    expect(applyImportTransform('19:40:48', 'date')).toBe('19:40:48')
  })
  it('未知の transform・空は前後空白のみ除去', () => {
    expect(applyImportTransform('  abc ', '')).toBe('abc')
    expect(applyImportTransform('AbC', 'lower')).toBe('abc')
    expect(applyImportTransform('AbC', 'upper')).toBe('ABC')
  })
  it('IMPORT_TRANSFORMS（UI 選択肢カタログ）を現在の対応集合に固定（選択式化 2026-08-07）', () => {
    // カタログの value 集合を実装の switch 分岐（'' = 既定 / number / date / upper / lower）に固定する。
    // 注意: 逆方向（switch へ分岐を追加してカタログ更新を忘れる）は検出できない = 変換の追加時は
    // applyImportTransform・IMPORT_TRANSFORMS・本テストの 3 点を同時に更新すること（カタログのコメントにも明記）
    expect(IMPORT_TRANSFORMS.map(t => t.value)).toEqual(['', 'number', 'date', 'upper', 'lower'])
    // 全選択肢にラベル・説明があること（UI の「何が起きるか」表示の材料）
    for (const t of IMPORT_TRANSFORMS) {
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.hint.length).toBeGreaterThan(0)
    }
  })
})

const FIELD = { transform: '', columnIndex: null, byteStart: null, byteEnd: null, jsonKey: null }

describe('extractCsvRecords（CSV → レコード）', () => {
  it('列番号 or ヘッダ名で値を解決し、変換を適用する', () => {
    const { records, mappingError } = extractCsvRecords(
      'code,name,price\r\nP-1,りんご,"1,200"\nP-2,みかん,800\n',
      [
        { ...FIELD, sourceField: 'code', targetItemKey: 'code', columnIndex: 0 },
        { ...FIELD, sourceField: 'name', targetItemKey: 'name' }, // ヘッダ名で解決
        { ...FIELD, sourceField: 'price', targetItemKey: 'listPrice', transform: 'number' },
      ])
    expect(mappingError).toBeNull()
    expect(records).toHaveLength(2)
    expect(records[0]!.values).toEqual({ code: 'P-1', name: 'りんご', listPrice: '1200' })
    expect(records[1]!.rowNo).toBe(2)
  })
  it('列を特定できない項目はマッピングエラー（実行前に止める）', () => {
    const { mappingError } = extractCsvRecords('a,b\n1,2\n',
      [{ ...FIELD, sourceField: 'ない列', targetItemKey: 'code' }])
    expect(mappingError).toContain('ない列')
  })
  it('引用符内の改行を含むセルで行がずれない（rowsToCsv 出力の複数行セル = レビュー MAJOR 回帰）', () => {
    // 2 データ行。1 行目の note セルに埋め込み改行 → 行単位 split だと "2行目" が幻の行になっていた
    const csv = 'code,name,note\nP-1,商品A,"1行目\n2行目"\nP-2,商品B,ok\n'
    const { records } = extractCsvRecords(csv, [
      { ...FIELD, sourceField: 'code', targetItemKey: 'code', columnIndex: 0 },
      { ...FIELD, sourceField: 'note', targetItemKey: 'note', columnIndex: 2 },
    ])
    expect(records).toHaveLength(2)
    expect(records[0]!.values).toEqual({ code: 'P-1', note: '1行目\n2行目' })
    expect(records[1]!.values).toEqual({ code: 'P-2', note: 'ok' })
  })
  it('ヘッダ中央に空セルがあっても columnIndex は絶対位置で解決する（Sheets 誤列取込 = レビュー MAJOR 回帰）', () => {
    // ヘッダ ['売上日','','得意先'] のように中央が空。得意先は columnIndex=2（絶対位置）で読む
    const csv = '売上日,,得意先\n2026-07-01,x,アケボノ商店\n'
    const { records } = extractCsvRecords(csv, [
      { ...FIELD, sourceField: '売上日', targetItemKey: 'salesDate', columnIndex: 0 },
      { ...FIELD, sourceField: '得意先', targetItemKey: 'companyId', columnIndex: 2 },
    ])
    expect(records[0]!.values).toEqual({ salesDate: '2026-07-01', companyId: 'アケボノ商店' })
  })
})

describe('extractFixedRecords（固定長 → レコード）', () => {
  it('1 始まり両端含むバイト範囲でスライスする', () => {
    const lines = ['P-001東京  ', 'P-002大阪  '].map(l => new TextEncoder().encode(l))
    const decode = (b: Uint8Array): string => new TextDecoder().decode(b)
    const { records, mappingError } = extractFixedRecords(lines, [
      { ...FIELD, sourceField: 'コード', targetItemKey: 'code', byteStart: 1, byteEnd: 5 },
    ], decode)
    expect(mappingError).toBeNull()
    expect(records.map(r => r.values.code)).toEqual(['P-001', 'P-002'])
  })
  it('バイト範囲未設定はマッピングエラー', () => {
    const { mappingError } = extractFixedRecords([], [{ ...FIELD, sourceField: 'a', targetItemKey: 'b' }], () => '')
    expect(mappingError).toContain('バイト範囲')
  })
})

describe('extractJsonRecords（JSON → レコード）', () => {
  it('ルートパス配下の配列をレコード化し、jsonKey（ドットパス）で値を引く', () => {
    const { records, mappingError } = extractJsonRecords(
      JSON.stringify({ data: { items: [{ sku: { code: 'S-1' }, qty: 3 }, { sku: { code: 'S-2' }, qty: 5 }] } }),
      [
        { ...FIELD, sourceField: 'sku', targetItemKey: 'skuId', jsonKey: 'sku.code' },
        { ...FIELD, sourceField: 'qty', targetItemKey: 'qty' },
      ], 'data.items')
    expect(mappingError).toBeNull()
    expect(records.map(r => r.values)).toEqual([{ skuId: 'S-1', qty: '3' }, { skuId: 'S-2', qty: '5' }])
  })
  it('構文エラー・パス不在はマッピングエラー', () => {
    expect(extractJsonRecords('{oops', [], undefined).mappingError).toContain('構文')
    expect(extractJsonRecords('{"a":1}', [], 'b.c').mappingError).toContain('b.c')
  })
})

describe('decodeImportBytes / splitLineBytes（復号・行分割）', () => {
  it('utf8 復号と CRLF/LF 混在・空行スキップの行分割', () => {
    const buf = Buffer.from('あいう\r\nかきく\n\nさしす', 'utf8')
    const lines = splitLineBytes(buf)
    expect(lines.map(b => decodeImportBytes(Buffer.from(b), 'utf8'))).toEqual(['あいう', 'かきく', 'さしす'])
  })
  it('sjis 復号（ICU の shift_jis デコーダ）', () => {
    // 「テスト」の Shift_JIS バイト列
    const sjis = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67])
    expect(decodeImportBytes(sjis, 'sjis')).toBe('テスト')
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
