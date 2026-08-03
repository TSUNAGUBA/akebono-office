import { describe, expect, it } from 'vitest'
import {
  a1ColToIndex, extractJsonKeys, normalizeFieldLocators, normalizeImportSourceConfig, numOrNull,
  parseCsvColumns, parseCsvLine, rowsToCsv,
} from '../../../shared/domain/import-parse'

describe('parseCsvLine（CSV 行分割）', () => {
  it('区切りで分割する', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c'])
  })
  it('クォート内の区切りは無視・"" はエスケープ', () => {
    expect(parseCsvLine('"a,1","b""x",c')).toEqual(['a,1', 'b"x', 'c'])
  })
  it('区切り文字を指定できる（タブ）', () => {
    expect(parseCsvLine('a\tb\tc', '\t')).toEqual(['a', 'b', 'c'])
  })
})

describe('parseCsvColumns（列と論理名の抽出）', () => {
  const csv = '売上日,商品コード,数量\n2026-01-01,ABC,3\n2026-01-02,XYZ,5'
  it('ヘッダ有り: 1 行目を論理名に、以降をサンプル行に', () => {
    const r = parseCsvColumns(csv, { hasHeader: true })
    expect(r.columns).toEqual([
      { index: 0, name: '売上日' }, { index: 1, name: '商品コード' }, { index: 2, name: '数量' },
    ])
    expect(r.sampleRows[0]).toEqual(['2026-01-01', 'ABC', '3'])
  })
  it('ヘッダ無し: 名前は「列N」・全行データ', () => {
    const r = parseCsvColumns(csv, { hasHeader: false })
    expect(r.columns.map(c => c.name)).toEqual(['列1', '列2', '列3'])
    expect(r.sampleRows.length).toBe(3)
  })
  it('空セルのヘッダは「列N」で補う', () => {
    expect(parseCsvColumns('a,,c', { hasHeader: true }).columns[1]).toEqual({ index: 1, name: '列2' })
  })
})

describe('extractJsonKeys（JSON キー抽出）', () => {
  it('配列: 先頭要素のキー', () => {
    const r = extractJsonKeys('[{"code":"A","name":"x"},{"code":"B"}]')
    expect(r).toEqual({ keys: ['code', 'name'], recordCount: 2, isArray: true })
  })
  it('単一オブジェクト: そのキー', () => {
    expect(extractJsonKeys('{"a":1,"b":2}')).toEqual({ keys: ['a', 'b'], recordCount: 1, isArray: false })
  })
  it('rootPath 配下の配列を対象にできる', () => {
    const r = extractJsonKeys('{"data":{"items":[{"sku":"S1"}]}}', 'data.items')
    expect(r.keys).toEqual(['sku'])
  })
  it('パース不可・非オブジェクトは throw', () => {
    expect(() => extractJsonKeys('not json')).toThrow()
    expect(() => extractJsonKeys('[1,2,3]')).toThrow()
  })
  it('空配列はレコードなしとして throw（先頭非オブジェクトと区別）', () => {
    expect(() => extractJsonKeys('[]')).toThrow('レコードがありません（空の配列です）')
  })
})

describe('numOrNull / normalizeFieldLocators（方式別ロケータの正規化 = モック↔API parity）', () => {
  it('numOrNull: 空文字・null・非数値は null・0 は保持', () => {
    expect(numOrNull('')).toBeNull()
    expect(numOrNull(null)).toBeNull()
    expect(numOrNull('x')).toBeNull()
    expect(numOrNull(0)).toBe(0)
    expect(numOrNull('12')).toBe(12)
  })
  it('v-model.number 由来の空文字ロケータを null へ落とす（M1 の回帰防止）', () => {
    // 固定長で開始/終了を空にした行 = '' が来ても number|null に正規化される
    expect(normalizeFieldLocators({ byteStart: '', byteEnd: '' }))
      .toEqual({ columnIndex: null, byteStart: null, byteEnd: null, jsonKey: null })
  })
  it('各ロケータを保持（columnIndex=0 も維持・空 jsonKey は null・trim）', () => {
    expect(normalizeFieldLocators({ columnIndex: 0, byteStart: 11, byteEnd: 20, jsonKey: ' code ' }))
      .toEqual({ columnIndex: 0, byteStart: 11, byteEnd: 20, jsonKey: 'code' })
    expect(normalizeFieldLocators({ jsonKey: '  ' }).jsonKey).toBeNull()
  })
})

describe('normalizeImportSourceConfig（取込元の方式別設定 = モック↔API parity）', () => {
  it('CSV: hasHeader 既定 true・delimiter 既定 ","・他方式の項目は落とす', () => {
    expect(normalizeImportSourceConfig({ endpoint: 'x', authValue: 'y' }, 'file_csv'))
      .toEqual({ hasHeader: true, delimiter: ',' })
    expect(normalizeImportSourceConfig({ hasHeader: false, delimiter: '\t' }, 'file_csv'))
      .toEqual({ hasHeader: false, delimiter: '\t' })
  })
  it('CSV: delimiter は 1 文字に切詰め（単一文字パーサに合わせる = m2）', () => {
    expect(normalizeImportSourceConfig({ delimiter: '||' }, 'file_csv').delimiter).toBe('|')
  })
  it('固定長: 保持する設定なし（空オブジェクト）', () => {
    expect(normalizeImportSourceConfig({ hasHeader: false, endpoint: 'x' }, 'file_fixed')).toEqual({})
  })
  it('API: endpoint・authType（不正は none）・authValue（none は空）・jsonRootPath', () => {
    expect(normalizeImportSourceConfig({ endpoint: 'https://x/y', authType: 'bearer', authValue: 'tok', jsonRootPath: 'd' }, 'api_pull'))
      .toEqual({ endpoint: 'https://x/y', authType: 'bearer', authValue: 'tok', jsonRootPath: 'd' })
    expect(normalizeImportSourceConfig({ authType: 'bogus', authValue: 'tok' }, 'api_pull'))
      .toEqual({ endpoint: '', authType: 'none', authValue: '' })
  })
  it('Sheets: ブック/シート・開始行/列を保持（他方式の項目は落とす）', () => {
    expect(normalizeImportSourceConfig(
      { spreadsheetId: 'ss1', spreadsheetName: '売上台帳', sheetName: '明細', headerRow: 2, startColumn: 'b', endpoint: 'x' },
      'sheets_pull',
    )).toEqual({ spreadsheetId: 'ss1', spreadsheetName: '売上台帳', sheetName: '明細', headerRow: 2, startColumn: 'B' })
  })
  it('Sheets: headerRow 既定 1（不正・範囲外）・startColumn 既定 A（非 A-Z）', () => {
    expect(normalizeImportSourceConfig({ headerRow: 0, startColumn: '1' }, 'sheets_pull'))
      .toEqual({ spreadsheetId: '', spreadsheetName: '', sheetName: '', headerRow: 1, startColumn: 'A' })
    expect(normalizeImportSourceConfig({ headerRow: 1.5, startColumn: 'AAAA' }, 'sheets_pull').headerRow).toBe(1)
    expect(normalizeImportSourceConfig({ startColumn: 'AAAA' }, 'sheets_pull').startColumn).toBe('A')
  })
})

describe('a1ColToIndex（A1 列 → 0 始まり index。Sheets 取込）', () => {
  it('単一列: A=0・C=2・Z=25', () => {
    expect(a1ColToIndex('A')).toBe(0)
    expect(a1ColToIndex('C')).toBe(2)
    expect(a1ColToIndex('Z')).toBe(25)
  })
  it('複数列: AA=26・AB=27・小文字/空白も許容', () => {
    expect(a1ColToIndex('AA')).toBe(26)
    expect(a1ColToIndex('AB')).toBe(27)
    expect(a1ColToIndex(' b ')).toBe(1)
  })
  it('不正（数値・空・記号）は 0（A 相当）', () => {
    expect(a1ColToIndex('1')).toBe(0)
    expect(a1ColToIndex('')).toBe(0)
    expect(a1ColToIndex('A1')).toBe(0)
  })
})

describe('rowsToCsv（2 次元セル → CSV。RFC4180 引用）', () => {
  it('通常セルはそのまま結合', () => {
    expect(rowsToCsv([['a', 'b'], ['1', '2']])).toBe('a,b\n1,2')
  })
  it('カンマ/引用符/改行を含むセルは "" 囲み・内部 " は ""', () => {
    expect(rowsToCsv([['a,1', 'b"x', 'c\nd']])).toBe('"a,1","b""x","c\nd"')
  })
  it('null/undefined セルは空文字', () => {
    expect(rowsToCsv([[null as unknown as string, undefined as unknown as string, 'x']])).toBe(',,x')
  })
})
