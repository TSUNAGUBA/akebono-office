/**
 * データ取込（F-32）の実行時レコード抽出（純粋関数・Vue/DB 非依存。監査指摘 2026-07-30 ①の本実装）。
 * 取込元テキスト（CSV / 固定長 / JSON）+ マッピング定義 → 対象項目キー別の値レコード列へ変換する。
 * 反映（対象テーブルへの upsert・参照解決）は DB 依存のため API 側（routes/akebono-imports.ts）が担う。
 *
 * ロケータの規約（マッピング編集 UI = imports.vue と一致）:
 * - CSV: columnIndex（0 始まり）。null の場合はヘッダ行の列名 = sourceField で解決
 * - 固定長: byteStart / byteEnd（1 始まり・両端含む・バイト単位。Shift_JIS の全角 2 バイトを想定）
 * - JSON / API: jsonKey（ドットパス可）。null の場合は sourceField
 */
import { splitCsvRows } from './import-parse'

export interface ImportRunFieldDef {
  sourceField: string
  targetItemKey: string
  transform: string
  columnIndex: number | null
  byteStart: number | null
  byteEnd: number | null
  jsonKey: string | null
  /** 参照項目の突合キー（import-link）。抽出（本ファイル）では使わず、反映（API 側）の参照解決で使う。
   *  旧版マッピング（0053 以前の保存分）には存在しないため optional（下位互換 = 原則7） */
  lookupField?: string | null
}

export interface ImportRecord {
  /** データ行番号（ヘッダを除く 1 始まり。エラー報告用） */
  rowNo: number
  /** 元行の表示用テキスト（エラー隔離時の rawText。200 cp で切詰め） */
  raw: string
  /** targetItemKey → 変換適用後の文字列値 */
  values: Record<string, string>
}

export interface ImportExtractResult {
  records: ImportRecord[]
  /** マッピング定義レベルの問題（列が見つからない等。行の隔離ではなく実行前エラー） */
  mappingError: string | null
}

/** 1 回の取込で受け付ける最大データ行数（暴走・メモリ保護。超過は実行前エラー） */
export const MAX_IMPORT_ROWS = 5000

function capRaw(s: string): string {
  return [...s].slice(0, 200).join('')
}

/**
 * 値変換（transform 列)。対応: trim / number（¥・カンマ・空白を除去）/
 * date（YYYY/MM/DD・YYYY.MM.DD・YYYYMMDD → YYYY-MM-DD）/ upper / lower。
 * 未知の transform・空文字は素通し（前後空白のみ除去）
 */
export function applyImportTransform(value: string, transform: string): string {
  const v = value.trim()
  switch (transform) {
    case 'number':
      return v.replace(/[¥￥,\s]/g, '')
    case 'date': {
      const m = v.match(/^(\d{4})[/.\-]?(\d{1,2})[/.\-]?(\d{1,2})$/)
      if (!m) return v
      return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
    }
    case 'upper':
      return v.toUpperCase()
    case 'lower':
      return v.toLowerCase()
    case 'trim':
    default:
      return v
  }
}

/** CSV テキスト → レコード列。columnIndex 未設定の項目はヘッダ行の列名（sourceField 一致）で解決する */
export function extractCsvRecords(
  text: string,
  fields: ImportRunFieldDef[],
  opts: { hasHeader?: boolean; delimiter?: string } = {},
): ImportExtractResult {
  const delimiter = opts.delimiter || ','
  const hasHeader = opts.hasHeader ?? true
  // 引用符内の改行・区切りを保持した論理行分割（複数行セルで行/列がずれない = rowsToCsv 出力も安全）
  const rows = splitCsvRows(text, delimiter)
  if (rows.length === 0) return { records: [], mappingError: null }
  const header = hasHeader ? rows[0]!.map(h => h.trim()) : []
  const resolved: { field: ImportRunFieldDef; index: number }[] = []
  for (const f of fields) {
    let index = f.columnIndex
    if (index === null || index === undefined || index < 0) {
      const found = header.indexOf(f.sourceField)
      if (found < 0) {
        return { records: [], mappingError: `列「${f.sourceField}」を特定できません（列番号かヘッダ名が必要です）` }
      }
      index = found
    }
    resolved.push({ field: f, index })
  }
  const dataRows = hasHeader ? rows.slice(1) : rows
  const records: ImportRecord[] = dataRows.map((cells, i) => {
    const values: Record<string, string> = {}
    for (const { field, index } of resolved) {
      values[field.targetItemKey] = applyImportTransform(cells[index] ?? '', field.transform)
    }
    // raw（エラー表示用）は論理行のセルを区切りで再構成（複数行セルは 1 行に畳まれる）
    return { rowNo: i + 1, raw: capRaw(cells.join(delimiter)), values }
  })
  return { records, mappingError: null }
}

/**
 * 固定長テキスト → レコード列。バイト単位のスライスのため、呼び出し側が行ごとの生バイトと
 * デコーダを渡す（Shift_JIS の 2 バイト文字を文字数でなくバイト位置で切るため）。
 */
export function extractFixedRecords(
  lineBytes: Uint8Array[],
  fields: ImportRunFieldDef[],
  decode: (bytes: Uint8Array) => string,
): ImportExtractResult {
  for (const f of fields) {
    if (f.byteStart === null || f.byteEnd === null || f.byteStart < 1 || f.byteEnd < f.byteStart) {
      return { records: [], mappingError: `項目「${f.sourceField}」のバイト範囲（開始・終了）を設定してください` }
    }
  }
  const records: ImportRecord[] = lineBytes.map((bytes, i) => {
    const values: Record<string, string> = {}
    for (const f of fields) {
      const slice = bytes.subarray(f.byteStart! - 1, f.byteEnd!)
      values[f.targetItemKey] = applyImportTransform(decode(slice), f.transform)
    }
    return { rowNo: i + 1, raw: capRaw(decode(bytes)), values }
  })
  return { records, mappingError: null }
}

/** ドットパスで JSON 配下を辿る（import-parse.atPath と同一規約） */
function atPath(value: unknown, path: string): unknown {
  let cur: unknown = value
  for (const seg of path.split('.').map(s => s.trim()).filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** JSON テキスト（配列 or 単一オブジェクト。rootPath 配下可）→ レコード列 */
export function extractJsonRecords(
  text: string,
  fields: ImportRunFieldDef[],
  rootPath?: string,
): ImportExtractResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { records: [], mappingError: 'JSON を解析できませんでした（構文エラー）' }
  }
  const rooted = rootPath ? atPath(parsed, rootPath) : parsed
  if (rooted == null) return { records: [], mappingError: `ルートパス「${rootPath}」配下にデータがありません` }
  const items = Array.isArray(rooted) ? rooted : [rooted]
  const records: ImportRecord[] = []
  for (const [i, item] of items.entries()) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) continue
    const values: Record<string, string> = {}
    for (const f of fields) {
      const v = atPath(item, f.jsonKey ?? f.sourceField)
      values[f.targetItemKey] = applyImportTransform(v == null ? '' : String(v), f.transform)
    }
    records.push({ rowNo: i + 1, raw: capRaw(JSON.stringify(item)), values })
  }
  return { records, mappingError: null }
}
