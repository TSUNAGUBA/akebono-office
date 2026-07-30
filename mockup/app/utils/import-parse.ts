/**
 * データ取込の取込元解析（純粋関数）。実体は shared/domain/import-parse.ts（API と共有）。
 * 既存 import パス互換のための再エクスポート。
 */
export { parseCsvLine, parseCsvColumns, extractJsonKeys } from '../../../shared/domain/import-parse'
export type { CsvColumn, CsvParseResult, JsonKeysResult } from '../../../shared/domain/import-parse'
