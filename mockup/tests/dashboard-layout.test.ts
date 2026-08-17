/**
 * ダッシュボードのレイアウト（表示・配置）カスタマイズの純ロジック（utils/dashboard-layout.ts）。
 * - 解決階層（ユーザー > テナント > デフォルト）
 * - 壊れた JSON・不正構造の 1 段フォールバック（表示を壊さない）
 * - categorize（未割当 → その他・空セクション除去。useMenuCategories と共有）
 * - テンプレート定義の健全性（全 cardId が MENU_CARDS.dashboard に存在・focus は全カード等）
 */
import { describe, expect, it } from 'vitest'
import type { MenuCard } from '~/types/ui'
import { akebonoSegmentCardId } from '~/utils/akebono'
import {
  assignedAkebonoSegmentIds,
  buildCustomLayout,
  categorizeCards,
  DASHBOARD_TEMPLATES,
  DEFAULT_LAYOUT_OPTIONS,
  defaultDashboardLayout,
  layoutFromLegacyCategories,
  materializeLayout,
  parseDashboardLayout,
  parseMenuSections,
  pickBaseLayout,
  planDashboardCards,
  resolveDashboardLayout,
  templateById,
} from '~/utils/dashboard-layout'
import {
  DEFAULT_MENU_CATEGORIES, MENU_CARDS, OTHER_CATEGORY_ID, OTHER_CATEGORY_LABEL,
} from '~/utils/menu-registry'

const card = (id: string): MenuCard => ({ id, title: id, description: id, icon: 'X' })
const akCard = (segId: string): MenuCard => ({
  id: akebonoSegmentCardId(segId), title: segId, description: segId, icon: 'Store', to: `/akebono?seg=${segId}`,
})

const VALID_USER_LAYOUT = JSON.stringify({
  templateId: 'focus',
  sections: [{ id: 'menu', label: 'メニュー', cardIds: ['sales'] }],
  options: { notifications: 'bottom', showAkebono: false, density: 'compact' },
})
const VALID_TENANT_LAYOUT = JSON.stringify({
  templateId: 'executive',
  sections: [{ id: 'cockpit', label: '経営', cardIds: ['sales'] }],
  options: { notifications: 'bottom', showAkebono: true, density: 'comfortable' },
})
const LEGACY_CATEGORIES = JSON.stringify([
  { id: 'work', label: '業務', cardIds: ['timecard', 'reports'] },
])

describe('resolveDashboardLayout — 解決階層（ユーザー > テナント > デフォルト）', () => {
  it('ユーザー設定があればユーザー層が勝つ', () => {
    const r = resolveDashboardLayout({
      userRaw: VALID_USER_LAYOUT,
      tenantRaw: VALID_TENANT_LAYOUT,
      legacyCategoriesRaw: LEGACY_CATEGORIES,
    })
    expect(r.scope).toBe('user')
    expect(r.layout.templateId).toBe('focus')
  })

  it('ユーザー設定が無ければテナント設定（新キー dashboard-layout）', () => {
    const r = resolveDashboardLayout({ tenantRaw: VALID_TENANT_LAYOUT, legacyCategoriesRaw: LEGACY_CATEGORIES })
    expect(r.scope).toBe('tenant')
    expect(r.layout.templateId).toBe('executive')
  })

  it('新テナントキーが無く従来の menu-categories-dashboard があれば下位互換で解釈（原則7）', () => {
    const r = resolveDashboardLayout({ legacyCategoriesRaw: LEGACY_CATEGORIES })
    expect(r.scope).toBe('tenant')
    expect(r.layout.sections).toEqual([{ id: 'work', label: '業務', cardIds: ['timecard', 'reports'] }])
    // 従来設定には options が無いため default テンプレートの options を組み合わせる
    expect(r.layout.options).toEqual(DEFAULT_LAYOUT_OPTIONS)
  })

  it('どの層も無ければデフォルト（default テンプレート）', () => {
    const r = resolveDashboardLayout({})
    expect(r.scope).toBe('default')
    expect(r.layout.templateId).toBe('default')
    expect(r.layout.sections).toEqual(DEFAULT_MENU_CATEGORIES.dashboard)
  })

  it('ユーザー層はオブジェクトでも受け付ける（API prefs 由来）', () => {
    const r = resolveDashboardLayout({ userRaw: JSON.parse(VALID_USER_LAYOUT) })
    expect(r.scope).toBe('user')
    expect(r.layout.templateId).toBe('focus')
  })
})

describe('resolveDashboardLayout — 壊れた JSON・不正構造の 1 段フォールバック', () => {
  it('ユーザー層が壊れていればテナント層へ倒れる', () => {
    const r = resolveDashboardLayout({ userRaw: '{壊れた', tenantRaw: VALID_TENANT_LAYOUT })
    expect(r.scope).toBe('tenant')
  })

  it('テナント層（新キー）が壊れていて従来キーがあれば従来キーへ倒れる', () => {
    const r = resolveDashboardLayout({ tenantRaw: 'not json', legacyCategoriesRaw: LEGACY_CATEGORIES })
    expect(r.scope).toBe('tenant')
    expect(r.layout.sections[0]?.id).toBe('work')
  })

  it('テナント層が壊れていて従来キーも無ければデフォルトへ倒れる', () => {
    const r = resolveDashboardLayout({ userRaw: '', tenantRaw: '{bad', legacyCategoriesRaw: '' })
    expect(r.scope).toBe('default')
    expect(r.layout.templateId).toBe('default')
  })

  it('ユーザー層もテナント層も壊れていればデフォルトへ倒れる', () => {
    const r = resolveDashboardLayout({ userRaw: 'xxx', tenantRaw: 'yyy' })
    expect(r.scope).toBe('default')
  })
})

describe('parseDashboardLayout', () => {
  it('妥当な JSON 文字列 / オブジェクトを解釈する', () => {
    expect(parseDashboardLayout(VALID_USER_LAYOUT)?.templateId).toBe('focus')
    expect(parseDashboardLayout(JSON.parse(VALID_USER_LAYOUT))?.templateId).toBe('focus')
  })

  it('sections が無い・配列でなければ null（次の層へ）', () => {
    expect(parseDashboardLayout(JSON.stringify({ templateId: 'x', options: {} }))).toBeNull()
    expect(parseDashboardLayout(JSON.stringify({ sections: 'nope' }))).toBeNull()
  })

  it('空文字・null・undefined・トップレベル配列は null', () => {
    expect(parseDashboardLayout('')).toBeNull()
    expect(parseDashboardLayout('   ')).toBeNull()
    expect(parseDashboardLayout(null)).toBeNull()
    expect(parseDashboardLayout(undefined)).toBeNull()
    expect(parseDashboardLayout('[]')).toBeNull()
  })

  it('options の不正値・欠落は既定へ正規化する（将来のフィールド追加に耐える）', () => {
    const layout = parseDashboardLayout(JSON.stringify({
      sections: [],
      options: { notifications: 'weird', density: 'huge', showAkebono: 'yes' },
    }))
    expect(layout?.options).toEqual(DEFAULT_LAYOUT_OPTIONS)
  })

  it('templateId が無ければ custom', () => {
    expect(parseDashboardLayout(JSON.stringify({ sections: [] }))?.templateId).toBe('custom')
  })
})

describe('parseMenuSections', () => {
  it('妥当な配列 / JSON 文字列を解釈し、cardIds の非文字列を除去する', () => {
    const parsed = parseMenuSections([{ id: 'a', label: 'A', cardIds: ['x', 1, null, 'y'] }])
    expect(parsed).toEqual([{ id: 'a', label: 'A', cardIds: ['x', 'y'] }])
    expect(parseMenuSections('[{"id":"a","label":"A","cardIds":["x"]}]')).toEqual([{ id: 'a', label: 'A', cardIds: ['x'] }])
  })

  it('空文字・壊れ JSON・非配列・不正アイテムは null', () => {
    expect(parseMenuSections('')).toBeNull()
    expect(parseMenuSections('{bad')).toBeNull()
    expect(parseMenuSections({ not: 'array' })).toBeNull()
    expect(parseMenuSections([{ id: 'a', cardIds: [] }])).toBeNull() // label 欠落
    expect(parseMenuSections([{ id: '', label: 'A', cardIds: [] }])).toBeNull() // id 空
  })

  it('空配列は有効（= 全カードが「その他」へ集約される。従来 menu-categories 空設定と同挙動）', () => {
    expect(parseMenuSections('[]')).toEqual([])
  })
})

describe('categorizeCards（useMenuCategories と共有ロジック）', () => {
  const cards = [card('a'), card('b'), card('c'), card('d')]

  it('セクションに割り当て・順序を保つ', () => {
    const groups = categorizeCards(cards, [
      { id: 's1', label: 'S1', cardIds: ['b', 'a'] },
      { id: 's2', label: 'S2', cardIds: ['c'] },
    ])
    expect(groups.map(g => g.id)).toEqual(['s1', 's2', OTHER_CATEGORY_ID])
    expect(groups[0]?.cards.map(c => c.id)).toEqual(['b', 'a'])
  })

  it('未割当カードは「その他」へ（消えない）', () => {
    const groups = categorizeCards(cards, [{ id: 's1', label: 'S1', cardIds: ['a'] }])
    const other = groups.find(g => g.id === OTHER_CATEGORY_ID)
    expect(other?.label).toBe(OTHER_CATEGORY_LABEL)
    expect(other?.cards.map(c => c.id)).toEqual(['b', 'c', 'd'])
  })

  it('空セクション（存在しない cardId のみ）は落とす', () => {
    const groups = categorizeCards(cards, [
      { id: 'empty', label: 'Empty', cardIds: ['zzz'] },
      { id: 's1', label: 'S1', cardIds: ['a', 'b', 'c', 'd'] },
    ])
    expect(groups.map(g => g.id)).toEqual(['s1'])
  })

  it('全カード割当済みなら「その他」は付かない', () => {
    const groups = categorizeCards(cards, [{ id: 's1', label: 'S1', cardIds: ['a', 'b', 'c', 'd'] }])
    expect(groups.some(g => g.id === OTHER_CATEGORY_ID)).toBe(false)
  })
})

describe('テンプレート定義の健全性', () => {
  const dashboardIds = new Set(MENU_CARDS.dashboard.map(c => c.id))

  it('テンプレートは 6 種・id は一意（notify-first = 通知最上段。改善要望 2026-08-17）', () => {
    expect(DASHBOARD_TEMPLATES).toHaveLength(6)
    const ids = DASHBOARD_TEMPLATES.map(t => t.id)
    expect(new Set(ids).size).toBe(6)
    expect(ids).toEqual(['default', 'operations', 'sales', 'executive', 'focus', 'notify-first'])
  })

  it('notify-first テンプレートは通知を最上段（top）に配置する', () => {
    expect(templateById('notify-first')!.layout.options.notifications).toBe('top')
  })

  it('全テンプレートの全 cardId が MENU_CARDS.dashboard に存在する（外部リンクは categorize が処理）', () => {
    for (const t of DASHBOARD_TEMPLATES) {
      for (const sec of t.layout.sections) {
        for (const id of sec.cardIds) {
          expect(dashboardIds.has(id), `${t.id}/${sec.id}: ${id}`).toBe(true)
        }
      }
    }
  })

  it('各テンプレートは名前・説明・妥当な options を持つ', () => {
    for (const t of DASHBOARD_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
      expect(['side', 'bottom', 'top', 'hidden']).toContain(t.layout.options.notifications)
      expect(['comfortable', 'compact']).toContain(t.layout.options.density)
      expect(typeof t.layout.options.showAkebono).toBe('boolean')
    }
  })

  it('default テンプレートは現行構成（DEFAULT_MENU_CATEGORIES）+ 通知 side', () => {
    const def = templateById('default')!
    expect(def.layout.sections).toEqual(DEFAULT_MENU_CATEGORIES.dashboard)
    expect(def.layout.options).toEqual({ notifications: 'side', showAkebono: true, density: 'comfortable' })
  })

  it('focus テンプレートは単一「メニュー」に全カード + 通知 bottom + density compact', () => {
    const focus = templateById('focus')!
    expect(focus.layout.sections).toHaveLength(1)
    expect(focus.layout.sections[0]?.cardIds).toEqual(MENU_CARDS.dashboard.map(c => c.id))
    expect(focus.layout.options.notifications).toBe('bottom')
    expect(focus.layout.options.density).toBe('compact')
    expect(focus.layout.options.showAkebono).toBe(false)
  })

  it('executive テンプレートは通知 bottom（エグゼクティブ・コックピット）', () => {
    expect(templateById('executive')!.layout.options.notifications).toBe('bottom')
  })
})

describe('materializeLayout / defaultDashboardLayout', () => {
  it('テンプレートをディープコピーする（結果を変更しても定義は不変）', () => {
    const a = materializeLayout('default')
    a.sections[0]!.label = 'MUTATED'
    a.sections[0]!.cardIds.push('zzz')
    const b = materializeLayout('default')
    expect(b.sections[0]?.label).not.toBe('MUTATED')
    expect(b.sections[0]?.cardIds).not.toContain('zzz')
    expect(templateById('default')!.layout.sections[0]?.label).not.toBe('MUTATED')
  })

  it('未知 id は default に倒す', () => {
    expect(materializeLayout('does-not-exist').templateId).toBe('default')
  })

  it('materialize した layout の JSON は 4KB 未満（/v1/me/preferences の value 上限に収まる）', () => {
    // ユーザー層は user_preferences に保存され value は 4096 バイト上限。テンプレートは常にその範囲に収める
    for (const t of DASHBOARD_TEMPLATES) {
      const bytes = new TextEncoder().encode(JSON.stringify(materializeLayout(t.id))).length
      expect(bytes, `${t.id}: ${bytes} bytes`).toBeLessThan(4096)
    }
  })

  it('defaultDashboardLayout は default テンプレートの layout', () => {
    expect(defaultDashboardLayout().templateId).toBe('default')
    expect(defaultDashboardLayout().sections).toEqual(DEFAULT_MENU_CATEGORIES.dashboard)
  })
})

describe('layoutFromLegacyCategories', () => {
  it('従来 sections を default options と組み合わせてテナント層 layout にする', () => {
    const layout = layoutFromLegacyCategories(LEGACY_CATEGORIES)
    expect(layout?.templateId).toBe('default')
    expect(layout?.options).toEqual(DEFAULT_LAYOUT_OPTIONS)
  })

  it('未設定（空文字）・壊れ JSON は null', () => {
    expect(layoutFromLegacyCategories('')).toBeNull()
    expect(layoutFromLegacyCategories('{bad')).toBeNull()
  })
})

// ---------- AKEBONO 業態アプリのカテゴリ配置（#24。二重表示防止の中核ロジック） ----------

describe('assignedAkebonoSegmentIds（セクションに割当済みの業態 id 抽出）', () => {
  it('cardIds 中の akebono-seg:* だけを集める（基本メニュー・外部リンクは無視）', () => {
    const sections = [
      { id: 's1', label: 'S1', cardIds: ['timecard', akebonoSegmentCardId('seg-01'), 'el-1'] },
      { id: 's2', label: 'S2', cardIds: [akebonoSegmentCardId('seg-02')] },
    ]
    expect(assignedAkebonoSegmentIds(sections)).toEqual(new Set(['seg-01', 'seg-02']))
  })

  it('akebono カードが無ければ空集合', () => {
    expect(assignedAkebonoSegmentIds([{ id: 's', label: 'S', cardIds: ['sales', 'media'] }])).toEqual(new Set())
  })
})

describe('planDashboardCards（プール振り分けと専用セクションの担当）', () => {
  const internal = [card('timecard'), card('sales')]
  const external = [card('el-1')]
  const akebono = [akCard('seg-01'), akCard('seg-02'), akCard('seg-03')]

  it('showAkebono=true: 割当済み業態のみプールへ・未割当は専用セクションが担当（二重表示なし）', () => {
    const sections = [{ id: 's1', label: 'S1', cardIds: ['timecard', akebonoSegmentCardId('seg-01')] }]
    const plan = planDashboardCards({
      internalCards: internal, externalCards: external, akebonoCards: akebono, sections, showAkebono: true,
    })
    // プール = 基本 + 外部 + 割当済み akebono（seg-01）のみ
    expect(plan.pool.map(c => String(c.id))).toEqual([
      'timecard', 'sales', 'el-1', akebonoSegmentCardId('seg-01'),
    ])
    // 未割当（seg-02, seg-03）は専用セクションへ
    expect(plan.unassignedAkebonoSegmentIds).toEqual(['seg-02', 'seg-03'])
  })

  it('showAkebono=true かつ全業態割当済み: 専用セクションは空（= 出さない）', () => {
    const sections = [{
      id: 's1', label: 'S1',
      cardIds: [akebonoSegmentCardId('seg-01'), akebonoSegmentCardId('seg-02'), akebonoSegmentCardId('seg-03')],
    }]
    const plan = planDashboardCards({
      internalCards: internal, externalCards: external, akebonoCards: akebono, sections, showAkebono: true,
    })
    expect(plan.unassignedAkebonoSegmentIds).toEqual([])
    // 全 akebono がプールに入る（割当済みなので categorize がセクションへ配置する）
    expect(plan.pool.filter(c => String(c.id).startsWith('akebono-seg:')).length).toBe(3)
  })

  it('showAkebono=false（focus 等）: 全業態カードをプールへ・専用セクションは出さない（未割当は「その他」へ）', () => {
    const sections = [{ id: 's1', label: 'S1', cardIds: ['timecard'] }]
    const plan = planDashboardCards({
      internalCards: internal, externalCards: external, akebonoCards: akebono, sections, showAkebono: false,
    })
    expect(plan.unassignedAkebonoSegmentIds).toEqual([])
    expect(plan.pool.filter(c => String(c.id).startsWith('akebono-seg:')).length).toBe(3)
    // categorize に通すと未割当 akebono は「その他」へ落ちる（消えない）
    const groups = categorizeCards(plan.pool, sections)
    const other = groups.find(g => g.id === OTHER_CATEGORY_ID)
    expect(other?.cards.map(c => String(c.id))).toEqual([
      'sales', 'el-1', akebonoSegmentCardId('seg-01'), akebonoSegmentCardId('seg-02'), akebonoSegmentCardId('seg-03'),
    ])
  })

  it('akebonoCards が空（利用不可時に呼び出し側が空を渡す）: akebono はどこにも出ない', () => {
    const sections = [{ id: 's1', label: 'S1', cardIds: ['timecard', akebonoSegmentCardId('seg-01')] }]
    const plan = planDashboardCards({
      internalCards: internal, externalCards: external, akebonoCards: [], sections, showAkebono: true,
    })
    expect(plan.unassignedAkebonoSegmentIds).toEqual([])
    expect(plan.pool.some(c => String(c.id).startsWith('akebono-seg:'))).toBe(false)
  })
})

// ---------- セクション構成の 3 階層保存（#25。saveSections の中核 = buildCustomLayout） ----------

describe('buildCustomLayout（saveSections が保存する DashboardLayout の組み立て）', () => {
  const options = { notifications: 'bottom', showAkebono: false, density: 'compact' } as const
  const sections = [{ id: 's1', label: 'S1', cardIds: ['sales'] }]

  it('templateId=custom・現行 options を維持・sections をディープコピー', () => {
    const layout = buildCustomLayout(sections, options)
    expect(layout.templateId).toBe('custom')
    expect(layout.options).toEqual(options)
    expect(layout.sections).toEqual(sections)
    // ディープコピー: 返り値を変更しても入力は不変
    layout.sections[0]!.cardIds.push('zzz')
    expect(sections[0]!.cardIds).toEqual(['sales'])
  })

  it('保存 → 解決は user > tenant > default に従う（既存 resolveDashboardLayout が引き続き担う）', () => {
    const userJson = JSON.stringify(buildCustomLayout([{ id: 'u', label: 'U', cardIds: ['sales'] }], options))
    const tenantJson = JSON.stringify(buildCustomLayout([{ id: 't', label: 'T', cardIds: ['media'] }], DEFAULT_LAYOUT_OPTIONS))
    // user 保存があれば user が勝つ
    const r1 = resolveDashboardLayout({ userRaw: userJson, tenantRaw: tenantJson })
    expect(r1.scope).toBe('user')
    expect(r1.layout.sections[0]?.id).toBe('u')
    // user 解除（空）→ tenant が勝つ
    const r2 = resolveDashboardLayout({ userRaw: '', tenantRaw: tenantJson })
    expect(r2.scope).toBe('tenant')
    expect(r2.layout.sections[0]?.id).toBe('t')
    // 両方解除 → default
    const r3 = resolveDashboardLayout({ userRaw: '', tenantRaw: '' })
    expect(r3.scope).toBe('default')
  })

  it('全カード（基本 + 外部 + AKEBONO 想定）を 1 セクションに詰めても JSON は 4KB 未満（/v1/me/preferences 上限）', () => {
    // 現実的な最大: 全基本メニュー + 外部リンク 20 件 + 業態 20 件を単一セクションへ割当
    const ids = [
      ...MENU_CARDS.dashboard.map(c => c.id),
      ...Array.from({ length: 20 }, (_, i) => `el-${String(i).padStart(4, '0')}`),
      ...Array.from({ length: 20 }, (_, i) => akebonoSegmentCardId(`seg-${String(i).padStart(4, '0')}`)),
    ]
    const layout = buildCustomLayout([{ id: 'all', label: 'すべてのメニュー', cardIds: ids }], DEFAULT_LAYOUT_OPTIONS)
    const bytes = new TextEncoder().encode(JSON.stringify(layout)).length
    expect(bytes, `${bytes} bytes`).toBeLessThan(4096)
  })
})

// ---------- 保存先スコープ自身の層を土台にする（#25。レビュー MAJOR の回帰テスト） ----------

describe('pickBaseLayout（保存先スコープ自身の層を土台にする。他層の設定を漏らさない）', () => {
  // user 個人設定: focus 由来（options = bottom / showAkebono=false / compact）
  const userLayout = parseDashboardLayout(VALID_USER_LAYOUT)!
  // 全社設定: executive 由来（options = bottom / showAkebono=true / comfortable）
  const tenantLayout = parseDashboardLayout(VALID_TENANT_LAYOUT)!

  it('tenant 編集はテナント層自身（options・sections）を土台にする', () => {
    const base = pickBaseLayout('tenant', { userLayout, tenantLayout })
    expect(base.options).toEqual(tenantLayout.options)
    expect(base.sections).toEqual(tenantLayout.sections)
  })

  it('【回帰】管理者個人の user 設定は tenant 編集の土台に紛れ込まない（レビュー MAJOR）', () => {
    // user と tenant で異なる options を持たせ、tenant 側が user の options に汚染されないことを確認
    expect(userLayout.options).not.toEqual(tenantLayout.options)
    const base = pickBaseLayout('tenant', { userLayout, tenantLayout })
    expect(base.options).not.toEqual(userLayout.options)
  })

  it('tenant 層が無ければ default（user 設定へはフォールバックしない = テナントへ漏らさない）', () => {
    const base = pickBaseLayout('tenant', { userLayout, tenantLayout: null })
    expect(base.templateId).toBe('default')
    expect(base.options).toEqual(DEFAULT_LAYOUT_OPTIONS)
    expect(base.options).not.toEqual(userLayout.options)
  })

  it('user 編集は user 層を最優先し、無ければ tenant → default にフォールバック', () => {
    expect(pickBaseLayout('user', { userLayout, tenantLayout }).options).toEqual(userLayout.options)
    expect(pickBaseLayout('user', { userLayout: null, tenantLayout }).options).toEqual(tenantLayout.options)
    expect(pickBaseLayout('user', { userLayout: null, tenantLayout: null }).templateId).toBe('default')
  })

  it('saveSections 相当: 全社にセクション保存すると options はテナント層のものを維持する', () => {
    // saveSections = persistLayout(buildCustomLayout(draft, pickBaseLayout(scope).options), scope) 相当
    const saved = buildCustomLayout(
      [{ id: 'x', label: 'X', cardIds: ['sales'] }],
      pickBaseLayout('tenant', { userLayout, tenantLayout }).options,
    )
    expect(saved.templateId).toBe('custom')
    expect(saved.options).toEqual(tenantLayout.options)
    expect(saved.options).not.toEqual(userLayout.options)
  })
})
