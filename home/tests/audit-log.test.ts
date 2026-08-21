/**
 * 監査ログの表示・フィルタカタログ（SoT = shared/domain/audit-log.ts）。
 * - 全 entity にラベル・ページ対応があること（カタログの整合性）
 * - auditEntitiesForPage / auditEntitiesWithPage と AUDIT_ENTITY_META の整合（分割の完全性）
 * - 未知 entity / action のフォールバック（生値表示 = 表示が壊れない）
 * - モックの書込値（camelCase コレクション名）の読替え（normalizeAuditEntity = 原則7）
 * - ページ一覧（auditPageOptions）に重複がないこと
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIT_ACTION_META, AUDIT_ENTITY_META, AUDIT_PAGE_NAMES, AUDIT_PAGE_OTHER,
  auditActionLabel, auditEntitiesForPage, auditEntitiesWithPage, auditEntityMeta,
  auditPageName, auditPageOptions, normalizeAuditEntity,
} from '../../shared/domain/audit-log'

describe('AUDIT_ACTION_META（操作内容カタログ）', () => {
  it('api/src で実際に使われている action を網羅している', () => {
    // grep -rn "action: '" api/src の静的値 + 動的値（body.action = approved/rejected/withdrawn・
    // 定期付与ジョブの periodic-grant）
    const used = [
      'create', 'update', 'archive', 'restore', 'delete', 'import', 'upsert', 'run', 'reindex',
      'grant', 'connect', 'disconnect', 'approved', 'rejected', 'withdrawn', 'periodic-grant',
    ]
    for (const action of used) {
      expect(AUDIT_ACTION_META[action]?.label, `action '${action}' にラベルがない`).toBeTruthy()
    }
  })

  it('旧・設定画面の訳語を踏襲している（原則7 = 表示の下位互換）', () => {
    expect(auditActionLabel('create')).toBe('追加')
    expect(auditActionLabel('update')).toBe('更新')
    expect(auditActionLabel('archive')).toBe('無効化')
    expect(auditActionLabel('restore')).toBe('再有効化')
  })

  it('未知 action は生値のまま返す（フォールバック）', () => {
    expect(auditActionLabel('unknown-action')).toBe('unknown-action')
    expect(auditActionLabel('')).toBe('')
  })
})

describe('AUDIT_ENTITY_META（操作対象カタログ）', () => {
  it('全 entity に空でないラベルがある', () => {
    for (const [entity, meta] of Object.entries(AUDIT_ENTITY_META)) {
      expect(meta.label.trim(), `entity '${entity}' のラベルが空`).not.toBe('')
    }
  })

  it('entity キーは snake_case（API の書込値 = テーブル名）で正規化されている', () => {
    for (const entity of Object.keys(AUDIT_ENTITY_META)) {
      expect(entity, `entity '${entity}' が snake_case でない`).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('page は空 or "/" 始まりの実パスで、ページ名（AUDIT_PAGE_NAMES）が引ける', () => {
    for (const [entity, meta] of Object.entries(AUDIT_ENTITY_META)) {
      if (meta.page === '') continue
      expect(meta.page, `entity '${entity}' の page がパス形式でない`).toMatch(/^\/[a-z0-9/-]*$/)
      expect(AUDIT_PAGE_NAMES[meta.page], `page '${meta.page}' の表示名がない`).toBeTruthy()
    }
  })

  it('未知 entity は { label: 生値, page: "" } を返す（フォールバック）', () => {
    expect(auditEntityMeta('unknown_table')).toEqual({ label: 'unknown_table', page: '' })
  })

  it('モックの camelCase コレクション名を API の entity へ読替える（原則7）', () => {
    // 機械変換（camel → snake）
    expect(normalizeAuditEntity('externalLinks')).toBe('external_links')
    expect(normalizeAuditEntity('customFieldDefs')).toBe('custom_field_defs')
    // 機械変換で一致しない別名（コレクション名 ≠ テーブル名）
    expect(normalizeAuditEntity('codeMaster')).toBe('code_masters')
    expect(normalizeAuditEntity('knowledge')).toBe('knowledge_articles')
    expect(normalizeAuditEntity('holidays')).toBe('public_holidays')
    // snake_case はそのまま（API 書込値の素通し）
    expect(normalizeAuditEntity('external_links')).toBe('external_links')
  })

  it('モックで監査ログを書く全コレクション（useMasterCrud 系）がカタログで解決できる', () => {
    const mockCollections = [
      'members', 'departments', 'leaveTypes', 'industries', 'villages', 'workCategories',
      'companies', 'contacts', 'relationTypes', 'permissionRules', 'attendanceRoutes',
      'companyRelations', 'contactRelations', 'projects', 'knowledge', 'customFieldDefs',
      'codeMaster', 'externalLinks', 'attendanceRules', 'holidays', 'workflowRoutes',
      'decisionThemes', 'aiRoles', 'aiEmployees', 'businessSegments', 'warehouses', 'units',
      'taxRates', 'paymentTerms', 'consignmentTerms', 'variantAxisTemplates',
      'productCategories', 'productImageSections', 'delegateSettings', 'documents',
    ]
    for (const name of mockCollections) {
      const key = normalizeAuditEntity(name)
      expect(AUDIT_ENTITY_META[key], `モックコレクション '${name}'（→ '${key}'）がカタログにない`).toBeTruthy()
    }
  })
})

describe('auditEntitiesForPage / auditEntitiesWithPage（ページ展開の整合）', () => {
  it('全ページの entity 集合 + 「その他」で AUDIT_ENTITY_META を過不足なく分割する', () => {
    const all = Object.keys(AUDIT_ENTITY_META).sort()
    const pages = [...new Set(Object.values(AUDIT_ENTITY_META).map(m => m.page).filter(p => p !== ''))]
    const collected = [
      ...pages.flatMap(p => auditEntitiesForPage(p)),
      ...auditEntitiesForPage(AUDIT_PAGE_OTHER),
    ].sort()
    expect(collected).toEqual(all) // 重複なし・欠落なし（各 entity はちょうど 1 ページに属す）
  })

  it('auditEntitiesWithPage と「その他」は互いに素で全体を覆う', () => {
    const withPage = auditEntitiesWithPage()
    const other = auditEntitiesForPage(AUDIT_PAGE_OTHER)
    expect(new Set([...withPage, ...other]).size).toBe(Object.keys(AUDIT_ENTITY_META).length)
    for (const e of other) expect(withPage, `'${e}' がページあり集合と重複`).not.toContain(e)
  })

  it('各ページの entity は AUDIT_ENTITY_META の page 宣言と一致する', () => {
    for (const entity of auditEntitiesForPage('/settings')) {
      expect(AUDIT_ENTITY_META[entity]?.page).toBe('/settings')
    }
    // 代表ケース: 設定画面で編集する 4 種 + アプリ設定
    expect(auditEntitiesForPage('/settings').sort())
      .toEqual(['app_configs', 'code_masters', 'custom_field_defs', 'external_links'].sort())
    // AKEBONO 共通マスタ（8 種）
    expect(auditEntitiesForPage('/akebono/masters')).toHaveLength(8)
  })

  it('未知ページは空配列（API 側はフィルタを黙って無視できる = 原則4）', () => {
    expect(auditEntitiesForPage('/no-such-page')).toEqual([])
  })
})

describe('auditPageOptions / auditPageName（ページ選択肢）', () => {
  it('value（ページパス）に重複がなく、末尾に「その他」が付く', () => {
    const options = auditPageOptions()
    const values = options.map(o => o.value)
    expect(new Set(values).size).toBe(values.length)
    expect(options[options.length - 1]).toEqual({ value: AUDIT_PAGE_OTHER, label: 'その他' })
  })

  it('ラベルは「ページ名（パス）」形式（pageDisplay 相当。home の utils には依存しない）', () => {
    const options = auditPageOptions()
    const settings = options.find(o => o.value === '/settings')
    expect(settings?.label).toBe('設定（/settings）')
    // 「その他」以外は全て名称 + パスの併記
    for (const o of options) {
      if (o.value === AUDIT_PAGE_OTHER) continue
      expect(o.label, `'${o.value}' のラベルにパス併記がない`).toContain(`（${o.value}）`)
    }
  })

  it('auditPageName は未知パスをパスのまま・空/その他を「その他」と表示する', () => {
    expect(auditPageName('/settings')).toBe('設定')
    expect(auditPageName('/no-such-page')).toBe('/no-such-page')
    expect(auditPageName('')).toBe('その他')
    expect(auditPageName(AUDIT_PAGE_OTHER)).toBe('その他')
  })
})
