/**
 * ダッシュボード（F-01）の表示・配置カスタマイズ（オペレーター指示 2026-08-03。SoT = 本ファイル）。
 *
 * 「どのメニュー要素をどのセクションに・どの順で置くか（sections）」と「通知欄の位置・AKEBONO
 * 業務セクションの表示・カード密度（options）」をまとめて DashboardLayout で表す。
 * カスタマイズは 5 種のテンプレート（世の中の業務アプリを参考）から選択でき、
 * ユーザー層（この端末/アカウント）とテナント層（全社既定）の 2 階層で保存する。
 *
 * 設定の解決順（useDashboardLayout が適用）:
 *   ユーザー設定 > テナント設定 > デフォルト表示
 * テナント設定は新キー `dashboard-layout`（JSON）を優先し、未設定なら従来の
 * `menu-categories-dashboard`（useMenuCategories の tenant config）を default options と
 * 組み合わせてテナント層として解釈する（既存カスタマイズを尊重 = 原則7 の下位互換）。
 *
 * 本ファイルは純関数のみ（Nuxt 依存なし）。副作用を伴う保存・読込は useDashboardLayout が担う。
 * カード → セクションのグルーピング（categorizeCards）は useMenuCategories と共有する（原則3）。
 *
 * AKEBONO 業態アプリのカテゴリ配置（2026-08-03 #24）: planDashboardCards が「専用セクション（未割当業態）」と
 * 「セクション配置（割当済み業態）」を振り分け、二重表示を防ぐ。業態カードの写像は utils/akebono が SoT。
 */
import type { MenuCard } from '~/types/ui'
import { parseAkebonoSegmentCardId } from '~/utils/akebono'
import {
  DEFAULT_MENU_CATEGORIES, MENU_CARDS,
  type MenuCategoryDef, OTHER_CATEGORY_ID, OTHER_CATEGORY_LABEL,
} from '~/utils/menu-registry'

/** 通知欄の位置。side=右サイド（現行） / bottom=メニュー下 / hidden=非表示 */
export type NotificationPlacement = 'side' | 'bottom' | 'hidden'
/** カード密度（余白）。comfortable=標準 / compact=詰めて表示 */
export type LayoutDensity = 'comfortable' | 'compact'

export interface DashboardLayoutOptions {
  /** 通知欄の位置 */
  notifications: NotificationPlacement
  /** AKEBONO 業務（業態別）セクションを表示するか（実表示は権限・業態数と AND で判定） */
  showAkebono: boolean
  /** カード密度（任意。余白の調整のみ） */
  density: LayoutDensity
}

export interface DashboardLayout {
  /** 由来テンプレート（'default' 等。手動編集の余地に備え保持） */
  templateId: string
  /** セクション構成（id,label,cardIds）= メニュー要素の配置。cardIds は MENU_CARDS.dashboard の id */
  sections: MenuCategoryDef[]
  /** 表示オプション（通知位置・AKEBONO 表示・密度） */
  options: DashboardLayoutOptions
}

export interface DashboardTemplate {
  id: string
  name: string
  description: string
  layout: DashboardLayout
}

/** どの階層の設定が効いているか（表示用） */
export type DashboardScope = 'user' | 'tenant' | 'default'

/** カテゴリ（セクション）ごとにグループ化したカード（useMenuCategories と共用） */
export interface CategorizedCards {
  id: string
  label: string
  cards: MenuCard[]
}

const NOTIFICATION_PLACEMENTS: readonly NotificationPlacement[] = ['side', 'bottom', 'hidden']
const LAYOUT_DENSITIES: readonly LayoutDensity[] = ['comfortable', 'compact']

/** テンプレート未指定時のオプション既定値 */
export const DEFAULT_LAYOUT_OPTIONS: DashboardLayoutOptions = {
  notifications: 'side',
  showAkebono: true,
  density: 'comfortable',
}

/** ダッシュボードの全カード id（MENU_CARDS.dashboard 準拠。focus テンプレートの単一セクション等で使用） */
const ALL_DASHBOARD_CARD_IDS: string[] = MENU_CARDS.dashboard.map(c => c.id)

function cloneSections(sections: MenuCategoryDef[]): MenuCategoryDef[] {
  return sections.map(s => ({ id: s.id, label: s.label, cardIds: [...s.cardIds] }))
}

/**
 * テンプレート定義（5 種。世の中の業務アプリを参考にセクション/メニュー配置を設計）。
 * すべて同じ MENU_CARDS.dashboard の id を、別の section 構成/順序 + options で配置する。
 * cardIds は既存カード id のみを参照する（未割当カード + 外部リンクは categorize が「その他」へ回す）。
 */
export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    id: 'default',
    name: '標準',
    description: '現行の標準レイアウト。意思決定・業務ツール・経営状況をバランス良く配置し、通知は右サイドに常時表示します。',
    layout: {
      templateId: 'default',
      // 現行構成（menu-registry の既定カテゴリ）を流用
      sections: cloneSections(DEFAULT_MENU_CATEGORIES.dashboard),
      options: { notifications: 'side', showAkebono: true, density: 'comfortable' },
    },
  },
  {
    id: 'operations',
    name: '現場オペレーション',
    description: '毎日の打刻・勤怠・シフト・日報を最上部に集約。現場ですぐ開けるフィールド業務向けレイアウト。',
    layout: {
      templateId: 'operations',
      sections: [
        { id: 'daily', label: '毎日の業務', cardIds: ['timecard', 'attendance', 'shift', 'reports', 'ai-assistant'] },
        { id: 'record', label: '記録・共有', cardIds: ['customer-log', 'poipoi', 'minutes', 'workflow'] },
        { id: 'decision', label: 'AI・意思決定', cardIds: ['decision', 'ai-company'] },
        { id: 'insights', label: '経営・状況', cardIds: ['sales', 'media', 'status'] },
        { id: 'support', label: '業務支援', cardIds: ['support', 'inbox'] },
        { id: 'admin', label: '管理', cardIds: ['masters', 'settings'] },
      ],
      options: { notifications: 'side', showAkebono: true, density: 'comfortable' },
    },
  },
  {
    id: 'sales',
    name: '営業・顧客',
    description: '顧客ログ・売上・メディア・稟議を上部に。商談と顧客対応を中心に据えた CRM 風レイアウト。',
    layout: {
      templateId: 'sales',
      sections: [
        { id: 'sales', label: '営業', cardIds: ['customer-log', 'sales', 'media', 'workflow'] },
        { id: 'analysis', label: '状況・判断', cardIds: ['status', 'decision'] },
        { id: 'daily', label: '日々の業務', cardIds: ['timecard', 'attendance', 'shift', 'reports', 'ai-assistant'] },
        { id: 'record', label: '記録・共有', cardIds: ['poipoi', 'minutes'] },
        { id: 'ai', label: 'AIネイティブカンパニー', cardIds: ['ai-company'] },
        { id: 'support', label: '業務支援', cardIds: ['support', 'inbox'] },
        { id: 'admin', label: '管理', cardIds: ['masters', 'settings'] },
      ],
      options: { notifications: 'side', showAkebono: true, density: 'comfortable' },
    },
  },
  {
    id: 'executive',
    name: '経営',
    description: '売上・稼働状況・AIカンパニー・意思決定を最上部に。全体を俯瞰するエグゼクティブ・コックピット。通知は下部にまとめます。',
    layout: {
      templateId: 'executive',
      sections: [
        { id: 'cockpit', label: '経営・状況', cardIds: ['sales', 'status', 'ai-company', 'decision'] },
        { id: 'crm', label: '営業・顧客', cardIds: ['customer-log', 'media', 'workflow'] },
        { id: 'ops', label: '業務', cardIds: ['timecard', 'attendance', 'shift', 'reports', 'ai-assistant', 'poipoi', 'minutes'] },
        { id: 'support', label: '業務支援', cardIds: ['support', 'inbox'] },
        { id: 'admin', label: '管理', cardIds: ['masters', 'settings'] },
      ],
      options: { notifications: 'bottom', showAkebono: true, density: 'comfortable' },
    },
  },
  {
    id: 'focus',
    name: '集中（ミニマル）',
    description: '全メニューを 1 つのリストにまとめ、余白を抑えたミニマル表示。通知は下部・AKEBONO 業務セクションは非表示。',
    layout: {
      templateId: 'focus',
      sections: [
        { id: 'menu', label: 'メニュー', cardIds: [...ALL_DASHBOARD_CARD_IDS] },
      ],
      options: { notifications: 'bottom', showAkebono: false, density: 'compact' },
    },
  },
]

/** テンプレートを id で取得（無ければ undefined） */
export function templateById(id: string): DashboardTemplate | undefined {
  return DASHBOARD_TEMPLATES.find(t => t.id === id)
}

/**
 * テンプレートを保存用の DashboardLayout に materialize（毎回ディープコピー）。
 * 未知 id は default テンプレートに倒す（情報損失なし = 原則2）。
 */
export function materializeLayout(templateId: string): DashboardLayout {
  const tpl = templateById(templateId) ?? DASHBOARD_TEMPLATES[0]!
  return {
    templateId: tpl.id,
    sections: cloneSections(tpl.layout.sections),
    options: { ...tpl.layout.options },
  }
}

/** default テンプレートの layout（毎回ディープコピー） */
export function defaultDashboardLayout(): DashboardLayout {
  return materializeLayout('default')
}

/**
 * カスタムのセクション構成から DashboardLayout を組み立てる（useDashboardLayout.saveSections が使用・純関数）。
 * sections はディープコピーし、options はそのまま（呼び出し側で現行 options を渡す）。templateId は 'custom'。
 */
export function buildCustomLayout(sections: MenuCategoryDef[], options: DashboardLayoutOptions): DashboardLayout {
  return {
    templateId: 'custom',
    sections: cloneSections(sections),
    options: { ...options },
  }
}

/**
 * セクション定義の妥当性検証（JSON 文字列・配列の両方を受け付ける）。
 * 壊れた JSON・型不一致は null（呼び出し側で 1 段フォールバック）。空配列は「空の構成」として許容する
 * （= 全カードが「その他」に集約される。従来の menu-categories 空設定と同じ挙動）。
 */
export function parseMenuSections(raw: unknown): MenuCategoryDef[] | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    try { value = JSON.parse(raw) } catch { return null }
  }
  if (!Array.isArray(value)) return null
  const defs: MenuCategoryDef[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const { id, label, cardIds } = item as Record<string, unknown>
    if (typeof id !== 'string' || id === '' || typeof label !== 'string' || !Array.isArray(cardIds)) return null
    defs.push({ id, label, cardIds: cardIds.filter((c): c is string => typeof c === 'string') })
  }
  return defs
}

/** オプションの正規化（不正値・欠落は既定へ。将来のフィールド追加に耐える） */
function normalizeOptions(raw: unknown): DashboardLayoutOptions {
  const rec = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {}
  return {
    notifications: NOTIFICATION_PLACEMENTS.includes(rec.notifications as NotificationPlacement)
      ? rec.notifications as NotificationPlacement
      : DEFAULT_LAYOUT_OPTIONS.notifications,
    showAkebono: typeof rec.showAkebono === 'boolean' ? rec.showAkebono : DEFAULT_LAYOUT_OPTIONS.showAkebono,
    density: LAYOUT_DENSITIES.includes(rec.density as LayoutDensity)
      ? rec.density as LayoutDensity
      : DEFAULT_LAYOUT_OPTIONS.density,
  }
}

/**
 * DashboardLayout の妥当性検証（JSON 文字列 / オブジェクトの両対応）。
 * sections が妥当な配列でなければ null（= その層は無効として次の層へフォールバック）。
 * options は欠落・不正でも既定で補完する（表示を壊さない）。
 */
export function parseDashboardLayout(raw: unknown): DashboardLayout | null {
  if (raw === null || raw === undefined) return null
  let obj: unknown = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    try { obj = JSON.parse(raw) } catch { return null }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const rec = obj as Record<string, unknown>
  const sections = parseMenuSections(rec.sections)
  if (sections === null) return null
  const templateId = typeof rec.templateId === 'string' && rec.templateId !== '' ? rec.templateId : 'custom'
  return { templateId, sections, options: normalizeOptions(rec.options) }
}

/**
 * 従来の menu-categories-dashboard（sections のみ）をテナント層の DashboardLayout として解釈する
 * （下位互換 = 原則7）。options は default テンプレートの既定を組み合わせる。
 * 空配列は「空の構成」として尊重する（従来 index.vue の categorize と同じ挙動を維持）。
 */
export function layoutFromLegacyCategories(raw: string): DashboardLayout | null {
  const sections = parseMenuSections(raw)
  if (sections === null) return null
  return { templateId: 'default', sections, options: { ...DEFAULT_LAYOUT_OPTIONS } }
}

/**
 * 有効レイアウトの解決（純関数）。ユーザー設定 > テナント設定 > デフォルト の順。
 * 各層は壊れていれば 1 段スキップして次の層へフォールバックする（表示を壊さない）。
 *  - userRaw: ユーザー層（API=me.prefs.dashboardLayout / mock=localStorage。文字列 or オブジェクト）
 *  - tenantRaw: テナント層の新キー `dashboard-layout`（JSON 文字列）
 *  - legacyCategoriesRaw: 従来の `menu-categories-dashboard`（JSON 文字列。下位互換）
 */
export function resolveDashboardLayout(inputs: {
  userRaw?: unknown
  tenantRaw?: string
  legacyCategoriesRaw?: string
}): { layout: DashboardLayout; scope: DashboardScope } {
  const user = parseDashboardLayout(inputs.userRaw)
  if (user) return { layout: user, scope: 'user' }

  const tenant = parseDashboardLayout(inputs.tenantRaw ?? '')
  if (tenant) return { layout: tenant, scope: 'tenant' }

  const legacy = layoutFromLegacyCategories(inputs.legacyCategoriesRaw ?? '')
  if (legacy) return { layout: legacy, scope: 'tenant' }

  return { layout: defaultDashboardLayout(), scope: 'default' }
}

/**
 * カード一覧をセクションごとにグループ化する（カード側のフィルタ = 権限・トグルは呼び出し側で適用済み）。
 * 未割当カードは「その他」へ。空セクションは落とす。useMenuCategories.categorize と同一ロジック（原則3）。
 */
export function categorizeCards(cards: MenuCard[], sections: MenuCategoryDef[]): CategorizedCards[] {
  const byId = new Map(cards.map(c => [String(c.id), c]))
  const assigned = new Set<string>()
  const groups: CategorizedCards[] = []
  for (const cat of sections) {
    const catCards = cat.cardIds.map(id => byId.get(id)).filter((c): c is MenuCard => !!c)
    for (const c of catCards) assigned.add(String(c.id))
    if (catCards.length > 0) groups.push({ id: cat.id, label: cat.label, cards: catCards })
  }
  const rest = cards.filter(c => !assigned.has(String(c.id)))
  if (rest.length > 0) groups.push({ id: OTHER_CATEGORY_ID, label: OTHER_CATEGORY_LABEL, cards: rest })
  return groups
}

/** セクション定義群の cardIds から、セクションへ割当済みの AKEBONO 業態 id の集合を返す（純関数） */
export function assignedAkebonoSegmentIds(sections: MenuCategoryDef[]): Set<string> {
  const ids = new Set<string>()
  for (const sec of sections) {
    for (const cardId of sec.cardIds) {
      const segId = parseAkebonoSegmentCardId(cardId)
      if (segId !== null) ids.add(segId)
    }
  }
  return ids
}

/** planDashboardCards の結果（categorize へ渡すプール + 専用セクションが担当する未割当業態） */
export interface DashboardCardPlan {
  /** categorize に渡すカードプール（基本メニュー + 外部リンク + 条件付き AKEBONO カード） */
  pool: MenuCard[]
  /** 専用「AKEBONO 業務（業態別）」セクションに表示する未割当業態 id（showAkebono=false 時は空） */
  unassignedAkebonoSegmentIds: string[]
}

/**
 * ダッシュボードのカードプールと専用 AKEBONO セクションの割り振りを決める（純関数・単体テスト対象）。
 * AKEBONO カードの二重表示を防ぐための中核ロジック（オペレーター指示 2026-08-03 #24）:
 *  - showAkebono=true（専用セクションを出す）: セクションへ割当済みの業態カードだけをプールへ入れ
 *    （categorize が指定セクションへ配置）、未割当の業態は専用セクションが担当する
 *    （= 未割当が「その他」へ落ちて二重に見えるのを防ぐ）。
 *  - showAkebono=false（専用セクションを出さない。focus テンプレート等）: 全業態カードをプールへ入れる
 *    （未割当は「その他」へ = 消えない）。専用セクションは出さない。
 * ※ AKEBONO そのものが利用不可（機能トグル OFF・権限なし・業態なし）のときは、呼び出し側が
 *    akebonoCards に空配列を渡す（= どこにも出さない）。本関数は渡されたカードのみを扱う。
 */
export function planDashboardCards(input: {
  internalCards: MenuCard[]
  externalCards: MenuCard[]
  akebonoCards: MenuCard[]
  sections: MenuCategoryDef[]
  showAkebono: boolean
}): DashboardCardPlan {
  const { internalCards, externalCards, akebonoCards, sections, showAkebono } = input
  const base = [...internalCards, ...externalCards]
  if (!showAkebono) {
    return { pool: [...base, ...akebonoCards], unassignedAkebonoSegmentIds: [] }
  }
  const assigned = assignedAkebonoSegmentIds(sections)
  const assignedCards: MenuCard[] = []
  const unassigned: string[] = []
  for (const c of akebonoCards) {
    const segId = parseAkebonoSegmentCardId(String(c.id))
    if (segId === null) continue
    if (assigned.has(segId)) assignedCards.push(c)
    else unassigned.push(segId)
  }
  return { pool: [...base, ...assignedCards], unassignedAkebonoSegmentIds: unassigned }
}
