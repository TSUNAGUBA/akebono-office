/**
 * ナビゲーション定義（SoT）
 * サイドバー・モバイル下部ナビ・ダッシュボードのカード型メニューはすべてここから導出する。
 */

export interface NavItem {
  path: string
  label: string
  icon: string // lucide アイコン名
  adminOnly?: boolean
  /** 前方一致でアクティブ判定するか */
  matchPrefix?: boolean
  /** 機能トグルのキー（無効時は非表示） */
  featureKey?: string
}

export interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'home',
    label: 'ホーム',
    items: [
      { path: '/', label: 'ダッシュボード', icon: 'LayoutDashboard' },
      { path: '/inbox', label: '通知・エスカレーション', icon: 'Inbox' },
    ],
  },
  {
    id: 'work',
    label: '業務ツール',
    items: [
      { path: '/attendance', label: '勤怠管理', icon: 'Clock' },
      { path: '/shift', label: 'シフト表', icon: 'CalendarRange', featureKey: 'shift' },
      { path: '/reports', label: '日報・週報', icon: 'NotebookPen' },
      { path: '/workflow', label: 'ワークフロー', icon: 'GitPullRequestArrow' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    items: [
      { path: '/decision', label: '意思決定支援', icon: 'Scale', featureKey: 'decision', matchPrefix: true },
      { path: '/ai-company', label: 'AIネイティブカンパニー', icon: 'Building2', featureKey: 'aiCompany', matchPrefix: true },
      { path: '/akebono', label: 'AKEBONO', icon: 'Sunrise', featureKey: 'akebono' },
    ],
  },
  {
    id: 'support',
    label: '支援・状況',
    items: [
      { path: '/support', label: '業務支援ツール', icon: 'Wrench', matchPrefix: true },
      { path: '/status', label: '稼働状況', icon: 'Activity', featureKey: 'status', matchPrefix: true },
    ],
  },
  {
    id: 'admin',
    label: '管理',
    items: [
      { path: '/masters', label: 'マスタメンテナンス', icon: 'Database', adminOnly: true, matchPrefix: true },
      { path: '/settings', label: '設定', icon: 'Settings', adminOnly: true, matchPrefix: true },
    ],
  },
]

/** モバイル下部ナビ（5 項目固定） */
export const MOBILE_NAV: NavItem[] = [
  { path: '/', label: 'ホーム', icon: 'House' },
  { path: '/attendance', label: '勤怠', icon: 'Clock' },
  { path: '/reports', label: '日報', icon: 'NotebookPen' },
  { path: '/inbox', label: '通知', icon: 'Inbox' },
  { path: '/menu', label: 'メニュー', icon: 'Menu' },
]

/** 現在パスがナビ項目にマッチするか（最長一致は呼び出し側で） */
export function isActivePath(current: string, item: NavItem): boolean {
  if (item.matchPrefix) return current === item.path || current.startsWith(`${item.path}/`)
  return current === item.path
}
