<script setup lang="ts">
/**
 * 週報提出状況の「メンバー × 週」マトリクス（改修要望: 直近 4/8/12 週をまとめて確認）。
 * - 週列 = 昇順（左 = 古い週 → 右端 = 今週。列ヘッダーは M/D週 表記 + 今週列に「今週」注記）。
 *   週列生成の SoT = utils/report-weeks.ts recentWeekStarts
 * - 行 = チームタブと同じ対象メンバー（表示メンバー設定 ∩ 参照権限 = useReports.teamMembers・名前順）
 * - セル = 提出済（済）/ 下書き（自分のみ・下書き）/ 未提出（未）。色 + ラベル併記（色のみ判別の禁止 = 規約10）
 * - 提出済セルはクリックで週報詳細ドロワー（他人の週報は開くと既読 = PeriodPanel と同じ挙動）
 * - 集計 = 各行末に「x/N 週」・各週列フッターに「提出 x/y」
 * - モバイル: コンテナ内横スクロール + メンバー名列 sticky left + セル 44px タッチターゲット
 *   （375px でページ全体は横に溢れない = 原則8）
 */
import type { WeeklyReport } from '~/types/domain'
import { REPORT_STATUS_LABELS } from '~/composables/useReports'
import { fmtDate, todayJst } from '~/utils/format'
import { recentWeekStarts, weekRangeLabel } from '~/utils/report-weeks'

const reports = useReports()
const { currentUserId } = useCurrentUser()
const { show } = useToast()

// ---------- 表示範囲（直近 4/8/12 週。既定 = 4 週） ----------

const WEEK_RANGE_OPTIONS = [
  { value: '4', label: '直近4週' },
  { value: '8', label: '直近8週' },
  { value: '12', label: '直近12週' },
]
const weeksKey = ref('4')
const weekStarts = computed(() => recentWeekStarts(todayJst(), Number(weeksKey.value)))
const currentWeekStart = computed(() => weekStarts.value[weekStarts.value.length - 1] ?? '')

/** 列ヘッダーのラベル（M/D週 = 週初め月曜の日付） */
function weekHeadLabel(weekStart: string): string {
  return `${fmtDate(weekStart)}週`
}

// ---------- マトリクス（行 = メンバー / 列 = 週） ----------

type CellStatus = 'submitted' | 'draft' | 'none'
interface MatrixCell {
  weekStart: string
  cell: CellStatus
  report: WeeklyReport | undefined
}

/** 対象メンバー（日報チームタブと同じ可視ルール。名前順は useReports 側の既存順序のまま） */
const roster = computed(() => reports.teamMembers.value)

/** 週ごとの提出済み週報 Map + 自分の週報（下書き含む）。allSubmittedWeeklies が API の遅延ロードも担う */
const byWeek = computed(() =>
  weekStarts.value.map(ws => ({
    ws,
    submitted: new Map(reports.allSubmittedWeeklies(ws).map(r => [r.memberId, r])),
    mine: reports.myWeeklyOn(ws),
  })))

const rows = computed(() =>
  roster.value.map((m) => {
    const own = m.id === currentUserId.value
    const cells: MatrixCell[] = byWeek.value.map(({ ws, submitted, mine }) => {
      // 自分の行のみ下書きも見せる（他人の下書きは内容・存在とも見せない = PeriodPanel と同じ基準）
      const rep = own ? mine : submitted.get(m.id)
      const cell: CellStatus = rep ? (rep.status === 'submitted' ? 'submitted' : 'draft') : 'none'
      return { weekStart: ws, cell, report: rep }
    })
    return { member: m, own, cells, submittedCount: cells.filter(c => c.cell === 'submitted').length }
  }))

/** 週列ごとの提出数（フッター「提出 x/y」） */
const weekTotals = computed(() =>
  weekStarts.value.map((_, i) => rows.value.filter(r => r.cells[i]?.cell === 'submitted').length))

const CELL_LABELS: Record<CellStatus, string> = { submitted: '済', draft: '下書き', none: '未' }
const CELL_CLASSES: Record<CellStatus, string> = {
  submitted: 'bg-ok-soft text-ok',
  draft: 'bg-warn-soft text-warn',
  none: 'bg-surface-soft text-muted',
}

function cellAria(memberName: string, c: MatrixCell): string {
  const status = c.cell === 'submitted'
    ? REPORT_STATUS_LABELS.submitted
    : c.cell === 'draft' ? REPORT_STATUS_LABELS.draft : '未提出'
  return `${memberName}: ${weekHeadLabel(c.weekStart)}（${weekRangeLabel(c.weekStart)}）${status}`
    + (c.cell === 'submitted' ? '。クリックで内容を表示' : '')
}

// ---------- 詳細ドロワー（提出済セル → 週報の内容） ----------

const drawerId = ref<string | null>(null)
const drawerReport = computed<WeeklyReport | null>(() =>
  drawerId.value ? reports.weeklyById(drawerId.value) ?? null : null)

function openCell(c: MatrixCell): void {
  if (!c.report || c.cell !== 'submitted') return
  drawerId.value = c.report.id
  // 他人の提出済み週報は開いた時点で既読（PeriodPanel と同じ挙動。失敗は非ブロッキング）
  if (c.report.memberId !== currentUserId.value) void reports.markReportRead('weekly', c.report.id)
}

/** 未読に戻す（自動既読の取消フロー = 原則9.5・レビュー R1） */
async function onMarkUnread(): Promise<void> {
  const r = drawerReport.value
  if (!r) return
  const res = await reports.markReportUnread('weekly', r.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  drawerId.value = null
  show('未読に戻しました')
}

const drawerItems = computed(() => (drawerReport.value
  ? [
      { label: '今週の成果・達成感', text: drawerReport.value.goalReview },
      { label: '今週の主要業務', text: drawerReport.value.mainWork },
      { label: '今週の課題・原因仮説', text: drawerReport.value.issues },
      { label: '今週うまくいったこと・続けたいこと', text: drawerReport.value.goodPoints ?? '' },
      { label: '来週の最重要テーマ（最大3つ）', text: drawerReport.value.nextWeek },
    ]
  : []))
</script>

<template>
  <div class="grid gap-3">
    <UiSectionCard
      title="チームの週報提出状況（複数週）"
      :description="`直近${weeksKey}週の提出状況を「メンバー × 週」で一覧します。列は左が古い週・右端が今週です。「済」のセルはタップで内容を確認できます`"
    >
      <!-- 表示範囲はヘッダーではなく本文先頭（375px でタイトルと取り合わない = 原則8） -->
      <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <UiChipTabs v-model="weeksKey" :options="WEEK_RANGE_OPTIONS" aria-label="表示範囲（直近の週数）" />
        <span class="num text-xs text-muted">対象 {{ roster.length }} 名</span>
      </div>

      <UiEmptyState v-if="roster.length === 0" title="対象メンバーがいません" hint="表示メンバー設定・参照権限をご確認ください" />
      <template v-else>
        <div class="overflow-x-auto scroll-slim">
          <table class="tbl min-w-max" aria-label="週報提出状況（メンバー × 週）">
            <thead>
              <tr>
                <th scope="col" class="sticky left-0 z-10 bg-surface">メンバー</th>
                <th v-for="ws in weekStarts" :key="ws" scope="col" class="!text-center whitespace-nowrap">
                  <span class="num block">{{ weekHeadLabel(ws) }}</span>
                  <UiStatusBadge v-if="ws === currentWeekStart" label="今週" tone="brand" />
                </th>
                <th scope="col" class="!text-right whitespace-nowrap">提出数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.member.id">
                <th scope="row" class="sticky left-0 z-10 bg-surface text-left font-normal">
                  <span class="flex items-center gap-2 py-0.5">
                    <UiAvatar :name="r.member.name" size="sm" />
                    <span class="whitespace-nowrap text-[13px] font-semibold">
                      {{ r.member.name }}<span v-if="r.own" class="ml-1 text-[11px] font-normal text-muted">（自分）</span>
                    </span>
                  </span>
                </th>
                <td v-for="c in r.cells" :key="c.weekStart" class="!px-1 text-center">
                  <button
                    v-if="c.cell === 'submitted'"
                    type="button"
                    class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-1 text-xs font-bold transition-opacity hover:opacity-75"
                    :class="CELL_CLASSES.submitted"
                    :aria-label="cellAria(r.member.name, c)"
                    @click="openCell(c)"
                  >{{ CELL_LABELS.submitted }}</button>
                  <template v-else>
                    <span
                      class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-1 text-xs font-semibold"
                      :class="CELL_CLASSES[c.cell]"
                      aria-hidden="true"
                    >{{ CELL_LABELS[c.cell] }}</span>
                    <span class="sr-only">{{ cellAria(r.member.name, c) }}</span>
                  </template>
                </td>
                <td
                  class="num !text-right whitespace-nowrap text-xs"
                  :aria-label="`${r.member.name}: ${r.submittedCount}/${weekStarts.length} 週提出`"
                >{{ r.submittedCount }}/{{ weekStarts.length }} 週</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" class="sticky left-0 z-10 bg-surface text-left text-[11px] font-semibold text-muted">提出 / 対象</th>
                <td
                  v-for="(n, i) in weekTotals"
                  :key="weekStarts[i] ?? i"
                  class="num !text-center text-xs font-semibold"
                  :aria-label="`${weekHeadLabel(weekStarts[i] ?? '')}: 提出 ${n}/${rows.length} 名`"
                >{{ n }}/{{ rows.length }}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- 凡例（色 + ラベルの対応。色のみ判別の禁止 = 規約10） -->
        <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-sub">
          <span class="flex items-center gap-1.5">
            <span class="inline-flex h-5 w-8 items-center justify-center rounded bg-ok-soft text-[10px] font-bold text-ok" aria-hidden="true">済</span>
            {{ REPORT_STATUS_LABELS.submitted }}（タップで内容表示）
          </span>
          <span class="flex items-center gap-1.5">
            <span class="inline-flex h-5 w-10 items-center justify-center rounded bg-warn-soft text-[10px] font-bold text-warn" aria-hidden="true">下書き</span>
            {{ REPORT_STATUS_LABELS.draft }}（自分のみ表示）
          </span>
          <span class="flex items-center gap-1.5">
            <span class="inline-flex h-5 w-8 items-center justify-center rounded bg-surface-soft text-[10px] font-bold text-muted" aria-hidden="true">未</span>
            未提出
          </span>
        </div>
      </template>
    </UiSectionCard>

    <!-- 週報詳細ドロワー（提出済セルの内容確認） -->
    <UiDrawer
      :open="!!drawerReport"
      :title="drawerReport ? `${reports.memberName(drawerReport.memberId)} の週報` : '週報'"
      width="560px"
      @close="drawerId = null"
    >
      <div v-if="drawerReport" class="grid gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <UiAvatar :name="reports.memberName(drawerReport.memberId)" size="sm" />
          <span class="num text-[13px] font-semibold">{{ weekRangeLabel(drawerReport.weekStart) }} の週</span>
          <UiStatusBadge
            :tone="drawerReport.status === 'submitted' ? 'ok' : 'warn'"
            :label="REPORT_STATUS_LABELS[drawerReport.status]"
            dot
          />
        </div>
        <div v-for="it in drawerItems" :key="it.label">
          <p class="label">{{ it.label }}</p>
          <UiMarkdown v-if="it.text" :source="it.text" />
          <p v-else class="text-[13px]">—</p>
        </div>
        <!-- 自動既読の取消（他メンバーの提出済みのみ。原則9.5・レビュー R1） -->
        <div v-if="drawerReport.memberId !== currentUserId" class="flex justify-end border-t border-line pt-2">
          <button type="button" class="btn btn-ghost btn-sm" @click="onMarkUnread">未読に戻す</button>
        </div>
      </div>
    </UiDrawer>
  </div>
</template>
