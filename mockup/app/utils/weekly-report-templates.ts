/**
 * 週報の例文（改修依頼 2026-08-19。SoT = 本ファイル）。
 * 「自分の週報」の編集エリアの「例文を挿入」から各欄へ流し込む定型文。
 * 稟議の内容テンプレート（utils/workflow-templates.ts）と同様に、UI から参照する文面の SoT をここに集約する。
 *
 * 挿入対象は「今週の成果・達成感 / 今週の課題・原因仮説 / 今週うまくいったこと・続けたいこと /
 * 来週の最重要テーマ」の 4 欄（主要業務・チーム共有事項は書き手固有の内容のため例文を持たない）。
 */
export interface WeeklyReportExample {
  /** 今週の成果・達成感（wkGoal / WeeklyReport.goalReview） */
  goalReview: string
  /** 今週の課題・原因仮説（wkIssues / WeeklyReport.issues） */
  issues: string
  /** 今週うまくいったこと・続けたいこと（wkGoodPoints / WeeklyReport.goodPoints） */
  goodPoints: string
  /** 来週の最重要テーマ（wkNext / WeeklyReport.nextWeek） */
  nextWeek: string
}

export const WEEKLY_REPORT_EXAMPLE: WeeklyReportExample = {
  goalReview: '最重要テーマの顧客マスタの登録作業を完了することができた。段取りをきちんとしたことで予定通りに完了できてよかった。',
  issues: 'マスタ設定の確認に時間がかかった。設定手順が複数箇所に分散していることが原因だと思う。',
  goodPoints: '作業前に確認項目を一覧化したことで、入力精度を大幅に向上できた。今後も作業開始前にはチェックリストを作成する。',
  nextWeek: '①クライアントのシステム稼働に向けた事前準備。主観で進めないようにメンバーとも壁打ちをしながら実施する。\n②ECサイトのアップデート。ECサイトのアップデートの方向性について事前に壁打ちをした上で進める。',
}
