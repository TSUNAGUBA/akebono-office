/**
 * データ取込の実行時変換の選択肢カタログ。実体は shared/domain/import-run.ts（API と共有 =
 * applyImportTransform と同居し 1:1 を保つ）。既存 import パス互換のための再エクスポート
 * （utils/import-parse・utils/import-link と同型）。
 */
export { IMPORT_TRANSFORMS } from '../../../shared/domain/import-run'
