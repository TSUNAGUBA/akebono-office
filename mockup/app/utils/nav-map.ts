/**
 * ページ間導線マップ（バッチ7h・オペレーター指示 2026-07-19 #10。SoT）。
 * 「親ページへ戻る」リンクと「関連ページ・関連設定」ドロップダウンはここから導出し、
 * レイアウトヘッダーが全ページ共通で描画する（ページ個別のアドホックな戻るリンクは廃止 = 原則3）。
 *
 * - parent: 構造上の親（ブラウザ履歴ではなく情報設計上の親へ戻る = 迷子にならない）
 * - related: そのページの機能に関係するマスタ・設定・関連機能（権限 canPath / adminOnly でフィルタ）
 * - キーは実パス。動的ルート・子ページ一括は `prefix: true` の前方一致（最長一致で解決）
 */

export interface NavLink {
  to: string
  label: string
  /** 管理者にのみ表示（マスタ・設定系。canPath と併用） */
  adminOnly?: boolean
}

export interface NavMapEntry {
  /** 前方一致でマッチさせる（動的ルート用） */
  prefix?: boolean
  parent?: NavLink
  related?: NavLink[]
}

const HOME: NavLink = { to: '/', label: 'ホーム' }
const MASTERS: NavLink = { to: '/masters', label: 'マスタメンテナンス', adminOnly: true }
const SETTINGS: NavLink = { to: '/settings', label: '設定', adminOnly: true }
const PERMISSIONS: NavLink = { to: '/masters/permissions', label: '権限設定', adminOnly: true }
const MEMBERS: NavLink = { to: '/masters/members', label: 'メンバー管理', adminOnly: true }
const CUSTOMERS: NavLink = { to: '/masters/customers', label: '顧客（会社）マスタ', adminOnly: true }
const PROJECTS: NavLink = { to: '/masters/projects', label: 'プロジェクトマスタ', adminOnly: true }
const WORK_CATEGORIES: NavLink = { to: '/masters/work-categories', label: '業務種別マスタ', adminOnly: true }

export const NAV_MAP: Record<string, NavMapEntry> = {
  '/attendance': {
    parent: HOME,
    related: [
      { to: '/shift', label: 'シフト表' },
      { to: '/masters/leave-types', label: '休暇種別マスタ', adminOnly: true },
      { to: '/masters/holidays', label: '祝日マスタ', adminOnly: true },
      MEMBERS,
      PERMISSIONS,
    ],
  },
  '/shift': {
    parent: HOME,
    related: [
      { to: '/attendance', label: '勤怠管理' },
      { to: '/masters/holidays', label: '祝日マスタ', adminOnly: true },
      MEMBERS,
    ],
  },
  '/reports': {
    parent: HOME,
    related: [
      { to: '/ai-assistant', label: 'AI業務アシスタント' },
      { to: '/poipoi', label: 'ぽいぽいポスト' },
      WORK_CATEGORIES,
      PROJECTS,
      PERMISSIONS,
      { to: '/settings', label: '設定（日報の入力方式）', adminOnly: true },
    ],
  },
  '/ai-assistant': {
    parent: HOME,
    related: [
      { to: '/reports', label: '日報・週報' },
      PROJECTS,
    ],
  },
  '/poipoi': {
    parent: HOME,
    related: [
      { to: '/minutes', label: '議事録' },
      WORK_CATEGORIES,
      CUSTOMERS,
      PROJECTS,
    ],
  },
  '/minutes': {
    parent: HOME,
    related: [
      { to: '/poipoi', label: 'ぽいぽいポスト' },
      WORK_CATEGORIES,
      CUSTOMERS,
      PROJECTS,
    ],
  },
  '/workflow': {
    parent: HOME,
    related: [
      MEMBERS,
      PERMISSIONS,
      SETTINGS,
    ],
  },
  '/inbox': { parent: HOME, related: [SETTINGS] },
  '/sales': {
    parent: HOME,
    related: [
      { to: '/decision', label: '意思決定支援' },
      CUSTOMERS,
      PERMISSIONS,
    ],
  },
  '/decision': { parent: HOME, related: [{ to: '/sales', label: '売上管理' }] },
  '/decision/': { prefix: true, parent: { to: '/decision', label: '意思決定支援' } },
  '/status': { parent: HOME, related: [CUSTOMERS] },
  '/status/': { prefix: true, parent: { to: '/status', label: '提供システム稼働状況' } },
  '/support': { parent: HOME, related: [SETTINGS] },
  '/support/chatbot': {
    parent: { to: '/support', label: '業務支援ツール' },
    related: [
      { to: '/support/documents', label: 'ドキュメント管理' },
      { to: '/masters/knowledge', label: 'ナレッジマスタ', adminOnly: true },
    ],
  },
  '/support/documents': {
    parent: { to: '/support', label: '業務支援ツール' },
    related: [{ to: '/masters/knowledge', label: 'ナレッジマスタ', adminOnly: true }],
  },
  '/ai-company': {
    parent: HOME,
    related: [
      { to: '/ai-company/employees', label: 'AI 社員の管理', adminOnly: true },
      { to: '/ai-company/roles', label: 'ロール設定', adminOnly: true },
      { to: '/reports', label: '日報・週報' },
    ],
  },
  '/ai-company/employees': {
    parent: { to: '/ai-company', label: 'AIネイティブカンパニー' },
    related: [{ to: '/ai-company/roles', label: 'ロール設定', adminOnly: true }],
  },
  '/ai-company/roles': {
    parent: { to: '/ai-company', label: 'AIネイティブカンパニー' },
    related: [{ to: '/ai-company/employees', label: 'AI 社員の管理', adminOnly: true }],
  },
  '/akebono': { parent: HOME },
  '/menu': { parent: HOME },
  '/profile': { parent: HOME, related: [SETTINGS] },
  '/settings': {
    parent: HOME,
    related: [
      MASTERS,
      { to: '/attendance?tab=settings', label: '勤怠ルール', adminOnly: true },
      { to: '/workflow?tab=routes', label: '承認経路', adminOnly: true },
      PERMISSIONS,
    ],
  },
  '/masters': { parent: HOME, related: [SETTINGS] },
  '/masters/members': {
    parent: MASTERS,
    related: [
      { to: '/masters/departments', label: '部署マスタ', adminOnly: true },
      { to: '/masters/titles', label: '役職マスタ', adminOnly: true },
      PERMISSIONS,
    ],
  },
  '/masters/departments': { parent: MASTERS, related: [MEMBERS] },
  '/masters/customers': {
    parent: MASTERS,
    related: [
      { to: '/masters/contacts', label: '顧客（人）マスタ', adminOnly: true },
      { to: '/masters/industries', label: '業界マスタ', adminOnly: true },
      { to: '/masters/relations-company', label: '会社間関係', adminOnly: true },
    ],
  },
  '/masters/contacts': {
    parent: MASTERS,
    related: [
      CUSTOMERS,
      { to: '/masters/relations-contact', label: '人間関係', adminOnly: true },
      { to: '/masters/relation-types', label: '関係種別マスタ', adminOnly: true },
    ],
  },
  '/masters/projects': { parent: MASTERS, related: [CUSTOMERS, MEMBERS] },
  '/masters/titles': { parent: MASTERS, related: [MEMBERS, PERMISSIONS] },
  '/masters/leave-types': {
    parent: MASTERS,
    related: [{ to: '/attendance?tab=leave-admin', label: '休暇管理（勤怠）' }],
  },
  '/masters/work-categories': {
    parent: MASTERS,
    related: [
      { to: '/poipoi', label: 'ぽいぽいポスト' },
      { to: '/minutes', label: '議事録' },
    ],
  },
  '/masters/industries': { parent: MASTERS, related: [CUSTOMERS, { to: '/masters/knowledge', label: 'ナレッジマスタ', adminOnly: true }] },
  '/masters/holidays': { parent: MASTERS, related: [{ to: '/attendance', label: '勤怠管理' }] },
  '/masters/knowledge': { parent: MASTERS, related: [{ to: '/support/chatbot', label: 'AIチャットボット' }] },
  '/masters/relation-types': {
    parent: MASTERS,
    related: [
      { to: '/masters/relations-company', label: '会社間関係', adminOnly: true },
      { to: '/masters/relations-contact', label: '人間関係', adminOnly: true },
    ],
  },
  '/masters/relations-company': {
    parent: MASTERS,
    related: [{ to: '/masters/relation-types', label: '関係種別マスタ', adminOnly: true }, CUSTOMERS],
  },
  '/masters/relations-contact': {
    parent: MASTERS,
    related: [
      { to: '/masters/relation-types', label: '関係種別マスタ', adminOnly: true },
      { to: '/masters/contacts', label: '顧客（人）マスタ', adminOnly: true },
    ],
  },
  '/masters/company': { parent: MASTERS, related: [{ to: '/masters/industries', label: '業界マスタ', adminOnly: true }] },
  '/masters/permissions': { parent: MASTERS, related: [MEMBERS, { to: '/masters/titles', label: '役職マスタ', adminOnly: true }, SETTINGS] },
}

/** 現在パスの導線エントリ（完全一致 → prefix の最長一致。なければ null） */
export function navEntryOf(path: string): NavMapEntry | null {
  const exact = NAV_MAP[path]
  if (exact && !exact.prefix) return exact
  let best: NavMapEntry | null = null
  let bestLen = -1
  for (const [key, entry] of Object.entries(NAV_MAP)) {
    if (entry.prefix && path.startsWith(key) && key.length > bestLen) {
      best = entry
      bestLen = key.length
    }
  }
  return best
}
