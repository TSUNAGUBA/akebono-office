<script setup lang="ts">
/**
 * 意思決定支援（F-02）テーマ詳細
 * 3 カラム: ①意味（semantics）②関係（links）③制約と打ち手（actions。✗ は制約で潰れる）
 * 下段: 選択肢 A/B/C（AI 推奨 ★）+ 推奨理由 + シナリオスライダー（決定的予測の即時再計算）+ 判断の記録
 */
import { ArrowLeft, ArrowUpRight, Info, Link2, ListChecks, Scale, Sparkles, Star } from 'lucide-vue-next'
import type { DecisionSlot } from '~/types/domain'
import { fmtDateTime } from '~/utils/format'
import { DECISION_ACTION_META } from '~/utils/labels'

const route = useRoute()
const { themeById, logsOf, predict, record } = useDecision()
const { show } = useToast()
const { tbl } = useMockDb()
const members = tbl('members')

const theme = computed(() => themeById(String(route.params.id)))

// ---------- シナリオスライダー ----------

const params = reactive<Record<string, number>>({})
watch(theme, (t) => {
  if (!t) return
  for (const p of t.scenarioParams) {
    if (!(p.key in params)) params[p.key] = p.default
  }
}, { immediate: true })

const kpis = computed(() => (theme.value ? predict(theme.value, { ...params }) : []))

// ---------- 関係チップの info 開閉 ----------

const openLink = ref<number | null>(null)
function toggleLink(i: number): void {
  openLink.value = openLink.value === i ? null : i
}

// ---------- 判断の記録 ----------

const recordSlot = ref<DecisionSlot | null>(null)
const reason = ref('')
const reasonError = ref('')
const recordOption = computed(() =>
  theme.value?.options.find(o => o.slot === recordSlot.value))

function openRecord(slot: DecisionSlot): void {
  recordSlot.value = slot
  reason.value = ''
  reasonError.value = ''
}

function submitRecord(): void {
  if (!theme.value || !recordSlot.value) return
  if (!reason.value.trim()) {
    reasonError.value = '判断理由を入力してください'
    return
  }
  const res = record(theme.value.id, recordSlot.value, reason.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(`選択肢 ${recordSlot.value} で判断を記録しました`, 'ok', { label: '判断履歴を見る', to: '/decision' })
  recordSlot.value = null
}

const themeLogs = computed(() => (theme.value ? logsOf(theme.value.id) : []))
function memberName(id: string): string {
  return members.value.find(m => m.id === id)?.name ?? id
}
</script>

<template>
  <div v-if="!theme">
    <UiEmptyState icon="Scale" title="判断テーマが見つかりません" hint="URL が正しいか確認してください">
      <template #action>
        <NuxtLink to="/decision" class="btn btn-primary btn-sm">テーマ一覧へ戻る</NuxtLink>
      </template>
    </UiEmptyState>
  </div>

  <div v-else>
    <UiPageHeader :title="theme.title" :description="`目的関数: ${theme.objective}`">
      <template #actions>
        <UiStatusBadge :label="DECISION_CATEGORY_LABELS[theme.category]" :tone="DECISION_CATEGORY_TONES[theme.category]" />
        <NuxtLink to="/decision" class="btn btn-ghost btn-sm">
          <ArrowLeft class="h-3.5 w-3.5" aria-hidden="true" />
          一覧へ
        </NuxtLink>
      </template>
    </UiPageHeader>

    <!-- オントロジー 3 次元ビュー -->
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <!-- ① 意味 -->
      <UiSectionCard title="① 意味" description="属性・KPI" flush>
        <table class="tbl">
          <tbody>
            <tr v-for="s in theme.semantics" :key="s.key">
              <th class="w-[42%] !text-left">{{ s.key }}</th>
              <td class="num text-[13px]">{{ s.value }}</td>
            </tr>
          </tbody>
        </table>
      </UiSectionCard>

      <!-- ② 関係 -->
      <UiSectionCard title="② 関係" description="マスタ実データへのリンク">
        <ul class="grid gap-1.5">
          <li v-for="(l, i) in theme.links" :key="i">
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-left text-xs font-medium transition-colors"
              :class="openLink === i ? 'border-brand bg-brand-soft text-brand' : 'border-line-strong bg-surface text-sub hover:border-muted'"
              :aria-expanded="openLink === i"
              @click="toggleLink(i)"
            >
              <Link2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ l.label }}</span>
              <Info class="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
            </button>
            <div v-if="openLink === i" class="mt-1 rounded-lg bg-page p-2.5 text-xs text-sub">
              <p>{{ l.info }}</p>
              <NuxtLink :to="l.to" class="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline">
                画面を開く
                <ArrowUpRight class="h-3.5 w-3.5" aria-hidden="true" />
              </NuxtLink>
            </div>
          </li>
        </ul>
      </UiSectionCard>

      <!-- ③ 制約と打ち手 -->
      <UiSectionCard title="③ 制約と打ち手" description="制約を通った打ち手だけが選択肢に昇格します">
        <ul class="grid gap-2">
          <li
            v-for="(a, i) in theme.actions"
            :key="i"
            class="rounded-lg border border-line px-2.5 py-2"
            :class="a.status === 'ng' ? 'opacity-50' : ''"
          >
            <div class="flex items-center gap-2">
              <span
                class="num shrink-0 text-sm font-bold"
                :class="{
                  ok: 'text-ok', warn: 'text-warn', ng: 'text-crit',
                }[a.status]"
                :aria-label="a.status === 'ng' ? '実行不可' : a.status === 'warn' ? '条件付き' : '実行可'"
              >{{ DECISION_ACTION_META[a.status].symbol }}</span>
              <span class="min-w-0 flex-1 text-[13px] font-medium" :class="a.status === 'ng' ? 'line-through' : ''">
                {{ a.name }}
              </span>
              <UiStatusBadge v-if="a.slot" :label="`→ 選択肢 ${a.slot}`" tone="brand" />
            </div>
            <p v-if="a.why" class="mt-1 pl-6 text-[11px]" :class="a.status === 'ng' ? 'text-crit' : 'text-warn'">
              {{ a.why }}
            </p>
          </li>
        </ul>
      </UiSectionCard>
    </div>

    <!-- 選択肢 A/B/C -->
    <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
      <section
        v-for="o in theme.options"
        :key="o.slot"
        class="card flex flex-col p-3"
        :class="o.recommended ? 'ring-2 ring-brand' : ''"
      >
        <div class="flex items-center gap-2">
          <span class="flex h-7 w-7 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand">{{ o.slot }}</span>
          <UiStatusBadge v-if="o.recommended" label="★ AI推奨" tone="brand" />
        </div>
        <h3 class="mt-2 text-[13px] font-bold leading-snug">{{ o.title }}</h3>
        <ul class="mt-2 grid gap-1">
          <li v-for="(p, i) in o.prediction" :key="i" class="flex items-start gap-1.5 text-xs text-sub">
            <ListChecks class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
            {{ p }}
          </li>
        </ul>
        <p class="mt-2 rounded-lg bg-page p-2 text-[11px] text-muted">根拠: {{ o.basis }}</p>
        <button
          type="button"
          class="btn mt-3"
          :class="o.recommended ? 'btn-primary' : ''"
          @click="openRecord(o.slot)"
        >
          この選択肢で判断を記録
        </button>
      </section>
    </div>

    <!-- AI 推奨理由 -->
    <div class="mt-3 flex items-start gap-2.5 rounded-[10px] border border-brand bg-brand-soft p-3">
      <Sparkles class="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
      <div>
        <p class="text-xs font-bold text-brand">
          <Star class="mr-0.5 inline h-3 w-3" aria-hidden="true" />
          AI が推奨する理由
        </p>
        <p class="mt-0.5 text-[13px] text-ink">{{ theme.whyRecommend }}</p>
      </div>
    </div>

    <!-- シナリオ比較 -->
    <UiSectionCard class="mt-4" title="シナリオ比較" description="パラメータを動かすと予測 KPI が即時に再計算されます（決定的な簡易モデル）">
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="grid gap-3">
          <div v-for="p in theme.scenarioParams" :key="p.key">
            <label class="label flex items-baseline justify-between" :for="`param-${p.key}`">
              {{ p.label }}
              <span class="num text-[13px] font-bold text-brand">{{ params[p.key] }} {{ p.unit }}</span>
            </label>
            <input
              :id="`param-${p.key}`"
              v-model.number="params[p.key]"
              type="range"
              class="w-full accent-[var(--c-brand)]"
              :min="p.min"
              :max="p.max"
              :step="p.step"
              :aria-valuetext="`${params[p.key]} ${p.unit}`"
            >
            <div class="num flex justify-between text-[10px] text-muted" aria-hidden="true">
              <span>{{ p.min }} {{ p.unit }}</span>
              <span>{{ p.max }} {{ p.unit }}</span>
            </div>
          </div>
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <UiKpiCard v-for="k in kpis" :key="k.label" :label="k.label" :value="k.value" :sub="k.sub ?? ''" />
        </div>
      </div>
    </UiSectionCard>

    <!-- このテーマの判断履歴 -->
    <UiSectionCard
      v-if="themeLogs.length > 0"
      class="mt-4"
      title="このテーマの判断履歴"
      description="記録済みの意思決定ログ"
    >
      <ul class="grid gap-2">
        <li v-for="l in themeLogs" :key="l.id" class="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs">
          <UiStatusBadge :label="`選択肢 ${l.chosenSlot}`" tone="brand" />
          <span class="min-w-0 flex-1 text-[13px]">{{ l.reason }}</span>
          <span class="text-muted">{{ memberName(l.decidedBy) }}</span>
          <span class="num text-muted">{{ fmtDateTime(l.at) }}</span>
        </li>
      </ul>
      <NuxtLink to="/decision" class="link mt-2 inline-flex items-center gap-1 text-xs">
        <Scale class="h-3.5 w-3.5" aria-hidden="true" />
        判断履歴の一覧（/decision）へ戻る
      </NuxtLink>
    </UiSectionCard>

    <!-- 理由入力モーダル -->
    <UiModal
      :open="!!recordSlot"
      :title="`選択肢 ${recordSlot ?? ''} で判断を記録`"
      @close="recordSlot = null"
    >
      <div class="grid gap-3">
        <p v-if="recordOption" class="rounded-lg bg-page p-2.5 text-[13px]">
          {{ recordOption.title }}
          <UiStatusBadge v-if="recordOption.recommended" class="ml-1" label="★ AI推奨" tone="brand" />
        </p>
        <UiFormField label="判断理由" required :error="reasonError" hint="意思決定ログに記録され、分析基盤へ蓄積されます">
          <textarea v-model="reason" class="textarea" rows="4" placeholder="この選択肢を選ぶ理由・前提条件など" />
        </UiFormField>
      </div>
      <template #footer>
        <button type="button" class="btn btn-ghost" @click="recordSlot = null">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="submitRecord">判断を記録</button>
      </template>
    </UiModal>
  </div>
</template>
