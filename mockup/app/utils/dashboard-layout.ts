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

/**
 * 通知欄の位置（**PC シーン専用**）。side=右サイド（現行・lg+） / bottom=メニュー下（md+） /
 * top=メニュー上（md+。通知を最上段に = 改善要望 2026-08-17） / hidden=非表示。
 * モバイルは本設定に依存せず、メニュー最優先・通知はヘッダーのベル/下部ナビ「通知」から開く（index.vue で分岐）。
 */
export type NotificationPlacement = 'side' | 'bottom' | 'top' | 'hidden'
/** カード密度（余白）。comfortable=標準 / compact=詰めて表示 */
export type LayoutDensity = 'comfortable' | 'compact'

export interface DashboardLayoutOptions {
  /** 通知欄の位置（配置キー未設定時のフォールバック値。2026-08-18 の分離以降、SoT は配置専用キー） */
  notifications: NotificationPlacement
  /**
   * true = このレイアウトは通知配置を「自分では指定しない」（配置キー・下位層へ委譲する）。
   * 2026-08-18 の分離**後**に保存されたレイアウトが立てる。未定義（分離前の保存値）は
   * 「ユーザーがレイアウトで配置を選んだ」当時の意思として尊重し、ユーザー層ではテナント配置キーより優先する（原則7）。
   * これが無いと、テンプレート適用時に書き込むフォールバック値（テナント由来など）がユーザー層に固定され、
   * 以後のテナント配置変更・自分の配置解除が効かなくなる（レビュー R5）。
   */
  notificationsInherit?: boolean
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

const NOTIFICATION_PLACEMENTS: readonly NotificationPlacement[] = ['side', 'bottom', 'top', 'hidden']
const LAYOUT_DENSITIES: readonly LayoutDensity[] = ['comfortable', 'compact']

/**
 * 通知配置の選択肢（レイアウト設定 = 通知の配置に特化。改修依頼 2026-08-18）。
 * 「上」「右」「下」「非表示」の 4 択を UI（DashboardLayoutPicker）へ提供する。
 */
export const NOTIFICATION_PLACEMENT_OPTIONS: readonly {
  value: NotificationPlacement
  label: string
  description: string
}[] = [
  { value: 'top', label: '上', description: 'メニューの上に全幅で表示（通知から一日を始める配置）' },
  { value: 'side', label: '右', description: '右サイドに常時表示（画面幅が広い PC 向けの標準配置）' },
  { value: 'bottom', label: '下', description: 'メニューの下に全幅で表示（メニュー優先の配置）' },
  { value: 'hidden', label: '非表示', description: '通知欄を表示しない（通知はヘッダーのベルから開く）' },
]

/** レイアウトの通知配置だけを差し替えた複製を返す（レイアウト設定とセクション設定の分離 = 純関数） */
export function withNotificationPlacement(
  layout: DashboardLayout,
  placement: NotificationPlacement,
): DashboardLayout {
  return {
    templateId: layout.templateId,
    sections: cloneSections(layout.sections),
    options: { ...layout.options, notifications: placement },
  }
}

/**
 * 通知配置の保存値をパース（専用キー。文字列 / JSON 引用文字列の両対応 = configs / prefs の保存経路差を吸収）。
 * 未設定・不正値は null（= 設定なし。レイアウト由来の配置へフォールバック）。
 */
export function parseNotificationPlacement(raw: unknown): NotificationPlacement | null {
  if (raw === null || raw === undefined) return null
  let value: unknown = raw
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t === '') return null
    // JSON.stringify された文字列（'"top"'）も受理する（configs の保存流儀と生文字列の両対応）
    if (t.startsWith('"')) {
      try { value = JSON.parse(t) } catch { return null }
    } else {
      value = t
    }
  }
  return NOTIFICATION_PLACEMENTS.includes(value as NotificationPlacement)
    ? value as NotificationPlacement
    : null
}

/**
 * 通知配置の解決（層整合。2026-08-18）。専用キーとレイアウト由来の配置を**同じ層の優先順位**で解決する:
 *   ユーザー配置キー > ユーザー層レイアウトの options.notifications > テナント配置キー > 解決レイアウト由来
 * レイアウト設定を「通知の配置」に特化させた際、配置をレイアウト本体（sections を含む JSON）と別キーで
 * 保存することで「配置だけ変えたのにセクション構成が層に固定される」副作用を避ける（レビュー R1）。
 * さらに、**専用キー導入前にユーザー層レイアウト（テンプレート等）で配置を選んでいた既存ユーザー**の選択を
 * 新しいテナント配置キーが上書きしないよう、ユーザー層レイアウト由来をテナントキーより優先する（原則7・レビュー R2）。
 */
/** 層ごとのレイアウト由来の配置（placement = options.notifications / inherit = 配置を指定しない委譲マーカー） */
export interface LayerPlacement {
  placement: NotificationPlacement
  inherit?: boolean
}

export function resolveNotificationPlacement(inputs: {
  userRaw?: unknown
  tenantRaw?: unknown
  /** ユーザー層レイアウト由来の配置（層に無ければ null）。inherit = 分離後の保存 = 配置を指定しない */
  userLayout?: LayerPlacement | null
  /** テナント層レイアウト由来の配置（層に無ければ null。従来 menu-categories の下位互換解釈も含む） */
  tenantLayout?: LayerPlacement | null
}): { placement: NotificationPlacement; source: 'user' | 'tenant' | 'layout' | 'default' } {
  const user = parseNotificationPlacement(inputs.userRaw)
  if (user) return { placement: user, source: 'user' }
  // 分離前のユーザー層レイアウト（inherit なし）は「当時レイアウトで配置を選んだ」意思としてテナントキーより優先（原則7）。
  // inherit 付き（分離後の保存）はフォールバック値を層に固定せず下位へ委譲する（レビュー R5/R8 = 値の凍結を作らない）
  if (inputs.userLayout && !inputs.userLayout.inherit) {
    return { placement: inputs.userLayout.placement, source: 'layout' }
  }
  const tenant = parseNotificationPlacement(inputs.tenantRaw)
  if (tenant) return { placement: tenant, source: 'tenant' }
  if (inputs.tenantLayout && !inputs.tenantLayout.inherit) {
    return { placement: inputs.tenantLayout.placement, source: 'layout' }
  }
  return { placement: DEFAULT_LAYOUT_OPTIONS.notifications, source: 'default' }
}

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
 * テンプレート定義（6 種。世の中の業務アプリを参考にセクション/メニュー配置を設計）。
 * すべて同じ MENU_CARDS.dashboard の id を、別の section 構成/順序 + options で配置する。
 * cardIds は既存カード id のみを参照する（未割当カード + 外部リンクは categorize が「その他」へ回す）。
 * 2026-08-18 分離: 通知の配置はレイアウト設定（専用キー）が SoT。options.notifications は
 * 「配置キー未設定時のフォールバック値」としてのみ使われる（applyTemplate は適用先層の現行配置を維持する）。
 */
export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    id: 'default',
    name: '標準',
    description: '現行の標準レイアウト。意思決定・業務ツール・経営状況をバランス良く配置します。',
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
    description: '顧客活動・売上・メディア・稟議を上部に。商談と顧客対応を中心に据えた CRM 風レイアウト。',
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
    description: '売上・稼働状況・AIカンパニー・意思決定を最上部に。全体を俯瞰するエグゼクティブ・コックピットです。',
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
    description: '全メニューを 1 つのリストにまとめ、余白を抑えたミニマル表示。AKEBONO 業務セクションは非表示。',
    layout: {
      templateId: 'focus',
      sections: [
        { id: 'menu', label: 'メニュー', cardIds: [...ALL_DASHBOARD_CARD_IDS] },
      ],
      options: { notifications: 'bottom', showAkebono: false, density: 'compact' },
    },
  },
  {
    id: 'notify-first',
    name: '通知ファースト',
    description: 'メニュー構成は標準と同じです。通知から一日を始める運用向け（通知を最上段にするには「レイアウト」タブで配置「上」を選択してください）。',
    layout: {
      templateId: 'notify-first',
      sections: cloneSections(DEFAULT_MENU_CATEGORIES.dashboard),
      options: { notifications: 'top', showAkebono: true, density: 'comfortable' },
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
 * 指定スコープでの編集・保存の「土台」となるレイアウトを層ごとに選ぶ（純関数。useDashboardLayout が使用）。
 * - tenant: テナント層自身を最優先し、無ければアプリ既定（default）へ。**user 層にはフォールバックしない**
 *   （管理者個人の user 設定の options/sections がテナントへ漏れるのを防ぐ = レビュー MAJOR）。
 * - user: user 層を最優先し、無ければ tenant → default の順にフォールバック（今見えている構成を開始点にする）。
 * ドラフト初期値（sections）と保存時に引き継ぐ options の両方をこの土台から取ることで、
 * 保存先スコープと無関係な層の設定が紛れ込まないことを保証する。
 */
export function pickBaseLayout(
  scope: 'user' | 'tenant',
  layers: { userLayout: DashboardLayout | null; tenantLayout: DashboardLayout | null },
): DashboardLayout {
  if (scope === 'tenant') return layers.tenantLayout ?? defaultDashboardLayout()
  return layers.userLayout ?? layers.tenantLayout ?? defaultDashboardLayout()
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
  const options: DashboardLayoutOptions = {
    notifications: NOTIFICATION_PLACEMENTS.includes(rec.notifications as NotificationPlacement)
      ? rec.notifications as NotificationPlacement
      : DEFAULT_LAYOUT_OPTIONS.notifications,
    showAkebono: typeof rec.showAkebono === 'boolean' ? rec.showAkebono : DEFAULT_LAYOUT_OPTIONS.showAkebono,
    density: LAYOUT_DENSITIES.includes(rec.density as LayoutDensity)
      ? rec.density as LayoutDensity
      : DEFAULT_LAYOUT_OPTIONS.density,
  }
  // 分離後の保存レイアウトの「配置はキーへ委譲」マーカー（未定義 = 分離前の保存値 = 立てない。原則7）
  if (rec.notificationsInherit === true) options.notificationsInherit = true
  return options
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

// ---------- セクション構成のお気に入り（自由設定の保存・呼び出し。改修依頼 2026-08-18） ----------

/** セクション構成のお気に入り（自由設定に名前を付けて保存・呼び出しできる。ユーザー個人のもの） */
export interface SectionFavorite {
  id: string
  name: string
  sections: MenuCategoryDef[]
  /** 保存日時（JST ISO。表示用） */
  savedAt: string
}

/** お気に入りの件数上限（user_preferences の value 4KB 上限に収まる範囲で余裕を持たせる） */
export const MAX_SECTION_FAVORITES = 10

/**
 * お気に入り保存値（配列全体）の合計サイズ上限（バイト）。API の user_preferences は value 4KB
 * （実バイト 4096）でサーバー拒否されるため、保存前に余裕を持って検証しユーザーへ案内する（原則4）。
 */
export const SECTION_FAVORITES_MAX_BYTES = 3800

/**
 * お気に入り保存値のパース（JSON 文字列 / 配列の両対応 = parseQuickAccessIds と同じ流儀）。
 * 未設定・不正値は null。壊れたエントリは**その 1 件だけ落とす**（お気に入りは独立した記録の集まりで、
 * 1 件の破損で全件を失わせない = 原則2 の状態保護）。
 */
export function parseSectionFavorites(raw: unknown): SectionFavorite[] | null {
  if (raw === null || raw === undefined) return null
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    try { value = JSON.parse(raw) } catch { return null }
  }
  if (!Array.isArray(value)) return null
  const out: SectionFavorite[] = []
  const seenIds = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const sections = parseMenuSections(rec.sections)
    if (typeof rec.id !== 'string' || rec.id === '' || seenIds.has(rec.id)) continue
    if (typeof rec.name !== 'string' || rec.name.trim() === '') continue
    if (sections === null) continue
    seenIds.add(rec.id)
    out.push({
      id: rec.id,
      name: rec.name,
      sections,
      savedAt: typeof rec.savedAt === 'string' ? rec.savedAt : '',
    })
  }
  return out
}

/**
 * お気に入りへ保存する（純関数）。同名は上書き（id・並び順維持 = 呼び出し側が確認済み）、
 * 新規は末尾へ追加。上限超過はエラー（呼び出し側が警告表示）。id は savedAt 由来 + 衝突時連番。
 */
export function upsertSectionFavorite(
  list: SectionFavorite[],
  input: { name: string; sections: MenuCategoryDef[]; savedAt: string },
): { ok: true; list: SectionFavorite[]; overwritten: boolean } | { ok: false; error: string } {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'お気に入りの名前を入力してください' }
  const sections = input.sections.map(s => ({ id: s.id, label: s.label, cardIds: [...s.cardIds] }))
  const existing = list.find(f => f.name === name)
  let next: SectionFavorite[]
  let overwritten: boolean
  if (existing) {
    overwritten = true
    next = list.map(f => f.id === existing.id ? { ...f, name, sections, savedAt: input.savedAt } : f)
  } else {
    if (list.length >= MAX_SECTION_FAVORITES) {
      return { ok: false, error: `お気に入りは最大 ${MAX_SECTION_FAVORITES} 件までです（不要なものを削除してください）` }
    }
    overwritten = false
    const base = `fav-${input.savedAt.replace(/\D/g, '')}`
    let id = base
    for (let i = 2; list.some(f => f.id === id); i++) id = `${base}-${i}`
    next = [...list, { id, name, sections, savedAt: input.savedAt }]
  }
  // 保存値は 1 キー（user_preferences）に収める必要があるため、合計サイズも検証する（4KB のサーバー上限より手前で案内）
  if (new TextEncoder().encode(JSON.stringify(next)).length > SECTION_FAVORITES_MAX_BYTES) {
    return { ok: false, error: 'お気に入りの合計サイズが上限に達しました。不要なお気に入りを削除するか、セクション数を減らしてください' }
  }
  return { ok: true, list: next, overwritten }
}

/** お気に入りを削除する（純関数。取消フロー = 原則 9.5 の「呼び出しで戻せる」記録の整理用） */
export function removeSectionFavorite(list: SectionFavorite[], id: string): SectionFavorite[] {
  return list.filter(f => f.id !== id)
}
