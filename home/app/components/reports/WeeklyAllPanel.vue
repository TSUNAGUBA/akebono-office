<script setup lang="ts">
/**
 * 全員の週報パネル（一覧 + 週次 AI インサイトのサブタブ）。
 * 改修依頼 2026-08-20 第2バッチ: 週報のトップレベル独立（/weekly-report）に伴い
 * reports.vue のインライン実装から移設（実装の移動が主・挙動は不変）。
 * - 参照権限 = 権限表「日報・週報の参照対象」（F-16-6）に従う（useReports 側で適用済み）
 * - 既読/未読の可視化（開くと既読・「未読に戻す」= ReportsWeeklyDetailDrawer）
 */
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import type { WeeklyReport } from '~/types/domain'
import { REPORT_STATUS_LABELS } from '~/composables/useReports'
import { addDays, todayJst } from '~/utils/format'
import { matchesMemberFilter, memberFilterOptionsOf } from '~/utils/report-filters'
import { weekRangeLabel } from '~/utils/report-weeks'

const reports = useReports()
const { currentUserId } = useCurrentUser()
const { tbl } = useMockDb()
const members = tbl('members')
const { options: deptOptions } = useDepartments()

const memberFilterOptions = computed(() => memberFilterOptionsOf(members.value))

/** サブビュー（一覧 / 週次 AI インサイト = バッチ7g。インサイトは全登録データ横断のため本タブに置く） */
const weeklyAllView = ref('list')
const WEEKLY_ALL_VIEW_TABS = [
  { key: 'list', label: '全員の週報' },
  { key: 'insight', label: 'AI インサイト' },
]

const selAllWeekStart = ref(reports.weekStartOf(todayJst()))
const isAllThisWeek = computed(() => selAllWeekStart.value === reports.weekStartOf(todayJst()))

function moveAllWeeklyWeek(delta: number): void {
  selAllWeekStart.value = addDays(selAllWeekStart.value, delta * 7)
}

const waDeptId = ref('')
const waMemberId = ref('')

const allWeeklies = computed(() =>
  reports.allSubmittedWeeklies(selAllWeekStart.value)
    .filter(r => matchesMemberFilter(members.value, r.memberId, waDeptId.value, waMemberId.value)))

/** 一覧プレビュー用の抜粋（改行・連続空白を 1 スペースへ畳んで先頭 max 文字。超過は … を付す） */
function excerpt(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

/**
 * 全員の週報一覧の行プレビュー項目（改修4）。本文がある主要項目のラベル + 抜粋のみを返す。
 * 全文は行クリックの週報詳細ドロワーで確認できる（一覧は要点のみ・過度に大きくしない）。
 */
function weeklyPreviewItems(w: WeeklyReport): { label: string; text: string }[] {
  return [
    { label: '今週の成果', text: excerpt(w.goalReview) },
    { label: '主要業務', text: excerpt(w.mainWork) },
    { label: '課題', text: excerpt(w.issues) },
  ].filter(it => it.text)
}

// ---- 既読/未読の可視化（週報。日報と同じ扱い = 自分の週報は対象外） ----

function isWeeklyUnread(w: WeeklyReport): boolean {
  return w.memberId !== currentUserId.value && !reports.isReportRead('weekly', w.id)
}

// 既定 = 未読のみに統一（通知・日報のデフォルト表示を未読のみに揃える。オペレーター指示）
const waUnreadOnly = ref(true)
const waUnreadCount = computed(() => allWeeklies.value.filter(isWeeklyUnread).length)
const visibleWeeklies = computed(() =>
  waUnreadOnly.value ? allWeeklies.value.filter(isWeeklyUnread) : allWeeklies.value)

// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング。絞り込みは visibleWeeklies が担う）
const { page: waPage, pageSize: waPageSize, rows: pagedWeeklies, total: waTotal } = useListView<WeeklyReport>({ source: visibleWeeklies })
watch([weeklyAllView, selAllWeekStart, waDeptId, waMemberId, waUnreadOnly], () => { waPage.value = 1 })

/** 週報詳細ドロワー（表示・既読・未読取消は ReportsWeeklyDetailDrawer） */
const weeklyDrawerId = ref<string | null>(null)
</script>

<template>
  <div class="grid gap-3">
    <UiTabBar v-model="weeklyAllView" :tabs="WEEKLY_ALL_VIEW_TABS" />

    <!-- 週次 AI インサイト（該当週の全登録データから経営・営業・チーム視点のレポート = バッチ7g） -->
    <WidgetsWeeklyInsight v-if="weeklyAllView === 'insight'" :initial-week-start="selAllWeekStart" />

    <template v-else>
      <UiFilterBar>
        <div class="flex items-center gap-1.5">
          <button type="button" class="btn btn-sm" aria-label="前の週へ" @click="moveAllWeeklyWeek(-1)">
            <ChevronLeft class="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" class="btn btn-sm" :disabled="isAllThisWeek" @click="selAllWeekStart = reports.weekStartOf(todayJst())">今週</button>
          <button type="button" class="btn btn-sm" aria-label="次の週へ" @click="moveAllWeeklyWeek(1)">
            <ChevronRight class="h-4 w-4" aria-hidden="true" />
          </button>
          <span class="num ml-1 whitespace-nowrap text-xs font-semibold">{{ weekRangeLabel(selAllWeekStart) }}</span>
          <UiStatusBadge v-if="isAllThisWeek" label="今週" tone="brand" />
        </div>
        <UiSelect v-model="waDeptId" :options="deptOptions" empty-label="すべての部署" aria-label="部署で絞り込み" />
        <UiSelect v-model="waMemberId" :options="memberFilterOptions" empty-label="すべてのメンバー" aria-label="メンバーで絞り込み" />
        <button
          type="button"
          class="btn btn-sm"
          :class="waUnreadOnly ? 'btn-primary' : ''"
          :aria-pressed="waUnreadOnly"
          @click="waUnreadOnly = !waUnreadOnly"
        >
          未読のみ
        </button>
        <template #trailing>
          <UiStatusBadge v-if="waUnreadCount > 0" tone="brand" :label="`未読 ${waUnreadCount} 件`" dot />
          <span class="num text-xs text-muted">{{ allWeeklies.length }} 件</span>
        </template>
      </UiFilterBar>

      <UiSectionCard
        title="全員の週報"
        description="選択した週の提出済み週報。開くと既読になります。参照できる範囲は権限設定（日報・週報の参照対象）に従います"
        flush
      >
        <UiEmptyState
          v-if="visibleWeeklies.length === 0"
          :title="waUnreadOnly ? '未読の週報はありません' : 'この週の提出済み週報がありません'"
          :hint="waUnreadOnly ? 'すべて既読です（「未読のみ」を解除すると全件表示されます）' : '「自分の週報」から提出すると、ここに表示されます（絞り込み条件も確認してください）'"
        />
        <ul v-else class="divide-y divide-line">
          <li v-for="w in pagedWeeklies" :key="w.id">
            <!-- 行クリックで週報詳細ドロワー（全項目）を開く。一覧は週レンジ + 主要項目のプレビュー
                 （成果・主要業務・課題の抜粋。モバイルでも崩れないカード風リスト）= 改修4 -->
            <button
              type="button"
              class="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
              @click="weeklyDrawerId = w.id"
            >
              <UiAvatar :name="reports.memberName(w.memberId)" size="sm" />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-1.5">
                  <span class="text-[13px] font-bold">{{ reports.memberName(w.memberId) }}</span>
                  <span class="num text-[11px] text-muted">{{ weekRangeLabel(w.weekStart) }}</span>
                  <UiStatusBadge v-if="isWeeklyUnread(w)" tone="brand" label="未読" dot />
                </span>
                <span v-if="weeklyPreviewItems(w).length > 0" class="mt-1 grid gap-1">
                  <span v-for="it in weeklyPreviewItems(w)" :key="it.label" class="grid gap-0.5">
                    <span class="text-[10px] font-bold text-muted">{{ it.label }}</span>
                    <span class="line-clamp-2 text-xs text-sub">{{ it.text }}</span>
                  </span>
                </span>
                <span v-else class="mt-1 block text-xs text-muted">（本文の記載がありません）</span>
                <span class="mt-1.5 block text-[10px] text-muted">タップで全項目を表示</span>
              </span>
              <UiStatusBadge tone="ok" :label="REPORT_STATUS_LABELS.submitted" dot class="shrink-0" />
            </button>
          </li>
        </ul>
        <UiPagination v-model:page="waPage" v-model:page-size="waPageSize" :total="waTotal" />
      </UiSectionCard>
    </template>

    <!-- 週報詳細ドロワー（全員の週報の行から） -->
    <ReportsWeeklyDetailDrawer :report-id="weeklyDrawerId" @close="weeklyDrawerId = null" />
  </div>
</template>
