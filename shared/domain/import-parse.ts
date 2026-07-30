/**
 * データ取込（F-32）の取込元解析（純粋関数・Vue/DB 非依存）。
 * CSV アップロード → 列（index＋論理名）抽出、JSON 貼付 → キー抽出。マッピング設定の左辺候補を作る。
 * 実ファイル/実 API の本番取込（SSRF 対策・大容量ストリーム等）は別途。ここは設定支援の軽量解析。
 */

/** CSV 1 行を区切り文字で分割（"…" 囲み・"" エスケープ対応の簡易パーサ） */
export function parseCsvLine(line: string, delimiter = ','): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQuotes = false
      } else cur += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

export interface CsvColumn { index: number; name: string }
export interface CsvParseResult { columns: CsvColumn[]; sampleRows: string[][] }

/**
 * CSV テキストを解析して列（0 始まり index ＋ 論理名）とサンプル行を返す。
 * hasHeader=true は 1 行目を項目名に使う（空セルは「列N」）。false は全行データ・名前は「列N」。
 */
export function parseCsvColumns(
  text: string,
  opts: { hasHeader?: boolean; delimiter?: string; sampleLimit?: number } = {},
): CsvParseResult {
  const delimiter = opts.delimiter || ','
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.length > 0)
  if (lines.length === 0) return { columns: [], sampleRows: [] }
  const hasHeader = opts.hasHeader ?? true
  const firstCells = parseCsvLine(lines[0]!, delimiter)
  const columns: CsvColumn[] = firstCells.map((c, i) => ({
    index: i,
    name: hasHeader ? (c.trim() || `列${i + 1}`) : `列${i + 1}`,
  }))
  const dataLines = hasHeader ? lines.slice(1) : lines
  const sampleRows = dataLines.slice(0, opts.sampleLimit ?? 3).map(l => parseCsvLine(l, delimiter))
  return { columns, sampleRows }
}

export interface JsonKeysResult { keys: string[]; recordCount: number; isArray: boolean }

/** ドットパスで JSON 配下を辿る（空文字/未指定は根） */
function atPath(value: unknown, path?: string): unknown {
  if (!path) return value
  let cur: unknown = value
  for (const seg of path.split('.').map(s => s.trim()).filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * JSON テキスト（配列 or 単一オブジェクト）を解析し、先頭レコードのキー一覧を返す。
 * rootPath 指定時はそのパス配下（配列 or オブジェクト）を対象にする。パース不可・非オブジェクトは throw。
 */
export function extractJsonKeys(text: string, rootPath?: string): JsonKeysResult {
  const parsed = atPath(JSON.parse(text) as unknown, rootPath)
  const isArray = Array.isArray(parsed)
  const records = isArray ? (parsed as unknown[]) : [parsed]
  if (records.length === 0) throw new Error('レコードがありません（空の配列です）')
  const first = records[0]
  if (first == null || typeof first !== 'object' || Array.isArray(first)) {
    throw new Error('先頭レコードがオブジェクトではありません')
  }
  return { keys: Object.keys(first as Record<string, unknown>), recordCount: records.length, isArray }
}

// ---------- 方式別設定・ロケータの正規化（フロント/API 共有 = 原則3。モック↔API の永続化形を揃える parity） ----------

export const IMPORT_AUTH_TYPES = ['none', 'bearer', 'api_key', 'basic'] as const

/** コードポイント単位の切詰め（api/lib/text.capCp と同一。サロゲート境界を壊さない） */
function capCp(s: string, n: number): string {
  return [...s].slice(0, n).join('')
}

/** 数値化（空文字・null・非数値は null）。CSV 列番号 / 固定長バイト範囲の正規化に使う（v-model.number の '' 対策） */
export function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export interface ImportFieldLocators {
  columnIndex: number | null
  byteStart: number | null
  byteEnd: number | null
  jsonKey: string | null
}

/** マッピング項目の方式別ロケータを正規化（数値でない値・空 jsonKey は null）。モック saveMapping / API importFieldsOf が共有 */
export function normalizeFieldLocators(raw: Record<string, unknown>): ImportFieldLocators {
  const jk = raw.jsonKey != null && String(raw.jsonKey).trim() ? capCp(String(raw.jsonKey).trim(), 200) : null
  return {
    columnIndex: numOrNull(raw.columnIndex),
    byteStart: numOrNull(raw.byteStart),
    byteEnd: numOrNull(raw.byteEnd),
    jsonKey: jk,
  }
}

/**
 * 取込元の方式別設定を method 別に正規化（使う項目のみ保持・不正 authType は none・none は authValue 空）。
 * モック（useAkebonoImports）と API（akebono-imports）が共有し、両モードで同一の config 形に揃える。
 * delimiter は 1 文字に切詰める（parseCsvLine が単一文字区切りのため 2 文字以上は無効）。
 */
export function normalizeImportSourceConfig(raw: unknown, method: string): Record<string, unknown> {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const cfg: Record<string, unknown> = {}
  if (method === 'file_csv') {
    cfg.hasHeader = o.hasHeader !== false // 既定 true
    cfg.delimiter = typeof o.delimiter === 'string' && o.delimiter.length > 0 ? o.delimiter.slice(0, 1) : ','
  }
  if (method === 'file_json' || method === 'api_pull') {
    if (typeof o.jsonRootPath === 'string' && o.jsonRootPath.trim()) cfg.jsonRootPath = capCp(o.jsonRootPath.trim(), 200)
  }
  if (method === 'api_pull') {
    cfg.endpoint = capCp(String(o.endpoint ?? '').trim(), 500)
    const at = (IMPORT_AUTH_TYPES as readonly string[]).includes(String(o.authType)) ? String(o.authType) : 'none'
    cfg.authType = at
    cfg.authValue = at === 'none' ? '' : capCp(String(o.authValue ?? '').trim(), 500)
  }
  return cfg
}
