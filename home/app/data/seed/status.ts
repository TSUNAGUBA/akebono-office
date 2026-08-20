/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { ServiceIncident } from '~/types/domain'
import { addDays } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

export const seedServiceIncidents: ServiceIncident[] = [
  // resolved: AKEBONO SCM 夜間バッチ遅延（軽微）
  {
    id: 'inc-0001', serviceId: 'svc-01', title: '夜間バッチの遅延', impact: 'minor', status: 'resolved',
    updates: [
      { status: 'investigating', body: '夜間バッチの完了遅延を検知。原因を調査しています。', at: `${addDays(today, -9)}T06:10:00+09:00` },
      { status: 'identified', body: '前日データ量の急増によるタイムアウトと特定。リトライを実施。', at: `${addDays(today, -9)}T07:00:00+09:00` },
      { status: 'resolved', body: 'バッチ再実行が完了し、画面への反映を確認しました。', at: `${addDays(today, -9)}T08:20:00+09:00` },
    ],
    startedAt: `${addDays(today, -9)}T06:10:00+09:00`, resolvedAt: `${addDays(today, -9)}T08:20:00+09:00`,
  },
  // resolved: TOKUTAKE AI Platform の ETL 障害（重大 → フルライフサイクル）
  {
    id: 'inc-0002', serviceId: 'svc-03', title: 'ETL ジョブ失敗による分析データ更新停止', impact: 'major', status: 'resolved',
    updates: [
      { status: 'investigating', body: '深夜 ETL の一部ジョブが失敗し、当日分の分析データが更新されていません。影響範囲を調査しています。', at: `${addDays(today, -20)}T07:30:00+09:00` },
      { status: 'identified', body: 'ソース DB のスキーマ変更が原因と特定。マッピング修正をデプロイします。', at: `${addDays(today, -20)}T10:15:00+09:00` },
      { status: 'monitoring', body: '修正を適用し、リカバリ実行が完了。データ整合を監視しています。', at: `${addDays(today, -20)}T13:40:00+09:00` },
      { status: 'resolved', body: '全ジョブの正常完了と画面表示を確認し、解決としました。', at: `${addDays(today, -19)}T16:00:00+09:00` },
    ],
    startedAt: `${addDays(today, -20)}T07:30:00+09:00`, resolvedAt: `${addDays(today, -19)}T16:00:00+09:00`,
  },
  // open: UNDEUX Sales Suite の表示遅延（調査中・性能低下）
  {
    id: 'inc-0003', serviceId: 'svc-02', title: '分析画面の一部レポートで表示遅延', impact: 'minor', status: 'investigating',
    updates: [
      { status: 'investigating', body: '朝 8 時台から週次売上レポートの表示に 20 秒以上かかる事象を確認。マート再構築ジョブとの競合を調査しています。', at: `${today}T08:40:00+09:00` },
    ],
    startedAt: `${today}T08:40:00+09:00`, resolvedAt: null,
  },
]
