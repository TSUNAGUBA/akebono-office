<script setup lang="ts">
/**
 * AI週次レポート詳細（/media/reports/:id。改善要望 2026-08-21・F-55）。
 * 1｜エグゼクティブサマリー 2｜重要な変化 3｜AIによる原因仮説 4｜コンテンツ評価 5｜AI推奨アクション の構成。
 * 推奨アクションは「実行する / 継続検討 / 対象外」を選んで記録し、「実行する」は改善施策として起票される
 * （改善施策一覧 /media/measures から参照・二重起票はしない = 冪等）。
 */
import { ArrowLeft, ClipboardCheck, TrendingDown, TrendingUp } from 'lucide-vue-next'
import {
  MEDIA_REPORT_DECISIONS, weeklyReportCounts,
  type MediaReportDecision, type MediaWeeklyReport,
} from '../../../../../shared/domain/media-weekly-report'
import { MEDIA_REPORT_DECISION_TONES } from '~/composables/useMediaReports'
import { PRIORITY_LABELS, priorityTone } from '~/utils/media'
import { fmtDate, fmtDateTime } from '~/utils/format'
import type { Member } from '~/types/domain'
import type { TableColumn } from '~/types/ui'

const route = useRoute()
const mr = useMediaReports()
const { tbl } = useMockDb()
const { show } = useToast()

const reportId = computed(() => String(route.params.id ?? ''))
const fetched = ref<MediaWeeklyReport | null>(null)
const loading = ref(true)

// 一覧キャッシュ優先（判断の反映が即時に見える）。未ロード時は単件フェッチで補完
const report = computed<MediaWeeklyReport | null>(() => mr.reportById(reportId.value) ?? fetched.value)
const counts = computed(() => (report.value ? weeklyReportCounts(report.value.content) : null))

watchEffect(async () => {
  const id = reportId.value
  if (!id) return
  loading.value = true
  fetched.value = await mr.fetchReport(id)
  loading.value = false
})

function memberName(id?: string | null): string {
  return id ? ((tbl('members').value as Member[]).find(m => m.id === id)?.name ?? id) : ''
}

const deciding = ref<number | null>(null)

async function decide(index: number, decision: MediaReportDecision): Promise<void> {
  if (deciding.value !== null || !report.value) return
  const prevDecision = report.value.content.actions[index]?.decision
  if (prevDecision === decision) return // 同じ判断の再選択は no-op（判断者・日時を無用に上書きしない）
  deciding.value = index
  try {
    const res = await mr.decideAction(report.value.id, index, decision)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    if (decision === '実行する') {
      // 起票済み（過去に実行する → 取消済み含む）は二重起票しないため文言を出し分ける（レビュー R1 M-7）
      show(res.measureCreated
        ? '「実行する」を記録し、改善施策として起票しました'
        : '「実行する」を記録しました（この推奨アクションの改善施策は起票済みです。取消済みの場合は一覧から復元できます）',
      'ok', { label: '改善施策一覧', to: '/media/measures' })
    } else if (prevDecision === '実行する') {
      show(`「${decision}」へ変更しました（起票済みの改善施策は残ります。不要な場合は改善施策一覧から取り消せます）`)
    } else {
      show(`「${decision}」を記録しました`)
    }
    // 単件フェッチ分も最新化（API モードで fetched を表示しているケース）
    fetched.value = await mr.fetchReport(report.value.id)
  } finally { deciding.value = null }
}

const ratingCols: TableColumn[] = [
  { key: 'title', label: 'テーマ（記事）', primary: true },
  { key: 'traffic', label: '集客', align: 'center' },
  { key: 'growth', label: '成長', align: 'center', primary: true },
  { key: 'cv', label: 'CV貢献', align: 'center' },
  { key: 'comment', label: 'AI評価' },
]
const ratingRows = computed(() => (report.value?.content.ratings ?? []).map(r => ({
  title: r.title, traffic: r.traffic, growth: r.growth, cv: r.cv, comment: r.comment,
})))
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <UiPageHeader
      :title="report ? `${fmtDate(report.periodFrom)}〜${fmtDate(report.periodTo)} AI週次分析` : 'AI週次レポート'"
      :description="report ? `生成 ${fmtDateTime(report.generatedAt)}・${report.llm ? 'LLM 生成' : '集計値からの自動生成'}` : ''"
    >
      <template #actions>
        <NuxtLink to="/media/reports" class="btn btn-sm">
          <ArrowLeft class="h-3.5 w-3.5" aria-hidden="true" />
          レポート一覧へ
        </NuxtLink>
      </template>
    </UiPageHeader>

    <UiEmptyState
      v-if="!report && !loading"
      icon="FileChartColumn"
      title="レポートが見つかりません"
      hint="取り消されたか、URL が正しくない可能性があります"
    >
      <template #action>
        <NuxtLink to="/media/reports" class="btn btn-primary btn-sm">レポート一覧へ戻る</NuxtLink>
      </template>
    </UiEmptyState>
    <p v-else-if="!report" class="py-10 text-center text-[13px] text-muted" aria-live="polite" aria-busy="true">
      レポートを読み込み中…
    </p>

    <div v-else class="grid gap-4">
      <!-- サマリーバッジ -->
      <div v-if="counts" class="num flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <span>重要変化：<span class="font-bold">{{ counts.changes }}</span> 件</span>
        <span>推奨アクション：<span class="font-bold">{{ counts.actions }}</span> 件</span>
        <span :class="counts.undecided > 0 ? 'text-warn' : ''">未判断：<span class="font-bold">{{ counts.undecided }}</span> 件</span>
      </div>

      <!-- 1｜エグゼクティブサマリー -->
      <UiSectionCard title="1｜エグゼクティブサマリー">
        <ul class="grid list-disc gap-1 pl-4 text-[13px]">
          <li v-for="(s, i) in report.content.executiveSummary" :key="i">{{ s }}</li>
        </ul>
      </UiSectionCard>

      <!-- 2｜重要な変化 -->
      <UiSectionCard title="2｜重要な変化" description="前週比・記事トレンドから検知した伸長・低下">
        <p v-if="report.content.changes.length === 0" class="text-[12px] text-muted">大きな変化は検知されていません</p>
        <div v-else class="grid gap-3 sm:grid-cols-2">
          <div>
            <p class="label mb-1 flex items-center gap-1"><TrendingUp class="h-3.5 w-3.5 text-ok" aria-hidden="true" />伸長</p>
            <ul class="grid gap-1.5">
              <li v-for="(c, i) in report.content.changes.filter(x => x.direction === 'up')" :key="i" class="rounded-lg border border-ok/40 bg-ok-soft px-2.5 py-1.5 text-[12px]">
                <span class="font-semibold">{{ c.label }}</span>
                <span class="num ml-1 font-bold text-ok">{{ c.value }}</span>
                <span class="mt-0.5 block text-[11px] text-sub">{{ c.detail }}</span>
              </li>
            </ul>
          </div>
          <div>
            <p class="label mb-1 flex items-center gap-1"><TrendingDown class="h-3.5 w-3.5 text-crit" aria-hidden="true" />低下</p>
            <p v-if="report.content.changes.every(x => x.direction !== 'down')" class="text-[12px] text-muted">低下項目はありません</p>
            <ul v-else class="grid gap-1.5">
              <li v-for="(c, i) in report.content.changes.filter(x => x.direction === 'down')" :key="i" class="rounded-lg border border-crit/40 bg-crit-soft px-2.5 py-1.5 text-[12px]">
                <span class="font-semibold">{{ c.label }}</span>
                <span class="num ml-1 font-bold text-crit">{{ c.value }}</span>
                <span class="mt-0.5 block text-[11px] text-sub">{{ c.detail }}</span>
              </li>
            </ul>
          </div>
        </div>
      </UiSectionCard>

      <!-- 3｜AIによる原因仮説 -->
      <UiSectionCard title="3｜AIによる原因仮説">
        <ul class="grid list-disc gap-1 pl-4 text-[13px]">
          <li v-for="(h, i) in report.content.hypotheses" :key="i">{{ h }}</li>
        </ul>
      </UiSectionCard>

      <!-- 4｜コンテンツ評価 -->
      <UiSectionCard title="4｜コンテンツ評価" description="集客（◎/○/△/×）・成長（↗/ー/↘）・CV貢献（◎/○/△/×）と AI の一言評価">
        <UiDataTable :columns="ratingCols" :rows="ratingRows" row-key="title" />
      </UiSectionCard>

      <!-- 5｜AI推奨アクション -->
      <UiSectionCard
        title="5｜AI推奨アクション"
        description="各アクションを「実行する / 継続検討 / 対象外」から判断して記録します。「実行する」は改善施策として起票されます"
      >
        <template #actions>
          <NuxtLink to="/media/measures" class="btn btn-ghost btn-sm">
            <ClipboardCheck class="h-3.5 w-3.5" aria-hidden="true" />
            改善施策一覧
          </NuxtLink>
        </template>
        <ul class="grid gap-2.5">
          <li v-for="(a, i) in report.content.actions" :key="i" class="rounded-lg border border-line p-3">
            <div class="flex flex-wrap items-center gap-2">
              <UiStatusBadge :label="`優先度 ${PRIORITY_LABELS[a.priority]}`" :tone="priorityTone(a.priority)" />
              <span class="text-[13px] font-bold">{{ a.title }}</span>
              <UiStatusBadge :label="a.decision" :tone="MEDIA_REPORT_DECISION_TONES[a.decision] ?? 'neutral'" dot class="ml-auto" />
            </div>
            <p class="mt-1 text-[12px] text-sub">理由：{{ a.reason }}</p>
            <p class="text-[12px] text-sub">期待効果：{{ a.expectedEffect }}</p>
            <!-- 未判断へ戻すことも可（判断のやり直し = 原則9.5。既に未判断のときは選択肢に出さない） -->
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                v-for="d in MEDIA_REPORT_DECISIONS.filter(x => x !== '未判断' || a.decision !== '未判断')"
                :key="d"
                type="button"
                class="rounded-full border px-3 py-1 text-[12px] transition-colors"
                :class="a.decision === d ? 'border-brand bg-brand-soft font-semibold text-brand' : 'border-line hover:bg-surface'"
                :disabled="deciding !== null"
                :aria-pressed="a.decision === d"
                @click="decide(i, d)"
              >
                {{ deciding === i ? '記録中…' : d === '未判断' ? '未判断に戻す' : d }}
              </button>
              <span v-if="a.decidedAt" class="ml-auto text-[11px] text-muted">
                {{ fmtDateTime(a.decidedAt) }}{{ memberName(a.decidedByMemberId) ? `・${memberName(a.decidedByMemberId)}` : '' }}
              </span>
            </div>
          </li>
        </ul>
      </UiSectionCard>
    </div>
  </div>
</template>
