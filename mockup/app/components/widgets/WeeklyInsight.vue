<script setup lang="ts">
/**
 * 週次 AI インサイト（バッチ7g・オペレーター指示 2026-07-19 #9）。
 * 該当週の全登録データ（閲覧権限準拠）から、集計サマリーカード・グラフ・
 * エグゼクティブサマリー・SWOT・リスク・推奨アクションの実用レポートを表示する。
 * 週ナビゲーション付き・何度でも再生成可（保存しない = 常に最新データから生成）
 */
import { ChevronLeft, ChevronRight, Sparkles, TriangleAlert } from 'lucide-vue-next'
import type { WeeklyInsightResult } from '~/composables/useWeeklyInsight'
import { addDays, fmtDate } from '~/utils/format'

const props = defineProps<{
  /** 初期表示の週（週初め = 月曜） */
  initialWeekStart: string
}>()

const { generate } = useWeeklyInsight()
const { show } = useToast()

const weekStart = ref(props.initialWeekStart)
const result = ref<WeeklyInsightResult | null>(null)
const loading = ref(false)

const weekLabel = computed(() => `${fmtDate(weekStart.value)}〜${fmtDate(addDays(weekStart.value, 6))}`)

async function run(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    result.value = await generate(weekStart.value)
  } catch (e) {
    show(apiErrorOf(e).message, 'crit')
  } finally {
    loading.value = false
  }
}

function moveWeek(delta: number): void {
  weekStart.value = addDays(weekStart.value, delta * 7)
  result.value = null
  void run()
}

onMounted(run)

const m = computed(() => result.value?.metrics ?? null)
const insight = computed(() => result.value?.insight ?? null)

const SEVERITY_META: Record<string, { label: string; tone: 'crit' | 'warn' | 'info' }> = {
  high: { label: '高', tone: 'crit' },
  mid: { label: '中', tone: 'warn' },
  low: { label: '低', tone: 'info' },
}

const SWOT_QUADRANTS = [
  { key: 'strengths', label: 'Strengths（強み）', cls: 'border-ok/40 bg-ok-soft' },
  { key: 'weaknesses', label: 'Weaknesses（弱み）', cls: 'border-warn/40 bg-warn-soft' },
  { key: 'opportunities', label: 'Opportunities（機会）', cls: 'border-brand/40 bg-brand-soft' },
  { key: 'threats', label: 'Threats（脅威）', cls: 'border-crit/40 bg-crit-soft' },
] as const
</script>

<template>
  <div class="grid gap-3">
    <!-- 週ナビゲーション + 再生成 -->
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-sm" aria-label="前の週" @click="moveWeek(-1)">
        <ChevronLeft class="h-4 w-4" aria-hidden="true" />
      </button>
      <span class="num text-[13px] font-bold">{{ weekLabel }}</span>
      <button type="button" class="btn btn-sm" aria-label="次の週" @click="moveWeek(1)">
        <ChevronRight class="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" class="btn btn-primary btn-sm ml-auto" :disabled="loading" @click="run">
        <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
        {{ loading ? '生成中…' : result ? 'インサイトを再生成' : 'インサイトを生成' }}
      </button>
    </div>

    <UiEmptyState v-if="!result && loading" icon="Sparkles" title="週次データを集計し、インサイトを生成しています…" />

    <template v-if="m && insight">
      <!-- 集計サマリーカード -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <UiKpiCard label="日報提出" :value="`${m.reportSubmitted}件`" :sub="`提出者 ${m.reporters}/${m.membersActive} 名`" icon="FileText" />
        <UiKpiCard label="総工数" :value="`${m.totalHours}h`" :sub="`週報 ${m.weeklyCount} 件`" icon="Clock" />
        <UiKpiCard label="タスク計画" :value="m.planTotal > 0 ? `${m.planDone}/${m.planTotal}` : '—'" sub="完了/計画" icon="ClipboardList" />
        <UiKpiCard label="課題・エスカレ" :value="`${m.issues.length} / ${m.escalationRaised}`" :sub="`エスカレ解決 ${m.escalationResolved}`" icon="TriangleAlert" />
        <UiKpiCard label="稟議" :value="`${m.workflowSubmitted}件`" :sub="`承認 ${m.workflowApproved} 件`" icon="Stamp" />
        <UiKpiCard label="AI タスク完了" :value="`${m.aiTasksDone}件`" :sub="`進行中 ${m.aiTasksActive} 件`" icon="Bot" />
        <UiKpiCard label="議事録 / ポスト" :value="`${m.minutesCount} / ${m.poipoiCount}`" sub="週内の登録" icon="StickyNote" />
        <UiKpiCard
          v-if="m.salesMonthAmount !== null"
          label="当月売上"
          :value="`${(m.salesMonthAmount / 10_000).toLocaleString('ja-JP')}万円`"
          sub="売上管理より"
          icon="TrendingUp"
        />
      </div>

      <!-- グラフ -->
      <div class="grid gap-3 lg:grid-cols-2">
        <ChartsBarChartCard
          title="メンバー別工数（提出済み日報）"
          :labels="m.memberHours.map(x => x.name)"
          :series="[{ label: '工数(h)', data: m.memberHours.map(x => x.hours) }]"
          horizontal
          :y-formatter="v => `${v}h`"
        />
        <ChartsBarChartCard
          title="業務テーマ別工数"
          :labels="m.themeHours.map(x => x.theme)"
          :series="[{ label: '工数(h)', data: m.themeHours.map(x => x.hours) }]"
          horizontal
          :y-formatter="v => `${v}h`"
        />
        <ChartsLineChartCard
          title="日別の日報提出数"
          :labels="m.dailySubmissions.map(x => x.date.slice(5))"
          :series="[{ label: '提出数', data: m.dailySubmissions.map(x => x.count) }]"
          class="lg:col-span-2"
        />
      </div>

      <!-- エグゼクティブサマリー -->
      <UiSectionCard
        title="エグゼクティブサマリー"
        :description="result?.llm ? 'Vertex AI による生成（集計値に基づく）' : '集計値からの自動生成（AI 無効環境のため決定的レポート）'"
      >
        <UiMarkdown :source="insight.executiveSummary" />
      </UiSectionCard>

      <!-- SWOT -->
      <UiSectionCard title="SWOT 分析">
        <div class="grid gap-2 sm:grid-cols-2">
          <div
            v-for="q in SWOT_QUADRANTS"
            :key="q.key"
            class="rounded-lg border p-3"
            :class="q.cls"
          >
            <p class="mb-1 text-[11px] font-bold">{{ q.label }}</p>
            <p v-if="insight.swot[q.key].length === 0" class="text-[12px] text-muted">特記事項なし</p>
            <ul v-else class="grid list-disc gap-0.5 pl-4 text-[13px]">
              <li v-for="(item, i) in insight.swot[q.key]" :key="i">{{ item }}</li>
            </ul>
          </div>
        </div>
      </UiSectionCard>

      <!-- リスク -->
      <UiSectionCard title="リスク" flush>
        <p v-if="insight.risks.length === 0" class="px-4 py-3 text-[13px] text-muted">検知されたリスクはありません</p>
        <ul v-else class="divide-y divide-line">
          <li v-for="(r, i) in insight.risks" :key="i" class="flex flex-wrap items-start gap-2 px-4 py-2.5">
            <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" :class="`text-${SEVERITY_META[r.severity]?.tone ?? 'warn'}`" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-2">
                <span class="text-[13px] font-bold">{{ r.title }}</span>
                <UiStatusBadge :label="`重要度 ${SEVERITY_META[r.severity]?.label ?? '中'}`" :tone="SEVERITY_META[r.severity]?.tone ?? 'warn'" />
              </span>
              <span class="mt-0.5 block text-[12px] text-sub">対応: {{ r.mitigation }}</span>
            </span>
          </li>
        </ul>
      </UiSectionCard>

      <!-- 推奨アクション + 課題明細 -->
      <div class="grid gap-3 lg:grid-cols-2">
        <UiSectionCard title="推奨アクション">
          <ol class="grid list-decimal gap-1 pl-5 text-[13px]">
            <li v-for="(a, i) in insight.actions" :key="i">{{ a }}</li>
          </ol>
        </UiSectionCard>
        <UiSectionCard title="今週の課題報告（日報より）" flush>
          <p v-if="m.issues.length === 0" class="px-4 py-3 text-[13px] text-muted">課題報告はありません</p>
          <ul v-else class="divide-y divide-line">
            <li v-for="(iss, i) in m.issues" :key="i" class="px-4 py-2 text-[13px]">
              <span class="font-semibold">{{ iss.member }}:</span>
              <span class="text-sub">{{ iss.issue }}</span>
            </li>
          </ul>
        </UiSectionCard>
      </div>
    </template>
  </div>
</template>
