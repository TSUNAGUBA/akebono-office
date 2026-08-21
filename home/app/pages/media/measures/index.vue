<script setup lang="ts">
/**
 * 改善施策一覧（/media/measures。改善要望 2026-08-21・F-56）。
 * AI週次レポートで「実行する」と判断した推奨アクションが改善施策として並ぶ。
 * - 上部にステータス別サマリー（実施予定 n｜実施中 n｜効果観測中 n｜評価待ち n｜完了 n）
 * - フィルタ: ステータス / 効果判定 = チップ表現（受付箱と同型 = UiChipTabs）・
 *   対象メディア / 担当 = オートコンプリート付きドロップダウン（UiCombobox。改善要望の指定）・期間 = date 2 欄
 * - 一覧 20 件/ページ（X-7）。行押下で詳細ページ（/media/measures/:id）へ
 */
import type { MediaMeasure } from '../../../../../shared/domain/media-weekly-report'
import {
  MEDIA_MEASURE_EVALUATIONS, MEDIA_MEASURE_STATUSES,
} from '../../../../../shared/domain/media-weekly-report'
import {
  MEDIA_MEASURE_EVALUATION_TONES, MEDIA_MEASURE_STATUS_TONES,
} from '~/composables/useMediaReports'
import { fmtDate } from '~/utils/format'
import type { Member } from '~/types/domain'
import type { MediaChannel } from '~/types/media'
import type { TableColumn } from '~/types/ui'

const router = useRouter()
const mr = useMediaReports()
const { tbl } = useMockDb()

const channels = computed(() => (tbl('mediaChannels').value as MediaChannel[]).filter(c => c.active !== false))
const members = computed(() => (tbl('members').value as Member[]).filter(m => m.active !== false))

function channelName(id: string): string {
  return channels.value.find(c => c.id === id)?.name ?? id
}
function memberName(id: string): string {
  return members.value.find(m => m.id === id)?.name ?? id
}

// ---------- フィルタ（チップ + オートコンプリート = 改善要望 2026-08-21） ----------
const statusFilter = ref('')
const evaluationFilter = ref('')
const channelFilter = ref('')
const channelFilterText = ref('')
const assigneeFilter = ref('')
const assigneeFilterText = ref('')
const fromDate = ref('')
const toDate = ref('')

const statusOptions = [{ value: '', label: 'すべて' }, ...MEDIA_MEASURE_STATUSES.map(s => ({ value: s, label: s }))]
const evaluationOptions = [
  { value: '', label: '効果判定: すべて' },
  ...MEDIA_MEASURE_EVALUATIONS.map(e => ({ value: e, label: e })),
]
const channelOptions = computed(() => channels.value.map(c => ({ value: c.id, label: c.name })))
const memberOptions = computed(() => members.value.map(m => ({ value: m.id, label: m.name })))

const all = computed(() => mr.measuresList())

const filtered = computed(() => all.value.filter((m) => {
  if (statusFilter.value && m.status !== statusFilter.value) return false
  if (evaluationFilter.value && (m.verification?.humanEvaluation ?? '') !== evaluationFilter.value) return false
  if (channelFilter.value && m.channelId !== channelFilter.value) return false
  if (assigneeFilter.value && m.assigneeMemberId !== assigneeFilter.value) return false
  const created = (m.createdAt ?? '').slice(0, 10)
  if (fromDate.value && created < fromDate.value) return false
  if (toDate.value && created > toDate.value) return false
  return true
}))

/** ステータス別サマリー（ステータス以外の現在のフィルタ条件で数える） */
const statusCounts = computed(() => {
  const base = all.value.filter((m) => {
    if (evaluationFilter.value && (m.verification?.humanEvaluation ?? '') !== evaluationFilter.value) return false
    if (channelFilter.value && m.channelId !== channelFilter.value) return false
    if (assigneeFilter.value && m.assigneeMemberId !== assigneeFilter.value) return false
    const created = (m.createdAt ?? '').slice(0, 10)
    if (fromDate.value && created < fromDate.value) return false
    if (toDate.value && created > toDate.value) return false
    return true
  })
  return MEDIA_MEASURE_STATUSES.map(s => ({ status: s, count: base.filter(m => m.status === s).length }))
})

const { page, pageSize, rows: paged, total } = useListView<MediaMeasure>({ source: filtered })
watch([statusFilter, evaluationFilter, channelFilter, assigneeFilter, fromDate, toDate], () => { page.value = 1 })

const columns: TableColumn[] = [
  { key: 'name', label: '施策名', primary: true },
  { key: 'channel', label: '対象メディア' },
  { key: 'status', label: 'ステータス', primary: true },
  { key: 'assignee', label: '担当' },
  { key: 'dueDate', label: '期限', align: 'right' },
  { key: 'evaluation', label: '効果判定' },
  { key: 'source', label: '発生元' },
]
const rows = computed(() => paged.value.map(m => ({
  id: m.id,
  name: m.name,
  channel: channelName(m.channelId),
  status: m.status,
  assignee: memberName(m.assigneeMemberId),
  dueDate: m.dueDate ? fmtDate(m.dueDate) : '—',
  evaluation: m.verification?.humanEvaluation ?? '',
  source: m.sourceLabel || '手動起票',
})))

function openMeasure(id: unknown): void {
  void router.push(`/media/measures/${String(id)}`)
}

// 取消済み（復元導線 = 原則9.5）
const showArchived = ref(false)
const restoring = ref(false)
const { show } = useToast()

async function onRestore(m: MediaMeasure): Promise<void> {
  if (restoring.value) return
  restoring.value = true
  try {
    const res = await mr.restoreMeasure(m.id)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show('復元しました')
  } finally { restoring.value = false }
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <UiPageHeader
      title="改善施策一覧"
      description="AIレポートで「実行する」と判断した施策の実行・効果検証を管理します。行を押すと詳細（施策 + 効果検証）を表示します"
    />

    <div class="grid gap-4">
      <MediaChannelBar />

      <!-- ステータス別サマリー -->
      <div class="num flex flex-wrap items-center gap-x-1 gap-y-1 text-[13px]">
        <template v-for="(c, i) in statusCounts" :key="c.status">
          <span v-if="i > 0" class="text-line">｜</span>
          <button
            type="button"
            class="rounded px-1.5 py-0.5 transition-colors hover:bg-brand-soft"
            :class="statusFilter === c.status ? 'bg-brand-soft font-bold text-brand' : ''"
            :aria-pressed="statusFilter === c.status"
            @click="statusFilter = statusFilter === c.status ? '' : c.status"
          >
            {{ c.status }} <span class="font-bold">{{ c.count }}</span>
          </button>
        </template>
      </div>

      <!-- フィルタは全て折返す主スロットに置く（#trailing は nowrap のため、コンボ 2 + 期間 2 欄を入れると
           375px で横はみ出しする = UI スイープ検出。原則8） -->
      <UiFilterBar>
        <UiChipTabs v-model="statusFilter" :options="statusOptions" aria-label="ステータスで絞り込み" />
        <UiChipTabs v-model="evaluationFilter" :options="evaluationOptions" aria-label="効果判定で絞り込み" />
        <UiCombobox
          v-model="channelFilter" v-model:text="channelFilterText" :options="channelOptions"
          :allow-create="false" :show-value="false" placeholder="対象メディア" aria-label="対象メディアで絞り込み" class="w-44"
        />
        <UiCombobox
          v-model="assigneeFilter" v-model:text="assigneeFilterText" :options="memberOptions"
          :allow-create="false" :show-value="false" placeholder="担当" aria-label="担当で絞り込み" class="w-36"
        />
        <div class="flex min-w-0 items-center gap-1">
          <input v-model="fromDate" type="date" class="input w-36" aria-label="起票日（から）">
          <span class="shrink-0 text-[11px] text-muted">〜</span>
          <input v-model="toDate" type="date" class="input w-36" aria-label="起票日（まで）">
        </div>
      </UiFilterBar>

      <UiSectionCard :title="`改善施策（${filtered.length}件）`" flush>
        <UiEmptyState
          v-if="filtered.length === 0"
          icon="ClipboardCheck"
          title="改善施策はまだありません"
          hint="AIレポートの推奨アクションで「実行する」を選ぶと、改善施策として起票されます"
        >
          <template #action>
            <NuxtLink to="/media/reports" class="btn btn-primary btn-sm">AIレポートへ</NuxtLink>
          </template>
        </UiEmptyState>
        <template v-else>
          <UiDataTable :columns="columns" :rows="rows" row-key="id" clickable @row-click="row => openMeasure(row.id)">
            <template #cell-status="{ value }">
              <UiStatusBadge :label="String(value)" :tone="MEDIA_MEASURE_STATUS_TONES[String(value)] ?? 'neutral'" dot />
            </template>
            <template #cell-evaluation="{ value }">
              <UiStatusBadge v-if="value" :label="String(value)" :tone="MEDIA_MEASURE_EVALUATION_TONES[String(value)] ?? 'neutral'" />
              <span v-else class="text-[11px] text-muted">未評価</span>
            </template>
          </UiDataTable>
          <div class="px-4 pb-3">
            <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
          </div>
        </template>

        <!-- 取消済み（復元導線 = 原則9.5） -->
        <div v-if="mr.archivedMeasures().length > 0" class="border-t border-line px-4 py-2">
          <button type="button" class="btn btn-ghost btn-sm" @click="showArchived = !showArchived">
            {{ showArchived ? '取消済みを隠す' : `取消済みを表示（${mr.archivedMeasures().length}件）` }}
          </button>
          <ul v-if="showArchived" class="mt-1 divide-y divide-line">
            <li v-for="m in mr.archivedMeasures()" :key="m.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
              <span class="text-[13px] text-muted line-through">{{ m.name }}</span>
              <button type="button" class="btn btn-ghost btn-sm ml-auto" :disabled="restoring" :aria-label="`「${m.name}」を復元する`" @click="onRestore(m)">
                元に戻す
              </button>
            </li>
          </ul>
        </div>
      </UiSectionCard>
    </div>
  </div>
</template>
