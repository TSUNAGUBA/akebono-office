/**
 * ダッシュボードのレイアウト（表示・配置）カスタマイズの純ロジック（utils/dashboard-layout.ts）。
 * - 解決階層（ユーザー > テナント > デフォルト）
 * - 壊れた JSON・不正構造の 1 段フォールバック（表示を壊さない）
 * - categorize（未割当 → その他・空セクション除去。useMenuCategories と共有）
 * - テンプレート定義の健全性（全 cardId が MENU_CARDS.dashboard に存在・focus は全カード等）
 * - セクション「その他」の表示/非表示（options.showOther / categorizeCards の includeOther。改修依頼 2026-08-20）
 */
import { describe, expect, it } from 'vitest'
import type { MenuCard } from '~/types/ui'
import { akebonoSegmentCardId } from '~/utils/akebono'
import {
  buildCustomLayout,
  categorizeCards,
  DASHBOARD_TEMPLATES,
  DEFAULT_LAYOUT_OPTIONS,
  defaultDashboardLayout,
  layoutFromLegacyCategories,
  materializeLayout,
  MAX_SECTION_FAVORITES,
  NOTIFICATION_PLACEMENT_OPTIONS,
  parseDashboardLayout,
  parseMenuSections,
  parseNotificationPlacement,
  parseSectionFavorites,
  pickBaseLayout,
  removeSectionFavorite,
  resolveDashboardLayout,
  resolveNotificationPlacement,
  type SectionFavorite,
  templateById,
  upsertSectionFavorite,
  withNotificationPlacement,
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
  options: { notifications: 'bottom', density: 'compact' },
})
const VALID_TENANT_LAYOUT = JSON.stringify({
  templateId: 'executive',
  sections: [{ id: 'cockpit', label: '経営', cardIds: ['sales'] }],
  options: { notifications: 'bottom', density: 'comfortable' },
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
      options: { notifications: 'weird', density: 'huge' },
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
    }
  })

  it('default テンプレートは現行構成（DEFAULT_MENU_CATEGORIES）+ 通知 side', () => {
    const def = templateById('default')!
    expect(def.layout.sections).toEqual(DEFAULT_MENU_CATEGORIES.dashboard)
    expect(def.layout.options).toEqual({ notifications: 'side', density: 'comfortable' })
  })

  it('focus テンプレートは単一「メニュー」に全カード + 通知 bottom + density compact', () => {
    const focus = templateById('focus')!
    expect(focus.layout.sections).toHaveLength(1)
    expect(focus.layout.sections[0]?.cardIds).toEqual(MENU_CARDS.dashboard.map(c => c.id))
    expect(focus.layout.options.notifications).toBe('bottom')
    expect(focus.layout.options.density).toBe('compact')
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

// ---------- AKEBONO 業態カードのセクション配置（トップ固定セクション廃止 = 改善要望 2026-08-21） ----------

describe('AKEBONO 業態カードは他メニューと同様に categorizeCards が扱う', () => {
  const internal = [card('timecard'), card('sales')]
  const external = [card('el-1')]
  const akebono = [akCard('seg-01'), akCard('seg-02'), akCard('seg-03')]
  const pool = [...internal, ...external, ...akebono]

  it('セクションへ割当済みの業態はそのセクションへ・未割当は「その他」へ（二重表示なし）', () => {
    const sections = [{ id: 's1', label: 'S1', cardIds: ['timecard', akebonoSegmentCardId('seg-01')] }]
    const groups = categorizeCards(pool, sections)
    expect(groups.find(g => g.id === 's1')?.cards.map(c => String(c.id)))
      .toEqual(['timecard', akebonoSegmentCardId('seg-01')])
    const other = groups.find(g => g.id === OTHER_CATEGORY_ID)
    expect(other?.cards.map(c => String(c.id))).toEqual([
      'sales', 'el-1', akebonoSegmentCardId('seg-02'), akebonoSegmentCardId('seg-03'),
    ])
  })

  it('showOther=false 相当（includeOther: false）では未割当の業態も出ない（他メニューと同じ表示制御）', () => {
    const sections = [{ id: 's1', label: 'S1', cardIds: ['timecard'] }]
    const groups = categorizeCards(pool, sections, { includeOther: false })
    expect(groups.some(g => g.id === OTHER_CATEGORY_ID)).toBe(false)
    expect(groups.flatMap(g => g.cards.map(c => String(c.id)))).toEqual(['timecard'])
  })
})

// ---------- セクション構成の 3 階層保存（#25。saveSections の中核 = buildCustomLayout） ----------

describe('buildCustomLayout（saveSections が保存する DashboardLayout の組み立て）', () => {
  const options = { notifications: 'bottom', density: 'compact' } as const
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
  // user 個人設定: focus 由来（options = bottom / compact）
  const userLayout = parseDashboardLayout(VALID_USER_LAYOUT)!
  // 全社設定: executive 由来（options = bottom / comfortable）
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

// ---------- 2026-08-18: レイアウト（通知配置）とセクション設定の分離 + お気に入り ----------

describe('NOTIFICATION_PLACEMENT_OPTIONS / withNotificationPlacement（通知配置の分離）', () => {
  it('選択肢は 上（top）・右（side）・下（bottom）・非表示（hidden）の 4 択', () => {
    expect(NOTIFICATION_PLACEMENT_OPTIONS.map(o => o.value)).toEqual(['top', 'side', 'bottom', 'hidden'])
    expect(NOTIFICATION_PLACEMENT_OPTIONS.map(o => o.label)).toEqual(['上', '右', '下', '非表示'])
  })

  it('withNotificationPlacement は通知配置だけを差し替える（sections・他 options は不変）', () => {
    const base = materializeLayout('executive') // notifications: 'bottom'
    const next = withNotificationPlacement(base, 'top')
    expect(next.options.notifications).toBe('top')
    expect(next.options.density).toBe(base.options.density)
    expect(next.templateId).toBe(base.templateId)
    expect(next.sections).toEqual(base.sections)
  })

  it('withNotificationPlacement はディープコピーを返す（元レイアウトを破壊しない）', () => {
    const base = materializeLayout('default')
    const next = withNotificationPlacement(base, 'hidden')
    next.sections[0]!.cardIds.push('__mutated__')
    expect(base.sections[0]!.cardIds).not.toContain('__mutated__')
    expect(base.options.notifications).toBe('side')
  })
})

describe('parseSectionFavorites（お気に入りのパース。壊れたエントリは 1 件だけ落とす）', () => {
  const fav = { id: 'fav-1', name: '自分の定番', sections: [{ id: 's1', label: 'A', cardIds: ['timecard'] }], savedAt: '2026-08-18T09:00:00+09:00' }

  it('JSON 文字列・配列（JSONB）の両方を受理する', () => {
    expect(parseSectionFavorites(JSON.stringify([fav]))).toEqual([fav])
    expect(parseSectionFavorites([fav])).toEqual([fav])
  })

  it('未設定・不正 JSON・非配列は null（= 設定なし）', () => {
    expect(parseSectionFavorites('')).toBeNull()
    expect(parseSectionFavorites(undefined)).toBeNull()
    expect(parseSectionFavorites(null)).toBeNull()
    expect(parseSectionFavorites('{')).toBeNull()
    expect(parseSectionFavorites({ a: 1 })).toBeNull()
  })

  it('壊れたエントリはその 1 件だけ落とす（全件を失わせない = 原則2）', () => {
    const broken = [
      fav,
      { id: '', name: 'id なし', sections: [], savedAt: '' },
      { id: 'fav-2', name: '', sections: [], savedAt: '' },
      { id: 'fav-3', name: 'sections 不正', sections: 'x', savedAt: '' },
      { id: 'fav-4', name: '正常（空セクション）', sections: [], savedAt: '' },
    ]
    expect(parseSectionFavorites(broken)).toEqual([
      fav,
      { id: 'fav-4', name: '正常（空セクション）', sections: [], savedAt: '' },
    ])
  })

  it('id 重複は先勝ちで除去する', () => {
    const dup = { ...fav, name: '重複' }
    expect(parseSectionFavorites([fav, dup])).toEqual([fav])
  })
})

describe('upsertSectionFavorite / removeSectionFavorite（お気に入りの保存・削除）', () => {
  const sections = [{ id: 's1', label: 'A', cardIds: ['timecard', 'reports'] }]
  const at = '2026-08-18T09:00:00+09:00'

  it('新規は末尾へ追加され、id は savedAt 由来で採番される', () => {
    const r = upsertSectionFavorite([], { name: '定番', sections, savedAt: at })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.overwritten).toBe(false)
    expect(r.list).toHaveLength(1)
    expect(r.list[0]!.id).toBe(`fav-${at.replace(/\D/g, '')}`)
    expect(r.list[0]!.sections).toEqual(sections)
  })

  it('同名は上書き（id・並び順を維持）', () => {
    const first = upsertSectionFavorite([], { name: '定番', sections, savedAt: at })
    if (!first.ok) throw new Error('unreachable')
    const updated = [{ id: 's2', label: 'B', cardIds: ['workflow'] }]
    const r = upsertSectionFavorite(first.list, { name: '定番', sections: updated, savedAt: '2026-08-19T09:00:00+09:00' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.overwritten).toBe(true)
    expect(r.list).toHaveLength(1)
    expect(r.list[0]!.id).toBe(first.list[0]!.id)
    expect(r.list[0]!.sections).toEqual(updated)
  })

  it('同時刻保存の id 衝突は連番サフィックスで回避する', () => {
    const a = upsertSectionFavorite([], { name: 'A', sections, savedAt: at })
    if (!a.ok) throw new Error('unreachable')
    const b = upsertSectionFavorite(a.list, { name: 'B', sections, savedAt: at })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.list.map(f => f.id)).toEqual([`fav-${at.replace(/\D/g, '')}`, `fav-${at.replace(/\D/g, '')}-2`])
  })

  it('空名はエラー・上限（MAX_SECTION_FAVORITES）超過はエラー', () => {
    expect(upsertSectionFavorite([], { name: '  ', sections, savedAt: at }).ok).toBe(false)
    let list: SectionFavorite[] = []
    for (let i = 0; i < MAX_SECTION_FAVORITES; i++) {
      const r = upsertSectionFavorite(list, { name: `fav-${i}`, sections, savedAt: at })
      if (!r.ok) throw new Error('unreachable')
      list = r.list
    }
    const over = upsertSectionFavorite(list, { name: 'もう 1 件', sections, savedAt: at })
    expect(over.ok).toBe(false)
    // 上限到達でも既存名の上書きはできる（枠を消費しない）
    const overwrite = upsertSectionFavorite(list, { name: 'fav-0', sections, savedAt: at })
    expect(overwrite.ok).toBe(true)
  })

  it('保存はディープコピー（呼び出し側 draft の後続編集がお気に入りへ波及しない）', () => {
    const src = [{ id: 's1', label: 'A', cardIds: ['timecard'] }]
    const r = upsertSectionFavorite([], { name: '定番', sections: src, savedAt: at })
    if (!r.ok) throw new Error('unreachable')
    src[0]!.cardIds.push('__mutated__')
    expect(r.list[0]!.sections[0]!.cardIds).not.toContain('__mutated__')
  })

  it('removeSectionFavorite は指定 id のみを除去する', () => {
    const a = upsertSectionFavorite([], { name: 'A', sections, savedAt: at })
    if (!a.ok) throw new Error('unreachable')
    const b = upsertSectionFavorite(a.list, { name: 'B', sections, savedAt: '2026-08-19T09:00:00+09:00' })
    if (!b.ok) throw new Error('unreachable')
    const removed = removeSectionFavorite(b.list, a.list[0]!.id)
    expect(removed.map(f => f.name)).toEqual(['B'])
    // 存在しない id は no-op（冪等）
    expect(removeSectionFavorite(removed, 'fav-nope')).toEqual(removed)
  })
})

describe('通知配置の専用キー（parseNotificationPlacement / resolveNotificationPlacement）', () => {
  it('生文字列・JSON 引用文字列の両方を受理し、不正値・未設定は null', () => {
    expect(parseNotificationPlacement('top')).toBe('top')
    expect(parseNotificationPlacement('"side"')).toBe('side')
    expect(parseNotificationPlacement(' bottom ')).toBe('bottom')
    expect(parseNotificationPlacement('hidden')).toBe('hidden')
    expect(parseNotificationPlacement('')).toBeNull()
    expect(parseNotificationPlacement('  ')).toBeNull()
    expect(parseNotificationPlacement('middle')).toBeNull()
    expect(parseNotificationPlacement(null)).toBeNull()
    expect(parseNotificationPlacement(undefined)).toBeNull()
    expect(parseNotificationPlacement(42)).toBeNull()
    expect(parseNotificationPlacement('"broken')).toBeNull()
  })

  it('解決は層整合: ユーザーキー > ユーザー層レイアウト由来 > テナントキー > テナント層レイアウト由来 > 既定', () => {
    // ユーザーキーが最優先
    expect(resolveNotificationPlacement({
      userRaw: 'top', tenantRaw: 'bottom', userLayout: { placement: 'side' }, tenantLayout: null,
    })).toEqual({ placement: 'top', source: 'user' })
    // ユーザー層レイアウト（専用キー導入前の保存値 = inherit なし）で配置を選んでいた既存ユーザーを
    // 新しいテナント配置キーが上書きしない（原則7 = レビュー R2）
    expect(resolveNotificationPlacement({
      userRaw: '', tenantRaw: 'hidden', userLayout: { placement: 'top' }, tenantLayout: null,
    })).toEqual({ placement: 'top', source: 'layout' })
    // ユーザー層レイアウトが無ければテナントキー
    expect(resolveNotificationPlacement({
      userRaw: '', tenantRaw: 'bottom', userLayout: null, tenantLayout: { placement: 'side' },
    })).toEqual({ placement: 'bottom', source: 'tenant' })
    // キーが無ければテナント層レイアウト由来（分離前の保存値）
    expect(resolveNotificationPlacement({
      userRaw: '', tenantRaw: '', userLayout: null, tenantLayout: { placement: 'bottom' },
    })).toEqual({ placement: 'bottom', source: 'layout' })
    // どの層にも無ければアプリ既定（side）
    expect(resolveNotificationPlacement({ userRaw: '', tenantRaw: '', userLayout: null, tenantLayout: null }))
      .toEqual({ placement: 'side', source: 'default' })
    // 不正な上位層キーは 1 段スキップして下位層へ（表示を壊さない）
    expect(resolveNotificationPlacement({
      userRaw: 'bogus', tenantRaw: 'hidden', userLayout: null, tenantLayout: null,
    })).toEqual({ placement: 'hidden', source: 'tenant' })
  })

  it('分離後の保存レイアウト（notificationsInherit）は配置をキー・下位層へ委譲する（レビュー R5/R8）', () => {
    // inherit 付きユーザー層レイアウトはテナント配置キーに勝たない（フォールバック値を層に固定しない）
    expect(resolveNotificationPlacement({
      userRaw: '', tenantRaw: 'hidden', userLayout: { placement: 'bottom', inherit: true }, tenantLayout: null,
    })).toEqual({ placement: 'hidden', source: 'tenant' })
    // キーが無ければさらに下位層へ委譲し、凍結スナップショット（inherit 付きの placement 値）は使わない
    // = テナントキー解除後も全員が同じ既定へ戻る（レビュー R8）
    expect(resolveNotificationPlacement({
      userRaw: '', tenantRaw: '', userLayout: { placement: 'bottom', inherit: true }, tenantLayout: null,
    })).toEqual({ placement: 'side', source: 'default' })
    // 下位のテナント層レイアウト（分離前の明示配置）があればそれへ委譲する
    expect(resolveNotificationPlacement({
      userRaw: '', tenantRaw: '', userLayout: { placement: 'side', inherit: true }, tenantLayout: { placement: 'bottom' },
    })).toEqual({ placement: 'bottom', source: 'layout' })
    // parse は inherit マーカーを保持する（未指定 = 分離前の保存値 = 立てない）
    const withInherit = parseDashboardLayout(JSON.stringify({
      sections: [], options: { notifications: 'top', notificationsInherit: true, density: 'comfortable' },
    }))
    expect(withInherit?.options.notificationsInherit).toBe(true)
    const legacy = parseDashboardLayout(JSON.stringify({
      sections: [], options: { notifications: 'top', density: 'comfortable' },
    }))
    expect(legacy?.options.notificationsInherit).toBeUndefined()
  })

  it('専用キー方式のため、配置保存はレイアウト本体（sections）へ書かない前提が成り立つ（回帰ピン）', () => {
    // レイアウト本体の解決（sections）は配置キーと独立: テナントのセクション変更は
    // 「配置だけ設定したユーザー」にもそのまま届く（配置キーはユーザー層にレイアウトを作らない）
    const tenant = JSON.stringify(buildCustomLayout(
      [{ id: 's1', label: '全社', cardIds: ['timecard'] }], DEFAULT_LAYOUT_OPTIONS))
    const r = resolveDashboardLayout({ userRaw: undefined, tenantRaw: tenant })
    expect(r.scope).toBe('tenant')
    expect(r.layout.sections[0]!.label).toBe('全社')
  })
})

describe('テンプレート説明の分離整合（通知位置の記述を持たない = レビュー対応）', () => {
  it('テンプレートの説明文は通知位置を約束しない（配置はレイアウト設定が SoT）', () => {
    for (const t of DASHBOARD_TEMPLATES) {
      // notify-first のみ「レイアウト」タブへの案内として言及を許容する
      if (t.id === 'notify-first') continue
      expect(t.description).not.toMatch(/通知は/)
    }
  })
})

// ---------- 2026-08-20: セクション「その他」の表示/非表示（showOther） ----------

describe('categorizeCards — includeOther オプション（「その他」の表示/非表示。改修依頼 2026-08-20）', () => {
  const cards = [card('a'), card('b'), card('c')]
  const sections = [{ id: 's1', label: 'S1', cardIds: ['a'] }]

  it('includeOther=false は「その他」を付けない（未配置カードは表示対象から外す）', () => {
    const groups = categorizeCards(cards, sections, { includeOther: false })
    expect(groups.map(g => g.id)).toEqual(['s1'])
    expect(groups.some(g => g.id === OTHER_CATEGORY_ID)).toBe(false)
  })

  it('省略・includeOther=true は従来どおり「その他」へ（既存呼び出し = useMenuCategories に影響しない）', () => {
    for (const groups of [
      categorizeCards(cards, sections),
      categorizeCards(cards, sections, { includeOther: true }),
      categorizeCards(cards, sections, {}),
    ]) {
      const other = groups.find(g => g.id === OTHER_CATEGORY_ID)
      expect(other?.label).toBe(OTHER_CATEGORY_LABEL)
      expect(other?.cards.map(c => c.id)).toEqual(['b', 'c'])
    }
  })

  it('includeOther=false でも割当済みセクションの順序・空セクション除去は不変', () => {
    const groups = categorizeCards(cards, [
      { id: 'empty', label: 'Empty', cardIds: ['zzz'] },
      { id: 's1', label: 'S1', cardIds: ['b', 'a'] },
    ], { includeOther: false })
    expect(groups.map(g => g.id)).toEqual(['s1'])
    expect(groups[0]?.cards.map(c => c.id)).toEqual(['b', 'a'])
  })

  it('全カード未配置 + includeOther=false は空配列（呼び出し側 index.vue が空状態を描画する）', () => {
    expect(categorizeCards(cards, [], { includeOther: false })).toEqual([])
  })
})

describe('options.showOther の永続化（false のときだけ書く = 原則7。改修依頼 2026-08-20）', () => {
  const layoutJson = (options: Record<string, unknown>): string =>
    JSON.stringify({ sections: [], options })

  it('showOther:false はパース → 保存（JSON）→ 再パースのラウンドトリップで保持される', () => {
    const parsed = parseDashboardLayout(layoutJson({
      notifications: 'side', density: 'comfortable', showOther: false,
    }))!
    expect(parsed.options.showOther).toBe(false)
    // normalizeOptions が未知フィールドとして落とさない（落とすと保存のたびに設定が消える）
    const reparsed = parseDashboardLayout(JSON.stringify(parsed))!
    expect(reparsed.options.showOther).toBe(false)
  })

  it('showOther:true・欠落・不正値はキー自体を書かない（未定義 = 表示）', () => {
    expect(parseDashboardLayout(layoutJson({ showOther: true }))!.options).not.toHaveProperty('showOther')
    expect(parseDashboardLayout(layoutJson({}))!.options).not.toHaveProperty('showOther')
    expect(parseDashboardLayout(layoutJson({ showOther: 'no' }))!.options).not.toHaveProperty('showOther')
  })

  it('テンプレート・アプリ既定の options は showOther を持たない（未定義 = 表示 = 従来挙動）', () => {
    expect(DEFAULT_LAYOUT_OPTIONS).not.toHaveProperty('showOther')
    for (const t of DASHBOARD_TEMPLATES) {
      expect(t.layout.options, t.id).not.toHaveProperty('showOther')
    }
  })

  it('resolveDashboardLayout: showOther の無い既存保存値（レガシー）は従来どおり解決される（原則7）', () => {
    // 既存のユーザー層・テナント層・従来 menu-categories のいずれも showOther 無し = 表示（挙動不変）
    const r1 = resolveDashboardLayout({ userRaw: VALID_USER_LAYOUT })
    expect(r1.scope).toBe('user')
    expect(r1.layout.options.showOther).toBeUndefined()
    const r2 = resolveDashboardLayout({ tenantRaw: VALID_TENANT_LAYOUT })
    expect(r2.scope).toBe('tenant')
    expect(r2.layout.options.showOther).toBeUndefined()
    const r3 = resolveDashboardLayout({ legacyCategoriesRaw: LEGACY_CATEGORIES })
    expect(r3.scope).toBe('tenant')
    expect(r3.layout.options.showOther).toBeUndefined()
  })

  it('showOther:false の保存値は解決・配置差し替えを経ても false を保つ', () => {
    const saved = buildCustomLayout(
      [{ id: 's1', label: 'S1', cardIds: ['sales'] }],
      { ...DEFAULT_LAYOUT_OPTIONS, showOther: false },
    )
    const r = resolveDashboardLayout({ userRaw: JSON.stringify(saved) })
    expect(r.layout.options.showOther).toBe(false)
    // effectiveLayout は配置キー適用で withNotificationPlacement を通る（showOther の見た目が配置変更で戻らない）
    expect(withNotificationPlacement(r.layout, 'top').options.showOther).toBe(false)
  })
})
