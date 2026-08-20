<script setup lang="ts">
/**
 * 期間レポート（週報・月報）の 自分/全員/チーム ビュー（改修依頼 2026-08-19 第4弾）。
 * 週報と月報は同型（期間キー = weekStart / monthStart のみ差異）のため 1 コンポーネントで共通化する（原則3）。
 * - kind='weekly' は「チーム」ビューでのみ本コンポーネントを使う（自分/全員は reports.vue に既存実装がある）。
 * - kind='monthly' は 自分/全員/チーム の全ビューを本コンポーネントで提供する（週報 UI と同等の体験）。
 * - 参照可否は日報・週報と同じ権限（canViewMemberReports）。既読・未読は kind 単位で管理（useReports）。
 * - モバイル前提のレスポンシブ（一覧はカード風リスト・入力は 1〜2 カラム。原則8）。
 */
import { ChevronLeft, ChevronRight, Eye, FileText, Pencil, Send, Sparkles } from 'lucide-vue-next'
import type { MonthlyReport, WeeklyReport } from '~/types/domain'
import { WEEKLY_TEAM_SHARE_DEFAULT, WEEKLY_TEAM_SHARE_KINDS } from '../../../../shared/domain/types'
import type { MonthlyReportInput, WeeklyReportInput } from '~/composables/useReports'
import { MONTHLY_REPORT_EXAMPLE, WEEKLY_REPORT_EXAMPLE } from '~/utils/weekly-report-templates'
import { addDays } from '~/utils/format'

type PeriodReport = WeeklyReport | MonthlyReport

const props = defineProps<{
  kind: 'weekly' | 'monthly'
  /** 表示するビュー（reports.vue のタブから指定） */
  view: 'mine' | 'all' | 'team'
}>()

const reports = useReports()
const { show } = useToast()
const { isRunning, run } = useAsyncAction()
const { currentUserId } = useCurrentUser()

const isWeekly = computed(() => props.kind === 'weekly')

// ---------- kind によるアダプタ（週報/月報で参照する composable 関数・ラベルを切り替える） ----------

/** 期間の開始日（週=月曜 / 月=月初） */
function periodStartOf(date: string): string {
  return isWeekly.value ? reports.weekStartOf(date) : reports.monthStartOf(date)
}
/** 期間キー（保存 body のキー名） */
function periodKey(): 'weekStart' | 'monthStart' {
  return isWeekly.value ? 'weekStart' : 'monthStart'
}
/** 対象レポートの期間開始日を取り出す */
function startOf(r: PeriodReport): string {
  return isWeekly.value ? (r as WeeklyReport).weekStart : (r as MonthlyReport).monthStart
}
function myOn(start: string): PeriodReport | undefined {
  return isWeekly.value ? reports.myWeeklyOn(start) : reports.myMonthlyOn(start)
}
function allSubmitted(start: string): PeriodReport[] {
  return isWeekly.value ? reports.allSubmittedWeeklies(start) : reports.allSubmittedMonthlies(start)
}
async function savePeriod(input: WeeklyReportInput | MonthlyReportInput, submit: boolean) {
  return isWeekly.value
    ? reports.saveWeekly(input as WeeklyReportInput, submit)
    : reports.saveMonthly(input as MonthlyReportInput, submit)
}
async function draftFromLower(start: string): Promise<{ mainWork: string; issues: string }> {
  return isWeekly.value ? reports.draftFromDailies(start) : reports.draftFromWeeklies(start)
}

/** 1 期間ぶん進める / 戻す（週 = ±7 日 / 月 = ±1 か月） */
function stepPeriod(start: string, delta: number): string {
  if (isWeekly.value) return addDays(start, delta * 7)
  const [y, m] = start.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + delta
  const ny = Math.floor(total / 12)
  const nm = (total % 12 + 12) % 12
  return `${ny}-${String(nm + 1).padStart(2, '0')}-01`
}

/** 期間ラベル（週 = M/D〜M/D の週 / 月 = YYYY年M月） */
function periodLabel(start: string): string {
  if (isWeekly.value) {
    const end = addDays(start, 6)
    const md = (d: string): string => { const [, mm, dd] = d.split('-'); return `${Number(mm)}/${Number(dd)}` }
    return `${md(start)}〜${md(end)} の週`
  }
  const [y, m] = start.split('-')
  return `${y}年${Number(m)}月`
}

/** 見出し・欄ラベルの語（週報 = 今週/来週 / 月報 = 今月/来月） */
const L = computed(() => (isWeekly.value
  ? { unit: '週報', cur: '今週', next: '来週', lower: '日報', thisOne: '今週' }
  : { unit: '月報', cur: '今月', next: '来月', lower: '週報', thisOne: '今月' }))

const example = computed(() => (isWeekly.value ? WEEKLY_REPORT_EXAMPLE : MONTHLY_REPORT_EXAMPLE))
const teamShareKindOptions = WEEKLY_TEAM_SHARE_KINDS.map(k => ({ value: k, label: k }))

// ---------- 期間選択 ----------

const selStart = ref(periodStartOf(todayJst()))
const isCurrent = computed(() => selStart.value === periodStartOf(todayJst()))
function movePeriod(delta: number): void { selStart.value = stepPeriod(selStart.value, delta) }
function toCurrent(): void { selStart.value = periodStartOf(todayJst()) }

// ================= 自分（mine）: 参照 + エディタ =================

const selReport = computed(() => myOn(selStart.value))
const editing = ref(false)
const mdPreview = ref(false)
const fGoal = ref('')
const fMain = ref('')
const fIssues = ref('')
const fGood = ref('')
const fNext = ref('')
const fShareKind = ref(WEEKLY_TEAM_SHARE_DEFAULT)
const fShareNote = ref('')

/** 選択期間が変わったら編集状態を解除（未保存の入力を持ち越さない） */
watch(selStart, () => { editing.value = false; mdPreview.value = false })

function loadEditor(): void {
  const r = selReport.value
  fGoal.value = r?.goalReview ?? ''
  fMain.value = r?.mainWork ?? ''
  fIssues.value = r?.issues ?? ''
  fGood.value = r?.goodPoints ?? ''
  fNext.value = r?.nextWeek ?? ''
  fShareKind.value = r?.teamShareKind || WEEKLY_TEAM_SHARE_DEFAULT
  fShareNote.value = r?.teamShareNote ?? ''
}

function startEditing(): void {
  loadEditor()
  editing.value = true
}

async function generateDraft(): Promise<void> {
  await run(`${props.kind}-generate`, async () => {
    const d = await draftFromLower(selStart.value)
    if (d.mainWork) fMain.value = d.mainWork
    if (d.issues) fIssues.value = d.issues
    show(`${L.value.lower}から下書きを生成しました`)
  })
}

/** 例文を各欄へ挿入（入力済みなら上書き確認 = 原則9.5。SoT = utils/weekly-report-templates.ts） */
function insertExample(): void {
  const filled = [fGoal.value, fIssues.value, fGood.value, fNext.value].some(v => v.trim())
  if (filled && !window.confirm('入力済みの内容を例文で上書きします。よろしいですか？')) return
  fGoal.value = example.value.goalReview
  fIssues.value = example.value.issues
  fGood.value = example.value.goodPoints
  fNext.value = example.value.nextWeek
  show('例文を挿入しました')
}

function inputOf(): WeeklyReportInput | MonthlyReportInput {
  const base = {
    goalReview: fGoal.value, mainWork: fMain.value, issues: fIssues.value, nextWeek: fNext.value,
    goodPoints: fGood.value, teamShareKind: fShareKind.value, teamShareNote: fShareNote.value,
  }
  return { [periodKey()]: selStart.value, ...base } as WeeklyReportInput | MonthlyReportInput
}

async function onSave(submit: boolean): Promise<void> {
  await run(`${props.kind}-${submit ? 'submit' : 'draft'}`, async () => {
    const res = await savePeriod(inputOf(), submit)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show(submit ? `${L.value.unit}を提出しました` : '下書きを保存しました')
    if (submit) editing.value = false
  })
}

// 過去の期間レポート一覧（自分）
const myList = computed(() => (isWeekly.value ? reports.myWeeklies.value : reports.myMonthlies.value))
const { page: myPage, pageSize: myPageSize, rows: pagedMyList, total: myTotal } =
  useListView<PeriodReport>({ source: myList })

// ================= 全員（all）=================

const unreadOnly = ref(false)
const allList = computed(() => allSubmitted(selStart.value))
function isUnread(r: PeriodReport): boolean {
  return r.memberId !== currentUserId.value && !reports.isReportRead(props.kind, r.id)
}
const visibleAll = computed(() => (unreadOnly.value ? allList.value.filter(isUnread) : allList.value))
const unreadCount = computed(() => allList.value.filter(isUnread).length)
const { page: allPage, pageSize: allPageSize, rows: pagedAll, total: allTotal } =
  useListView<PeriodReport>({ source: visibleAll })

/** 本文プレビュー（成果・主要業務・課題の抜粋。一覧のカードに 2 行まで表示） */
function previewItems(r: PeriodReport): { label: string; text: string }[] {
  return [
    { label: `${L.value.cur}の成果`, text: r.goalReview },
    { label: `${L.value.cur}の主要業務`, text: r.mainWork },
    { label: '課題・原因仮説', text: r.issues },
  ].filter(it => it.text.trim())
}

// ================= チーム（team）: 期間の提出状況 =================

/** チーム対象メンバー（日報チームタブと同じ可視ルール） */
const teamRoster = computed(() => reports.teamMembers.value)
/** 選択期間の提出済みレポート（他者 = 参照可のもの / 自分 = 下書きも含む myOn） */
const teamStatus = computed(() => {
  const submitted = new Map(allSubmitted(selStart.value).map(r => [r.memberId, r]))
  const mine = myOn(selStart.value)
  return teamRoster.value.map((m) => {
    const own = m.id === currentUserId.value
    const rep = own ? mine : submitted.get(m.id)
    const cell: 'submitted' | 'draft' | 'none' = rep
      ? (rep.status === 'submitted' ? 'submitted' : 'draft')
      : 'none'
    return { member: m, report: rep, cell, own }
  })
})
const teamSubmittedCount = computed(() => teamStatus.value.filter(s => s.cell === 'submitted').length)

// ================= 詳細ドロワー（全員 / チーム） =================

const drawerId = ref<string | null>(null)
const drawerReport = computed<PeriodReport | null>(() => {
  if (!drawerId.value) return null
  return (isWeekly.value ? reports.weeklyById(drawerId.value) : reports.monthlyById(drawerId.value)) ?? null
})
function openReport(r: PeriodReport): void {
  drawerId.value = r.id
  if (r.memberId !== currentUserId.value) void reports.markReportRead(props.kind, r.id)
}

/** 未読に戻す（自動既読の取消フロー = 原則9.5。週報/月報共通。レビュー R1 = 月報に取消導線が無かった） */
async function onMarkUnread(): Promise<void> {
  const r = drawerReport.value
  if (!r) return
  const res = await reports.markReportUnread(props.kind, r.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  drawerId.value = null
  show('未読に戻しました')
}
</script>

<template>
  <div class="grid gap-3">
    <!-- 期間ナビ（自分/全員/チーム で共通） -->
    <UiFilterBar>
      <div class="flex items-center gap-1.5">
        <button type="button" class="btn btn-sm" :aria-label="`前の${isWeekly ? '週' : '月'}へ`" @click="movePeriod(-1)">
          <ChevronLeft class="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-sm" :disabled="isCurrent" @click="toCurrent">{{ L.thisOne }}</button>
        <button type="button" class="btn btn-sm" :aria-label="`次の${isWeekly ? '週' : '月'}へ`" @click="movePeriod(1)">
          <ChevronRight class="h-4 w-4" aria-hidden="true" />
        </button>
        <span class="num ml-1 whitespace-nowrap text-xs font-semibold">{{ periodLabel(selStart) }}</span>
        <UiStatusBadge v-if="isCurrent" :label="L.thisOne" tone="brand" />
      </div>
      <template v-if="view === 'all'" #trailing>
        <button
          type="button" class="btn btn-sm" :class="unreadOnly ? 'btn-primary' : ''"
          :aria-pressed="unreadOnly" @click="unreadOnly = !unreadOnly"
        >未読のみ</button>
        <UiStatusBadge v-if="unreadCount > 0" tone="brand" :label="`未読 ${unreadCount} 件`" dot />
      </template>
      <template v-else-if="view === 'mine'" #trailing>
        <UiStatusBadge
          :tone="selReport?.status === 'submitted' ? 'ok' : selReport ? 'warn' : 'neutral'"
          :label="selReport ? REPORT_STATUS_LABELS[selReport.status] : '未作成'"
          dot
        />
      </template>
    </UiFilterBar>

    <!-- ================= 自分 ================= -->
    <template v-if="view === 'mine'">
      <UiSectionCard
        :title="`${isCurrent ? L.thisOne : `選択${isWeekly ? '週' : '月'}`}の${L.unit}（${periodLabel(selStart)}）`"
        :description="selReport?.status === 'submitted'
          ? '提出済みです'
          : editing ? `${L.lower}から下書きを生成できます` : `「${L.unit}を書く」から入力できます`"
      >
        <template v-if="selReport?.status !== 'submitted'" #actions>
          <button v-if="!editing" type="button" class="btn btn-primary btn-sm" @click="startEditing">
            <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
            {{ L.unit }}を書く
          </button>
          <UiButton v-else size="sm" :loading="isRunning(`${kind}-generate`)" @click="generateDraft">
            <template #icon><Sparkles class="h-3.5 w-3.5" aria-hidden="true" /></template>
            {{ L.lower }}から下書き生成
          </UiButton>
        </template>

        <!-- 提出済み: 読み取り表示 -->
        <div v-if="selReport && selReport.status === 'submitted'" class="grid gap-3">
          <UiStatusBadge tone="ok" :label="REPORT_STATUS_LABELS.submitted" dot class="justify-self-start" />
          <div class="grid gap-3 md:grid-cols-2">
            <div><p class="label">{{ L.cur }}の成果・達成感</p><UiMarkdown v-if="selReport.goalReview" :source="selReport.goalReview" /><p v-else class="text-[13px]">—</p></div>
            <div><p class="label">{{ L.cur }}の主要業務</p><UiMarkdown v-if="selReport.mainWork" :source="selReport.mainWork" /><p v-else class="text-[13px]">—</p></div>
            <div><p class="label">{{ L.cur }}の課題・原因仮説</p><UiMarkdown v-if="selReport.issues" :source="selReport.issues" /><p v-else class="text-[13px]">—</p></div>
            <div><p class="label">{{ L.cur }}うまくいったこと・続けたいこと</p><UiMarkdown v-if="selReport.goodPoints" :source="selReport.goodPoints" /><p v-else class="text-[13px]">—</p></div>
            <div><p class="label">{{ L.next }}の最重要テーマ（最大3つ）</p><UiMarkdown v-if="selReport.nextWeek" :source="selReport.nextWeek" /><p v-else class="text-[13px]">—</p></div>
            <div><p class="label">チーム共有事項</p><p class="text-[13px]">{{ selReport.teamShareKind || WEEKLY_TEAM_SHARE_DEFAULT }}{{ selReport.teamShareNote ? `／${selReport.teamShareNote}` : '' }}</p></div>
          </div>
        </div>

        <!-- 未提出・未編集: 状態表示のみ -->
        <div v-else-if="!editing" class="flex flex-wrap items-center gap-2">
          <UiStatusBadge :tone="selReport ? 'warn' : 'neutral'" :label="selReport ? REPORT_STATUS_LABELS.draft : '未作成'" dot />
          <span class="text-xs text-muted">
            {{ selReport ? `下書きが保存されています。「${L.unit}を書く」から続きを編集できます` : `${isCurrent ? L.thisOne : `この${isWeekly ? '週' : '月'}`}の${L.unit}はまだ作成されていません` }}
          </span>
        </div>

        <!-- エディタ -->
        <div v-else class="grid gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <button type="button" class="btn btn-sm" @click="insertExample">
              <FileText class="h-3.5 w-3.5" aria-hidden="true" />
              例文を挿入
            </button>
            <button type="button" class="btn btn-sm" :aria-pressed="mdPreview" @click="mdPreview = !mdPreview">
              <component :is="mdPreview ? Pencil : Eye" class="h-3.5 w-3.5" aria-hidden="true" />
              {{ mdPreview ? '編集に戻る' : 'プレビュー' }}
            </button>
          </div>
          <div class="grid gap-3 md:grid-cols-2">
            <UiFormField :label="`${L.cur}の成果・達成感`">
              <div v-if="mdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="fGoal" /></div>
              <textarea v-else v-model="fGoal" class="textarea" :placeholder="example.goalReview" />
            </UiFormField>
            <UiFormField :label="`${L.cur}の主要業務`" required>
              <div v-if="mdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="fMain" /></div>
              <textarea v-else v-model="fMain" class="textarea" :placeholder="`${L.cur}の主な業務`" />
            </UiFormField>
            <UiFormField :label="`${L.cur}の課題・原因仮説`">
              <div v-if="mdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="fIssues" /></div>
              <textarea v-else v-model="fIssues" class="textarea" :placeholder="example.issues" />
            </UiFormField>
            <UiFormField :label="`${L.cur}うまくいったこと・続けたいこと`">
              <div v-if="mdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="fGood" /></div>
              <textarea v-else v-model="fGood" class="textarea" :placeholder="example.goodPoints" />
            </UiFormField>
            <UiFormField :label="`${L.next}の最重要テーマ（最大3つ）`">
              <div v-if="mdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="fNext" /></div>
              <textarea v-else v-model="fNext" class="textarea" :placeholder="example.nextWeek" />
            </UiFormField>
          </div>
          <UiFormField label="チーム共有事項">
            <div class="grid gap-1.5">
              <UiChipTabs
                :model-value="fShareKind" :options="teamShareKindOptions" aria-label="チーム共有事項の種別"
                @update:model-value="(v: string) => { fShareKind = v }"
              />
              <textarea v-model="fShareNote" class="textarea" placeholder="共有したい内容（任意）" aria-label="チーム共有事項の内容" />
            </div>
          </UiFormField>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <button type="button" class="btn" @click="editing = false">閉じる</button>
            <UiButton :loading="isRunning(`${kind}-draft`)" @click="onSave(false)">下書き保存</UiButton>
            <UiButton variant="primary" :loading="isRunning(`${kind}-submit`)" @click="onSave(true)">
              <template #icon><Send class="h-3.5 w-3.5" aria-hidden="true" /></template>
              提出
            </UiButton>
          </div>
        </div>
      </UiSectionCard>

      <!-- 過去の期間レポート -->
      <UiSectionCard :title="`過去の${L.unit}`" flush>
        <UiEmptyState v-if="myList.length === 0" :title="`${L.unit}がまだありません`" :hint="`${L.thisOne}の${L.unit}を作成すると一覧に表示されます`" />
        <ul v-else class="divide-y divide-line">
          <li v-for="r in pagedMyList" :key="r.id">
            <button type="button" class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft" @click="openReport(r)">
              <span class="num flex-1 text-[13px] font-semibold">{{ periodLabel(startOf(r)) }}</span>
              <UiStatusBadge :tone="r.status === 'submitted' ? 'ok' : 'warn'" :label="REPORT_STATUS_LABELS[r.status]" />
            </button>
          </li>
        </ul>
        <UiPagination v-model:page="myPage" v-model:page-size="myPageSize" :total="myTotal" />
      </UiSectionCard>
    </template>

    <!-- ================= 全員 ================= -->
    <UiSectionCard
      v-else-if="view === 'all'"
      :title="`全員の${L.unit}`"
      :description="`選択した${isWeekly ? '週' : '月'}の提出済み${L.unit}。開くと既読になります。参照できる範囲は権限設定（日報・週報の参照対象）に従います`"
      flush
    >
      <UiEmptyState
        v-if="visibleAll.length === 0"
        :title="unreadOnly ? `未読の${L.unit}はありません` : `この${isWeekly ? '週' : '月'}の提出済み${L.unit}がありません`"
        :hint="unreadOnly ? 'すべて既読です（「未読のみ」を解除すると全件表示されます）' : `「自分の${L.unit}」から提出すると、ここに表示されます`"
      />
      <ul v-else class="divide-y divide-line">
        <li v-for="r in pagedAll" :key="r.id">
          <button type="button" class="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft" @click="openReport(r)">
            <UiAvatar :name="reports.memberName(r.memberId)" size="sm" />
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-1.5">
                <span class="text-[13px] font-bold">{{ reports.memberName(r.memberId) }}</span>
                <span class="num text-[11px] text-muted">{{ periodLabel(startOf(r)) }}</span>
                <UiStatusBadge v-if="isUnread(r)" tone="brand" label="未読" dot />
              </span>
              <span v-if="previewItems(r).length > 0" class="mt-1 grid gap-1">
                <span v-for="it in previewItems(r)" :key="it.label" class="grid gap-0.5">
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
      <UiPagination v-model:page="allPage" v-model:page-size="allPageSize" :total="allTotal" />
    </UiSectionCard>

    <!-- ================= チーム（提出状況） ================= -->
    <UiSectionCard
      v-else
      :title="`チームの${L.unit}提出状況`"
      :description="`選択した${isWeekly ? '週' : '月'}のメンバー別提出状況。提出済みは開いて内容を確認できます`"
      flush
    >
      <template #actions>
        <span class="num text-xs text-muted">{{ teamSubmittedCount }} / {{ teamRoster.length }} 名 提出</span>
      </template>
      <UiEmptyState v-if="teamRoster.length === 0" title="対象メンバーがいません" hint="表示メンバー設定・参照権限をご確認ください" />
      <ul v-else class="divide-y divide-line">
        <li v-for="s in teamStatus" :key="s.member.id">
          <component
            :is="s.report && s.cell === 'submitted' ? 'button' : 'div'"
            :type="s.report && s.cell === 'submitted' ? 'button' : undefined"
            class="flex w-full items-center gap-3 px-3 py-2.5 text-left"
            :class="s.report && s.cell === 'submitted' ? 'transition-colors hover:bg-brand-soft' : ''"
            @click="s.report && s.cell === 'submitted' ? openReport(s.report) : undefined"
          >
            <UiAvatar :name="s.member.name" size="sm" />
            <span class="min-w-0 flex-1">
              <span class="text-[13px] font-semibold">{{ s.member.name }}<span v-if="s.own" class="ml-1 text-[11px] text-muted">（自分）</span></span>
            </span>
            <UiStatusBadge
              :tone="s.cell === 'submitted' ? 'ok' : s.cell === 'draft' ? 'warn' : 'neutral'"
              :label="s.cell === 'submitted' ? REPORT_STATUS_LABELS.submitted : s.cell === 'draft' ? REPORT_STATUS_LABELS.draft : '未提出'"
              dot
            />
          </component>
        </li>
      </ul>
    </UiSectionCard>

    <!-- 詳細ドロワー（全員 / チーム / 過去一覧の参照） -->
    <UiDrawer
      :open="!!drawerReport"
      :title="drawerReport ? `${reports.memberName(drawerReport.memberId)} の${L.unit}` : L.unit"
      width="560px"
      @close="drawerId = null"
    >
      <div v-if="drawerReport" class="grid gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="num text-[13px] font-semibold">{{ periodLabel(startOf(drawerReport)) }}</span>
          <UiStatusBadge :tone="drawerReport.status === 'submitted' ? 'ok' : 'warn'" :label="REPORT_STATUS_LABELS[drawerReport.status]" dot />
        </div>
        <div><p class="label">{{ L.cur }}の成果・達成感</p><UiMarkdown v-if="drawerReport.goalReview" :source="drawerReport.goalReview" /><p v-else class="text-[13px]">—</p></div>
        <div><p class="label">{{ L.cur }}の主要業務</p><UiMarkdown v-if="drawerReport.mainWork" :source="drawerReport.mainWork" /><p v-else class="text-[13px]">—</p></div>
        <div><p class="label">{{ L.cur }}の課題・原因仮説</p><UiMarkdown v-if="drawerReport.issues" :source="drawerReport.issues" /><p v-else class="text-[13px]">—</p></div>
        <div><p class="label">{{ L.cur }}うまくいったこと・続けたいこと</p><UiMarkdown v-if="drawerReport.goodPoints" :source="drawerReport.goodPoints" /><p v-else class="text-[13px]">—</p></div>
        <div><p class="label">{{ L.next }}の最重要テーマ（最大3つ）</p><UiMarkdown v-if="drawerReport.nextWeek" :source="drawerReport.nextWeek" /><p v-else class="text-[13px]">—</p></div>
        <div><p class="label">チーム共有事項</p><p class="text-[13px]">{{ drawerReport.teamShareKind || WEEKLY_TEAM_SHARE_DEFAULT }}{{ drawerReport.teamShareNote ? `／${drawerReport.teamShareNote}` : '' }}</p></div>
        <!-- 自動既読の取消（他メンバーの提出済みのみ = 自分のレポートは既読管理の対象外。原則9.5） -->
        <div v-if="drawerReport.memberId !== currentUserId" class="flex justify-end border-t border-line pt-2">
          <button type="button" class="btn btn-ghost btn-sm" @click="onMarkUnread">未読に戻す</button>
        </div>
      </div>
    </UiDrawer>
  </div>
</template>
