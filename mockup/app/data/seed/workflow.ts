/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { ApprovalLog, DelegateSetting, WorkflowRequest, WorkflowRouteStep } from '~/types/domain'
import { addDays } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

/** 経路スナップショット生成（core.ts の workflowRoutes と整合するロール列） */
function snap(...roles: WorkflowRouteStep['approverRole'][]): WorkflowRouteStep[] {
  return roles.map((approverRole, i) => ({
    order: i + 1, approverRole, approverMemberId: null, mode: 'serial' as const,
  }))
}

export const seedWorkflowRequests: WorkflowRequest[] = [
  // 承認中（step1: マネージャー）— 既定ユーザー m-03 の承認待ちデモ
  {
    id: 'WF-0001', category: 'purchase', title: '開発用モニター 2 台の購入', amount: 86000,
    body: '開発部の増員に伴い 27 インチモニターを 2 台購入したい。相見積 2 社: A 社 86,000 円 / B 社 92,000 円。',
    attachments: ['見積書_A社.pdf'], requesterId: 'm-05', status: 'in_review', currentStep: 1,
    routeSnapshot: snap('manager'),
    createdAt: `${addDays(today, -2)}T10:00:00+09:00`,
  },
  // 決裁済（ログ完備: 申請 → 承認）
  {
    id: 'WF-0002', category: 'expense', title: '技術書籍・オンライン講座の購入', amount: 32000,
    body: 'AI 分析基盤の開発に向けた学習教材。書籍 3 冊とオンライン講座 1 件。',
    attachments: ['領収書一覧.pdf'], requesterId: 'm-06', status: 'approved', currentStep: 1,
    routeSnapshot: snap('manager'),
    createdAt: `${addDays(today, -6)}T09:20:00+09:00`,
  },
  // 却下（コメント付き）
  {
    id: 'WF-0003', category: 'trip', title: '沖縄・シーサイドホテルズ視察出張（2 名）', amount: 210000,
    body: 'DX 構想策定の事前視察として 2 名で 2 泊 3 日の現地調査を行いたい。',
    attachments: ['旅程案.pdf', '概算見積.xlsx'], requesterId: 'm-07', status: 'rejected', currentStep: 2,
    routeSnapshot: snap('manager', 'director'),
    createdAt: `${addDays(today, -8)}T11:00:00+09:00`,
  },
  // 差戻し（申請者が編集 → 再申請できる）
  {
    id: 'WF-0004', category: 'purchase', title: '負荷試験用クラウド環境の増強', amount: 480000,
    body: 'トクタケ AI 分析基盤の負荷試験に向けて GPU インスタンスを 1 ヶ月増強したい。',
    attachments: ['構成見積_C社.pdf'], requesterId: 'm-06', status: 'remanded', currentStep: 1,
    routeSnapshot: snap('manager', 'director'),
    createdAt: `${addDays(today, -1)}T09:00:00+09:00`,
  },
  // 承認中 step2 の高額案件（100 万超 = 3 段階経路。代理設定により m-03 が代理承認できる）
  {
    id: 'WF-0005', category: 'purchase', title: '分析基盤用 GPU サーバーの購入', amount: 1850000,
    body: 'トクタケ AI 分析プラットフォームの本番推論用 GPU サーバー 1 台。3 社見積の最安。保守 3 年込み。',
    attachments: ['見積書_D社.pdf', '構成仕様書.pdf', '見積比較表.xlsx'], requesterId: 'm-05', status: 'in_review', currentStep: 2,
    routeSnapshot: snap('manager', 'director', 'president'),
    createdAt: `${addDays(today, -3)}T10:00:00+09:00`,
  },
  // 下書き（既定ユーザー m-03 が編集して提出できる）
  {
    id: 'WF-0006', category: 'contract', title: '北都物流との業務委託契約更新', amount: 15000000,
    body: '物流改善コンサルティングの契約更新（2026 年度下期）。単価・スコープは現行踏襲。',
    attachments: [], requesterId: 'm-03', status: 'draft', currentStep: 0,
    routeSnapshot: [],
    createdAt: `${addDays(today, -1)}T16:40:00+09:00`,
  },
]

export const seedApprovalLogs: ApprovalLog[] = [
  // WF-0001（承認中 step1）
  { id: 'apl-0001', requestId: 'WF-0001', step: 0, actorId: 'm-05', delegateForId: null, action: 'submit', comment: '', at: `${addDays(today, -2)}T10:00:00+09:00` },
  // WF-0002（決裁済）
  { id: 'apl-0002', requestId: 'WF-0002', step: 0, actorId: 'm-06', delegateForId: null, action: 'submit', comment: '', at: `${addDays(today, -6)}T09:20:00+09:00` },
  { id: 'apl-0003', requestId: 'WF-0002', step: 1, actorId: 'm-03', delegateForId: null, action: 'approve', comment: '学習内容の共有会もお願いします', at: `${addDays(today, -6)}T13:05:00+09:00` },
  // WF-0003（却下）
  { id: 'apl-0004', requestId: 'WF-0003', step: 0, actorId: 'm-07', delegateForId: null, action: 'submit', comment: '', at: `${addDays(today, -8)}T11:00:00+09:00` },
  { id: 'apl-0005', requestId: 'WF-0003', step: 1, actorId: 'm-03', delegateForId: null, action: 'approve', comment: '現地調査は有効と判断', at: `${addDays(today, -8)}T15:10:00+09:00` },
  { id: 'apl-0006', requestId: 'WF-0003', step: 2, actorId: 'm-02', delegateForId: null, action: 'reject', comment: '構想策定フェーズの受注前のため時期尚早。受注確定後にオンライン調査から始めてください', at: `${addDays(today, -7)}T10:30:00+09:00` },
  // WF-0004（差戻し）
  { id: 'apl-0007', requestId: 'WF-0004', step: 0, actorId: 'm-06', delegateForId: null, action: 'submit', comment: '', at: `${addDays(today, -1)}T09:00:00+09:00` },
  { id: 'apl-0008', requestId: 'WF-0004', step: 1, actorId: 'm-03', delegateForId: null, action: 'remand', comment: '10 万円超のため相見積（2 社以上）の添付が必要です。期間も 2 週間で足りないか再検討を', at: `${addDays(today, -1)}T11:30:00+09:00` },
  // WF-0005（承認中 step2）
  { id: 'apl-0009', requestId: 'WF-0005', step: 0, actorId: 'm-05', delegateForId: null, action: 'submit', comment: '', at: `${addDays(today, -3)}T10:00:00+09:00` },
  { id: 'apl-0010', requestId: 'WF-0005', step: 1, actorId: 'm-03', delegateForId: null, action: 'approve', comment: '見積比較を確認。妥当', at: `${addDays(today, -2)}T09:40:00+09:00` },
]

export const seedDelegateSettings: DelegateSetting[] = [
  // 佐伯取締役（m-02）が出張のため葛西（m-03）へ代理承認を設定（今日を含む期間 = 有効）
  {
    id: 'dg-0001', memberId: 'm-02', delegateMemberId: 'm-03',
    from: addDays(today, -1), to: addDays(today, 5), active: true,
  },
]
