<script setup lang="ts">
/**
 * メディア分析 AIレポート一覧（/media/reports。改善要望 2026-08-21・F-55）。
 * 週次の AI 分析レポートを自動生成（モック = 訪問時に直近完了週分を決定的へ遅延生成 /
 * API = 一覧表示時に直前完了週を冪等生成 + Cloud Scheduler の週次ジョブ）し、一覧表示する。
 * 先頭に直前週レポートのサマリー（重要変化 / 推奨アクション / 未判断の件数）・一覧は 20 件/ページ（X-7）。
 * 行押下で詳細ページ（/media/reports/:id）へ遷移する。
 */
import { FileChartColumn } from 'lucide-vue-next'
import { weeklyReportCounts, type MediaWeeklyReport } from '../../../../../shared/domain/media-weekly-report'
import { fmtDate, fmtDateTime, fmtInt } from '~/utils/format'
import type { TableColumn } from '~/types/ui'

const router = useRouter()
const { effectiveChannelId, currentChannel } = useCurrentChannel()
const { settingFor } = useMediaChannels()
const mr = useMediaReports()
const isApi = useApiMode()

const setting = computed(() => settingFor(effectiveChannelId.value))
const connected = computed(() => setting.value?.gaConnected === true)

// 自動生成（手動ステップを残さない = 原則1。直近 4 完了週の冪等バックフィル = 取り逃した週の回復パス。
// チャンネル切替でも追随・GA 連携直後は force 再試行 = 同一セッションの連携完了を取りこぼさない）
watch(effectiveChannelId, (id) => { if (id && connected.value) void mr.ensureGenerated(id) }, { immediate: true })
watch(connected, (ok) => { if (ok && effectiveChannelId.value) void mr.ensureGenerated(effectiveChannelId.value, true) })

const reports = computed(() => mr.reportsFor(effectiveChannelId.value))
const latest = computed<MediaWeeklyReport | null>(() => reports.value[0] ?? null)
const latestCounts = computed(() => (latest.value ? weeklyReportCounts(latest.value.content) : null))

const { page, pageSize, rows: paged, total } = useListView<MediaWeeklyReport>({ source: reports })
watch(effectiveChannelId, () => { page.value = 1 })

const columns: TableColumn[] = [
  { key: 'period', label: '対象週', primary: true },
  { key: 'changes', label: '重要変化', align: 'right' },
  { key: 'actions', label: '推奨アクション', align: 'right', primary: true },
  { key: 'undecided', label: '未判断', align: 'right' },
  { key: 'generatedAt', label: '生成日時', align: 'right' },
]
const rows = computed(() => paged.value.map((r) => {
  const c = weeklyReportCounts(r.content)
  return {
    id: r.id,
    period: `${fmtDate(r.periodFrom)}〜${fmtDate(r.periodTo)}`,
    changes: c.changes,
    actions: c.actions,
    undecided: c.undecided,
    generatedAt: fmtDateTime(r.generatedAt),
  }
}))

function openReport(id: unknown): void {
  void router.push(`/media/reports/${String(id)}`)
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <UiPageHeader
      title="AIレポート"
      description="週次の AI 分析レポートを自動生成します。重要な変化・原因仮説・コンテンツ評価・推奨アクションを確認し、実行する施策を判断できます"
    />

    <div class="grid gap-4">
      <MediaChannelBar />

      <template v-if="!connected">
        <MediaGaConnect variant="gate" />
        <p class="text-center text-[11px] text-muted">
          「{{ currentChannel?.name }}」の AIレポートを生成するには Google Analytics の連携が必要です。
        </p>
      </template>

      <template v-else>
        <!-- 前週のAIレポート（サマリー）。押下で詳細へ -->
        <button
          v-if="latest && latestCounts"
          type="button"
          class="card block w-full px-4 py-3 text-left transition-colors hover:border-brand"
          :aria-label="`${fmtDate(latest.periodFrom)}〜${fmtDate(latest.periodTo)} の AI 週次分析を開く`"
          @click="openReport(latest.id)"
        >
          <p class="flex items-center gap-2 text-[11px] font-semibold text-muted">
            <FileChartColumn class="h-3.5 w-3.5" aria-hidden="true" />
            前週のAIレポート
          </p>
          <p class="mt-1 text-[15px] font-bold">
            {{ fmtDate(latest.periodFrom) }}〜{{ fmtDate(latest.periodTo) }} AI週次分析
          </p>
          <p class="num mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            <span>重要変化：<span class="font-bold">{{ fmtInt(latestCounts.changes) }}</span> 件</span>
            <span>推奨アクション：<span class="font-bold">{{ fmtInt(latestCounts.actions) }}</span> 件</span>
            <span :class="latestCounts.undecided > 0 ? 'text-warn' : ''">未判断：<span class="font-bold">{{ fmtInt(latestCounts.undecided) }}</span> 件</span>
          </p>
        </button>

        <UiSectionCard title="レポート一覧" description="週次レポートの履歴です。行を押すと詳細を表示します" flush>
          <UiEmptyState
            v-if="reports.length === 0"
            icon="FileChartColumn"
            title="レポートはまだありません"
            :hint="isApi ? '週が完了すると自動で生成されます（GA 連携直後は数分後に再読み込みしてください）' : '週が完了すると自動で生成されます'"
          />
          <template v-else>
            <UiDataTable :columns="columns" :rows="rows" row-key="id" clickable @row-click="row => openReport(row.id)">
              <template #cell-undecided="{ value }">
                <span class="num" :class="Number(value) > 0 ? 'font-bold text-warn' : 'text-muted'">{{ value }}</span>
              </template>
            </UiDataTable>
            <div class="px-4 pb-3">
              <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
            </div>
          </template>
        </UiSectionCard>
      </template>
    </div>
  </div>
</template>
