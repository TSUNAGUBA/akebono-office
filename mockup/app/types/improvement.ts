/**
 * 改善要望ドメイン（F-42）の再エクスポート。
 * SoT は repo 直下 shared/domain/improvement.ts（フロントエンドと API サービスで共有）。
 * 型・純関数（集約・プロンプト組み立て・ステータス）を共有する。追加・変更は shared 側で行う。
 */
export * from '../../../shared/domain/improvement'
