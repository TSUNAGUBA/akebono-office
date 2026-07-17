/**
 * 勤怠計算の再エクスポート。
 * SoT は repo 直下 shared/domain/attendance-calc.ts（フロントエンドと API サービスで共有）。
 * 既存の `~/utils/attendance-calc` import を維持するためのシム。ロジック変更は shared 側で行う。
 */
export * from '../../../shared/domain/attendance-calc'
