<script setup lang="ts">
/**
 * 日報・週報（F-06）
 * タブ: 自分の日報 / チーム（管理者のみ・提出状況マトリクス+タイムライン） / 週報
 */
import {
  BellRing, Check, ChevronLeft, ChevronRight, Minus, Plus, Send, Sparkles, Trash2,
} from 'lucide-vue-next'
import type { DailyReport, ReportEntry, WeeklyReport } from '~/types/domain'
import { REPORT_STATUS_LABELS } from '~/composables/useReports'
import { addDays, fmtDate, fmtDateLong, fmtMinutes, fmtTime, weekdayOf } from '~/utils/format'
import type { TabItem } from '~/types/ui'

const route = useRoute()
const { currentUser, currentUserId, isAdmin } = useCurrentUser()
const reports = useReports()
const attendance = useAttendance()
const { show } = useToast()
const { ask } = useConfirm()
const { tbl } = useMockDb()
const projects = tbl('projects')

// ---------- タブ ----------

const TAB_KEYS = ['mine', 'team', 'weekly'] as const
const tabs = computed<TabItem[]>(() => {
  const t: TabItem[] = [{ key: 'mine', label: '自分の日報' }]
  if (isAdmin.value) t.push({ key: 'team', label: 'チーム' })
  t.push({ key: 'weekly', label: '週報' })
  return t
})
const queryTab = typeof route.query.tab === 'string' ? route.query.tab : ''
const tab = ref<string>((TAB_KEYS as readonly string[]).includes(queryTab) ? queryTab : 'mine')
watchEffect(() => {
  if (!tabs.value.some(t => t.key === tab.value)) tab.value = 'mine'
})

// ---------- 共通ヘルパー ----------

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const

function dayLabel(d: string): string {
  return `${fmtDate(d)}(${WEEKDAYS[weekdayOf(d)] ?? ''})`
}

function projectName(id: string): string {
  return projects.value.find(p => p.id === id)?.name ?? id
}

function totalHoursOf(r: DailyReport): number {
  return r.entries.reduce((s, e) => s + e.hours, 0)
}

function gapText(gap: number): string {
  return gap > 0 ? `+${fmtMinutes(gap)}` : fmtMinutes(gap)
}

const activeProjects = computed(() =>
  projects.value
    .filter(p => p.active && p.status === 'active')
    .map(p => ({ value: p.id, label: p.name })))

// ---------- 自分の日報タブ ----------

const selDate = ref(todayJst())
const myReport = computed(() => reports.myReportOn(selDate.value))

const editEntries = ref<ReportEntry[]>([])
const editReflection = ref('')
const editIssues = ref('')
const editTomorrow = ref('')

function blankEntry(): ReportEntry {
  return { projectId: '', task: '', hours: 1, progress: 0 }
}

function loadEditor(): void {
  const r = myReport.value
  if (r && r.status === 'draft') {
    editEntries.value = r.entries.length > 0 ? r.entries.map(e => ({ ...e })) : [blankEntry()]
    editReflection.value = r.reflection
    editIssues.value = r.issues
    editTomorrow.value = r.tomorrow
  } else {
    editEntries.value = [blankEntry()]
    editReflection.value = ''
    editIssues.value = ''
    editTomorrow.value = ''
  }
}
watch([selDate, currentUserId], loadEditor, { immediate: true })

function addRow(): void {
  editEntries.value.push(blankEntry())
}

function removeRow(i: number): void {
  editEntries.value.splice(i, 1)
  if (editEntries.value.length === 0) editEntries.value.push(blankEntry())
}

function stepHours(i: number, delta: number): void {
  const e = editEntries.value[i]
  if (!e) return
  const cur = Number.isFinite(e.hours) ? e.hours : 0
  e.hours = Math.max(0, Math.round((cur + delta) * 4) / 4)
}

const totalHours = computed(() =>
  editEntries.value.reduce((s, e) => s + (Number.isFinite(e.hours) ? e.hours : 0), 0))

const dayWorkMinutes = computed(() => {
  try {
    return attendance.daySummary(currentUser.value.id, selDate.value).workMinutes
  } catch {
    return 0
  }
})

const editorGap = computed(() => {
  if (dayWorkMinutes.value <= 0) return null
  const gap = Math.round(totalHours.value * 60) - dayWorkMinutes.value
  return Math.abs(gap) > 60 ? gap : null
})

const submittedGap = computed(() => {
  const r = myReport.value
  return r && r.status === 'submitted' ? reports.gapOf(r) : null
})

const mineStatus = computed(() => {
  const r = myReport.value
  if (!r) return { tone: 'neutral' as const, label: '未作成' }
  return r.status === 'submitted'
    ? { tone: 'ok' as const, label: REPORT_STATUS_LABELS.submitted }
    : { tone: 'warn' as const, label: REPORT_STATUS_LABELS.draft }
})

function payload() {
  return {
    date: selDate.value,
    entries: editEntries.value.map(e => ({ ...e })),
    reflection: editReflection.value,
    issues: editIssues.value,
    tomorrow: editTomorrow.value,
  }
}

function onSaveDraft(): void {
  const res = reports.saveDraft(payload())
  show(res.ok ? '下書きを保存しました' : res.error.message, res.ok ? 'ok' : 'warn')
}

function onSubmit(): void {
  const res = reports.submit(payload())
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show('日報を提出しました')
  if (res.escalated) {
    show('課題が管理者へ共有されました', 'info', { label: '受信箱', to: '/inbox' })
  }
  if (res.hoursGapMinutes !== null) {
    show(`勤怠実労働と工数合計に 60 分超の乖離があります（${gapText(res.hoursGapMinutes)}）`, 'warn')
  }
}

// ---------- AI アシスト入力（F-06-7。材料の入力は AI業務アシスタント F-14 へ移設） ----------

const assist = useReportAssist()
const tp = useTaskPlans()
const inputMode = assist.inputMode

/** 入力方式が 'both' のときの切替（既定は AI アシスト） */
const entryMethod = ref<'form' | 'assist'>('assist')
const assistActive = computed(() =>
  inputMode.value === 'assist' || (inputMode.value === 'both' && entryMethod.value === 'assist'))

/** この日の自分の日報（提出済みのときのみ）。提出済み保護（ドラフト再生成不可）の唯一の判定元 */
const submittedForDate = computed(() =>
  myReport.value?.status === 'submitted' ? myReport.value : undefined)
const isSubmittedDay = computed(() => !!submittedForDate.value)

/** AI アシスト時、編集フォームはドラフトの確認・修正ステップとしてのみ表示する */
const confirmStep = ref(false)
/** 直近生成した AI ドラフトの根拠（null = AI 生成のドラフトではない） */
const draftBasis = ref<string[] | null>(null)
const editorWrap = ref<HTMLElement | null>(null)
const showEditor = computed(() => !assistActive.value || confirmStep.value)

watch([selDate, currentUserId], () => {
  confirmStep.value = false
  draftBasis.value = null
})

// -- 材料サマリ（入力は AI業務アシスタントで行う） --

const dayPlanStats = computed(() => {
  const plans = tp.plansOf(currentUserId.value, selDate.value)
  return { total: plans.length, done: plans.filter(p => p.status === 'done').length }
})
const dayMemoCount = computed(() =>
  assist.logsOf(currentUserId.value, selDate.value).filter(l => l.kind === 'memo').length)
const dayAnswerStats = computed(() => {
  const qs = assist.questionsFor(currentUserId.value, selDate.value)
  return { total: qs.length, answered: qs.filter(q => q.answered).length }
})

// -- ドラフト生成 → 確認・修正ステップ --

function scrollToEditor(): void {
  void nextTick(() => editorWrap.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

async function onGenerateDraft(): Promise<void> {
  if (submittedForDate.value) return // 提出済みの日報は上書きしない
  if (confirmStep.value) {
    // 確認・修正中の手直しを黙って捨てない
    const okAsk = await ask('ドラフトの再生成', '生成し直すと、確認・修正中の内容を新しいドラフトで置き換えます。よろしいですか？', { confirmLabel: '再生成' })
    if (!okAsk) return
  }
  const d = assist.generateDraft(currentUserId.value, selDate.value)
  editEntries.value = d.entries.map(e => ({ ...e }))
  editReflection.value = d.reflection
  editIssues.value = d.issues
  editTomorrow.value = d.tomorrow
  draftBasis.value = d.basis
  confirmStep.value = true
  show('AI ドラフトを生成しました。内容を確認・修正して提出してください')
  scrollToEditor()
}

/** 保存済みの下書きを（AI 生成なしで）確認・修正ステップで開く */
function openSavedDraft(): void {
  draftBasis.value = null
  confirmStep.value = true
  scrollToEditor()
}

// ---------- チームタブ（管理者） ----------

const matrixDays = computed(() => reports.recentBusinessDays(7))
const teamTimeline = computed(() => reports.timeline(7))

const drawerReportId = ref<string | null>(null)
const drawerReport = computed(() =>
  drawerReportId.value ? reports.reportById(drawerReportId.value) ?? null : null)
const drawerAuthor = computed(() =>
  drawerReport.value ? reports.authorOf(drawerReport.value) : null)
const drawerGap = computed(() =>
  drawerReport.value ? reports.gapOf(drawerReport.value) : null)

function cellClass(memberId: string, date: string): string {
  const s = reports.cellStatus(memberId, date)
  if (s === 'submitted') return 'bg-ok-soft text-ok hover:brightness-95'
  if (s === 'draft') return 'bg-warn-soft text-warn hover:brightness-95'
  return 'bg-surface-soft text-muted hover:bg-brand-soft hover:text-brand'
}

function cellAria(memberId: string, date: string): string {
  const s = reports.cellStatus(memberId, date)
  const name = reports.memberName(memberId)
  const label = s === 'none' ? '未提出（クリックでリマインド）' : REPORT_STATUS_LABELS[s]
  return `${name} ${dayLabel(date)}: ${label}`
}

function openCell(memberId: string, date: string): void {
  const r = reports.reportOn(memberId, date)
  if (r) {
    drawerReportId.value = r.id
    return
  }
  void askRemind(memberId, date)
}

async function askRemind(memberId: string, date: string): Promise<void> {
  const name = reports.memberName(memberId)
  const ok = await ask('リマインド送信', `${name} さんへ ${fmtDateLong(date)} の日報リマインドを送信しますか？`, { confirmLabel: '送信' })
  if (!ok) return
  reports.remind(memberId, date)
  show(`${name} さんへリマインドを送信しました`)
}

async function remindAll(): Promise<void> {
  const date = matrixDays.value[matrixDays.value.length - 1]
  if (!date) return
  const targets = reports.teamMembers.value.filter(m =>
    reports.cellStatus(m.id, date) !== 'submitted' && m.id !== currentUserId.value)
  if (targets.length === 0) {
    show('全員提出済みです')
    return
  }
  const ok = await ask('一括リマインド', `${fmtDateLong(date)} が未提出の ${targets.length} 名へリマインドを送信しますか？`, { confirmLabel: '送信' })
  if (!ok) return
  for (const m of targets) reports.remind(m.id, date)
  show(`${targets.length} 名へリマインドを送信しました`)
}

// ---------- 週報タブ ----------

const thisWeekStart = computed(() => reports.weekStartOf(todayJst()))
const myCurrentWeekly = computed(() => reports.myWeeklyOn(thisWeekStart.value))

const wkGoal = ref('')
const wkMain = ref('')
const wkIssues = ref('')
const wkNext = ref('')

function loadWeeklyEditor(): void {
  const r = myCurrentWeekly.value
  if (r && r.status === 'draft') {
    wkGoal.value = r.goalReview
    wkMain.value = r.mainWork
    wkIssues.value = r.issues
    wkNext.value = r.nextWeek
  } else if (!r) {
    wkGoal.value = ''
    wkMain.value = ''
    wkIssues.value = ''
    wkNext.value = ''
  }
}
watch(currentUserId, loadWeeklyEditor, { immediate: true })

function weekLabel(weekStart: string): string {
  return `${fmtDate(weekStart)}〜${fmtDate(addDays(weekStart, 6))}`
}

function generateFromDailies(): void {
  const d = reports.draftFromDailies(thisWeekStart.value)
  if (!d.mainWork && !d.issues) {
    show('今週の日報がまだありません', 'warn')
    return
  }
  if (d.mainWork) wkMain.value = d.mainWork
  if (d.issues) wkIssues.value = d.issues
  show('日報から下書きを生成しました')
}

function onSaveWeekly(submitNow: boolean): void {
  const res = reports.saveWeekly({
    weekStart: thisWeekStart.value,
    goalReview: wkGoal.value,
    mainWork: wkMain.value,
    issues: wkIssues.value,
    nextWeek: wkNext.value,
  }, submitNow)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(submitNow ? '週報を提出しました' : '下書きを保存しました')
}

const weeklyDrawerId = ref<string | null>(null)
const weeklyDrawer = computed<WeeklyReport | null>(() =>
  reports.myWeeklies.value.find(r => r.id === weeklyDrawerId.value) ?? null)
</script>

<template>
  <div>
    <UiPageHeader title="日報・週報" description="日々の活動報告と週次のふりかえり。AI 社員の日次報告も同じタイムラインに届きます" />

    <UiTabBar v-model="tab" :tabs="tabs" class="mb-3" />

    <!-- ================= 自分の日報 ================= -->
    <div v-if="tab === 'mine'" class="grid gap-3">
      <UiFilterBar>
        <button type="button" class="btn btn-sm" aria-label="前日へ" @click="selDate = addDays(selDate, -1)">
          <ChevronLeft class="h-4 w-4" aria-hidden="true" />
        </button>
        <input v-model="selDate" type="date" class="input w-auto" aria-label="対象日">
        <button type="button" class="btn btn-sm" aria-label="翌日へ" @click="selDate = addDays(selDate, 1)">
          <ChevronRight class="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-sm" @click="selDate = todayJst()">今日</button>
        <template #trailing>
          <UiStatusBadge :tone="mineStatus.tone" :label="mineStatus.label" dot />
        </template>
      </UiFilterBar>

      <!-- 入力方式の切替（設定が 'both' のとき） -->
      <div
        v-if="inputMode === 'both'"
        class="inline-flex items-center gap-1 justify-self-start rounded-lg border border-line bg-surface p-1"
        role="group"
        aria-label="日報の入力方式"
      >
        <button
          type="button"
          class="btn btn-sm"
          :class="entryMethod === 'form' ? 'btn-primary' : 'btn-ghost'"
          :aria-pressed="entryMethod === 'form'"
          @click="entryMethod = 'form'"
        >
          通常入力
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :class="entryMethod === 'assist' ? 'btn-primary' : 'btn-ghost'"
          :aria-pressed="entryMethod === 'assist'"
          @click="entryMethod = 'assist'"
        >
          <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
          AI アシスト
        </button>
      </div>

      <!-- 提出済み: 読み取り表示 + コメントスレッド -->
      <UiSectionCard v-if="myReport && myReport.status === 'submitted'" :title="`${fmtDateLong(selDate)} の日報`">
        <div class="grid gap-4">
          <div class="flex flex-wrap items-center gap-2">
            <UiStatusBadge tone="ok" :label="REPORT_STATUS_LABELS.submitted" dot />
            <span v-if="myReport.submittedAt" class="num text-[11px] text-muted">提出 {{ fmtTime(myReport.submittedAt) }}</span>
            <UiStatusBadge v-if="submittedGap !== null" tone="warn" :label="`工数乖離 ${gapText(submittedGap)}`" />
            <UiStatusBadge v-if="myReport.issues" tone="warn" label="課題あり" />
          </div>
          <div class="overflow-x-auto scroll-slim">
            <table class="tbl">
              <thead>
                <tr><th>プロジェクト</th><th>作業内容</th><th class="!text-right">工数</th><th class="!text-right">進捗</th></tr>
              </thead>
              <tbody>
                <tr v-for="(e, i) in myReport.entries" :key="i">
                  <td class="whitespace-nowrap">{{ projectName(e.projectId) }}</td>
                  <td>{{ e.task }}</td>
                  <td class="num text-right">{{ e.hours }}h</td>
                  <td class="num text-right">{{ e.progress }}%</td>
                </tr>
                <tr>
                  <td colspan="2" class="text-right text-[11px] font-semibold text-muted">合計</td>
                  <td class="num text-right font-bold">{{ totalHoursOf(myReport) }}h</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <div class="grid gap-3 md:grid-cols-3">
            <div>
              <p class="label">所感</p>
              <p class="whitespace-pre-wrap text-[13px]">{{ myReport.reflection || '—' }}</p>
            </div>
            <div :class="myReport.issues ? 'rounded-lg bg-warn-soft p-2.5' : ''">
              <p class="label" :class="myReport.issues ? '!text-warn' : ''">課題{{ myReport.issues ? '（管理者へ共有済み）' : '' }}</p>
              <p class="whitespace-pre-wrap text-[13px]">{{ myReport.issues || '—' }}</p>
            </div>
            <div>
              <p class="label">明日の予定</p>
              <p class="whitespace-pre-wrap text-[13px]">{{ myReport.tomorrow || '—' }}</p>
            </div>
          </div>
          <WidgetsCommentThread :report-id="myReport.id" />
        </div>
      </UiSectionCard>

      <!-- ================= AI アシスト入力（F-06-7/8） ================= -->
      <template v-if="assistActive">
        <!-- 材料サマリ（計画・メモ・回答の入力は AI業務アシスタント F-14 で行う） -->
        <UiSectionCard
          title="AI アシストの材料"
          description="タスク計画の結果・ぽいぽいメモ・ヒアリング回答を材料に AI が下書きを作ります。材料の入力は AI業務アシスタントで"
        >
          <template #actions>
            <NuxtLink to="/ai-assistant" class="btn btn-sm btn-primary">
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
              AI業務アシスタントを開く
            </NuxtLink>
          </template>
          <ul class="grid gap-2 sm:grid-cols-3">
            <li class="rounded-lg border border-line p-2.5 text-center">
              <p class="text-[11px] font-bold text-muted">タスク計画（結果記録）</p>
              <p class="num mt-0.5 text-[15px] font-bold">
                {{ dayPlanStats.done }}<span class="text-xs text-muted"> / {{ dayPlanStats.total }} 件</span>
              </p>
            </li>
            <li class="rounded-lg border border-line p-2.5 text-center">
              <p class="text-[11px] font-bold text-muted">ぽいぽいメモ</p>
              <p class="num mt-0.5 text-[15px] font-bold">{{ dayMemoCount }}<span class="text-xs text-muted"> 件</span></p>
            </li>
            <li class="rounded-lg border border-line p-2.5 text-center">
              <p class="text-[11px] font-bold text-muted">ヒアリング回答</p>
              <p class="num mt-0.5 text-[15px] font-bold">
                {{ dayAnswerStats.answered }}<span class="text-xs text-muted"> / {{ dayAnswerStats.total }} 問</span>
              </p>
            </li>
          </ul>
        </UiSectionCard>

        <!-- ドラフト生成 -->
        <UiSectionCard title="日報ドラフト生成" description="スケジュール・回答・メモを材料に AI が下書きを作ります">
          <div class="grid gap-2">
            <button
              type="button"
              class="btn btn-primary btn-lg w-full justify-center"
              :disabled="!!submittedForDate"
              @click="onGenerateDraft"
            >
              <Sparkles class="h-4 w-4" aria-hidden="true" />
              AI で日報ドラフトを生成
            </button>
            <p v-if="submittedForDate" class="text-center text-xs text-muted">
              この日の日報は提出済みです（提出済みの日報は上書きしません）
            </p>
            <p v-else class="text-center text-[11px] text-muted">
              生成後、フォームで内容を確認・修正してから提出します（何度でも生成し直せます）
            </p>
            <button
              v-if="!submittedForDate && myReport && myReport.status === 'draft' && !confirmStep"
              type="button"
              class="btn btn-sm justify-self-center"
              @click="openSavedDraft"
            >
              保存済みの下書きを開いて修正
            </button>
          </div>
        </UiSectionCard>
      </template>

      <!-- 未提出: エディタ（AI アシスト時はドラフトの確認・修正ステップとしてのみ表示） -->
      <div v-if="!isSubmittedDay && showEditor" ref="editorWrap">
      <UiSectionCard :title="`${fmtDateLong(selDate)} の日報を書く`" description="プロジェクト別に作業内容と工数（0.25h 刻み）を記録します">
        <div class="grid gap-3">
          <!-- AI ドラフトバナー（生成根拠つき） -->
          <div v-if="assistActive && draftBasis" class="rounded-lg bg-brand-soft p-3">
            <p class="flex items-start gap-1.5 text-[13px] font-bold text-brand">
              <Sparkles class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              AI ドラフトです。内容を確認・修正してから提出してください
            </p>
            <template v-if="draftBasis.length > 0">
              <p class="label mt-1.5 !mb-1">生成根拠</p>
              <ul class="grid gap-0.5">
                <li v-for="(b, i) in draftBasis" :key="i" class="flex items-start gap-1 text-xs text-sub">
                  <span aria-hidden="true">・</span>
                  <span>{{ b }}</span>
                </li>
              </ul>
            </template>
          </div>

          <div v-for="(e, i) in editEntries" :key="i" class="rounded-lg border border-line p-2.5">
            <div class="grid gap-2 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)]">
              <UiFormField label="プロジェクト" required>
                <select v-model="e.projectId" class="select" :aria-label="`エントリ${i + 1} プロジェクト`">
                  <option value="" disabled>選択してください</option>
                  <option v-for="p in activeProjects" :key="p.value" :value="p.value">{{ p.label }}</option>
                </select>
              </UiFormField>
              <UiFormField label="作業内容" required>
                <input v-model="e.task" type="text" class="input" placeholder="実施した作業" :aria-label="`エントリ${i + 1} 作業内容`">
              </UiFormField>
            </div>
            <div class="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
              <UiFormField label="工数 (h)">
                <div class="flex items-center gap-1">
                  <button type="button" class="btn btn-sm" aria-label="工数を 0.25h 減らす" @click="stepHours(i, -0.25)">
                    <Minus class="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <input v-model.number="e.hours" type="number" min="0" step="0.25" class="input num w-20 text-right" :aria-label="`エントリ${i + 1} 工数`">
                  <button type="button" class="btn btn-sm" aria-label="工数を 0.25h 増やす" @click="stepHours(i, 0.25)">
                    <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </UiFormField>
              <UiFormField label="進捗 (%)">
                <input v-model.number="e.progress" type="number" min="0" max="100" step="5" class="input num w-20 text-right" :aria-label="`エントリ${i + 1} 進捗`">
              </UiFormField>
              <button type="button" class="btn btn-sm ml-auto text-crit" @click="removeRow(i)">
                <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                行を削除
              </button>
            </div>
          </div>

          <div>
            <button type="button" class="btn btn-sm" @click="addRow">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" />
              行を追加
            </button>
          </div>

          <div class="flex flex-wrap items-center gap-2 rounded-lg bg-surface-soft px-3 py-2 text-xs text-sub">
            <span class="num font-semibold">工数合計 {{ totalHours }}h</span>
            <span v-if="dayWorkMinutes > 0" class="num">/ 勤怠実労働 {{ fmtMinutes(dayWorkMinutes) }}</span>
            <span v-else>/ この日の打刻がないため乖離チェック対象外</span>
            <UiStatusBadge v-if="editorGap !== null" tone="warn" :label="`乖離 ${gapText(editorGap)}`" />
          </div>

          <div class="grid gap-3 md:grid-cols-3">
            <UiFormField label="所感">
              <textarea v-model="editReflection" class="textarea" placeholder="今日のふりかえり" />
            </UiFormField>
            <UiFormField label="課題" hint="記入して提出すると管理者へ自動共有されます">
              <textarea v-model="editIssues" class="textarea" placeholder="困っていること・ブロッカー" />
            </UiFormField>
            <UiFormField label="明日の予定">
              <textarea v-model="editTomorrow" class="textarea" placeholder="翌営業日の予定" />
            </UiFormField>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2">
            <button type="button" class="btn" @click="onSaveDraft">下書き保存</button>
            <button type="button" class="btn btn-primary" @click="onSubmit">
              <Send class="h-3.5 w-3.5" aria-hidden="true" />
              提出
            </button>
          </div>
        </div>
      </UiSectionCard>
      </div>
    </div>

    <!-- ================= チーム（管理者） ================= -->
    <div v-else-if="tab === 'team'" class="grid gap-3">
      <UiSectionCard title="提出状況マトリクス" description="メンバー × 直近 7 営業日。未提出セルをクリックするとリマインドできます" flush>
        <template #actions>
          <button type="button" class="btn btn-sm" @click="remindAll">
            <BellRing class="h-3.5 w-3.5" aria-hidden="true" />
            一括リマインド
          </button>
        </template>
        <div class="overflow-x-auto scroll-slim">
          <table class="tbl">
            <thead>
              <tr>
                <th class="sticky left-0 z-[2] bg-surface-soft">メンバー</th>
                <th v-for="d in matrixDays" :key="d" class="!text-center">{{ dayLabel(d) }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in reports.teamMembers.value" :key="m.id">
                <td class="sticky left-0 z-[1] whitespace-nowrap bg-surface">
                  <span class="flex items-center gap-2">
                    <UiAvatar :name="m.name" size="sm" />
                    <span class="text-[13px] font-semibold">{{ m.name }}</span>
                  </span>
                </td>
                <td v-for="d in matrixDays" :key="d" class="!p-1 text-center">
                  <button
                    type="button"
                    class="inline-flex h-8 w-full min-w-[52px] items-center justify-center rounded-md text-[11px] font-semibold transition-colors"
                    :class="cellClass(m.id, d)"
                    :aria-label="cellAria(m.id, d)"
                    @click="openCell(m.id, d)"
                  >
                    <Check v-if="reports.cellStatus(m.id, d) === 'submitted'" class="h-4 w-4" aria-hidden="true" />
                    <template v-else-if="reports.cellStatus(m.id, d) === 'draft'">{{ REPORT_STATUS_LABELS.draft }}</template>
                    <template v-else>未</template>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiSectionCard>

      <UiSectionCard title="タイムライン" description="チームと AI 社員の日報（直近 7 営業日・新しい順）" flush>
        <UiEmptyState v-if="teamTimeline.length === 0" title="提出済みの日報がありません" />
        <ul v-else class="divide-y divide-line">
          <li v-for="r in teamTimeline" :key="r.id">
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
              @click="drawerReportId = r.id"
            >
              <UiAvatar :name="reports.authorOf(r).name" :kind="reports.authorOf(r).kind" />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span class="text-[13px] font-bold">{{ reports.authorOf(r).name }}</span>
                  <UiStatusBadge v-if="r.authorKind === 'ai'" tone="info" label="AI社員" />
                  <span class="num text-[11px] text-muted">{{ fmtDateLong(r.date) }}</span>
                </span>
                <span class="block truncate text-xs text-sub">{{ r.entries[0]?.task ?? '—' }}</span>
              </span>
              <UiStatusBadge v-if="r.issues" tone="warn" label="課題あり" />
              <span class="num shrink-0 text-xs text-sub">{{ totalHoursOf(r) }}h</span>
            </button>
          </li>
        </ul>
      </UiSectionCard>
    </div>

    <!-- ================= 週報 ================= -->
    <div v-else class="grid gap-3">
      <!-- 今週の週報 -->
      <UiSectionCard
        :title="`今週の週報（${weekLabel(thisWeekStart)}）`"
        :description="myCurrentWeekly?.status === 'submitted' ? '提出済みです' : '日報から下書きを生成できます'"
      >
        <template v-if="myCurrentWeekly?.status !== 'submitted'" #actions>
          <button type="button" class="btn btn-sm" @click="generateFromDailies">
            <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
            日報から下書き生成
          </button>
        </template>

        <!-- 提出済み: 読み取り表示 -->
        <div v-if="myCurrentWeekly && myCurrentWeekly.status === 'submitted'" class="grid gap-3">
          <UiStatusBadge tone="ok" :label="REPORT_STATUS_LABELS.submitted" dot class="justify-self-start" />
          <div class="grid gap-3 md:grid-cols-2">
            <div><p class="label">今週の目標達成</p><p class="whitespace-pre-wrap text-[13px]">{{ myCurrentWeekly.goalReview || '—' }}</p></div>
            <div><p class="label">主要業務</p><p class="whitespace-pre-wrap text-[13px]">{{ myCurrentWeekly.mainWork || '—' }}</p></div>
            <div><p class="label">課題</p><p class="whitespace-pre-wrap text-[13px]">{{ myCurrentWeekly.issues || '—' }}</p></div>
            <div><p class="label">来週の予定</p><p class="whitespace-pre-wrap text-[13px]">{{ myCurrentWeekly.nextWeek || '—' }}</p></div>
          </div>
        </div>

        <!-- エディタ -->
        <div v-else class="grid gap-3">
          <div class="grid gap-3 md:grid-cols-2">
            <UiFormField label="今週の目標達成">
              <textarea v-model="wkGoal" class="textarea" placeholder="目標に対するふりかえり" />
            </UiFormField>
            <UiFormField label="主要業務" required>
              <textarea v-model="wkMain" class="textarea" placeholder="今週の主な業務" />
            </UiFormField>
            <UiFormField label="課題">
              <textarea v-model="wkIssues" class="textarea" placeholder="課題・相談したいこと" />
            </UiFormField>
            <UiFormField label="来週の予定">
              <textarea v-model="wkNext" class="textarea" placeholder="来週やること" />
            </UiFormField>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <button type="button" class="btn" @click="onSaveWeekly(false)">下書き保存</button>
            <button type="button" class="btn btn-primary" @click="onSaveWeekly(true)">
              <Send class="h-3.5 w-3.5" aria-hidden="true" />
              提出
            </button>
          </div>
        </div>
      </UiSectionCard>

      <!-- 過去の週報 -->
      <UiSectionCard title="過去の週報" flush>
        <UiEmptyState v-if="reports.myWeeklies.value.length === 0" title="週報がまだありません" hint="今週の週報を作成すると一覧に表示されます" />
        <ul v-else class="divide-y divide-line">
          <li v-for="w in reports.myWeeklies.value" :key="w.id">
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
              @click="weeklyDrawerId = w.id"
            >
              <span class="num flex-1 text-[13px] font-semibold">{{ weekLabel(w.weekStart) }}</span>
              <UiStatusBadge :tone="w.status === 'submitted' ? 'ok' : 'warn'" :label="REPORT_STATUS_LABELS[w.status]" />
            </button>
          </li>
        </ul>
      </UiSectionCard>
    </div>

    <!-- 日報詳細ドロワー（チームタブ） -->
    <UiDrawer
      :open="!!drawerReport"
      :title="drawerReport && drawerAuthor ? `${drawerAuthor.name} の日報` : '日報'"
      width="560px"
      @close="drawerReportId = null"
    >
      <div v-if="drawerReport && drawerAuthor" class="grid gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <UiAvatar :name="drawerAuthor.name" :kind="drawerAuthor.kind" />
          <div class="min-w-0">
            <p class="flex flex-wrap items-center gap-2 text-[13px] font-bold">
              {{ drawerAuthor.name }}
              <UiStatusBadge v-if="drawerReport.authorKind === 'ai'" tone="info" label="AI社員" />
            </p>
            <p class="num text-[11px] text-muted">{{ fmtDateLong(drawerReport.date) }}</p>
          </div>
          <div class="ml-auto flex flex-wrap gap-1.5">
            <UiStatusBadge
              :tone="drawerReport.status === 'submitted' ? 'ok' : 'warn'"
              :label="REPORT_STATUS_LABELS[drawerReport.status]"
              dot
            />
            <UiStatusBadge v-if="drawerGap !== null" tone="warn" :label="`工数乖離 ${gapText(drawerGap)}`" />
          </div>
        </div>

        <div class="overflow-x-auto scroll-slim">
          <table class="tbl">
            <thead>
              <tr><th>プロジェクト</th><th>作業内容</th><th class="!text-right">工数</th><th class="!text-right">進捗</th></tr>
            </thead>
            <tbody>
              <tr v-for="(e, i) in drawerReport.entries" :key="i">
                <td class="whitespace-nowrap">{{ projectName(e.projectId) }}</td>
                <td>{{ e.task }}</td>
                <td class="num text-right">{{ e.hours }}h</td>
                <td class="num text-right">{{ e.progress }}%</td>
              </tr>
              <tr>
                <td colspan="2" class="text-right text-[11px] font-semibold text-muted">合計</td>
                <td class="num text-right font-bold">{{ totalHoursOf(drawerReport) }}h</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>

        <div class="grid gap-3">
          <div>
            <p class="label">所感</p>
            <p class="whitespace-pre-wrap text-[13px]">{{ drawerReport.reflection || '—' }}</p>
          </div>
          <div v-if="drawerReport.issues" class="rounded-lg bg-warn-soft p-2.5">
            <p class="label !text-warn">課題（管理者へ共有済み）</p>
            <p class="whitespace-pre-wrap text-[13px]">{{ drawerReport.issues }}</p>
          </div>
          <div>
            <p class="label">明日の予定</p>
            <p class="whitespace-pre-wrap text-[13px]">{{ drawerReport.tomorrow || '—' }}</p>
          </div>
        </div>

        <WidgetsCommentThread :report-id="drawerReport.id" />
      </div>
    </UiDrawer>

    <!-- 週報詳細ドロワー -->
    <UiDrawer
      :open="!!weeklyDrawer"
      :title="weeklyDrawer ? `週報 ${weekLabel(weeklyDrawer.weekStart)}` : '週報'"
      @close="weeklyDrawerId = null"
    >
      <div v-if="weeklyDrawer" class="grid gap-3">
        <UiStatusBadge
          :tone="weeklyDrawer.status === 'submitted' ? 'ok' : 'warn'"
          :label="REPORT_STATUS_LABELS[weeklyDrawer.status]"
          dot
          class="justify-self-start"
        />
        <div><p class="label">今週の目標達成</p><p class="whitespace-pre-wrap text-[13px]">{{ weeklyDrawer.goalReview || '—' }}</p></div>
        <div><p class="label">主要業務</p><p class="whitespace-pre-wrap text-[13px]">{{ weeklyDrawer.mainWork || '—' }}</p></div>
        <div><p class="label">課題</p><p class="whitespace-pre-wrap text-[13px]">{{ weeklyDrawer.issues || '—' }}</p></div>
        <div><p class="label">来週の予定</p><p class="whitespace-pre-wrap text-[13px]">{{ weeklyDrawer.nextWeek || '—' }}</p></div>
      </div>
    </UiDrawer>
  </div>
</template>
