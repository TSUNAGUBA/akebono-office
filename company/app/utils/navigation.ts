/** ナビゲーション定義（本アプリのメニュー SoT。PC ヘッダー・モバイルボトムナビ共用） */

export interface NavItem {
  to: string
  label: string
  /** lucide アイコンキー（IconGlyph が解決） */
  icon: string
  adminOnly?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'ダッシュボード', icon: 'LayoutDashboard' },
  { to: '/tasks', label: 'タスクボード', icon: 'ClipboardList' },
  { to: '/activity', label: '活動ログ', icon: 'Activity' },
  { to: '/reports', label: '日次報告', icon: 'FileText' },
  { to: '/tokens', label: 'トークン管理', icon: 'Gauge' },
  { to: '/employees', label: 'AI 社員', icon: 'Users', adminOnly: true },
  { to: '/roles', label: 'ロール', icon: 'Shield', adminOnly: true },
]

/** モバイルボトムナビ（5 枠固定） */
export const MOBILE_NAV: NavItem[] = [
  { to: '/', label: 'ホーム', icon: 'LayoutDashboard' },
  { to: '/tasks', label: 'タスク', icon: 'ClipboardList' },
  { to: '/activity', label: '活動', icon: 'Activity' },
  { to: '/reports', label: '報告', icon: 'FileText' },
  { to: '/tokens', label: 'トークン', icon: 'Gauge' },
]

/** 現在パスがナビ項目に一致するか（完全一致。クエリは無視） */
export function isActivePath(current: string, to: string): boolean {
  return current === to
}
