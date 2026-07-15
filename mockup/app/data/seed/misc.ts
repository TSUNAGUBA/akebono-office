/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { AkebonoWish, AuditLog } from '~/types/domain'
import { addDays } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

export const seedAkebonoWishes: AkebonoWish[] = [
  { id: 'aw-0001', memberId: 'm-04', body: '顧客ごとの提案履歴と結果を横断検索できるようにしてほしい。過去の勝ちパターンを再利用したい。', at: `${addDays(today, -3)}T15:20:00+09:00` },
  { id: 'aw-0002', memberId: 'm-05', body: 'AI 社員に開発タスクのコードレビューまで任せられるようになると嬉しい。', at: `${addDays(today, -1)}T11:05:00+09:00` },
]

export const seedAuditLogs: AuditLog[] = []
