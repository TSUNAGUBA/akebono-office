/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { AkebonoWish, AuditLog } from '~/types/domain'
import type { ImprovementItem, ImprovementRequest } from '~/types/improvement'
import { addDays } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

export const seedAkebonoWishes: AkebonoWish[] = [
  { id: 'aw-0001', memberId: 'm-04', body: '顧客ごとの提案履歴と結果を横断検索できるようにしてほしい。過去の勝ちパターンを再利用したい。', at: `${addDays(today, -3)}T15:20:00+09:00` },
  { id: 'aw-0002', memberId: 'm-05', body: 'AI 社員に開発タスクのコードレビューまで任せられるようになると嬉しい。', at: `${addDays(today, -1)}T11:05:00+09:00` },
]

/**
 * 改善要望のデモ（F-42。各ページの「要望を送る」から集まった生要望）。
 * imreq-0001〜0003 は集約済み（itemId 付き）でカンバン/ガントの初期表示に使う。
 * imreq-0004/0005 は未集約（itemId:null）で「AI で集約」の動作を体験できる。
 */
export const seedImprovementRequests: ImprovementRequest[] = [
  { id: 'imreq-0001', memberId: 'm-04', memberName: '三浦 彩', pagePath: '/akebono/sales', pageLabel: 'AKEBONO 売上', body: '売上一覧で合計金額をもっと大きく目立たせてほしい。月次の締めで一番見る数字なので。', itemId: 'imp-0001', archivedAt: null, createdAt: `${addDays(today, -8)}T10:12:00+09:00` },
  { id: 'imreq-0002', memberId: 'm-05', memberName: '小野寺 岳', pagePath: '/akebono/sales', pageLabel: 'AKEBONO 売上', body: '税込・税抜の表示を切り替えられるようにしたい。得意先によって見たい方が違う。', itemId: 'imp-0001', archivedAt: null, createdAt: `${addDays(today, -7)}T14:40:00+09:00` },
  { id: 'imreq-0003', memberId: 'm-03', memberName: '葛西 大輔', pagePath: '/timecard', pageLabel: 'タイムカード', body: '打刻を押し間違えたときに取り消せるようにしてほしい。今は修正申請しかなく手間。', itemId: 'imp-0002', archivedAt: null, createdAt: `${addDays(today, -5)}T09:03:00+09:00` },
  { id: 'imreq-0004', memberId: 'm-04', memberName: '三浦 彩', pagePath: '/reports', pageLabel: '日報・週報', body: '日報の下書きを前日分からコピーできるようにしてほしい。定型の作業報告が多いので。', itemId: null, archivedAt: null, createdAt: `${addDays(today, -2)}T18:30:00+09:00` },
  { id: 'imreq-0005', memberId: 'm-05', memberName: '小野寺 岳', pagePath: '/masters/members', pageLabel: 'メンバー管理', body: 'メンバー一覧を部署で絞り込めるようにしてほしい。人数が増えて探しづらい。', itemId: null, archivedAt: null, createdAt: `${addDays(today, -1)}T13:15:00+09:00` },
]

/**
 * 改修単位のデモ（F-42。AI 集約の結果を模した初期データ）。
 * imp-0001 = 対応する（対応予定期間あり = ガントにバー表示）／imp-0002 = 未判定（予定未定）。
 */
export const seedImprovementItems: ImprovementItem[] = [
  {
    id: 'imp-0001',
    title: '「AKEBONO 売上」の表示改善（合計の強調・税表示切替）',
    summary: '売上一覧で合計金額を大きく強調し、税込/税抜を切り替えられるようにする。',
    detail: '### 対象ページ: AKEBONO 売上（`/akebono/sales`）\n\n**寄せられた要望 2 件:**\n1. 合計金額をもっと大きく目立たせてほしい（月次の締めで一番見る数字）\n2. 税込・税抜の表示を切り替えたい（得意先によって見たい方が違う）',
    status: 'accepted',
    pagePaths: ['/akebono/sales'],
    sourceRequestIds: ['imreq-0001', 'imreq-0002'],
    llm: false,
    archivedAt: null,
    createdAt: `${addDays(today, -6)}T09:00:00+09:00`,
    updatedAt: `${addDays(today, -3)}T09:00:00+09:00`,
    resolvedAt: null,
    planStart: addDays(today, -2),
    planEnd: addDays(today, 9),
  },
  {
    id: 'imp-0002',
    title: '「タイムカード」の打刻取消を可能にする',
    summary: '押し間違えた打刻をその場で取り消せるようにする（修正申請なしで戻せる導線）。',
    detail: '### 対象ページ: タイムカード（`/timecard`）\n\n**寄せられた要望 1 件:**\n1. 打刻を押し間違えたときに取り消せるようにしてほしい（今は修正申請しかなく手間）',
    status: 'triage',
    pagePaths: ['/timecard'],
    sourceRequestIds: ['imreq-0003'],
    llm: false,
    archivedAt: null,
    createdAt: `${addDays(today, -4)}T09:00:00+09:00`,
    updatedAt: `${addDays(today, -4)}T09:00:00+09:00`,
    resolvedAt: null,
    planStart: null,
    planEnd: null,
  },
]

export const seedAuditLogs: AuditLog[] = []
