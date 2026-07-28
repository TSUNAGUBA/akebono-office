/**
 * Akebonoメニュー アプリ基盤（F-20。マルチ業態対応）
 * - アプリの使用/不使用（akebonoAppConfigs = SoT）・ラベルオーバーライドを「業態（BusinessSegment）ごと」に保持
 * - 一意キー = (segmentId, appKey)。1 テナントで複数業態のアプリ構成・表示名を業態別に管理できる
 * - 業種プリセット（§3.3）は各業態の業種タイプ単独で適用（和集合ではない）・差分適用
 * - メニュー表示は「導入状態（enabled）× F-16 権限」の 2 段（本モックは enabled のみ・権限は既存 usePermissions）
 *
 * カタログ（アプリキー・名称・説明・アイコン・依存）はコード上の静的定義が SoT（menu-registry と同型）。
 * DB（akebonoAppConfigs）は業態ごとの選択（ON/OFF・ラベル）だけを持つ。
 *
 * 既定の対象業態は「現在の業態」（useCurrentSegment）。設定画面は業態を明示指定して他業態も編集できる。
 */
import type { AkebonoAppConfig, BusinessSegment } from '~/types/akebono'
import {
  AKEBONO_APP_KEYS, INDUSTRY_TYPE_LABELS, presetAppConfigsForSegments,
  presetAppsForSegment, type AkebonoAppKey,
} from '~/utils/akebono'

export interface AkebonoAppDef {
  key: AkebonoAppKey
  title: string
  description: string
  icon: string
  to: string
  /** 機能トグル（useAppSettings）のキー。無効化されているとカタログから除外する */
  featureKey?: string
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
  // メディア分析は各業態と 1:1 で対になる業務アプリ（2026-07-28。従来のトップ独立メニューから配下アプリへ移設）
  { key: 'media', title: 'メディア分析', description: 'GA × AI でサイト・記事のインサイトと次アクション、業務との PDCA、AI 記事生成', icon: 'LineChart', to: '/media', featureKey: 'media' },
]

/** 常時有効の管理者機能（プリセット対象外。§3.3 の注記。ハブ下部に表示） */
export interface AkebonoAdminTool { title: string; description: string; icon: string; to: string }
export const AKEBONO_ADMIN_TOOLS: AkebonoAdminTool[] = [
  { title: '業態アプリ設定', description: 'トップに並ぶ業態アプリの名称・アイコンと、商品登録の既定値（単位・課金区分・バリアント軸）', icon: 'LayoutGrid', to: '/akebono/settings/segments' },
  { title: '共通マスタ管理', description: '取引先ロール・事業セグメント・倉庫・単位・税区分・委託条件ほか', icon: 'Database', to: '/akebono/masters' },
  { title: 'データ取込・連携', description: 'CSV/固定長/JSON/API の項目マッピング・変換・取込', icon: 'Upload', to: '/akebono/imports' },
  { title: '項目カスタマイズ', description: 'フォーム/一覧の項目を業種の基本項目から差し引き・追加', icon: 'SlidersHorizontal', to: '/akebono/settings/items' },
]

export function useAkebonoApps() {
  const { tbl, commit } = useMockDb()
  const configs = tbl('akebonoAppConfigs')
  const { activeSegments, effectiveSegmentId } = useCurrentSegment()
  const { isEnabled } = useAppSettings()
  const toast = useToast()

  /** 機能トグルで利用可能なアプリか（featureKey 未設定は常に利用可） */
  function isFeatureAvailable(app: AkebonoAppDef): boolean {
    return !app.featureKey || isEnabled(app.featureKey)
  }

  /** 機能トグルで利用可能なアプリのみのカタログ（設定 UI・プリセット差分で使う） */
  const availableCatalog = computed(() => AKEBONO_APP_CATALOG.filter(isFeatureAvailable))

  /** 対象業態を解決する（未指定 = 現在の業態） */
  function resolveSegmentId(segmentId?: string): string {
    return segmentId ?? effectiveSegmentId.value
  }

  function configOf(segmentId: string, appKey: string): AkebonoAppConfig | undefined {
    return configs.value.find(c => c.segmentId === segmentId && c.appKey === appKey)
  }

  /** その業態に設定行が 1 件でもあるか（= 一度でも設定・シードされたか） */
  function hasAnyConfig(segmentId: string): boolean {
    return configs.value.some(c => c.segmentId === segmentId)
  }

  /**
   * アプリが使用（導入）状態か。対象業態は未指定で現在の業態。
   * 設定行が 1 件も無い業態（実行時に追加された新規業態）は業種プリセットを既定にする
   * （原則1: 初期化をコードで完結。管理者が設定するまで空メニューにしない）。
   */
  function isAppEnabled(appKey: string, segmentId?: string): boolean {
    const sid = resolveSegmentId(segmentId)
    if (!sid) return false
    const cfg = configOf(sid, appKey)
    if (cfg) return cfg.enabled === true
    if (!hasAnyConfig(sid)) return presetAppsOf(sid).includes(appKey as AkebonoAppKey)
    return false
  }

  /** 未設定の業態に業種プリセットの初期設定を materialize する（初回書込時。原則1・原則2） */
  function ensureSegmentConfigs(segmentId: string): void {
    if (hasAnyConfig(segmentId)) return
    const seg = activeSegments.value.find(s => s.id === segmentId)
    if (!seg) return
    configs.value = [...configs.value, ...presetAppConfigsForSegments([seg])]
  }

  /** 表示ラベル（オーバーライド優先。F-20-6）。対象業態は未指定で現在の業態 */
  function labelOf(app: AkebonoAppDef, segmentId?: string): string {
    return configOf(resolveSegmentId(segmentId), app.key)?.labelOverride || app.title
  }

  /** 指定業態で使用中のアプリのカード（機能トグルで無効なアプリは除外） */
  function enabledAppsOf(segmentId?: string): AkebonoAppDef[] {
    const sid = resolveSegmentId(segmentId)
    return AKEBONO_APP_CATALOG.filter(a => isFeatureAvailable(a) && isAppEnabled(a.key, sid))
  }

  /** 現在業態で使用中のアプリのカード（ハブ・ダッシュボードで表示） */
  const enabledApps = computed(() => enabledAppsOf())

  /** 指定業態の業種タイプから導かれるプリセット（単独業態） */
  function presetAppsOf(segmentId?: string): AkebonoAppKey[] {
    const seg = activeSegments.value.find(s => s.id === resolveSegmentId(segmentId))
    return seg ? presetAppsForSegment(seg) : []
  }

  /** アプリの使用/不使用を切り替える（設定系。業態ごと。upsert） */
  function setEnabled(appKey: string, enabled: boolean, segmentId?: string): void {
    const sid = resolveSegmentId(segmentId)
    if (!sid) return
    // 未設定の新規業態は初回書込でプリセットを materialize してから当該アプリだけ上書き
    // （プリセット既定の他アプリが「行が無い」で OFF に落ちるのを防ぐ）
    ensureSegmentConfigs(sid)
    const existing = configOf(sid, appKey)
    if (existing) {
      configs.value = configs.value.map(c =>
        c.segmentId === sid && c.appKey === appKey ? { ...c, enabled, source: 'manual' } : c)
    } else {
      configs.value = [...configs.value, { segmentId: sid, appKey, enabled, labelOverride: null, source: 'manual' }]
    }
    commit()
  }

  /** ラベルオーバーライドの設定（F-20-6。業態ごと。upsert） */
  function setLabel(appKey: string, label: string, segmentId?: string): void {
    const sid = resolveSegmentId(segmentId)
    if (!sid) return
    ensureSegmentConfigs(sid)
    const labelOverride = label.trim() || null
    const existing = configOf(sid, appKey)
    if (existing) {
      configs.value = configs.value.map(c =>
        c.segmentId === sid && c.appKey === appKey ? { ...c, labelOverride } : c)
    } else {
      configs.value = [...configs.value, { segmentId: sid, appKey, enabled: false, labelOverride, source: 'manual' }]
    }
    commit()
  }

  /**
   * プリセットを適用する（F-20-4。業態ごと）。確認済み前提で呼ぶ。
   * 「プリセットに含まれるアプリを ON」にするのみ。既存の ON は勝手に OFF にしない（既存設定の保護 = 原則2）。
   * 対象業態以外の設定行には一切触れない。
   */
  function applyPreset(segmentId?: string): { enabled: number } {
    const sid = resolveSegmentId(segmentId)
    if (!sid) return { enabled: 0 }
    const target = new Set(presetAppsOf(sid))
    let enabled = 0
    const next = [...configs.value]
    for (const appKey of AKEBONO_APP_KEYS) {
      if (!target.has(appKey)) continue
      const idx = next.findIndex(c => c.segmentId === sid && c.appKey === appKey)
      if (idx >= 0) {
        if (next[idx]!.enabled !== true) {
          next[idx] = { ...next[idx]!, enabled: true, source: 'preset' }
          enabled++
        }
      } else {
        next.push({ segmentId: sid, appKey, enabled: true, labelOverride: null, source: 'preset' })
        enabled++
      }
    }
    configs.value = next
    commit()
    toast.show(`プリセットを適用しました（${enabled} 件を有効化）`)
    return { enabled }
  }

  /** プリセットとの差分（適用プレビュー用。業態ごと） */
  function presetDiffOf(segmentId?: string) {
    const sid = resolveSegmentId(segmentId)
    const target = new Set(presetAppsOf(sid))
    return availableCatalog.value.map(app => ({
      app,
      inPreset: target.has(app.key),
      enabled: isAppEnabled(app.key, sid),
      willEnable: target.has(app.key) && !isAppEnabled(app.key, sid),
    }))
  }

  /** 現在業態のプリセット差分 */
  const presetDiff = computed(() => presetDiffOf())

  function industryTypeLabel(segment: BusinessSegment): string {
    return INDUSTRY_TYPE_LABELS[segment.industryType]
  }

  return {
    catalog: AKEBONO_APP_CATALOG,
    configs, activeSegments,
    enabledApps, enabledAppsOf, presetDiff, presetDiffOf, presetAppsOf,
    isAppEnabled, labelOf, setEnabled, setLabel, applyPreset, industryTypeLabel,
  }
}
