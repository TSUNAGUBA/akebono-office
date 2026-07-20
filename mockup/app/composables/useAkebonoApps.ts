/**
 * Akebonoメニュー アプリ基盤（F-20）
 * - アプリの使用/不使用（akebonoAppConfigs = SoT）・ラベルオーバーライド
 * - 事業セグメント（業態）に応じた業種プリセット（§3.3）と差分適用
 * - メニュー表示は「導入状態（enabled）× F-16 権限」の 2 段（本モックは enabled のみ・権限は既存 usePermissions）
 *
 * カタログ（アプリキー・名称・説明・アイコン・依存）はコード上の静的定義が SoT（menu-registry と同型）。
 * DB（akebonoAppConfigs）はテナントの選択（ON/OFF・ラベル）だけを持つ。
 */
import type { AkebonoAppConfig, BusinessSegment } from '~/types/akebono'
import { AKEBONO_APP_KEYS, INDUSTRY_TYPE_LABELS, presetAppsFor, type AkebonoAppKey } from '~/utils/akebono'

export interface AkebonoAppDef {
  key: AkebonoAppKey
  title: string
  description: string
  icon: string
  to: string
}

/** アプリカタログ（F-20-2。静的 SoT） */
export const AKEBONO_APP_CATALOG: AkebonoAppDef[] = [
  { key: 'products', title: '商品マスタ管理', description: '商品・SKU・画像（サンプル/製品）。全トランザクションの派生元', icon: 'Package', to: '/akebono/products' },
  { key: 'production', title: '生産管理', description: '生産指示・実績。情報サービスは開発工数・案件進行に読み替え', icon: 'Factory', to: '/akebono/production' },
  { key: 'purchase-orders', title: '発注管理', description: '仕入先への発注。情報サービスは外注費に読み替え', icon: 'ClipboardList', to: '/akebono/purchase-orders' },
  { key: 'purchases', title: '仕入管理', description: '仕入計上（買取・委託）。委託は販売時精算', icon: 'Truck', to: '/akebono/purchases' },
  { key: 'inbounds', title: '入荷管理', description: '入荷予定・入荷実績。在庫へ入庫', icon: 'PackageOpen', to: '/akebono/inbounds' },
  { key: 'outbounds', title: '出荷管理', description: '出荷指示・出荷実績。店舗納品は預け在庫へ', icon: 'PackageCheck', to: '/akebono/outbounds' },
  { key: 'inventory', title: '在庫管理', description: '在庫台帳から残高導出・調整・移動・棚卸', icon: 'Boxes', to: '/akebono/inventory' },
  { key: 'sales', title: '売上管理', description: '売上明細・セグメント別サマリ・委託売上の取込', icon: 'TrendingUp', to: '/akebono/sales' },
  { key: 'billing', title: '請求管理', description: '請求締め・発行・入金消込・委託精算（店舗マージン請求/作家支払）', icon: 'ReceiptText', to: '/akebono/billing' },
]

/** 常時有効の管理者機能（プリセット対象外。§3.3 の注記。ハブ下部に表示） */
export interface AkebonoAdminTool { title: string; description: string; icon: string; to: string }
export const AKEBONO_ADMIN_TOOLS: AkebonoAdminTool[] = [
  { title: '共通マスタ管理', description: '取引先ロール・事業セグメント・倉庫・単位・税区分・委託条件ほか', icon: 'Database', to: '/akebono/masters' },
  { title: 'データ取込・連携', description: 'CSV/固定長/JSON/API の項目マッピング・変換・取込', icon: 'Upload', to: '/akebono/imports' },
  { title: '項目カスタマイズ', description: 'フォーム/一覧の項目を業種の基本項目から差し引き・追加', icon: 'SlidersHorizontal', to: '/akebono/settings/items' },
]

export function useAkebonoApps() {
  const { tbl, commit } = useMockDb()
  const configs = tbl('akebonoAppConfigs')
  const segments = tbl('businessSegments')
  const toast = useToast()

  function configOf(appKey: string): AkebonoAppConfig | undefined {
    return configs.value.find(c => c.appKey === appKey)
  }

  /** アプリが使用（導入）状態か（未設定 = 無効 = 未導入） */
  function isAppEnabled(appKey: string): boolean {
    return configOf(appKey)?.enabled === true
  }

  /** 表示ラベル（オーバーライド優先。F-20-6） */
  function labelOf(app: AkebonoAppDef): string {
    return configOf(app.key)?.labelOverride || app.title
  }

  /** 使用中アプリのカード（ハブ・ダッシュボードで表示） */
  const enabledApps = computed(() =>
    AKEBONO_APP_CATALOG.filter(a => isAppEnabled(a.key)))

  /** 有効な事業セグメント */
  const activeSegments = computed(() =>
    (segments.value as BusinessSegment[]).filter(s => s.active !== false)
      .sort((a, b) => a.displayOrder - b.displayOrder))

  /** 自社セグメントの業種タイプから導かれるプリセット（和集合） */
  const presetApps = computed<AkebonoAppKey[]>(() =>
    presetAppsFor(activeSegments.value.map(s => s.industryType)))

  /** アプリの使用/不使用を切り替える（設定系。監査は簡略） */
  function setEnabled(appKey: string, enabled: boolean): void {
    const existing = configOf(appKey)
    if (existing) {
      configs.value = configs.value.map(c =>
        c.appKey === appKey ? { ...c, enabled, source: 'manual' } : c)
    } else {
      configs.value = [...configs.value, { appKey, enabled, labelOverride: null, source: 'manual' }]
    }
    commit()
  }

  /** ラベルオーバーライドの設定（F-20-6） */
  function setLabel(appKey: string, label: string): void {
    const existing = configOf(appKey)
    const labelOverride = label.trim() || null
    if (existing) {
      configs.value = configs.value.map(c => c.appKey === appKey ? { ...c, labelOverride } : c)
    } else {
      configs.value = [...configs.value, { appKey, enabled: false, labelOverride, source: 'manual' }]
    }
    commit()
  }

  /**
   * プリセットを適用する（F-20-4）。確認済み前提で呼ぶ。
   * 「プリセットに含まれるアプリを ON」にするのみ。既存の ON は勝手に OFF にしない（既存設定の保護 = 原則2）。
   */
  function applyPreset(): { enabled: number } {
    const target = new Set(presetApps.value)
    let enabled = 0
    const next = AKEBONO_APP_KEYS.map((appKey): AkebonoAppConfig => {
      const existing = configOf(appKey)
      if (target.has(appKey) && existing?.enabled !== true) {
        enabled++
        return { appKey, enabled: true, labelOverride: existing?.labelOverride ?? null, source: 'preset' }
      }
      return existing ?? { appKey, enabled: false, labelOverride: null, source: 'preset' }
    })
    configs.value = next
    commit()
    toast.show(`プリセットを適用しました（${enabled} 件を有効化）`)
    return { enabled }
  }

  /** プリセットとの差分（適用プレビュー用） */
  const presetDiff = computed(() => {
    const target = new Set(presetApps.value)
    return AKEBONO_APP_CATALOG.map(app => ({
      app,
      inPreset: target.has(app.key),
      enabled: isAppEnabled(app.key),
      willEnable: target.has(app.key) && !isAppEnabled(app.key),
    }))
  })

  function industryTypeLabel(app: BusinessSegment): string {
    return INDUSTRY_TYPE_LABELS[app.industryType]
  }

  return {
    catalog: AKEBONO_APP_CATALOG,
    configs, enabledApps, activeSegments, presetApps, presetDiff,
    isAppEnabled, labelOf, setEnabled, setLabel, applyPreset, industryTypeLabel,
  }
}
