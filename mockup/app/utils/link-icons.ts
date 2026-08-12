/**
 * 外部リンク（設定 > 外部リンク）のアイコン選択肢（改善要望: プレビュー選択式にしたい）。
 * - 業務ツールで使いやすい lucide アイコンのキュレーション。プレビュー付きグリッドで選ぶ。
 * - すべて lucide-vue-next に実在するキー（tests/link-icons.test.ts が実在性・重複を検証）。
 * - SEGMENT_ICON_CHOICES（utils/akebono）の外部リンク版。用途が異なるため別リストとして持つ。
 */
export const LINK_ICON_CHOICES = [
  'Link', 'ExternalLink', 'Globe', 'Table2', 'FileSpreadsheet', 'Receipt', 'BookOpen',
  'FileText', 'FolderOpen', 'Calendar', 'Mail', 'MessageSquare', 'CreditCard', 'Wallet',
  'BarChart3', 'LineChart', 'Database', 'Server', 'Cloud', 'Briefcase', 'Users',
  'ClipboardList', 'CheckSquare', 'Wrench', 'Settings', 'Building2', 'Truck', 'Package',
] as const

export type LinkIconKey = (typeof LINK_ICON_CHOICES)[number]

/** 外部リンクの既定アイコン（未選択・未検出時のフォールバック） */
export const LINK_ICON_FALLBACK = 'Link'
