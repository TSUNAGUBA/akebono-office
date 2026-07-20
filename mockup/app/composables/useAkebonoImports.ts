/**
 * データ取込・連携基盤（F-32）
 * 取込元（CSV/固定長/JSON/API）・項目マッピング（AI 候補 + 人が確定・版管理）・
 * 取込実行（ステージング → 検証 → 反映。冪等・エラー行隔離）。
 * モックは実行をシミュレートし、実行履歴・エラー行を残す（管理者限定）。
 */
import type {
  ImportMapping, ImportMethod, ImportRun, ImportSource, ImportTargetEntity,
} from '~/types/akebono'
import type { Result } from '~/types/domain'
import { irange } from '~/utils/rng'
import { nextCode } from '~/utils/akebono'

export const IMPORT_METHOD_LABELS: Record<ImportMethod, string> = {
  file_csv: 'CSV ファイル',
  file_fixed: '固定長テキスト',
  file_json: 'JSON ファイル',
  api_pull: 'API 接続（pull）',
}
export const IMPORT_ENTITY_LABELS: Record<ImportTargetEntity, string> = {
  product: '商品', sku: 'SKU', company: '取引先', sales_record: '売上明細', inventory: '在庫',
}

export function useAkebonoImports() {
  const { tbl, commit, nextId } = useMockDb()
  const sources = tbl('importSources')
  const mappings = tbl('importMappings')
  const runs = tbl('importRuns')

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

  function addSource(input: { name: string; method: ImportMethod; encoding: 'utf8' | 'sjis'; targetEntity: ImportTargetEntity }): Result {
    if (!input.name.trim()) return { ok: false, error: { code: 'AKO-IMP-001', message: '取込元名は必須です' } }
    const id = nextId('importSources', 'imp')
    sources.value = [...sources.value, { id, name: input.name.trim(), method: input.method, encoding: input.encoding, targetEntity: input.targetEntity, schedule: 'manual', active: true }]
    commit()
    return { ok: true, id }
  }
  function archiveSource(id: string): Result {
    sources.value = sources.value.map(s => s.id === id ? { ...s, active: false } : s)
    commit()
    return { ok: true, id }
  }

  /** 新しいマッピング版を作成（既存 active は superseded に）。AI 候補 + 人が確定の想定 */
  function saveMapping(sourceId: string, fields: { sourceField: string; targetItemKey: string; transform: string }[]): Result {
    const versions = mappingsOf(sourceId)
    const nextVersion = (versions[0]?.version ?? 0) + 1
    const id = nextId('importMappings', 'impm')
    const mapping: ImportMapping = {
      id, sourceId, version: nextVersion, status: 'active', createdAt: nowJstIso(),
      fields: fields.filter(f => f.sourceField && f.targetItemKey).map((f, i) => ({ id: `${id}-f${i}`, ...f })),
    }
    mappings.value = [
      ...mappings.value.map(m => m.sourceId === sourceId && m.status === 'active' ? { ...m, status: 'superseded' as const } : m),
      mapping,
    ]
    commit()
    return { ok: true, id }
  }

  /**
   * 取込を実行（シミュレート）。ステージング → 検証 → 反映を 1 回で行い、実行履歴を残す。
   * 決定的にサンプルのエラー行を 1 件混ぜる（マスタ未登録 = 隔離・健全行は反映 = 原則4）。
   */
  function runImport(sourceId: string): Result & { runId?: string } {
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
    sources, mappings, runs, activeSources, recentRuns,
    sourceById, mappingsOf, activeMappingOf, runsOf,
    addSource, archiveSource, saveMapping, runImport,
  }
}
