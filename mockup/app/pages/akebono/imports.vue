<script setup lang="ts">
/**
 * F-32 データ取込・連携（管理者専用）
 * 取込元（CSV/固定長/JSON/API）・項目マッピング（AI 候補 + 人が確定・版管理）・
 * 取込実行（ステージング → 検証 → 反映。冪等・dry-run 思想。エラー行隔離）。
 * モックは実行をシミュレートし、実行履歴・エラー行を残す。
 */
import { Plus, Play, Trash2, Wand2 } from 'lucide-vue-next'
import {
  IMPORT_METHOD_LABELS, IMPORT_ENTITY_LABELS,
} from '~/composables/useAkebonoImports'
import type { ImportMapping, ImportRun, ImportSource } from '~/types/akebono'
import type { FieldDef, TableColumn } from '~/types/ui'
import { fmtDateTime, fmtInt } from '~/utils/format'

const imp = useAkebonoImports()
const toast = useToast()

// ---------- 取込元一覧 ----------

const selectedSourceId = ref<string | null>(null)
const selectedSource = computed<ImportSource | null>(() =>
  selectedSourceId.value ? (imp.sourceById(selectedSourceId.value) ?? null) : null,
)

const sourceRows = computed(() =>
  imp.activeSources.value as unknown as Record<string, unknown>[],
)

const sourceColumns: TableColumn[] = [
  { key: 'name', label: '名称', primary: true },
  { key: 'method', label: '方式', primary: true },
  { key: 'targetEntity', label: '対象', primary: true },
  { key: 'active', label: '状態' },
]

function asSource(row: Record<string, unknown>): ImportSource {
  return row as unknown as ImportSource
}

function selectSource(row: Record<string, unknown>): void {
  selectedSourceId.value = String(row.id)
}

// ---------- 取込元を追加（モーダル） ----------

const addOpen = ref(false)
const addForm = ref<Record<string, unknown>>({})
const addErrors = ref<Record<string, string>>({})

const addFields: FieldDef[] = [
  { key: 'name', label: '取込元名', type: 'text', required: true, placeholder: '例）本社売上 CSV（日次）' },
  {
    key: 'method', label: '取込方式', type: 'select', required: true,
    options: (Object.keys(IMPORT_METHOD_LABELS) as (keyof typeof IMPORT_METHOD_LABELS)[])
      .map(k => ({ value: k, label: IMPORT_METHOD_LABELS[k] })),
  },
  {
    key: 'encoding', label: '文字コード', type: 'select', required: true,
    options: [{ value: 'utf8', label: 'UTF-8' }, { value: 'sjis', label: 'Shift_JIS' }],
    hint: 'API 接続の場合も応答本文の文字コードを指定します',
  },
  {
    key: 'targetEntity', label: '取込対象', type: 'select', required: true,
    options: (Object.keys(IMPORT_ENTITY_LABELS) as (keyof typeof IMPORT_ENTITY_LABELS)[])
      .map(k => ({ value: k, label: IMPORT_ENTITY_LABELS[k] })),
  },
]

function openAdd(): void {
  addForm.value = { name: '', method: 'file_csv', encoding: 'utf8', targetEntity: 'product' }
  addErrors.value = {}
  addOpen.value = true
}

function submitAdd(): void {
  const e: Record<string, string> = {}
  if (!String(addForm.value.name ?? '').trim()) e.name = '取込元名は必須です'
  addErrors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('必須項目を入力してください', 'crit')
    return
  }
  const res = imp.addSource({
    name: String(addForm.value.name ?? ''),
    method: addForm.value.method as ImportSource['method'],
    encoding: addForm.value.encoding as ImportSource['encoding'],
    targetEntity: addForm.value.targetEntity as ImportSource['targetEntity'],
  })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('取込元を追加しました', 'ok')
  addOpen.value = false
  if (res.id) selectedSourceId.value = res.id
}

// ---------- マッピング ----------

const mappingRows = computed<ImportMapping[]>(() =>
  selectedSourceId.value ? imp.mappingsOf(selectedSourceId.value) : [],
)
const mappingTableRows = computed(() =>
  mappingRows.value as unknown as Record<string, unknown>[],
)
const mappingColumns: TableColumn[] = [
  { key: 'version', label: '版', align: 'right', width: '70px', primary: true },
  { key: 'status', label: '状態', primary: true },
  { key: 'fieldCount', label: '項目数', align: 'right', primary: true },
]
function asMapping(row: Record<string, unknown>): ImportMapping {
  return row as unknown as ImportMapping
}

const MAPPING_STATUS: Record<ImportMapping['status'], { label: string; tone: 'ok' | 'neutral' | 'info' }> = {
  active: { label: '有効', tone: 'ok' },
  draft: { label: '下書き', tone: 'info' },
  superseded: { label: '旧版', tone: 'neutral' },
}

// マッピング編集モーダル（簡易エディタ）
const mapOpen = ref(false)
type MapDraftRow = { sourceField: string; targetItemKey: string; transform: string }
const mapDraft = ref<MapDraftRow[]>([])

function openMapEditor(): void {
  const active = selectedSourceId.value ? imp.activeMappingOf(selectedSourceId.value) : undefined
  mapDraft.value = active && active.fields.length > 0
    ? active.fields.map(f => ({ sourceField: f.sourceField, targetItemKey: f.targetItemKey, transform: f.transform }))
    : [{ sourceField: '', targetItemKey: '', transform: '' }]
  mapOpen.value = true
}
function addMapRow(): void {
  mapDraft.value = [...mapDraft.value, { sourceField: '', targetItemKey: '', transform: '' }]
}
function removeMapRow(i: number): void {
  mapDraft.value = mapDraft.value.filter((_, idx) => idx !== i)
}
function suggestMapping(): void {
  // AI 候補提示のシミュレート（人が確定する前提。実際は列名解析 + マスタ項目マッチ）
  mapDraft.value = [
    { sourceField: 'code', targetItemKey: 'code', transform: 'trim' },
    { sourceField: 'name', targetItemKey: 'name', transform: 'trim' },
    { sourceField: 'price', targetItemKey: 'unitPrice', transform: 'number' },
  ]
  toast.show('AI が候補を提示しました。内容を確認して保存してください', 'info')
}
function saveMapping(): void {
  if (!selectedSourceId.value) return
  const valid = mapDraft.value.filter(f => f.sourceField.trim() && f.targetItemKey.trim())
  if (valid.length === 0) {
    toast.show('取込元項目と対象項目キーを1行以上入力してください', 'crit')
    return
  }
  const res = imp.saveMapping(selectedSourceId.value, valid.map(f => ({
    sourceField: f.sourceField.trim(),
    targetItemKey: f.targetItemKey.trim(),
    transform: f.transform.trim(),
  })))
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('マッピングを新しい版として保存しました', 'ok')
  mapOpen.value = false
}

// ---------- 取込実行 ----------

function runImport(): void {
  if (!selectedSourceId.value) return
  const res = imp.runImport(selectedSourceId.value)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  const run = res.runId ? imp.runsOf(selectedSourceId.value).find(r => r.id === res.runId) : undefined
  const failed = run?.counts.failed ?? 0
  toast.show(
    `取込を実行しました（${run?.code ?? ''}）${failed > 0 ? ` / ${failed}件を隔離` : ''}`,
    failed > 0 ? 'warn' : 'ok',
  )
}

// ---------- 実行履歴 ----------

const runRows = computed(() =>
  (selectedSourceId.value ? imp.runsOf(selectedSourceId.value) : []) as unknown as Record<string, unknown>[],
)
const runColumns: TableColumn[] = [
  { key: 'code', label: 'コード', primary: true },
  { key: 'startedAt', label: '開始', primary: true },
  { key: 'status', label: '状態', primary: true },
  { key: 'counts', label: '件数（済/反映/失敗）', align: 'right' },
  { key: 'errorCount', label: 'エラー', align: 'right' },
]
function asRun(row: Record<string, unknown>): ImportRun {
  return row as unknown as ImportRun
}

const RUN_STATUS: Record<ImportRun['status'], { label: string; tone: 'ok' | 'warn' | 'crit' | 'info' | 'neutral' }> = {
  staged: { label: 'ステージング', tone: 'info' },
  validated: { label: '検証済', tone: 'info' },
  applied: { label: '反映済', tone: 'ok' },
  failed: { label: '失敗', tone: 'crit' },
  reverted: { label: '取消済', tone: 'neutral' },
}

// エラー明細ドロワー
const errorDrawerOpen = ref(false)
const errorRun = ref<ImportRun | null>(null)
function openRun(row: Record<string, unknown>): void {
  errorRun.value = asRun(row)
  errorDrawerOpen.value = true
}
</script>

<template>
  <MastersMasterShell
    title="データ取込・連携"
    description="外部ファイル・API から商品・取引先・売上などを取り込みます（F-32）。AI が項目マッピング候補を提示し、人が確定します"
  >
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openAdd">
        <Plus class="h-4 w-4" aria-hidden="true" />
        取込元を追加
      </button>
    </template>

    <!-- 思想注記 -->
    <div class="card border-line bg-info-soft p-3 text-[12px] leading-relaxed text-sub">
      取込は <span class="font-semibold text-ink">ステージング → 検証（dry-run）→ 反映</span> の順で行い、
      マスタ未登録などの不正行は隔離して健全行のみ反映します（原則4）。同一データの再取込は冪等に扱われます。
      本画面はモックのため実行結果をシミュレートします。実運用では API 接続時の SSRF 対策・認証情報の保管はサーバー側で実装します。
    </div>

    <!-- 取込元一覧 -->
    <UiSectionCard :title="`取込元（${imp.activeSources.value.length}件）`" flush>
      <UiDataTable
        :columns="sourceColumns"
        :rows="sourceRows"
        clickable
        empty-title="取込元がまだありません"
        empty-hint="「取込元を追加」から登録してください"
        @row-click="selectSource"
      >
        <template #cell-name="{ row }">
          <span class="font-medium" :class="{ 'text-brand': asSource(row).id === selectedSourceId }">
            {{ asSource(row).name }}
          </span>
        </template>
        <template #cell-method="{ row }">
          {{ IMPORT_METHOD_LABELS[asSource(row).method] }}
        </template>
        <template #cell-targetEntity="{ row }">
          {{ IMPORT_ENTITY_LABELS[asSource(row).targetEntity] }}
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asSource(row).active ? '有効' : '無効'" :tone="asSource(row).active ? 'ok' : 'neutral'" dot />
        </template>
      </UiDataTable>
    </UiSectionCard>

    <!-- 選択取込元の詳細 -->
    <UiSectionCard v-if="selectedSource" :title="`${selectedSource.name} の詳細`" :description="`${IMPORT_METHOD_LABELS[selectedSource.method]} / ${IMPORT_ENTITY_LABELS[selectedSource.targetEntity]} / ${selectedSource.encoding === 'utf8' ? 'UTF-8' : 'Shift_JIS'}`">
      <template #actions>
        <button type="button" class="btn btn-sm" @click="openMapEditor">
          <Wand2 class="h-4 w-4" aria-hidden="true" />
          マッピングを保存
        </button>
        <button type="button" class="btn btn-primary btn-sm" @click="runImport">
          <Play class="h-4 w-4" aria-hidden="true" />
          取込を実行
        </button>
      </template>

      <div class="grid gap-4">
        <!-- マッピング版一覧 -->
        <div>
          <p class="mb-1.5 text-[12px] font-semibold text-muted">マッピング定義（版管理）</p>
          <UiDataTable
            :columns="mappingColumns"
            :rows="mappingTableRows"
            empty-title="マッピング未定義"
            empty-hint="「マッピングを保存」で AI 候補を確定してください"
          >
            <template #cell-version="{ row }">
              <span class="num tabular-nums">v{{ asMapping(row).version }}</span>
            </template>
            <template #cell-status="{ row }">
              <UiStatusBadge :label="MAPPING_STATUS[asMapping(row).status].label" :tone="MAPPING_STATUS[asMapping(row).status].tone" dot />
            </template>
            <template #cell-fieldCount="{ row }">
              <span class="num tabular-nums">{{ asMapping(row).fields.length }}</span>
            </template>
          </UiDataTable>
        </div>

        <!-- 実行履歴 -->
        <div>
          <p class="mb-1.5 text-[12px] font-semibold text-muted">実行履歴（行クリックでエラー明細）</p>
          <UiDataTable
            :columns="runColumns"
            :rows="runRows"
            clickable
            empty-title="実行履歴がありません"
            empty-hint="「取込を実行」で取込を開始してください"
            @row-click="openRun"
          >
            <template #cell-code="{ row }">
              <span class="font-medium">{{ asRun(row).code }}</span>
            </template>
            <template #cell-startedAt="{ row }">
              {{ fmtDateTime(asRun(row).startedAt) }}
            </template>
            <template #cell-status="{ row }">
              <UiStatusBadge :label="RUN_STATUS[asRun(row).status].label" :tone="RUN_STATUS[asRun(row).status].tone" dot />
            </template>
            <template #cell-counts="{ row }">
              <span class="num tabular-nums">
                {{ fmtInt(asRun(row).counts.staged) }} / {{ fmtInt(asRun(row).counts.applied) }} /
                <span :class="asRun(row).counts.failed > 0 ? 'text-crit font-semibold' : ''">{{ fmtInt(asRun(row).counts.failed) }}</span>
              </span>
            </template>
            <template #cell-errorCount="{ row }">
              <span class="num tabular-nums" :class="asRun(row).errors.length > 0 ? 'text-crit font-semibold' : 'text-muted'">
                {{ asRun(row).errors.length }}
              </span>
            </template>
          </UiDataTable>
        </div>
      </div>
    </UiSectionCard>

    <UiEmptyState
      v-else
      icon="MousePointerClick"
      title="取込元を選択してください"
      hint="上の一覧から取込元を選ぶと、マッピング定義と実行履歴を表示します"
    />

    <!-- 取込元を追加モーダル -->
    <UiModal :open="addOpen" title="取込元を追加" @close="addOpen = false">
      <UiSchemaForm v-model="addForm" :fields="addFields" :errors="addErrors" />
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="addOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="submitAdd">追加</button>
        </div>
      </template>
    </UiModal>

    <!-- マッピング編集モーダル -->
    <UiModal :open="mapOpen" title="マッピングを保存（新しい版）" width="640px" @close="mapOpen = false">
      <div class="grid gap-3">
        <p class="text-[12px] leading-relaxed text-sub">
          取込元の項目を対象エンティティの項目キーへ対応づけます。変換には trim / upper / number / dateFormat 等を指定できます（空 = 恒等）。
          保存すると新しい版として記録され、既存の有効版は旧版になります。
        </p>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn btn-sm" @click="suggestMapping">
            <Wand2 class="h-4 w-4" aria-hidden="true" />
            AI 候補を提示
          </button>
          <button type="button" class="btn btn-sm" @click="addMapRow">
            <Plus class="h-4 w-4" aria-hidden="true" />
            行を追加
          </button>
        </div>

        <div class="overflow-x-auto">
          <div class="grid min-w-[520px] gap-2">
            <div class="grid grid-cols-[1fr_1fr_1fr_36px] gap-2 text-[11px] font-semibold text-muted">
              <span>取込元項目</span>
              <span>対象項目キー</span>
              <span>変換</span>
              <span aria-hidden="true" />
            </div>
            <div v-for="(r, i) in mapDraft" :key="i" class="grid grid-cols-[1fr_1fr_1fr_36px] items-center gap-2">
              <input v-model="r.sourceField" class="input" type="text" placeholder="例）price" aria-label="取込元項目">
              <input v-model="r.targetItemKey" class="input" type="text" placeholder="例）unitPrice" aria-label="対象項目キー">
              <input v-model="r.transform" class="input" type="text" placeholder="例）number" aria-label="変換">
              <button type="button" class="btn btn-ghost btn-sm" aria-label="行を削除" @click="removeMapRow(i)">
                <Trash2 class="h-4 w-4 text-crit" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="mapOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="saveMapping">保存</button>
        </div>
      </template>
    </UiModal>

    <!-- エラー明細ドロワー -->
    <template #drawer>
      <UiDrawer :open="errorDrawerOpen" :title="errorRun ? `${errorRun.code} のエラー明細` : 'エラー明細'" @close="errorDrawerOpen = false">
        <div v-if="errorRun" class="grid gap-3 text-[13px]">
          <div class="grid grid-cols-2 gap-2">
            <div class="card p-2.5">
              <p class="text-[11px] text-muted">ステージ / 反映</p>
              <p class="num tabular-nums text-[15px] font-bold">{{ fmtInt(errorRun.counts.staged) }} / {{ fmtInt(errorRun.counts.applied) }}</p>
            </div>
            <div class="card p-2.5">
              <p class="text-[11px] text-muted">隔離（失敗）</p>
              <p class="num tabular-nums text-[15px] font-bold" :class="errorRun.counts.failed > 0 ? 'text-crit' : ''">{{ fmtInt(errorRun.counts.failed) }}</p>
            </div>
          </div>

          <UiEmptyState
            v-if="errorRun.errors.length === 0"
            icon="CircleCheck"
            title="エラー行はありません"
            hint="全行が正常に反映されました"
          />
          <div v-else class="grid gap-2">
            <p class="text-[11px] font-semibold text-muted">隔離された行（{{ errorRun.errors.length }}件）</p>
            <div v-for="(e, i) in errorRun.errors" :key="i" class="card border-crit p-2.5">
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-semibold text-muted">行 {{ e.rowNo }}</span>
                <UiStatusBadge label="隔離" tone="crit" dot />
              </div>
              <p class="mt-1 text-[12px] text-crit">{{ e.message }}</p>
              <pre class="mt-1.5 overflow-x-auto rounded bg-page p-2 text-[11px] text-sub">{{ e.rawText }}</pre>
            </div>
          </div>
        </div>
      </UiDrawer>
    </template>
  </MastersMasterShell>
</template>
