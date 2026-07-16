/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { DailyReport, ReportComment, WeeklyReport } from '~/types/domain'
import { addDays, weekdayOf } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

/** 直近の営業日（今日を含まない）を新しい順に n 件 */
function lastBusinessDays(n: number): string[] {
  const days: string[] = []
  let d = addDays(today, -1)
  while (days.length < n) {
    const w = weekdayOf(d)
    if (w !== 0 && w !== 6) days.push(d)
    d = addDays(d, -1)
  }
  return days
}

/** date を含む週の月曜 */
function mondayOf(date: string): string {
  const w = weekdayOf(date)
  return addDays(date, w === 0 ? -6 : 1 - w)
}

const bd = lastBusinessDays(3)
const b1 = bd[0]! // 直近営業日
const b2 = bd[1]!
const b3 = bd[2]!
const lastWeekStart = addDays(mondayOf(today), -7)

export const seedDailyReports: DailyReport[] = [
  // ---- 直近営業日（b1）----
  {
    id: 'dr-0001', authorKind: 'human', memberId: 'm-06', aiEmployeeId: null, date: b1,
    entries: [{ projectId: 'pj-03', task: 'AI 分析画面の集計 API 実装', hours: 6, progress: 60 }],
    reflection: '集計処理の見通しが立った', issues: 'PII 匿名化の仕様が未確定で手戻りの懸念', tomorrow: '匿名化仕様の確認と実装続き',
    status: 'submitted', submittedAt: `${b1}T18:45:00+09:00`,
  },
  {
    id: 'dr-0002', authorKind: 'human', memberId: 'm-05', aiEmployeeId: null, date: b1,
    entries: [
      { projectId: 'pj-01', task: 'SCM 在庫連携バッチの異常系テスト', hours: 3.5, progress: 70 },
      { projectId: 'pj-03', task: '推論 API のレスポンス改善', hours: 4.5, progress: 55 },
    ],
    reflection: 'バッチのリトライ設計は現行方針で問題なさそう', issues: '', tomorrow: '在庫連携バッチの本番想定リハーサル',
    status: 'submitted', submittedAt: `${b1}T19:05:00+09:00`,
  },
  {
    id: 'dr-0003', authorKind: 'human', memberId: 'm-04', aiEmployeeId: null, date: b1,
    entries: [
      { projectId: 'pj-02', task: '週次売上レポートの検収対応', hours: 4, progress: 80 },
      { projectId: 'pj-04', task: '庫内 KPI 定義のヒアリング準備', hours: 3, progress: 40 },
    ],
    reflection: '検収コメントは軽微。今週中にクローズ見込み', issues: '', tomorrow: '北都物流ヒアリング（現地）',
    status: 'submitted', submittedAt: `${b1}T18:20:00+09:00`,
  },
  {
    id: 'dr-0004', authorKind: 'human', memberId: 'm-07', aiEmployeeId: null, date: b1,
    entries: [{ projectId: 'pj-02', task: '問い合わせ一次対応と FAQ 整備', hours: 6, progress: 65 }],
    reflection: 'FAQ 化で同種問い合わせが減り始めた', issues: '', tomorrow: 'FAQ の残り 5 件を整備',
    status: 'submitted', submittedAt: `${b1}T17:55:00+09:00`,
  },
  {
    id: 'dr-0005', authorKind: 'human', memberId: 'm-08', aiEmployeeId: null, date: b1,
    entries: [{ projectId: 'pj-02', task: 'モニタリング当番・アラート棚卸し', hours: 4, progress: 50 }],
    reflection: '', issues: '', tomorrow: '',
    status: 'draft', submittedAt: null,
  },
  // ---- 2 営業日前（b2）----
  {
    id: 'dr-0006', authorKind: 'human', memberId: 'm-05', aiEmployeeId: null, date: b2,
    entries: [{ projectId: 'pj-03', task: '推論パイプラインの負荷試験', hours: 7.5, progress: 45 }],
    reflection: 'ボトルネックは前処理。並列化で解消できそう', issues: '', tomorrow: '前処理の並列化実装',
    status: 'submitted', submittedAt: `${b2}T19:30:00+09:00`,
  },
  {
    id: 'dr-0007', authorKind: 'human', memberId: 'm-06', aiEmployeeId: null, date: b2,
    entries: [
      { projectId: 'pj-03', task: '集計 API のスキーマ設計レビュー反映', hours: 5, progress: 50 },
      { projectId: 'pj-01', task: 'SCM 定例の議事メモ整理', hours: 2, progress: 100 },
    ],
    reflection: 'レビュー指摘は全件反映済み', issues: '', tomorrow: '集計 API 実装',
    status: 'submitted', submittedAt: `${b2}T18:50:00+09:00`,
  },
  {
    id: 'dr-0008', authorKind: 'human', memberId: 'm-04', aiEmployeeId: null, date: b2,
    entries: [
      { projectId: 'pj-05', task: '受発注フローの現状整理', hours: 2.5, progress: 30 },
      { projectId: 'pj-02', task: '売上分析ダッシュボードの改善要望ヒアリング', hours: 4, progress: 60 },
    ],
    reflection: 'みなみ食品は紙運用の比率が想定より高い', issues: '受発注フローの例外パターンが多く、標準化方針の合意が必要', tomorrow: '例外パターンの一覧化',
    status: 'submitted', submittedAt: `${b2}T18:40:00+09:00`,
  },
  {
    id: 'dr-0009', authorKind: 'human', memberId: 'm-03', aiEmployeeId: null, date: b2,
    entries: [
      { projectId: 'pj-01', task: 'SCM 定例のファシリテーションと Phase2 論点整理', hours: 3, progress: 100 },
      { projectId: 'pj-04', task: '物流改善 KPI 体系のレビュー', hours: 4, progress: 70 },
    ],
    reflection: 'Phase2 の論点は在庫粒度に集約。合意形成は順調', issues: '', tomorrow: 'KPI 体系の最終化',
    status: 'submitted', submittedAt: `${b2}T19:10:00+09:00`,
  },
  // ---- 3 営業日前（b3）----
  {
    id: 'dr-0010', authorKind: 'human', memberId: 'm-07', aiEmployeeId: null, date: b3,
    entries: [{ projectId: 'pj-02', task: 'マート再構築ジョブの監視と障害一次切り分け', hours: 6.5, progress: 100 }],
    reflection: '再構築失敗はデータ起因。恒久対応は開発チームへ引継ぎ', issues: '', tomorrow: '通常監視へ復帰',
    status: 'submitted', submittedAt: `${b3}T18:05:00+09:00`,
  },
  {
    id: 'dr-0011', authorKind: 'human', memberId: 'm-05', aiEmployeeId: null, date: b3,
    entries: [{ projectId: 'pj-01', task: 'SCM 在庫スナップショット設計（日次×SKU×拠点）', hours: 7.75, progress: 40 }],
    reflection: '棚卸月のバッチ停止枠を設計に織り込んだ', issues: '', tomorrow: '設計レビュー依頼',
    status: 'submitted', submittedAt: `${b3}T19:45:00+09:00`,
  },
  {
    id: 'dr-0012', authorKind: 'human', memberId: 'm-06', aiEmployeeId: null, date: b3,
    entries: [{ projectId: 'pj-03', task: 'アンケート分析画面のプロトタイプ作成', hours: 6.5, progress: 35 }],
    reflection: '桜井主任のフィードバックが的確で助かる', issues: '', tomorrow: 'プロトタイプの改善',
    status: 'submitted', submittedAt: `${b3}T18:30:00+09:00`,
  },
  // ---- AI 社員の日報（同一タイムラインへ混在表示: F-06-5）----
  {
    id: 'dr-0013', authorKind: 'ai', memberId: null, aiEmployeeId: 'ai-01', date: b1,
    entries: [{ projectId: 'pj-03', task: '介護シューズ市場調査: 競合 3 社の動向整理を完了', hours: 6, progress: 66 }],
    reflection: '活動サマリ: 市場規模データを 4 ソースから収集・突合。一次情報の欠落が 2 点あり要確認',
    issues: '', tomorrow: '調査レポートのドラフト作成',
    status: 'submitted', submittedAt: `${b1}T19:00:00+09:00`,
  },
  {
    id: 'dr-0014', authorKind: 'ai', memberId: null, aiEmployeeId: 'ai-03', date: b1,
    entries: [{ projectId: 'pj-02', task: '週次売上データの異常値検知と要因分析', hours: 5.5, progress: 100 }],
    reflection: '活動サマリ: 3 店舗で前週比 -18% の異常値を検知。天候要因と判定し、根拠データを添付済み',
    issues: '', tomorrow: '定例レポートへの反映',
    status: 'submitted', submittedAt: `${b1}T18:00:00+09:00`,
  },
]

export const seedWeeklyReports: WeeklyReport[] = [
  {
    id: 'wk-0001', memberId: 'm-03', weekStart: lastWeekStart,
    goalReview: '北都物流の KPI 体系ドラフト完成（達成）。SCM Phase2 論点整理（達成）',
    mainWork: '・SCM 定例のファシリテーションと Phase2 論点整理\n・物流改善 KPI 体系のドラフト作成\n・シーサイドホテルズ DX 構想の提案準備',
    issues: '・KPI が乱立気味。現場ボード掲載は 5 個までの裁定に沿って絞り込む',
    nextWeek: '・KPI 体系の最終化と北都物流への提示\n・SCM Phase2 の体制案作成',
    status: 'submitted',
  },
]

export const seedReportComments: ReportComment[] = [
  {
    id: 'rc-0001', reportId: 'dr-0001', memberId: 'm-03',
    body: 'PII 匿名化はトクタケ側と仕様確認の場を設定しました。明日の定例で共有します',
    at: `${b1}T19:10:00+09:00`,
    reactions: [{ memberId: 'm-06', emoji: '👍' }, { memberId: 'm-05', emoji: '👍' }],
  },
  {
    id: 'rc-0002', reportId: 'dr-0001', memberId: 'm-06',
    body: 'ありがとうございます。仕様が固まり次第、実装を再開します',
    at: `${b1}T19:20:00+09:00`,
    reactions: [{ memberId: 'm-03', emoji: '✅' }],
  },
  {
    id: 'rc-0003', reportId: 'dr-0003', memberId: 'm-03',
    body: '検収コメントの残件は私からも宇野本部長へフォローしておきます',
    at: `${b1}T19:30:00+09:00`,
    reactions: [{ memberId: 'm-04', emoji: '✅' }],
  },
  {
    id: 'rc-0004', reportId: 'dr-0014', memberId: 'm-04',
    body: '要因分析わかりやすいです。定例資料にそのまま使います',
    at: `${b1}T19:40:00+09:00`,
    reactions: [{ memberId: 'm-07', emoji: '👍' }],
  },
  {
    id: 'rc-0005', reportId: 'dr-0008', memberId: 'm-03',
    body: '例外パターンの一覧ができたら、標準化方針のすり合わせ MTG を設定しましょう',
    at: `${addDays(b2, 1)}T09:15:00+09:00`,
    reactions: [],
  },
]
