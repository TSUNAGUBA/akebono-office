/**
 * インサイト・アクション・分析サイクルのデモシード（モックモード用）。
 * フィードバックループ（FI-05）を最初から体感できるように、
 * 「前回サイクル → アクション → フィードバック済み」の状態を 1 周分用意する。
 * 次の生成では done+高評価（継続提案）/ done+低評価（代替提案）/ 実行中（重複抑制）が反映される。
 */
import type { IntelAction, IntelCycle, IntelInsight } from '~/types/intelligence'
import { addDays } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()
const prevCycleAt = `${addDays(today, -14)}T10:00:00+09:00`

export const seedCycles: IntelCycle[] = [
  {
    id: 'cy-0001',
    theme: 'management',
    targetId: null,
    targetName: '全社',
    at: prevCycleAt,
    inputSnapshot: [
      { source: 'daily', label: '日報', count: 118 },
      { source: 'support', label: 'サポート活動', count: 19 },
      { source: 'sales', label: '営業活動', count: 12 },
      { source: 'partner', label: 'ビジネスパートナー活動', count: 7 },
      { source: 'salesMonthly', label: '月次売上', count: 96 },
    ],
    feedbackConsidered: [],
    insightIds: ['ins-0001'],
    createdBy: 'm-03',
    active: true,
  },
]

export const seedInsights: IntelInsight[] = [
  {
    id: 'ins-0001',
    cycleId: 'cy-0001',
    theme: 'management',
    targetId: null,
    targetName: '全社',
    title: `経営サマリー（${addDays(today, -14).slice(0, 7)}）`,
    summary: '進行中商談のうち 4 件で Next Action が期限超過。サポートは「操作」カテゴリが最多。',
    findings: [
      '進行中の商談 9 件のうち 4 件は Next Action 日が未設定または期限超過。',
      'サポート受付は前月比 +18%。「操作」カテゴリが最多で FAQ 整備の余地がある。',
      '日報の課題記載率は 31%。データ連携関連の言及が繰り返し出現。',
    ],
    evidence: [
      { source: 'daily', label: '日報', count: 118 },
      { source: 'support', label: 'サポート活動', count: 19 },
      { source: 'sales', label: '営業活動', count: 12 },
    ],
    proposals: [
      { id: 'pr-0001', title: '停滞商談の Next Action 再設定', description: '期限超過商談の担当者と次の一手を決める。', priority: 'high' },
      { id: 'pr-0002', title: '操作系 FAQ の整備', description: '問い合わせ最多カテゴリの FAQ を整備し問い合わせ削減を図る。', priority: 'mid' },
      { id: 'pr-0003', title: '営業定例の週次化', description: '商談状況の共有頻度を上げ、停滞の早期検知を図る。', priority: 'mid' },
    ],
    confidence: 'high',
    feedbackConsidered: [],
    createdAt: prevCycleAt,
    createdBy: 'm-03',
    active: true,
  },
]

export const seedActions: IntelAction[] = [
  {
    id: 'act-0001',
    insightId: 'ins-0001',
    proposalId: 'pr-0001',
    theme: 'management',
    targetId: null,
    targetName: '全社',
    title: '停滞商談の Next Action 再設定',
    description: 'Next Action 期限超過の商談 4 件について、担当者と次アクション・期日を再設定する。',
    status: 'done',
    dueDate: addDays(today, -7),
    ownerId: 'm-03',
    result: '4 件すべてに次アクションと期日を設定。うち 2 件は提案フェーズへ前進。',
    feedbackRating: 5,
    feedbackNote: '停滞の可視化 → 即日対応の流れが効いた。商談前進に直結。',
    feedbackNext: '月次ではなく隔週で同じ棚卸しを回す。',
    createdAt: prevCycleAt,
    updatedAt: `${addDays(today, -6)}T15:00:00+09:00`,
    active: true,
  },
  {
    id: 'act-0002',
    insightId: 'ins-0001',
    proposalId: 'pr-0003',
    theme: 'management',
    targetId: null,
    targetName: '全社',
    title: '営業定例の週次化',
    description: '営業定例を隔週 → 週次へ変更し、商談状況の共有頻度を上げる。',
    status: 'done',
    dueDate: addDays(today, -5),
    ownerId: 'm-04',
    result: '2 週間試行したが、報告準備の負担が増えた割に新しい発見は少なかった。',
    feedbackRating: 2,
    feedbackNote: '頻度を上げるだけでは効果薄。共有フォーマットの問題が本質だった。',
    feedbackNext: '定例頻度は戻し、商談ボードの非同期更新ルールを検討する。',
    createdAt: prevCycleAt,
    updatedAt: `${addDays(today, -3)}T11:00:00+09:00`,
    active: true,
  },
  {
    id: 'act-0003',
    insightId: 'ins-0001',
    proposalId: 'pr-0002',
    theme: 'management',
    targetId: null,
    targetName: '全社',
    title: '操作系 FAQ の整備',
    description: '問い合わせ最多の「操作」カテゴリについて FAQ を整備する。',
    status: 'in_progress',
    dueDate: addDays(today, 7),
    ownerId: 'm-07',
    result: '',
    feedbackRating: null,
    feedbackNote: '',
    feedbackNext: '',
    createdAt: prevCycleAt,
    updatedAt: prevCycleAt,
    active: true,
  },
]
