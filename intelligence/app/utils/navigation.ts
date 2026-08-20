/** ナビゲーション定義（本アプリのメニュー SoT。PC ヘッダー・モバイルボトムナビ共用） */

export interface NavItem {
  to: string
  label: string
  /** lucide アイコンキー */
  icon: string
  adminOnly?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'ダッシュボード', icon: 'LayoutDashboard' },
  { to: '/insights', label: 'インサイト', icon: 'Lightbulb' },
  { to: '/actions', label: 'アクション', icon: 'ListChecks' },
  { to: '/cycles', label: 'ループ履歴', icon: 'RefreshCw' },
  { to: '/data', label: 'データソース', icon: 'Database' },
]

/** モバイルボトムナビ（5 枠固定） */
export const MOBILE_NAV: NavItem[] = [
  { to: '/', label: 'ホーム', icon: 'LayoutDashboard' },
  { to: '/insights', label: 'インサイト', icon: 'Lightbulb' },
  { to: '/actions', label: 'アクション', icon: 'ListChecks' },
  { to: '/cycles', label: 'ループ', icon: 'RefreshCw' },
  { to: '/data', label: 'データ', icon: 'Database' },
]

/** 現在パスがナビ項目に一致するか（完全一致。クエリは無視） */
export function isActivePath(current: string, to: string): boolean {
  return current === to
}
