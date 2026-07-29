<script setup lang="ts">
/**
 * 目標マスタ（管理者専用。F-01 コックピット着地予報の基準値 = cockpit-design §2.2）
 * - metric='segment_sales'（業態売上・円）は対象業態が必須 / 'report_rate'（日報提出率・%）は全社（0-100）
 * - 同一 (metric, segmentId) の active 重複は登録を妨げず警告のみ（評価は最新 1 件 = 後勝ち）
 * - 論理削除（無効化/復元）= 取消フロー（原則9.5）
 */
import { Plus } from 'lucide-vue-next'
import { ACTIVE_FILTER_OPTIONS, matchesActiveFilter } from '~/components/masters/MasterShell.vue'
import type { Goal, GoalMetric } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'
import { fmtYen } from '~/utils/format'
import { GOAL_METRIC_LABELS } from '~/utils/labels'

const crud = useMasterCrudAsync('goals', 'g')
const { segmentOptions, segmentName } = useAkebonoMasters()
const toast = useToast()
const confirm = useConfirm()

// ---------- 一覧 ----------

const search = ref('')
const statusFilter = ref('active')

/** 対象の表示名（業態売上 = 業態名 / 日報提出率 = 全社） */
function targetName(g: Goal): string {
  return g.metric === 'segment_sales' ? segmentName(g.segmentId) : '全社'
}

/** 月次目標値の単位付き表示（segment_sales = 円 / report_rate = %） */
function fmtGoalValue(g: Goal): string {
  return g.metric === 'segment_sales' ? fmtYen(g.monthlyValue) : `${g.monthlyValue}%`
}

const filtered = computed(() =>
  (crud.list.value as Goal[]).filter((g) => {
    if (!matchesActiveFilter(g, statusFilter.value)) return false
    const q = search.value.trim().toLowerCase()
    if (!q) return true
    return [GOAL_METRIC_LABELS[g.metric], targetName(g), g.note].some(v => v.toLowerCase().includes(q))
  }),
)

const tableRows = computed(() => filtered.value as unknown as Record<string, unknown>[])

const columns: TableColumn[] = [
  { key: 'metric', label: '指標', primary: true },
  { key: 'target', label: '対象', primary: true },
  { key: 'monthlyValue', label: '月次目標', align: 'right', primary: true },
  { key: 'note', label: 'メモ' },
  { key: 'active', label: '状態', primary: true },
]

function asGoal(row: Record<string, unknown>): Goal {
  return row as unknown as Goal
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<Goal | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as Goal | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? '目標を追加' : mode.value === 'edit' ? '目標を編集' : '目標詳細',
)

const metricOptions = Object.entries(GOAL_METRIC_LABELS).map(([value, label]) => ({ value, label }))

/** metric に応じて対象業態の要否・目標値の単位を切り替える（members.vue の雇用区分連動と同型） */
const formFields = computed<FieldDef[]>(() => {
  const metric = String(form.value.metric ?? 'segment_sales') as GoalMetric
  return [
    {
      key: 'metric', label: '指標', type: 'select', required: true, options: metricOptions,
      hint: '業態売上 = 業態ごとの月次売上目標（円）/ 日報提出率 = 全社の月次提出率目標（%）',
    },
    ...(metric === 'segment_sales'
      ? [{
          key: 'segmentId', label: '対象業態', type: 'select', required: true, options: segmentOptions.value,
          hint: '業態の追加・変更は AKEBONO 共通マスタ（事業セグメント）で行います',
        } satisfies FieldDef]
      : []),
    {
      key: 'monthlyValue',
      label: metric === 'segment_sales' ? '月次目標値（円）' : '月次目標値（%）',
      type: 'number', required: true, min: 0,
      ...(metric === 'report_rate' ? { max: 100 } : {}),
      step: 1,
      hint: metric === 'segment_sales' ? '月初からの売上実績を日割り外挿した着地予測と比較します' : '0〜100 で入力します（率は外挿せず現在値で評価）',
    },
    { key: 'note', label: 'メモ', type: 'textarea', placeholder: '目標の根拠・前提（任意）' },
  ]
})

const detailRows = computed(() => {
  const g = selected.value
  if (!g) return []
  return [
    { label: '指標', value: GOAL_METRIC_LABELS[g.metric] ?? g.metric },
    { label: '対象', value: targetName(g) },
    { label: '月次目標', value: fmtGoalValue(g) },
    { label: 'メモ', value: g.note || '—' },
    { label: '状態', value: g.active ? '有効' : '無効' },
  ]
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
  form.value = { metric: 'segment_sales', segmentId: '', monthlyValue: '', note: '' }
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  if (!selected.value) return
  form.value = JSON.parse(JSON.stringify(selected.value)) as Record<string, unknown>
  form.value.segmentId = selected.value.segmentId ?? ''
  errors.value = {}
  mode.value = 'edit'
}

async function cancelEdit(): Promise<void> {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

async function save(): Promise<void> {
  const metric = String(form.value.metric ?? '') as GoalMetric
  const value = Number(form.value.monthlyValue)
  const e: Record<string, string> = {}
  if (!metric) e.metric = '指標は必須です'
  if (metric === 'segment_sales' && !String(form.value.segmentId ?? '')) e.segmentId = '対象業態は必須です'
  if (form.value.monthlyValue === '' || form.value.monthlyValue == null || !Number.isFinite(value) || value < 0) {
    e.monthlyValue = '月次目標値は 0 以上の数値で入力してください'
  } else if (metric === 'report_rate' && value > 100) {
    e.monthlyValue = '日報提出率は 0〜100 で入力してください'
  }
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 入力内容を確認してください', 'crit')
    return
  }
  const payload: Partial<Goal> & { id?: string } = {
    metric,
    segmentId: metric === 'segment_sales' ? String(form.value.segmentId) : null,
    monthlyValue: value,
    note: String(form.value.note ?? '').trim(),
  }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value
  // 同一 (metric, segmentId) の active 重複は登録を妨げず警告のみ（評価は最新 1 件 = 後勝ち。§2.2）
  const duplicated = (crud.list.value as Goal[]).some(g =>
    g.active !== false && g.id !== payload.id && g.metric === payload.metric && g.segmentId === payload.segmentId)
  const res = await crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  if (duplicated) {
    toast.show('同じ対象の有効な目標が既にあります（着地予報は最新の 1 件を使用）', 'warn')
  } else {
    toast.show(mode.value === 'create' ? '目標を追加しました' : '目標を更新しました')
  }
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask(
    '目標の無効化',
    `「${GOAL_METRIC_LABELS[selected.value.metric]}（${targetName(selected.value)}）」を無効化しますか？（論理削除。あとから復元できます）`,
    { danger: true, confirmLabel: '無効化' },
  )
  if (!ok) return
  const res = await crud.archive(selected.value.id)
  if (res.ok) toast.show('無効化しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

async function restoreSelected(): Promise<void> {
  if (!selected.value) return
  const res = await crud.restore(selected.value.id)
  if (res.ok) toast.show('復元しました')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}
</script>

<template>
  <MastersMasterShell
    title="目標マスタ"
    description="ダッシュボードの着地予報が参照する月次目標です（業態売上 = 業態ごと・円 / 日報提出率 = 全社・%）"
  >
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="指標・対象・メモで検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <UiSectionCard :title="`目標一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="目標が登録されていません"
        empty-hint="「新規追加」から業態売上・日報提出率の月次目標を登録してください"
        @row-click="openDetail"
      >
        <template #cell-metric="{ row }">
          <span class="font-medium">{{ GOAL_METRIC_LABELS[asGoal(row).metric] ?? asGoal(row).metric }}</span>
        </template>
        <template #cell-target="{ row }">
          {{ targetName(asGoal(row)) }}
        </template>
        <template #cell-monthlyValue="{ row }">
          <span class="num">{{ fmtGoalValue(asGoal(row)) }}</span>
        </template>
        <template #cell-note="{ row }">
          <span class="text-sub">{{ asGoal(row).note || '—' }}</span>
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asGoal(row).active ? '有効' : '無効'" :tone="asGoal(row).active ? 'ok' : 'neutral'" dot />
        </template>
      </UiDataTable>
    </UiSectionCard>

    <template #drawer>
      <UiDrawer :open="drawerOpen" :title="drawerTitle" @close="drawerOpen = false">
        <dl v-if="mode === 'view' && selected" class="grid gap-2 text-[13px]">
          <div
            v-for="r in detailRows"
            :key="r.label"
            class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2 last:border-0"
          >
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
            <dd>{{ r.value }}</dd>
          </div>
        </dl>
        <UiSchemaForm v-else v-model="form" :fields="formFields" :errors="errors" />

        <template #footer>
          <div v-if="mode === 'view' && selected" class="flex items-center justify-between gap-2">
            <button v-if="selected.active" type="button" class="btn btn-danger btn-sm" @click="archiveSelected">無効化</button>
            <button v-else type="button" class="btn btn-sm" @click="restoreSelected">復元</button>
            <button type="button" class="btn btn-primary" @click="openEdit">編集</button>
          </div>
          <div v-else class="flex items-center justify-end gap-2">
            <button type="button" class="btn" @click="cancelEdit">キャンセル</button>
            <button type="button" class="btn btn-primary" @click="save">保存</button>
          </div>
        </template>
      </UiDrawer>
    </template>
  </MastersMasterShell>
</template>
