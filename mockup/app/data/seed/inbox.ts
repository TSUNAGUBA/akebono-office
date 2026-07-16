/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { AppNotification, Escalation } from '~/types/domain'
import { addDays } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

export const seedNotifications: AppNotification[] = [
  // ---- m-03（葛西: 管理者・デフォルトユーザー）宛て / 未読 ----
  { id: 'nt-0001', memberId: 'm-03', kind: 'approval', title: '承認依頼: 開発用モニター 2 台の購入', body: '小野寺さんから購買稟議（¥86,000）が届いています', link: '/workflow', read: false, at: `${addDays(today, -2)}T10:00:05+09:00` },
  { id: 'nt-0002', memberId: 'm-03', kind: 'escalation', title: 'エスカレーション: 課題の報告', body: '澤村さんの日報で課題が報告されました: PII 匿名化の仕様が未確定で手戻りの懸念', link: '/inbox', read: false, at: `${addDays(today, -1)}T18:45:12+09:00` },
  { id: 'nt-0003', memberId: 'm-03', kind: 'system', title: 'インシデント発生: UNDEUX Sales Suite', body: '分析画面の一部レポートで表示遅延が発生しています（調査中）', link: '/status/svc-02', read: false, at: `${today}T08:42:00+09:00` },
  { id: 'nt-0004', memberId: 'm-03', kind: 'comment', title: '三浦さんが日報にコメントしました', body: '「北都物流の KPI 定義、次回定例で共有をお願いします」', link: '/reports', read: false, at: `${addDays(today, -1)}T09:15:30+09:00` },
  { id: 'nt-0005', memberId: 'm-03', kind: 'escalation', title: 'エスカレーション: 過負荷', body: '小野寺さんの保有タスクが 8 件になりました（しきい値 7 件）', link: '/inbox', read: false, at: `${today}T09:05:00+09:00` },
  // ---- m-03 宛て / 既読 ----
  { id: 'nt-0006', memberId: 'm-03', kind: 'ai_report', title: 'AI社員 ソラ の日次報告', body: '売上マートで前月比の異常値 2 件を検知し、明細をまとめました', link: '/ai-company', read: true, at: `${addDays(today, -1)}T17:30:00+09:00` },
  { id: 'nt-0007', memberId: 'm-03', kind: 'reminder', title: '週報の提出期限が近づいています', body: '今週の週報は金曜 18:00 までに提出してください', link: '/reports', read: true, at: `${addDays(today, -2)}T09:00:00+09:00` },
  { id: 'nt-0008', memberId: 'm-03', kind: 'system', title: 'インシデント解決: TOKUTAKE AI Platform', body: 'ETL ジョブ失敗による分析データ更新停止は解消し、経過観察を終了しました', link: '/status/svc-03', read: true, at: `${addDays(today, -19)}T16:05:00+09:00` },
  // ---- 他メンバー宛て（宛先フィルタの確認用） ----
  { id: 'nt-0009', memberId: 'm-01', kind: 'escalation', title: 'エスカレーション: 過負荷', body: '小野寺さんの保有タスクが 8 件になりました（しきい値 7 件）', link: '/inbox', read: false, at: `${today}T09:05:00+09:00` },
]

export const seedEscalations: Escalation[] = [
  // open: 日報の課題記入（既存）
  {
    id: 'esc-0001', reason: 'issue_reported', targetMemberId: 'm-06', targetAiEmployeeId: null,
    context: '日報（昨日）で課題の記入: 「PII 匿名化の仕様が未確定で手戻りの懸念」',
    status: 'open', resolution: null, knowledgeReflected: false,
    dedupeKey: `issue:m-06:${addDays(today, -1)}`, raisedAt: `${addDays(today, -1)}T18:45:10+09:00`,
  },
  // open: 過負荷
  {
    id: 'esc-0002', reason: 'overload', targetMemberId: 'm-05', targetAiEmployeeId: null,
    context: '保有タスクが 8 件（しきい値 7 件超過）: トクタケ AI 分析 4 件 / SCM 導入 3 件 / 社内 1 件。優先順位の整理が必要です',
    status: 'open', resolution: null, knowledgeReflected: false,
    dedupeKey: `overload:m-05:${today}`, raisedAt: `${today}T09:05:00+09:00`,
  },
  // resolved: 裁定記録（ナレッジ還流済）
  {
    id: 'esc-0003', reason: 'issue_reported', targetMemberId: 'm-04', targetAiEmployeeId: null,
    context: '日報で課題の記入: 「北都物流の現場ボードに載せる KPI が 12 個に増え、現場のチェックが形骸化しかけている」',
    status: 'resolved',
    resolution: {
      type: 'ruling',
      body: '現場ボードに載せる KPI は 5 個まで。それ以外は月次レビューで確認する運用とする。',
      resolvedBy: 'm-01',
      at: `${addDays(today, -10)}T14:20:00+09:00`,
    },
    knowledgeReflected: true,
    dedupeKey: `issue:m-04:${addDays(today, -11)}`, raisedAt: `${addDays(today, -11)}T18:20:00+09:00`,
  },
  // resolved: 対応不要
  {
    id: 'esc-0004', reason: 'stalled_task', targetMemberId: 'm-07', targetAiEmployeeId: null,
    context: 'タスク「ウンドゥ月次レポート雛形の更新」が 3 日間更新されていません',
    status: 'resolved',
    resolution: {
      type: 'no_action',
      body: '本人の夏季休暇による停滞のため対応不要。復帰後に再開することを確認済み。',
      resolvedBy: 'm-03',
      at: `${addDays(today, -6)}T10:10:00+09:00`,
    },
    knowledgeReflected: false,
    dedupeKey: `stalled:m-07:${addDays(today, -7)}`, raisedAt: `${addDays(today, -7)}T09:00:00+09:00`,
  },
]
