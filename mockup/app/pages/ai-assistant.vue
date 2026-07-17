<script setup lang="ts">
/**
 * AI業務アシスタント（F-14）。日報の AI アシスト（材料の入力側）を独立させたページ。
 * - 明日の計画: 翌日の予定タスクへ 目的/達成条件/段取り を登録 → AI コメント → 修正（F-14-2/3）
 * - 今日の振り返り: 当日の終わりに結果・所感を記録 → 日報ドラフトへ自動反映可能に（F-14-4）
 * - スケジュール & タスク / ぽいぽいメモ / AI ヒアリング（F-06-7 から移設）
 * - 管理者: 蓄積データからのインサイト（計画数・完了率・振り返り記入率。F-14-6）
 */
import {
  ChevronLeft, ChevronRight, NotebookPen, Pencil, Plus, RefreshCw, Sparkles, Trash2, Zap,
} from 'lucide-vue-next'
import type { AssistQuestion } from '~/composables/useReportAssist'
import type { CalendarEvent, TaskPlan } from '~/types/domain'
import { addDays, fmtDateLong, fmtPct, fmtTime } from '~/utils/format'

const { currentUser, currentUserId, isAdmin } = useCurrentUser()
const cal = useCalendar()
const assist = useReportAssist()
const tp = useTaskPlans()

// サーバー側で進んだ計画・インサイト（他端末の操作）を表示時に取り込む
onMounted(() => { void tp.refresh() })
const { show } = useToast()
const { ask } = useConfirm()
const { tbl } = useMockDb()
const projects = tbl('projects')

const calConnected = cal.isConnected

function projectName(id: string | null): string {
  if (!id) return ''
  return projects.value.find(p => p.id === id)?.name ?? ''
}

// ================= 今日の振り返り（対象日は過去へ変更可） =================

const todayKey = todayJst()
const recDate = ref(todayKey)

const recPlans = computed(() => tp.plansOf(currentUserId.value, recDate.value))
const recDonePlans = computed(() => recPlans.value.filter(p => p.status === 'done'))

// 結果記録フォーム（計画ごとの入力状態）
const resultForm = ref<Record<string, { outcome: string; reflection: string }>>({})

function resultFormOf(planId: string): { outcome: string; reflection: string } {
  if (!resultForm.value[planId]) resultForm.value[planId] = { outcome: '', reflection: '' }
  return resultForm.value[planId]
}

async function onRecordResult(p: TaskPlan): Promise<void> {
  const f = resultFormOf(p.id)
  const r = await tp.recordResult(p.id, f)
  if (!r.ok) {
    show(r.error.message, 'warn')
    return
  }
  delete resultForm.value[p.id]
  show('結果を記録しました。日報ドラフトへ自動反映できます', 'ok', { label: '日報を書く', to: '/reports' })
}

// ================= 明日の計画（対象日は未来へ変更可） =================

/** 翌営業日（土日スキップ）を既定の計画対象日にする */
function nextWeekday(dateKey: string): string {
  let d = addDays(dateKey, 1)
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, 1)
  return d
}

const planDate = ref(nextWeekday(todayKey))

const planPlans = computed(() => tp.plansOf(currentUserId.value, planDate.value))

/** 計画対象日のカレンダー予定（まだ計画化されていないもの = 「予定から追加」の候補） */
const planDayEvents = computed(() => cal.eventsOf(currentUserId.value, planDate.value))
const unplannedEvents = computed(() => {
  const linked = new Set(planPlans.value.map(p => p.calendarEventId).filter(Boolean))
  return planDayEvents.value.filter(e => !linked.has(e.id))
})

function onSyncPlanDay(): void {
  const res = cal.syncFromGoogle(currentUserId.value, planDate.value)
  if (!res.ok) {
    show(res.error.message, 'crit')
    return
  }
  show(`${res.synced ?? 0} 件を同期しました（モック）`)
}

// 計画の作成・編集モーダル
const planModal = ref(false)
const planForm = ref({ id: '', calendarEventId: '', title: '', purpose: '', doneCriteria: '', approach: '' })
const planError = ref('')

function openPlanCreate(ev?: CalendarEvent): void {
  planForm.value = {
    id: '',
    calendarEventId: ev?.id ?? '',
    title: ev ? ev.title : '',
    purpose: '',
    doneCriteria: '',
    approach: '',
  }
  planError.value = ''
  planModal.value = true
}

function openPlanEdit(p: TaskPlan): void {
  planForm.value = {
    id: p.id,
    calendarEventId: p.calendarEventId ?? '',
    title: p.title,
    purpose: p.purpose,
    doneCriteria: p.doneCriteria,
    approach: p.approach,
  }
  planError.value = ''
  planModal.value = true
}

async function savePlan(): Promise<void> {
  planError.value = ''
  const f = planForm.value
  const r = await tp.upsertPlan({
    id: f.id || undefined,
    date: planDate.value,
    calendarEventId: f.calendarEventId || null,
    title: f.title,
    purpose: f.purpose,
    doneCriteria: f.doneCriteria,
    approach: f.approach,
  })
  if (!r.ok) {
    planError.value = r.error.message
    return
  }
  planModal.value = false
  show(f.id ? '計画を更新しました' : '計画を登録しました。「AI コメントをもらう」でレビューを受けられます')
}

async function onRemovePlan(p: TaskPlan): Promise<void> {
  const ok = await ask('計画の削除', `「${p.title}」の計画を削除しますか？`, { danger: true, confirmLabel: '削除' })
  if (!ok) return
  const r = await tp.removePlan(p.id)
  show(r.ok ? '計画を削除しました' : r.error.message, r.ok ? 'ok' : 'warn')
}

async function onAiReview(p: TaskPlan): Promise<void> {
  const r = await tp.aiReview(p.id)
  if (!r.ok) {
    show(r.error.message, 'warn')
    return
  }
  show('AI コメントを受け取りました。内容を確認して計画を修正できます')
}

// ================= ぽいぽいメモ / AI ヒアリング（振り返りの対象日に記録） =================

const memoText = ref('')
const dayMemos = computed(() =>
  assist.logsOf(currentUserId.value, recDate.value).filter(l => l.kind === 'memo'))

async function onPoipoi(): Promise<void> {
  const res = await assist.poipoiMemo(memoText.value, recDate.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  memoText.value = ''
  show('記録しました')
}

function onMemoKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return // IME 変換確定の Enter では送信しない
  void onPoipoi()
}

const questions = computed(() => assist.questionsFor(currentUserId.value, recDate.value))
const answeredCount = computed(() => questions.value.filter(q => q.answered).length)
const qaText = ref<Record<string, string>>({})
const reanswering = ref<Record<string, boolean>>({})

function lastAnswerOf(q: AssistQuestion): string {
  const found = [...assist.logsOf(currentUserId.value, recDate.value)].reverse().find(l =>
    l.kind === 'qa' && (q.calendarEventId ? l.calendarEventId === q.calendarEventId : l.question === q.question))
  return found?.answer ?? ''
}

async function submitAnswer(q: AssistQuestion, text: string): Promise<void> {
  const res = await assist.recordAnswer(q, text, recDate.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  qaText.value[q.key] = ''
  reanswering.value[q.key] = false
  show('回答を記録しました')
}

function onAnswerKeydown(e: KeyboardEvent, q: AssistQuestion): void {
  if (e.isComposing) return
  submitAnswer(q, qaText.value[q.key] ?? '')
}

watch([recDate, currentUserId], () => {
  memoText.value = ''
  qaText.value = {}
  reanswering.value = {}
  resultForm.value = {}
})
watch(currentUserId, () => {
  planDate.value = nextWeekday(todayKey)
  recDate.value = todayKey
})

// ================= 管理者インサイト（F-14-6） =================

const insightRows = computed(() => tp.insights(7))
</script>

<template>
  <div>
    <UiPageHeader
      title="AI業務アシスタント"
      description="前日の終わりに明日の計画を立て AI のコメントで磨き、当日の終わりに振り返る。蓄積は日報へ自動反映できます"
    >
      <template #actions>
        <NuxtLink to="/reports" class="btn btn-sm">
          <NotebookPen class="h-3.5 w-3.5" aria-hidden="true" /> 日報を書く（AI アシスト）
        </NuxtLink>
      </template>
    </UiPageHeader>

    <div class="grid gap-3">
      <!-- Google カレンダー連携ゲート -->
      <WidgetsCalendarConnectGate />

      <div class="grid items-start gap-3 lg:grid-cols-2">
        <!-- ================= 明日の計画 ================= -->
        <UiSectionCard
          title="明日の計画"
          description="予定タスクに目的・達成条件・段取りを登録し、AI コメントで磨きます"
        >
          <template #actions>
            <button type="button" class="btn btn-sm" aria-label="前日へ" @click="planDate = addDays(planDate, -1)">
              <ChevronLeft class="h-4 w-4" aria-hidden="true" />
            </button>
            <span class="num whitespace-nowrap text-xs font-semibold">{{ fmtDateLong(planDate) }}</span>
            <button type="button" class="btn btn-sm" aria-label="翌日へ" @click="planDate = addDays(planDate, 1)">
              <ChevronRight class="h-4 w-4" aria-hidden="true" />
            </button>
          </template>

          <div class="grid gap-2.5">
            <!-- 予定からの計画候補 -->
            <div v-if="calConnected" class="rounded-lg border border-line bg-surface-soft p-2.5">
              <div class="flex flex-wrap items-center gap-2">
                <p class="text-[11px] font-bold text-muted">この日の予定（クリックで計画化）</p>
                <button type="button" class="btn btn-sm ml-auto" @click="onSyncPlanDay">
                  <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" /> Google から同期
                </button>
              </div>
              <ul v-if="unplannedEvents.length > 0" class="mt-1.5 grid gap-1.5">
                <li v-for="e in unplannedEvents" :key="e.id">
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left transition-colors hover:border-[var(--c-brand)]"
                    :aria-label="`「${e.title}」を計画に追加`"
                    @click="openPlanCreate(e)"
                  >
                    <span class="num text-xs font-semibold text-sub">{{ e.from }}〜{{ e.to }}</span>
                    <span class="min-w-0 flex-1 truncate text-[13px] font-semibold">{{ e.title }}</span>
                    <Plus class="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                  </button>
                </li>
              </ul>
              <p v-else class="mt-1.5 text-[11px] text-muted">未計画の予定はありません（同期または手動追加できます）</p>
            </div>

            <!-- 計画一覧 -->
            <UiEmptyState
              v-if="planPlans.length === 0"
              icon="ClipboardList"
              title="この日の計画はまだありません"
              :hint="calConnected ? '予定から計画化するか、手動で追加してください' : '「タスクを追加」から計画を登録してください（カレンダー連携で予定からも追加できます）'"
            />
            <div
              v-for="p in planPlans"
              :key="p.id"
              class="rounded-lg border border-line p-2.5"
              :class="p.status === 'done' ? 'bg-surface-soft' : ''"
            >
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="min-w-0 flex-1 text-[13px] font-bold">{{ p.title }}</span>
                <UiStatusBadge v-if="p.status === 'done'" tone="ok" label="結果記録済み" dot />
                <template v-else>
                  <button type="button" class="btn btn-sm" :aria-label="`「${p.title}」を編集`" @click="openPlanEdit(p)">
                    <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button type="button" class="btn btn-sm text-crit" :aria-label="`「${p.title}」を削除`" @click="onRemovePlan(p)">
                    <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </template>
              </div>
              <p v-if="p.calendarEventId" class="mt-0.5 text-[11px] text-muted">カレンダー予定に紐付け済み</p>
              <dl class="mt-1.5 grid gap-1 text-[12px]">
                <div class="grid grid-cols-[64px_1fr] gap-1.5">
                  <dt class="text-[11px] font-semibold text-muted">目的</dt>
                  <dd class="whitespace-pre-wrap">{{ p.purpose || '—' }}</dd>
                </div>
                <div class="grid grid-cols-[64px_1fr] gap-1.5">
                  <dt class="text-[11px] font-semibold text-muted">達成条件</dt>
                  <dd class="whitespace-pre-wrap">{{ p.doneCriteria || '—' }}</dd>
                </div>
                <div class="grid grid-cols-[64px_1fr] gap-1.5">
                  <dt class="text-[11px] font-semibold text-muted">段取り</dt>
                  <dd class="whitespace-pre-wrap">{{ p.approach || '—' }}</dd>
                </div>
              </dl>
              <!-- AI コメント -->
              <div v-if="p.aiComment" class="mt-2 rounded-lg bg-brand-soft p-2.5">
                <p class="flex items-center gap-1 text-[11px] font-bold text-brand">
                  <Sparkles class="h-3.5 w-3.5" aria-hidden="true" /> AI コメント
                  <span v-if="p.aiCommentAt" class="num ml-auto font-normal text-muted">{{ fmtTime(p.aiCommentAt) }}</span>
                </p>
                <p class="mt-1 whitespace-pre-wrap text-[12px]">{{ p.aiComment }}</p>
              </div>
              <div v-if="p.status !== 'done'" class="mt-2 flex flex-wrap gap-1.5">
                <button type="button" class="btn btn-sm btn-primary" @click="onAiReview(p)">
                  <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
                  {{ p.aiComment ? 'AI コメントを再取得' : 'AI コメントをもらう' }}
                </button>
                <button v-if="p.aiComment" type="button" class="btn btn-sm" @click="openPlanEdit(p)">計画を修正する</button>
              </div>
            </div>

            <button type="button" class="btn w-full justify-center" @click="openPlanCreate()">
              <Plus class="h-4 w-4" aria-hidden="true" /> タスクを追加（手動）
            </button>
          </div>
        </UiSectionCard>

        <!-- ================= 今日の振り返り ================= -->
        <UiSectionCard
          title="今日の振り返り"
          description="計画したタスクの結果・所感を記録すると、日報ドラフトへ自動反映できます"
        >
          <template #actions>
            <button type="button" class="btn btn-sm" aria-label="前日へ" @click="recDate = addDays(recDate, -1)">
              <ChevronLeft class="h-4 w-4" aria-hidden="true" />
            </button>
            <span class="num whitespace-nowrap text-xs font-semibold">{{ fmtDateLong(recDate) }}</span>
            <button type="button" class="btn btn-sm" aria-label="翌日へ" @click="recDate = addDays(recDate, 1)">
              <ChevronRight class="h-4 w-4" aria-hidden="true" />
            </button>
          </template>

          <div class="grid gap-2.5">
            <UiEmptyState
              v-if="recPlans.length === 0"
              icon="ClipboardCheck"
              title="この日の計画がありません"
              hint="前日に「明日の計画」で登録したタスクがここに並びます"
            />
            <div v-for="p in recPlans" :key="p.id" class="rounded-lg border border-line p-2.5">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="min-w-0 flex-1 text-[13px] font-bold">{{ p.title }}</span>
                <UiStatusBadge
                  :tone="p.status === 'done' ? 'ok' : 'info'"
                  :label="p.status === 'done' ? '記録済み' : '未記録'"
                  dot
                />
              </div>
              <p class="mt-0.5 text-[11px] text-muted">達成条件: {{ p.doneCriteria || '—' }}</p>

              <!-- 記録済み: 読み取り表示（記録は上書きしない） -->
              <dl v-if="p.status === 'done'" class="mt-1.5 grid gap-1 text-[12px]">
                <div class="grid grid-cols-[52px_1fr] gap-1.5">
                  <dt class="text-[11px] font-semibold text-muted">結果</dt>
                  <dd class="whitespace-pre-wrap">{{ p.outcome }}</dd>
                </div>
                <div class="grid grid-cols-[52px_1fr] gap-1.5">
                  <dt class="text-[11px] font-semibold text-muted">所感</dt>
                  <dd class="whitespace-pre-wrap">{{ p.reflection || '—' }}</dd>
                </div>
              </dl>

              <!-- 未記録: 結果・所感の入力 -->
              <div v-else class="mt-2 grid gap-1.5">
                <UiFormField label="結果" required>
                  <textarea
                    v-model="resultFormOf(p.id).outcome"
                    class="textarea"
                    rows="2"
                    placeholder="例: 比較表を提示し A 案で合意。検証項目 3 件を持ち帰り"
                    :aria-label="`「${p.title}」の結果`"
                  />
                </UiFormField>
                <UiFormField label="所感">
                  <textarea
                    v-model="resultFormOf(p.id).reflection"
                    class="textarea"
                    rows="2"
                    placeholder="うまくいった理由・次に活かすこと"
                    :aria-label="`「${p.title}」の所感`"
                  />
                </UiFormField>
                <button type="button" class="btn btn-primary btn-sm justify-self-end" @click="onRecordResult(p)">
                  結果を記録する
                </button>
              </div>
            </div>

            <!-- ぽいぽいメモ -->
            <div class="rounded-lg border border-line p-2.5">
              <p class="text-[11px] font-bold text-muted">ぽいぽいメモ（計画外の出来事も一言でぽいっと）</p>
              <div class="mt-1.5 flex gap-1.5">
                <input
                  v-model="memoText"
                  type="text"
                  class="input min-w-0 flex-1"
                  placeholder="例: 見積の前提を確認済み"
                  aria-label="ぽいぽいメモ"
                  @keydown.enter="onMemoKeydown"
                >
                <button type="button" class="btn btn-primary shrink-0" @click="onPoipoi">
                  <Zap class="h-3.5 w-3.5" aria-hidden="true" />
                  記録
                </button>
              </div>
              <ul v-if="dayMemos.length > 0" class="mt-1.5 grid gap-1">
                <li v-for="m in dayMemos" :key="m.id" class="flex items-start gap-2 rounded-lg bg-surface-soft px-2.5 py-1.5">
                  <span class="num shrink-0 text-[11px] text-muted">{{ fmtTime(m.at) }}</span>
                  <span class="min-w-0 text-[13px]">{{ m.answer }}</span>
                </li>
              </ul>
            </div>

            <!-- AI ヒアリング -->
            <div class="rounded-lg border border-line p-2.5">
              <div class="flex items-center gap-2">
                <p class="text-[11px] font-bold text-muted">AI ヒアリング（予定の進み具合と今日のまとめ）</p>
                <span class="num ml-auto whitespace-nowrap text-xs font-semibold text-sub">回答 {{ answeredCount }}/{{ questions.length }}</span>
              </div>
              <div class="mt-1.5 grid gap-2">
                <div
                  v-for="q in questions"
                  :key="q.key"
                  class="rounded-lg border border-line p-2.5"
                  :class="q.answered ? 'bg-surface-soft' : ''"
                >
                  <p class="text-[13px] font-semibold">{{ assist.displayQuestion(q) }}</p>
                  <div v-if="q.answered && !reanswering[q.key]" class="mt-1.5 flex flex-wrap items-center gap-2">
                    <UiStatusBadge tone="ok" label="回答済み" dot />
                    <span class="min-w-0 flex-1 text-xs text-muted">{{ lastAnswerOf(q) }}</span>
                    <button type="button" class="btn btn-sm" @click="reanswering[q.key] = true">答え直す</button>
                  </div>
                  <div v-else class="mt-1.5 grid gap-1.5">
                    <div v-if="q.chips.length > 0" class="flex flex-wrap gap-1.5">
                      <button v-for="c in q.chips" :key="c" type="button" class="btn btn-sm" @click="submitAnswer(q, c)">
                        {{ c }}
                      </button>
                    </div>
                    <div class="flex gap-1.5">
                      <input
                        v-model="qaText[q.key]"
                        type="text"
                        class="input min-w-0 flex-1"
                        placeholder="自由記述で回答"
                        :aria-label="`「${assist.displayQuestion(q)}」への回答`"
                        @keydown.enter="onAnswerKeydown($event, q)"
                      >
                      <button type="button" class="btn shrink-0" @click="submitAnswer(q, qaText[q.key] ?? '')">記録</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <NuxtLink to="/reports" class="btn btn-primary w-full justify-center">
              <NotebookPen class="h-4 w-4" aria-hidden="true" />
              日報ドラフトを生成する（{{ recDonePlans.length }} 件の結果を反映）
            </NuxtLink>
          </div>
        </UiSectionCard>
      </div>

      <!-- ================= 管理者インサイト ================= -->
      <UiSectionCard
        v-if="isAdmin"
        title="チームインサイト（管理者）"
        description="直近 7 日の計画・振り返りの蓄積状況。日々のデータが意思決定のインサイト源になります"
        flush
      >
        <UiEmptyState v-if="insightRows.length === 0" icon="ChartNoAxesColumn" title="直近 7 日の計画データがありません" />
        <div v-else class="overflow-x-auto scroll-slim">
          <table class="tbl">
            <thead>
              <tr>
                <th>メンバー</th>
                <th class="!text-right">計画数</th>
                <th class="!text-right">結果記録</th>
                <th class="!text-right">完了率</th>
                <th class="!text-right">振り返り記入率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in insightRows" :key="row.memberId">
                <td class="whitespace-nowrap font-semibold">{{ row.name }}</td>
                <td class="num text-right">{{ row.planned }}</td>
                <td class="num text-right">{{ row.done }}</td>
                <td class="num text-right">{{ row.doneRate === null ? '—' : fmtPct(row.doneRate, 0) }}</td>
                <td class="num text-right">{{ row.reflectionRate === null ? '—' : fmtPct(row.reflectionRate, 0) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiSectionCard>
    </div>

    <!-- ================= モーダル: 計画の作成・編集 ================= -->
    <UiModal :open="planModal" :title="planForm.id ? '計画を編集' : `${fmtDateLong(planDate)} の計画を追加`" @close="planModal = false">
      <div class="grid gap-3">
        <UiFormField label="タスク名" required>
          <input v-model="planForm.title" type="text" class="input" placeholder="例: 定例の論点整理" >
        </UiFormField>
        <UiFormField v-if="planForm.calendarEventId" label="カレンダー予定">
          <p class="text-[12px] text-sub">
            {{ planDayEvents.find(e => e.id === planForm.calendarEventId)?.title ?? '（紐付け済み）' }}
            <span v-if="projectName(planDayEvents.find(e => e.id === planForm.calendarEventId)?.projectId ?? null)" class="text-muted">
              / {{ projectName(planDayEvents.find(e => e.id === planForm.calendarEventId)?.projectId ?? null) }}
            </span>
          </p>
        </UiFormField>
        <UiFormField label="目的" hint="なぜやるか。誰の・何の状態を変えるか">
          <textarea v-model="planForm.purpose" class="textarea" rows="2" placeholder="例: 在庫精度の改善方針を合意する" />
        </UiFormField>
        <UiFormField label="達成条件" hint="終了状態で書く（第三者が判定できる表現）">
          <textarea v-model="planForm.doneCriteria" class="textarea" rows="2" placeholder="例: 比較表を提示し、次回までの検証項目が決まっている" />
        </UiFormField>
        <UiFormField label="段取り・計画" hint="ステップに分解（① ② ③ など）">
          <textarea v-model="planForm.approach" class="textarea" rows="3" placeholder="例: ①現状データの確認 ②比較表作成 ③定例で提示" />
        </UiFormField>
        <p v-if="planError" class="text-[12px] font-medium text-crit" role="alert">{{ planError }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="planModal = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="savePlan">{{ planForm.id ? '更新する' : '登録する' }}</button>
      </template>
    </UiModal>
  </div>
</template>
