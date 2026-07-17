/** UI 共通型（components/ui の契約） */

export type Tone = 'ok' | 'warn' | 'serious' | 'crit' | 'info' | 'neutral' | 'brand'

export interface TableColumn {
  key: string
  label: string
  width?: string
  align?: 'left' | 'right' | 'center'
  /** モバイルカード表示で主要行に出すか */
  primary?: boolean
}

export interface FieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'time' | 'select' | 'multiselect' | 'boolean' | 'textarea'
  required?: boolean
  options?: { value: string; label: string }[]
  /** select の空値（''）option の表示（既定「選択してください」。例: 未所属・未設定） */
  emptyLabel?: string
  placeholder?: string
  hint?: string
  min?: number
  max?: number
  step?: number
}

export interface MenuCard {
  id: string
  title: string
  description: string
  icon: string // lucide アイコン名
  to?: string
  href?: string // 外部リンク
  badge?: number | string
  disabled?: boolean
  tone?: Tone
}

export interface TabItem {
  key: string
  label: string
  badge?: number
}
