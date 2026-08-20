/**
 * ドメイン型定義の再エクスポート。
 * SoT は repo 直下 shared/domain/types.ts（フロントエンドと API サービスで共有）。
 * 既存の `~/types/domain` import を維持するためのシム。型の追加・変更は shared 側で行う。
 */
export * from '../../../shared/domain/types'
