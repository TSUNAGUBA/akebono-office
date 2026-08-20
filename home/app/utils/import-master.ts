/**
 * 共通マスタ取込のカタログ＋値解析。実体は shared/domain/import-master.ts（API と共有）。
 * 既存 import パス互換のための再エクスポート（utils/import-link・import-run・import-parse と同型）。
 */
export {
  MASTER_IMPORT_DEFS, MASTER_IMPORT_ENTITIES, masterImportDefOf, parseMasterFieldValue,
} from '../../../shared/domain/import-master'
export type {
  MasterImportDef, MasterImportField, MasterImportFieldKind, MasterParsedValue, MasterParseResult,
} from '../../../shared/domain/import-master'
