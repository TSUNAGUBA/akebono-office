/**
 * データ取込・連携基盤（F-32）
 * 取込元（CSV/固定長/JSON/API）・項目マッピング（方式別に取込元を解析し右辺=対象アプリ項目へ対応づけ・版管理）・
 * 取込実行（ステージング → 検証 → 反映。冪等・エラー行隔離）。
 *
 * デュアルモード（Phase D = 0035。localStorage 依存の解消 = 本実装の最終フェーズ）:
 * - モック: 従来どおり useMockDb（同期）+ 実行はシミュレート
 * - API: SoT はサーバー（import_sources = 設定系・import_mappings = 設定系/版管理・
 *   import_runs = 記録系）。読み取りは一覧 GET のキャッシュ（useApi）、書込は各専用エンドポイントへ
 *   非同期に送り、成功後に影響コレクションを再ロードする（SoT 書込 → キャッシュ更新の順 = 原則6）。
 *   取込実行は**実取込**（監査指摘 2026-07-30 ① = implementation-status §48-1。ファイル添付 or
 *   サーバーの SSRF ガード付き pull → マッピング適用 → 対象テーブルへ反映）。
 * - 取消可能性（原則9.5）: 取込元 = 論理削除 + 復元。マッピング = 新版で上書き（旧版は履歴に残る）。
 */
import type {
  ImportFieldMap, ImportMapping, ImportMethod, ImportRun, ImportSource, ImportSourceConfig, ImportTargetEntity,
} from '~/types/akebono'
import type { Result } from '~/types/domain'
import { irange } from '~/utils/rng'
import { nextCode } from '~/utils/akebono'
import { normalizeFieldLocators, normalizeImportSourceConfig } from '~/utils/import-parse'

export const IMPORT_METHOD_LABELS: Record<ImportMethod, string> = {
  file_csv: 'CSV ファイル',
  file_fixed: '固定長テキスト',
  file_json: 'JSON ファイル',
  api_pull: 'API 接続（pull）',
}
export const IMPORT_ENTITY_LABELS: Record<ImportTargetEntity, string> = {
  product: '商品', sku: 'SKU', company: '取引先', sales_record: '売上明細', inventory: '在庫',
}

/** 実取込の反映先コレクション（取込成功後にキャッシュを取り直す = 原則6） */
const RELOAD_BY_ENTITY: Record<string, string[]> = {
  product: ['products', 'productSkus'],
  sku: ['productSkus'],
  company: ['companies'],
  sales_record: ['salesRecords'],
  inventory: ['inventoryTransactions', 'inventoryBalances'],
}

export function useAkebonoImports() {
  const { tbl, commit, nextId } = useMockDb()
  const sources = tbl('importSources')
  const mappings = tbl('importMappings')
  const runs = tbl('importRuns')
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()

  /** 取込設定・実行の書込は管理者のみ（API の requireAdmin = AKO-AUTH-003 と両モード一致。m4） */
  const isAdmin = computed(() => currentUser.value.role === 'admin')
  function adminGuard(): Result | null {
    return isAdmin.value ? null : { ok: false, error: { code: 'AKO-AUTH-003', message: 'この操作には管理者権限が必要です' } }
  }

  const activeSources = computed(() => sources.value.filter(s => s.active !== false))
  function sourceById(id: string): ImportSource | undefined {
    return sources.value.find(s => s.id === id)
  }
  function mappingsOf(sourceId: string): ImportMapping[] {
    return mappings.value.filter(m => m.sourceId === sourceId).sort((a, b) => b.version - a.version)
  }
  function activeMappingOf(sourceId: string): ImportMapping | undefined {
    return mappingsOf(sourceId).find(m => m.status === 'active')
  }
  function runsOf(sourceId: string): ImportRun[] {
    return runs.value.filter(r => r.sourceId === sourceId).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  }
  const recentRuns = computed(() => runs.value.slice().sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)))

  async function addSource(input: { name: string; method: ImportMethod; encoding: 'utf8' | 'sjis'; targetEntity: ImportTargetEntity; config?: ImportSourceConfig }): Promise<Result> {
    const denied = adminGuard(); if (denied) return denied
    if (!input.name.trim()) return { ok: false, error: { code: 'AKO-IMP-001', message: '取込元名は必須です' } }
    if (isApi) {
      const res = await apiWrite<ImportSource>('/v1/akebono/import-sources', { body: input, reload: ['importSources'] })
      return res.ok ? { ok: true, id: res.data.id } : res
    }
    const id = nextId('importSources', 'imp')
    // config は method 別に正規化（API の normalizeImportSourceConfig と同一関数 = 両モード parity）
    const config = normalizeImportSourceConfig(input.config ?? {}, input.method) as ImportSourceConfig
    sources.value = [...sources.value, { id, name: input.name.trim(), method: input.method, encoding: input.encoding, targetEntity: input.targetEntity, schedule: 'manual', active: true, config }]
    commit()
    return { ok: true, id }
  }

  /** 方式別設定の更新（エンドポイント/トークン・CSV ヘッダ有無等）。冪等（同値を再送しても結果不変）= 再試行安全 */
  async function updateSourceConfig(id: string, config: ImportSourceConfig): Promise<Result> {
    const denied = adminGuard(); if (denied) return denied
    if (isApi) return apiWrite(`/v1/akebono/import-sources/${id}/config`, { method: 'PUT', body: { config }, reload: ['importSources'], idempotent: true })
    // 取込元の method に合わせて正規化（API 経路と同じ subset に揃える）
    const method = sourceById(id)?.method
    const norm = method ? normalizeImportSourceConfig(config, method) as ImportSourceConfig : config
    sources.value = sources.value.map(s => s.id === id ? { ...s, config: norm } : s)
    commit()
    return { ok: true, id }
  }
  /** 取込元の無効化（論理削除）。冪等（active=false の再設定は結果不変）= コールドスタートのタイムアウトを 1 回再試行 */
  async function archiveSource(id: string): Promise<Result> {
    const denied = adminGuard(); if (denied) return denied
    if (isApi) return apiWrite(`/v1/akebono/import-sources/${id}/archive`, { reload: ['importSources'], idempotent: true })
    sources.value = sources.value.map(s => s.id === id ? { ...s, active: false } : s)
    commit()
    return { ok: true, id }
  }
  /** 取込元の復元（論理削除の取消 = 原則9.5。imports.vue が「無効も表示」トグル経由で両モードとも復元導線を持つ）。冪等 = 再試行安全 */
  async function restoreSource(id: string): Promise<Result> {
    const denied = adminGuard(); if (denied) return denied
    if (isApi) return apiWrite(`/v1/akebono/import-sources/${id}/restore`, { reload: ['importSources'], idempotent: true })
    sources.value = sources.value.map(s => s.id === id ? { ...s, active: true } : s)
    commit()
    return { ok: true, id }
  }

  /** 新しいマッピング版を作成（既存 active は superseded に）。方式別に取込元を解析して人が確定する想定 */
  async function saveMapping(sourceId: string, fields: Omit<ImportFieldMap, 'id'>[]): Promise<Result> {
    const denied = adminGuard(); if (denied) return denied
    if (isApi) {
      const res = await apiWrite<ImportMapping>('/v1/akebono/import-mappings', {
        body: { sourceId, fields }, reload: ['importMappings'],
      })
      return res.ok ? { ok: true, id: res.data.id } : res
    }
    const versions = mappingsOf(sourceId)
    const nextVersion = (versions[0]?.version ?? 0) + 1
    const id = nextId('importMappings', 'impm')
    const mapping: ImportMapping = {
      id, sourceId, version: nextVersion, status: 'active', createdAt: nowJstIso(),
      // ロケータは shared normalizeFieldLocators で正規化（API importFieldsOf と同一関数 = '' → null 等を両モード一致）
      fields: fields.filter(f => f.sourceField && f.targetItemKey).map((f, i) => ({
        id: `${id}-f${i}`, sourceField: f.sourceField, targetItemKey: f.targetItemKey, transform: f.transform,
        ...normalizeFieldLocators(f as unknown as Record<string, unknown>),
      })),
    }
    mappings.value = [
      ...mappings.value.map(m => m.sourceId === sourceId && m.status === 'active' ? { ...m, status: 'superseded' as const } : m),
      mapping,
    ]
    commit()
    return { ok: true, id }
  }

  /**
   * 取込を実行。API モードは**実取込**（監査指摘 2026-07-30 ①）: ファイル方式は添付ファイルを
   * base64 で送り、サーバーがパース → マッピング適用 → 検証 → 対象テーブルへ反映する
   * （API 接続方式はサーバーが SSRF ガード付きで pull）。エラー行は隔離・再実行は冪等。
   * モックはステージング → 検証 → 反映を 1 回で行い、決定的にサンプルのエラー行を混ぜる
   * （デモ用シミュレート。実取込はサーバーが必要なため API モード限定 = 画面に明示）。
   */
  async function runImport(sourceId: string, file?: File | null): Promise<Result & { runId?: string }> {
    const denied = adminGuard(); if (denied) return denied
    if (isApi) {
      const method = sourceById(sourceId)?.method
      const body: Record<string, unknown> = { sourceId }
      if (method?.startsWith('file')) {
        if (!file) return { ok: false, error: { code: 'AKO-IMP-004', message: '取込ファイルを選択してください' } }
        if (file.size > 10 * 1024 * 1024) {
          return { ok: false, error: { code: 'AKO-IMP-004', message: 'ファイルは 10MB 以下にしてください' } }
        }
        const buf = new Uint8Array(await file.arrayBuffer())
        let bin = ''
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
        body.filename = file.name
        body.contentBase64 = btoa(bin)
      }
      // 実反映後に対象コレクションのキャッシュも取り直す（SoT → キャッシュの順 = 原則6）
      const reload = ['importRuns', ...RELOAD_BY_ENTITY[sourceById(sourceId)?.targetEntity ?? ''] ?? []]
      const res = await apiWrite<ImportRun>('/v1/akebono/import-runs', { body, reload })
      return res.ok ? { ok: true, runId: res.data.id } : res
    }
    const source = sourceById(sourceId)
    if (!source) return { ok: false, error: { code: 'AKO-GEN-002', message: '取込元が見つかりません' } }
    const mapping = activeMappingOf(sourceId)
    if (!mapping) return { ok: false, error: { code: 'AKO-IMP-002', message: '有効なマッピング定義がありません（先にマッピングを保存してください）' } }
    const staged = 10 + irange(`imp:${sourceId}:${runs.value.length}`, 0, 20)
    const failed = irange(`impfail:${sourceId}:${runs.value.length}`, 0, 2)
    const applied = staged - failed
    const id = nextId('importRuns', 'impr')
    const run: ImportRun = {
      id, code: nextCode(runs.value.map(r => r.code), 'RUN'),
      sourceId, mappingVersion: mapping.version, startedAt: nowJstIso(), finishedAt: nowJstIso(),
      status: 'applied', counts: { staged, applied, skipped: 0, failed },
      errors: failed > 0
        ? [{ rowNo: 3, rawText: '（サンプル）マスタ未登録の商品コードを含む行', message: '商品コードがマスタ未登録のため隔離（AKO-IMP-010）' }]
        : [],
    }
    runs.value = [...runs.value, run]
    commit()
    return { ok: true, runId: id }
  }

  return {
    sources, mappings, runs, activeSources, recentRuns, isAdmin,
    sourceById, mappingsOf, activeMappingOf, runsOf,
    addSource, updateSourceConfig, archiveSource, restoreSource, saveMapping, runImport,
  }
}
