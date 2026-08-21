/**
 * 監査ログカタログ（API 側）。shared/domain/audit-log を API 側からも import できること、
 * および API が実際に書き込む entity / action がカタログで解決できることを確認する
 * （home 側と同一 SoT を読むことの担保 = 原則6。境界ケースの網羅は home/tests/audit-log.test.ts が担う）。
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIT_ACTION_META, AUDIT_ENTITY_META, AUDIT_PAGE_OTHER,
  auditActionLabel, auditEntitiesForPage, auditEntitiesWithPage, auditEntityMeta,
} from '../../../shared/domain/audit-log'
import { MASTERS } from '../../src/masters/registry'

describe('マスタ CRUD の entity 網羅（registry def.table = audit_logs.entity）', () => {
  it('全マスタの table 名がカタログに存在し、ページ対応がある', () => {
    for (const [entity, def] of Object.entries(MASTERS)) {
      const meta = AUDIT_ENTITY_META[def.table]
      expect(meta, `マスタ '${entity}'（table '${def.table}'）がカタログにない`).toBeTruthy()
      expect(meta!.label.trim()).not.toBe('')
      expect(meta!.page, `table '${def.table}' の操作対象ページが未設定`).not.toBe('')
    }
  })
})

describe('ルート直書きの entity 網羅（grep -rn "entity: \'" api/src の静的値 + 動的値）', () => {
  it('records 系・設定系・連携系の entity がカタログに存在する', () => {
    const used = [
      // 設定・監査
      'app_configs', 'akebono_app_configs', 'item_settings',
      // 勤怠・休暇・稟議
      'attendance_fix_requests', 'direct_requests', 'leave_requests', 'leave_grants',
      // 日報・AI・ノート・ドキュメント
      'daily_reports', 'task_plan', 'notes', 'documents', 'knowledge_articles',
      // 顧客・活動記録（spec.logTable の動的値 = sales/partner_activity_logs を含む）
      'customer_logs', 'customer_contexts', 'customer_context_notes',
      'support_activities', 'sales_activities', 'sales_activity_logs',
      'partner_activities', 'partner_activity_logs',
      // 改善要望
      'improvement_requests', 'improvement_request_comments', 'improvement_items', 'improvement_notes',
      // メディア・売上・連携・検索
      'media_channels', 'media_ga_tokens', 'media_articles', 'media_generated_articles',
      'media_external_articles', 'sales_monthly', 'mart_load_runs', 'user_chat_links', 'search_docs',
      // 名寄せ新規登録（lib/*-resolve）・祝日取込
      'companies', 'contacts', 'villages', 'public_holidays', 'members',
      // AKEBONO 記録系
      'products', 'product_skus', 'product_images', 'inventory_transactions',
      'inbound_plans', 'inbound_results', 'outbound_plans', 'outbound_results',
      'purchase_orders', 'purchase_records', 'production_orders',
      'sales_records', 'invoices', 'payment_receipts', 'payment_notices',
      'import_sources', 'import_mappings', 'import_runs', 'dashboard_insights',
    ]
    for (const entity of used) {
      expect(AUDIT_ENTITY_META[entity], `entity '${entity}' がカタログにない`).toBeTruthy()
    }
  })

  it('未知 entity はフォールバック（生値ラベル + 「その他」ページ）で表示が壊れない', () => {
    expect(auditEntityMeta('brand_new_table')).toEqual({ label: 'brand_new_table', page: '' })
  })
})

describe('action 網羅（grep -rn "action: \'" api/src + 動的 body.action / ジョブ）', () => {
  it('静的 action + 承認系の動的 action にラベルがある', () => {
    const used = [
      'create', 'update', 'archive', 'restore', 'delete', 'import', 'upsert', 'run', 'reindex',
      'grant', 'connect', 'disconnect',
      // 動的: leave/attendance の body.action・休暇の定期付与ジョブ
      'approved', 'rejected', 'withdrawn', 'periodic-grant',
    ]
    for (const action of used) {
      expect(AUDIT_ACTION_META[action]?.label, `action '${action}' にラベルがない`).toBeTruthy()
    }
    expect(auditActionLabel('nonexistent')).toBe('nonexistent') // 未知は生値
  })
})

describe('f.page のサーバーサイド展開（GET /v1/configs/audit-logs が使う導出）', () => {
  it('ページ → entity IN (...) の展開が page 宣言と一致する', () => {
    for (const entity of auditEntitiesForPage('/akebono/billing')) {
      expect(AUDIT_ENTITY_META[entity]?.page).toBe('/akebono/billing')
    }
    expect(auditEntitiesForPage('/akebono/billing').sort())
      .toEqual(['invoices', 'payment_notices', 'payment_receipts'])
  })

  it('「その他」= ページあり集合の補集合として全 entity を覆う（NOT IN 展開の前提）', () => {
    const withPage = auditEntitiesWithPage()
    const other = auditEntitiesForPage(AUDIT_PAGE_OTHER)
    expect([...withPage, ...other].sort()).toEqual(Object.keys(AUDIT_ENTITY_META).sort())
  })

  it('未知ページは空配列（route 側はフィルタを黙って無視する = 原則4）', () => {
    expect(auditEntitiesForPage('/unknown')).toEqual([])
  })
})
