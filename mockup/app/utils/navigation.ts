/**
 * ナビゲーション定義（SoT）
 * ヘッダーのページタイトル・モバイル下部ナビ・全機能メニュー（/menu）はここから導出する。
 * ※ PC のサイドメニューは廃止（2026-07-16 オペレーター指示）。
 *   PC の遷移はダッシュボードのカード型メニュー（pages/index.vue）起点で行う。
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
      { path: '/timecard', label: 'タイムカード', icon: 'Clock3' },
      { path: '/attendance', label: '勤怠管理', icon: 'Clock' },
      { path: '/shift', label: 'シフト表', icon: 'CalendarRange', featureKey: 'shift' },
      { path: '/reports', label: '日報', icon: 'NotebookPen' },
      { path: '/reports?kind=weekly', label: '週報', icon: 'CalendarDays' },
      { path: '/reports?kind=monthly', label: '月報', icon: 'CalendarClock' },
      { path: '/ai-assistant', label: 'AI業務アシスタント', icon: 'Sparkles' },
      { path: '/customer-log', label: '顧客活動', icon: 'MessageSquare' },
      { path: '/support-activity', label: 'サポート活動', icon: 'Headset' },
      { path: '/sales-activity', label: '営業活動', icon: 'Handshake' },
      { path: '/partner-activity', label: 'ビジネスパートナー活動', icon: 'Users' },
      { path: '/workflow', label: '稟議', icon: 'GitPullRequestArrow' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    items: [
      { path: '/decision', label: '意思決定支援', icon: 'Scale', featureKey: 'decision', matchPrefix: true },
      { path: '/ai-company', label: 'AIネイティブカンパニー', icon: 'Building2', featureKey: 'aiCompany', matchPrefix: true },
      { path: '/akebono', label: 'AKEBONO', icon: 'Sunrise', featureKey: 'akebono' },
      // メディア分析（/media）は AKEBONO 業務配下のアプリへ移設（2026-07-28）。トップ独立メニューからは撤去。
    ],
  },
  {
    id: 'support',
    label: '支援・状況',
    items: [
      { path: '/support', label: '業務支援ツール', icon: 'Wrench', matchPrefix: true },
      { path: '/sales', label: '売上管理', icon: 'TrendingUp' },
      { path: '/status', label: '提供システム稼働状況', icon: 'Activity', featureKey: 'status', matchPrefix: true },
    ],
  },
  {
    id: 'admin',
    label: '管理',
    items: [
      { path: '/improvements', label: '改善要望', icon: 'MessageSquarePlus' },
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

/**
 * 現在パスがナビ項目にマッチするか（最長一致は呼び出し側で）。current は route.fullPath を渡す。
 * 改修依頼 2026-08-19 第4弾: 日報/週報/月報は同一パス /reports をクエリ ?kind で切り替えるため、
 * クエリ付き項目は kind の一致で判定する（日報 = kind 無し）。
 */
export function isActivePath(current: string, item: NavItem): boolean {
  const [curPath = '', curQuery = ''] = current.split('?')
  const [itemPath = '', itemQuery = ''] = item.path.split('?')
  if (item.matchPrefix) return curPath === itemPath || curPath.startsWith(`${itemPath}/`)
  if (curPath !== itemPath) return false
  const curKind = new URLSearchParams(curQuery).get('kind') ?? ''
  const itemKind = new URLSearchParams(itemQuery).get('kind') ?? ''
  return curKind === itemKind
}
