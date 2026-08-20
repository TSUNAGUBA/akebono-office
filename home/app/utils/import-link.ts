/**
 * データ取込のマスタ間連携（突合キー）＋バリアント軸取込カタログ。実体は shared/domain/import-link.ts
 * （API と共有）。既存 import パス互換のための再エクスポート（utils/import-parse と同型）。
 */
export {
  IMPORT_REF_TARGETS, VARIANT_IMPORT_FIELDS,
  importRefTargetOf, isValidLookupField, lookupKeyLabel, validateImportMapping, variantAxisLabelsOf,
} from '../../../shared/domain/import-link'
export type { ImportRefFieldOption, ImportRefTarget } from '../../../shared/domain/import-link'
