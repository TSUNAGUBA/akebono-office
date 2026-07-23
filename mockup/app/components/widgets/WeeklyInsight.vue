<script setup lang="ts">
/**
 * 週次 AI インサイト（バッチ7g → バッチ7j・オペレーター指示 2026-07-19 #9/#12）。
 * - 一度生成したら保管し、再生成されるまでは保存済みの結果を表示する（週ナビは保存済みを読むだけ）
 * - 集計は「前日（asOf）まで」基準（日報は前日分までが正常な運用）
 * - 全体共通（サマリーカード・グラフ・エグゼクティブサマリー・SWOT・リスク・アクション）と
 *   個別ユーザー向け（ロール・役職・所属部署に最適化した要点・アクション)を分けて表示する
 */
import { ChevronLeft, ChevronRight, Sparkles, TriangleAlert, UserRound } from 'lucide-vue-next'
import type { WeeklyInsightBundle } from '~/composables/useWeeklyInsight'
import { addDays, fmtDate, fmtDateTime } from '~/utils/format'

const props = defineProps<{
  /** 初期表示の週（週初め = 月曜） */
  initialWeekStart: string
}>()

const { load, generate } = useWeeklyInsight()
const { show } = useToast()

const weekStart = ref(props.initialWeekStart)
const bundle = ref<WeeklyInsightBundle | null>(null)
const loading = ref(false)
const generating = ref(false)

const weekLabel = computed(() => `${fmtDate(weekStart.value)}〜${fmtDate(addDays(weekStart.value, 6))}`)

// 世代トークン: ロード中の週移動で古いレスポンスが新しい週のラベルに表示されるのを防ぐ
let runSeq = 0
async function loadStored(): Promise<void> {
  const seq = ++runSeq
  loading.value = true
  try {
    const r = await load(weekStart.value)
    if (seq !== runSeq) return
    bundle.value = r
  } catch (e) {
    if (seq === runSeq) show(apiErrorOf(e).message, 'crit')
  } finally {
    if (seq === runSeq) loading.value = false
  }
}

async function regenerate(): Promise<void> {
  if (generating.value) return
  const seq = ++runSeq
  generating.value = true
  try {
    const r = await generate(weekStart.value)
    if (seq !== runSeq) return
    bundle.value = r
    show('週次インサイトを生成し、保存しました（再生成するまでこの内容が表示されます）')
  } catch (e) {
    if (seq === runSeq) show(apiErrorOf(e).message, 'crit')
  } finally {
    // 自操作のフラグは無条件で戻す（PR #59 R1 M-1: 週送りで先取りされたとき
    // 「生成中…」のままボタンが永久に無効化されるデッドエンドの防止）
    generating.value = false
  }
}

function moveWeek(delta: number): void {
  weekStart.value = addDays(weekStart.value, delta * 7)
  bundle.value = null
  void loadStored()
}

onMounted(loadStored)

const company = computed(() => bundle.value?.company ?? null)
const personal = computed(() => bundle.value?.personal ?? null)
const m = computed(() => company.value?.metrics ?? null)
const insight = computed(() => company.value?.insight ?? null)

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
    <!-- 週ナビゲーション + 生成/再生成 -->
    <div class="flex flex-wrap items-center gap-2">
      <!-- 生成中は週送りも無効化（保存対象の週が生成中に変わる誤操作の防止 = R1 M-1） -->
      <button type="button" class="btn btn-sm" :disabled="generating" aria-label="前の週" @click="moveWeek(-1)">
        <ChevronLeft class="h-4 w-4" aria-hidden="true" />
      </button>
      <span class="num text-[13px] font-bold">{{ weekLabel }}</span>
      <button type="button" class="btn btn-sm" :disabled="generating" aria-label="次の週" @click="moveWeek(1)">
        <ChevronRight class="h-4 w-4" aria-hidden="true" />
      </button>
      <span v-if="company" class="text-[11px] text-muted">
        生成 {{ fmtDateTime(company.generatedAt) }}{{ company.generatedByName ? `（${company.generatedByName}）` : '' }}
      </span>
      <button
        type="button"
        class="btn btn-primary btn-sm ml-auto"
        :disabled="generating || loading"
        @click="regenerate"
      >
        <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
        {{ generating ? '生成中…' : company ? 'インサイトを再生成' : 'インサイトを生成' }}
      </button>
    </div>

    <UiEmptyState v-if="loading && !bundle" icon="Sparkles" title="保存済みのインサイトを読み込んでいます…" />
    <UiEmptyState
      v-else-if="!loading && !company"
      icon="Sparkles"
      title="この週のインサイトはまだ生成されていません"
      hint="「インサイトを生成」を押すと、該当週の全登録データ（前日分まで基準）から全体とあなた向けのレポートを生成・保存します"
    />

    <template v-if="m && insight">
      <p class="text-[11px] text-muted">
        集計は前日（{{ fmtDate(m.asOf) }}）分まで・経過営業日 {{ m.businessDaysElapsed }} 日基準。日報は前日分までが正常な運用のため、当日分は未提出として扱いません
      </p>

      <!-- あなた向けインサイト（個別 = ロール・役職・所属に最適化。バッチ7j） -->
      <UiSectionCard
        v-if="personal"
        title="あなた向けインサイト"
        :description="`${personal.metrics.memberName} さん向け（${[personal.metrics.department, personal.metrics.title].filter(Boolean).join(' / ') || 'ロール: ' + personal.metrics.role}）。${personal.llm ? 'Vertex AI による生成' : '集計値からの自動生成'}`"
      >
        <div class="grid gap-3">
          <p class="flex items-start gap-2 text-[13px]">
            <UserRound class="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
            <span>{{ personal.insight.summary }}</span>
          </p>
          <div class="grid gap-3 md:grid-cols-2">
            <div>
              <p class="label">今週の注目ポイント</p>
              <ul class="grid list-disc gap-0.5 pl-4 text-[13px]">
                <li v-for="(f, i) in personal.insight.focus" :key="i">{{ f }}</li>
              </ul>
            </div>
            <div>
              <p class="label">あなたへの推奨アクション</p>
              <ol class="grid list-decimal gap-0.5 pl-5 text-[13px]">
                <li v-for="(a, i) in personal.insight.actions" :key="i">{{ a }}</li>
              </ol>
            </div>
          </div>
        </div>
      </UiSectionCard>

      <!-- 全体共通: 集計サマリーカード -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <UiKpiCard label="日報提出（前日まで）" :value="`${m.reportSubmitted}件`" :sub="`提出者 ${m.reporters}/${m.membersActive} 名`" icon="FileText" />
        <UiKpiCard label="総時間" :value="`${m.totalHours}h`" :sub="`週報 ${m.weeklyCount} 件`" icon="Clock" />
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
          title="メンバー別時間（提出済み日報）"
          :labels="m.memberHours.map(x => x.name)"
          :series="[{ label: '時間(h)', data: m.memberHours.map(x => x.hours) }]"
          horizontal
          :y-formatter="v => `${v}h`"
        />
        <ChartsBarChartCard
          title="テーマ別時間"
          :labels="m.themeHours.map(x => x.theme)"
          :series="[{ label: '時間(h)', data: m.themeHours.map(x => x.hours) }]"
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

      <!-- エグゼクティブサマリー（全体共通 = 個人名・売上の言及なしで生成） -->
      <UiSectionCard
        title="エグゼクティブサマリー（全体）"
        :description="company?.llm ? 'Vertex AI による生成（集計値に基づく）' : '集計値からの自動生成（AI 無効環境のため決定的レポート）'"
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
        <UiSectionCard title="推奨アクション（全体）">
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
