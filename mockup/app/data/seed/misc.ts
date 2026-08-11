/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { AkebonoWish, AuditLog } from '~/types/domain'
import type { ImprovementRequest } from '~/types/improvement'
import { addDays } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

export const seedAkebonoWishes: AkebonoWish[] = [
  { id: 'aw-0001', memberId: 'm-04', body: '顧客ごとの提案履歴と結果を横断検索できるようにしてほしい。過去の勝ちパターンを再利用したい。', at: `${addDays(today, -3)}T15:20:00+09:00` },
  { id: 'aw-0002', memberId: 'm-05', body: 'AI 社員に開発タスクのコードレビューまで任せられるようになると嬉しい。', at: `${addDays(today, -1)}T11:05:00+09:00` },
]

/**
 * 改善要望のデモ（F-42。各ページの「要望を送る」から集まった生要望。未集約 = itemId:null）。
 * 管理ページで「AI で集約」を押すと改修単位（improvementItems）へまとまる様子を体験できる。
 */
export const seedImprovementRequests: ImprovementRequest[] = [
  { id: 'imreq-0001', memberId: 'm-04', memberName: '三浦 彩', pagePath: '/akebono/sales', pageLabel: 'AKEBONO 売上', body: '売上一覧で合計金額をもっと大きく目立たせてほしい。月次の締めで一番見る数字なので。', itemId: null, archivedAt: null, createdAt: `${addDays(today, -4)}T10:12:00+09:00` },
  { id: 'imreq-0002', memberId: 'm-05', memberName: '小野寺 岳', pagePath: '/akebono/sales', pageLabel: 'AKEBONO 売上', body: '税込・税抜の表示を切り替えられるようにしたい。得意先によって見たい方が違う。', itemId: null, archivedAt: null, createdAt: `${addDays(today, -3)}T14:40:00+09:00` },
  { id: 'imreq-0003', memberId: 'm-03', memberName: '葛西 大輔', pagePath: '/timecard', pageLabel: 'タイムカード', body: '打刻を押し間違えたときに取り消せるようにしてほしい。今は修正申請しかなく手間。', itemId: null, archivedAt: null, createdAt: `${addDays(today, -1)}T09:03:00+09:00` },
]

export const seedAuditLogs: AuditLog[] = []
