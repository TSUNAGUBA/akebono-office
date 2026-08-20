/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { AiActivityLog, AiTask } from '~/types/domain'
import { addDays } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

/**
 * AI タスク（proposed / in_progress / blocked / done / cancelled を網羅）
 * AI 社員の status（core.ts）との整合:
 *   in_progress/approved を持つ → working（ai-01, ai-03）
 *   proposed のみ → waiting_approval（ai-04）
 *   それ以外（blocked/done/cancelled のみ・なし） → idle（ai-02, ai-05）
 */
export const seedAiTasks: AiTask[] = [
  {
    id: 'at-0001', aiEmployeeId: 'ai-01', requesterId: 'm-03', title: '介護業界の市場動向調査',
    description: 'トクタケ製靴の次期提案に向け、介護シューズ市場の直近 3 年の動向をまとめる',
    decomposition: [
      { title: '市場規模・成長率の情報収集', done: true },
      { title: '競合 3 社の動向整理', done: true },
      { title: 'レポートドラフト作成', done: false },
    ],
    status: 'in_progress', dueDate: addDays(today, 2), confidence: 'high', createdAt: `${addDays(today, -2)}T09:30:00+09:00`,
  },
  {
    id: 'at-0002', aiEmployeeId: 'ai-03', requesterId: 'm-04', title: 'ウンドゥ売上分析の週次サマリー自動化',
    description: '売上分析スイートのマートから週次サマリーを自動生成する集計定義を作り、直近 4 週で検証する',
    decomposition: [
      { title: '対象 KPI と集計粒度の定義', done: true },
      { title: '集計クエリのドラフト作成', done: true },
      { title: '直近 4 週データでの検証', done: false },
      { title: 'サマリーテンプレートへの反映', done: false },
    ],
    status: 'in_progress', dueDate: addDays(today, 3), confidence: 'high', createdAt: `${addDays(today, -1)}T10:00:00+09:00`,
  },
  {
    id: 'at-0003', aiEmployeeId: 'ai-04', requesterId: 'm-03', title: '経費精算フローの FAQ 整備',
    description: '社内からの問い合わせが多い経費精算について、稟議区分との使い分けを含む FAQ を整備する',
    decomposition: [
      { title: '過去の問い合わせ傾向の分類', done: false },
      { title: '規程・承認経路との突合', done: false },
      { title: 'FAQ ドラフト作成', done: false },
    ],
    status: 'proposed', dueDate: addDays(today, 5), confidence: 'mid', createdAt: `${today}T09:05:00+09:00`,
  },
  {
    id: 'at-0004', aiEmployeeId: 'ai-05', requesterId: 'm-03', title: 'シーサイドホテルズ DX 提案書ドラフト',
    description: 'DX 構想策定支援（pj-07）のキックオフに向けた提案書の初稿を作成する',
    decomposition: [
      { title: '構成案の作成', done: true },
      { title: '既存ナレッジ・過去提案の参照', done: false },
      { title: 'ドラフト作成', done: false },
    ],
    status: 'blocked', dueDate: addDays(today, 4), confidence: 'mid', createdAt: `${addDays(today, -1)}T14:20:00+09:00`,
  },
  {
    id: 'at-0005', aiEmployeeId: 'ai-02', requesterId: 'm-04', title: '7 月定例の議事録清書とナレッジ登録',
    description: 'アケボノ商事 SCM 定例（7 月）の音声メモを議事録に清書し、合意事項をナレッジへ登録する',
    decomposition: [
      { title: 'メモの構造化と清書', done: true },
      { title: '決定事項・宿題の抽出', done: true },
      { title: 'ナレッジ記事として登録', done: true },
    ],
    status: 'done', dueDate: addDays(today, -1), confidence: 'high', createdAt: `${addDays(today, -2)}T11:00:00+09:00`,
  },
  {
    id: 'at-0006', aiEmployeeId: 'ai-03', requesterId: 'm-05', title: '旧 KPI レポートのフォーマット移行',
    description: '旧形式レポートの移行？',
    decomposition: [
      { title: '旧フォーマットの項目棚卸し', done: false },
      { title: '新テンプレートへのマッピング', done: false },
      { title: '移行スクリプトの作成', done: false },
    ],
    status: 'cancelled', dueDate: null, confidence: 'low', createdAt: `${addDays(today, -2)}T16:40:00+09:00`,
  },
]

/**
 * AI 活動ログ（直近 3 日・全 AI 社員・全 kind を網羅。tokens/costUsd は現実的なモック値）
 */
export const seedAiActivityLogs: AiActivityLog[] = [
  // ---- 2 日前 ----
  { id: 'aal-0001', aiEmployeeId: 'ai-01', taskId: 'at-0001', at: `${addDays(today, -2)}T09:32:00+09:00`, kind: 'plan', summary: '「介護業界の市場動向調査」を 3 ステップに分解し実行計画を作成', tokens: 3200, costUsd: 0.004 },
  { id: 'aal-0002', aiEmployeeId: 'ai-01', taskId: 'at-0001', at: `${addDays(today, -2)}T11:05:00+09:00`, kind: 'execute', summary: '市場規模・成長率の統計データを収集（公的統計 + 業界レポート）', tokens: 21400, costUsd: 0.024 },
  { id: 'aal-0003', aiEmployeeId: 'ai-02', taskId: 'at-0005', at: `${addDays(today, -2)}T11:10:00+09:00`, kind: 'plan', summary: '「7 月定例の議事録清書」の作業計画を作成', tokens: 2100, costUsd: 0.002 },
  { id: 'aal-0004', aiEmployeeId: 'ai-02', taskId: 'at-0005', at: `${addDays(today, -2)}T13:45:00+09:00`, kind: 'execute', summary: '音声メモを議事録形式に構造化・清書', tokens: 15800, costUsd: 0.017 },
  { id: 'aal-0005', aiEmployeeId: 'ai-03', taskId: 'at-0006', at: `${addDays(today, -2)}T16:45:00+09:00`, kind: 'escalate', summary: '依頼内容の確信度が低いため確認を要請（旧 KPI レポート移行の範囲が不明確）', tokens: 1800, costUsd: 0.005 },
  { id: 'aal-0006', aiEmployeeId: 'ai-04', taskId: null, at: `${addDays(today, -2)}T17:20:00+09:00`, kind: 'chat', summary: '「有給の残数確認方法」への質問対応（勤怠画面の手順を案内）', tokens: 950, costUsd: 0.001 },
  // ---- 1 日前 ----
  { id: 'aal-0007', aiEmployeeId: 'ai-01', taskId: 'at-0001', at: `${addDays(today, -1)}T10:12:00+09:00`, kind: 'execute', summary: '市場規模データを 4 ソースから収集し突合', tokens: 18400, costUsd: 0.021 },
  { id: 'aal-0008', aiEmployeeId: 'ai-02', taskId: 'at-0005', at: `${addDays(today, -1)}T09:40:00+09:00`, kind: 'execute', summary: '決定事項 6 件・宿題 4 件を抽出しナレッジ記事として登録', tokens: 9600, costUsd: 0.011 },
  { id: 'aal-0009', aiEmployeeId: 'ai-02', taskId: 'at-0005', at: `${addDays(today, -1)}T10:02:00+09:00`, kind: 'report', summary: '議事録清書タスクの完了を報告（成果物 2 点）', tokens: 2400, costUsd: 0.003 },
  { id: 'aal-0010', aiEmployeeId: 'ai-03', taskId: 'at-0002', at: `${addDays(today, -1)}T10:05:00+09:00`, kind: 'plan', summary: '「週次サマリー自動化」を 4 ステップに分解し実行計画を作成', tokens: 3900, costUsd: 0.011 },
  { id: 'aal-0011', aiEmployeeId: 'ai-03', taskId: 'at-0002', at: `${addDays(today, -1)}T14:30:00+09:00`, kind: 'execute', summary: '週次 KPI の集計クエリをドラフト（半加法メジャーの期末残高に注意）', tokens: 26700, costUsd: 0.075 },
  { id: 'aal-0012', aiEmployeeId: 'ai-05', taskId: 'at-0004', at: `${addDays(today, -1)}T14:25:00+09:00`, kind: 'plan', summary: '「DX 提案書ドラフト」の構成案を作成', tokens: 4300, costUsd: 0.005 },
  { id: 'aal-0013', aiEmployeeId: 'ai-05', taskId: 'at-0004', at: `${addDays(today, -1)}T16:50:00+09:00`, kind: 'escalate', summary: '過去提案の参照権限が不足しブロックを報告（documents:write のみ保有）', tokens: 1200, costUsd: 0.001 },
  // ---- 今日 ----
  { id: 'aal-0014', aiEmployeeId: 'ai-01', taskId: 'at-0001', at: `${today}T09:15:00+09:00`, kind: 'execute', summary: '競合 3 社（大手 2 社 + 新興 1 社）の直近動向を整理', tokens: 19800, costUsd: 0.022 },
  { id: 'aal-0015', aiEmployeeId: 'ai-03', taskId: 'at-0002', at: `${today}T09:40:00+09:00`, kind: 'execute', summary: '直近 4 週データで集計検証を開始（第 1 週分の突合完了）', tokens: 23500, costUsd: 0.066 },
  { id: 'aal-0016', aiEmployeeId: 'ai-04', taskId: null, at: `${today}T10:05:00+09:00`, kind: 'chat', summary: '「出張稟議の金額区分」への質問対応（15 万円境界の経路差を案内）', tokens: 1100, costUsd: 0.001 },
]

// ---------- 通知・エスカレーション ----------
