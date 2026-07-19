<script setup lang="ts">
/**
 * AIネイティブカンパニー（F-08）
 * 上段: アイソメトリックオフィス（クリック → 詳細ドロワー → タスク依頼 → 分解案承認）
 * 下段: タスクボード / 活動ログ / 日次報告
 */
import { Paperclip, Send, Settings2, Sparkles, Users, X } from 'lucide-vue-next'
import { DELEGATE_PERMISSION } from '../../../../shared/domain/ai-tasks'
import type { AiTask } from '~/types/domain'
import { AI_EMPLOYEE_STATUS_LABELS, AI_TASK_STATUS_LABELS } from '~/utils/labels'

const {
  employees, employeesAll, roleOf, employeeById, tasks, tasksOf, logs, aiReportsOn,
  requestTask, approveTask, progressTask, answerTask, blockTask, cancelTask, generateDailyReports,
  evaluateWorkloadSignals, reloadAi,
} = useAiCompany()
const { show } = useToast()
const { ask } = useConfirm()
const { currentUser, isAdmin } = useCurrentUser()

// 承認・回答後の自動実行（バッチ7i）は API モードではサーバー側で走るため、
// 進捗（ステップ完了・質問・完了報告）を数回ポーリングして画面へ反映する（モックは同期完了 = 不要）
const apiModeActive = useApiMode()
// 実 LLM は 1 ステップ数十秒 × 複数ステップ = 数分規模のため、5 秒間隔 × 最大 36 回（約 3 分）追跡する
//（R1 M-4。実行中タスクがなくなれば自然停止・それ以降は通知 + 手動の再読み込みで確認）
let pollTimer: ReturnType<typeof setTimeout> | null = null
function pollAutoRun(times = 36): void {
  if (!apiModeActive || times <= 0) return
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    await reloadAi()
    // 実行中タスクが残っている間だけ追跡を続ける（質問・完了で自然停止）
    if (tasks.value.some(t => t.status === 'in_progress')) pollAutoRun(times - 1)
  }, 5000)
}
onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer)
})

/** 添付の受付形式（フリーテキストと合わせた依頼者インプット = バッチ7f） */
const ATTACH_ACCEPT = '.md,.txt,.pdf,.docx,.pptx,.jpg,.jpeg,.png'
const ATTACH_EXTS = new Set(['md', 'txt', 'pdf', 'docx', 'pptx', 'jpg', 'jpeg', 'png'])
const ATTACH_MAX_BYTES = 10 * 1024 * 1024
const ATTACH_MAX_COUNT = 5

/** 添付の事前検証（サーバーの AKO-AIC-010/011 と同じ基準。不合格は理由をトーストして除外） */
function validateAttachments(current: File[], selected: File[]): File[] {
  const ok: File[] = [...current]
  for (const f of selected) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    if (!ATTACH_EXTS.has(ext)) {
      show(`「${f.name}」は非対応形式です（${ATTACH_ACCEPT}）`, 'warn')
      continue
    }
    if (f.size === 0 || f.size > ATTACH_MAX_BYTES) {
      show(`「${f.name}」は空か 10MB を超えています`, 'warn')
      continue
    }
    if (ok.length >= ATTACH_MAX_COUNT) {
      show(`添付は ${ATTACH_MAX_COUNT} 件までです（「${f.name}」以降を外しました）`, 'warn')
      break
    }
    ok.push(f)
  }
  return ok
}

// ---------- シグナル検知（stalled_task / overload） ----------

// 補助処理: 画面表示後に非ブロッキングで検知する（evaluateWorkloadSignals は内部で例外を握りつぶす）
onMounted(async () => {
  const { raised } = await evaluateWorkloadSignals()
  if (raised > 0) {
    show(`${raised}件のシグナルをエスカレーションしました`, 'warn', { label: '確認する', to: '/inbox' })
  }
})

// ---------- オフィス + 詳細ドロワー ----------

const selectedEmpId = ref<string | null>(null)
const selectedEmp = computed(() => (selectedEmpId.value ? employeeById(selectedEmpId.value) : undefined))
const selectedRole = computed(() => roleOf(selectedEmp.value))
const selectedTasks = computed(() =>
  selectedEmpId.value
    ? tasksOf(selectedEmpId.value).filter(t => t.status !== 'done' && t.status !== 'cancelled')
    : [])

const roleNames = computed<Record<string, string>>(() =>
  Object.fromEntries(employees.value.map(e => [e.id, roleOf(e)?.name ?? ''])))

function openEmployee(id: string): void {
  selectedEmpId.value = id
  reqTitle.value = ''
  reqDesc.value = ''
  reqFiles.value = []
  proposedTaskId.value = null
}

// ---------- タスク依頼フォーム ----------

const reqTitle = ref('')
const reqDesc = ref('')
const reqError = ref('')
const reqFiles = ref<File[]>([])
const reqFileInput = ref<HTMLInputElement | null>(null)

function onReqFilesSelected(ev: Event): void {
  const list = (ev.target as HTMLInputElement).files
  if (reqFileInput.value) reqFileInput.value.value = '' // 同一ファイルの再選択を可能にする
  if (!list) return
  reqFiles.value = validateAttachments(reqFiles.value, Array.from(list))
}

function removeReqFile(i: number): void {
  reqFiles.value = reqFiles.value.filter((_, x) => x !== i)
}
const proposedTaskId = ref<string | null>(null)
const proposedTask = computed<AiTask | undefined>(() =>
  proposedTaskId.value ? tasks.value.find(t => t.id === proposedTaskId.value) : undefined)

async function submitRequest(): Promise<void> {
  reqError.value = ''
  if (!selectedEmpId.value) return
  if (!reqTitle.value.trim()) {
    reqError.value = '件名を入力してください'
    return
  }
  const res = await requestTask(selectedEmpId.value, reqTitle.value, reqDesc.value, reqFiles.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  proposedTaskId.value = res.id
  reqFiles.value = []
  if (res.confidence === 'low') {
    show('確信度が低いため、分解案の確認を推奨します（管理者へエスカレーション済み）', 'warn', { label: '通知を確認', to: '/inbox' })
  } else {
    show('分解案を作成しました。内容を確認して承認してください')
  }
}

async function approveProposal(): Promise<void> {
  if (!proposedTaskId.value) return
  const res = await approveTask(proposedTaskId.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(`${selectedEmp.value?.name ?? 'AI社員'} が実行を開始しました。全ステップを自動で遂行します（確認が必要な場合・完了時は通知が届きます）`)
  reqTitle.value = ''
  reqDesc.value = ''
  proposedTaskId.value = null
  pollAutoRun()
}

// ---------- タスク詳細（成果物・質問と回答 = バッチ7f 実遂行） ----------

const detailTaskId = ref<string | null>(null)
const detailTask = computed(() => (detailTaskId.value ? tasks.value.find(t => t.id === detailTaskId.value) : undefined))
const openQuestion = computed(() => (detailTask.value?.questions ?? []).find(q => q.status === 'open'))
/** 回答できるのは依頼者本人または管理者（API 側ガードと同一） */
const canAnswer = computed(() =>
  !!detailTask.value && (detailTask.value.requesterId === currentUser.value.id || isAdmin.value))

const answerText = ref('')
const answerFiles = ref<File[]>([])
const answerFileInput = ref<HTMLInputElement | null>(null)
const answering = ref(false)

function openDetail(taskId: string): void {
  detailTaskId.value = taskId
  answerText.value = ''
  answerFiles.value = []
}

function onAnswerFilesSelected(ev: Event): void {
  const list = (ev.target as HTMLInputElement).files
  if (answerFileInput.value) answerFileInput.value.value = ''
  if (!list) return
  answerFiles.value = validateAttachments(answerFiles.value, Array.from(list))
}

function removeAnswerFile(i: number): void {
  answerFiles.value = answerFiles.value.filter((_, x) => x !== i)
}

// M-5: 添付原本のダウンロード（依頼者 or 管理者。API モードのみ = モックは原本を保存しない設計判断）
const canDownloadFiles = computed(() =>
  !!detailTask.value && (detailTask.value.requesterId === currentUser.value.id || isAdmin.value))

async function downloadFile(fileId: string, filename: string): Promise<void> {
  if (!useApiMode()) {
    show('モックモードは原本を保存していません（メタのみ）', 'warn')
    return
  }
  try {
    const data = await apiFetch<{ filename: string; mime: string; contentBase64: string }>(
      `/v1/ai-company/files/${fileId}`)
    const bin = atob(data.contentBase64)
    const buf = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([buf], { type: data.mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = data.filename || filename
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    show(apiErrorOf(e).message, 'warn')
  }
}

async function submitAnswer(): Promise<void> {
  if (!detailTaskId.value || answering.value) return
  answering.value = true
  try {
    const res = await answerTask(detailTaskId.value, answerText.value, answerFiles.value)
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'warn')
      return
    }
    answerText.value = ''
    answerFiles.value = []
    show('回答を送信しました。実行を自動で再開します')
    pollAutoRun()
  } finally {
    answering.value = false
  }
}

/** 詳細モーダルからの再開（自動実行が止まった場合のフォールバック導線。バッチ7i） */
async function progressFromDetail(): Promise<void> {
  if (!detailTaskId.value) return
  await onProgress(detailTaskId.value)
}

function stepOutputs(t: { outputs?: { step: number }[] }): { step: number; title: string; body: string; at: string }[] {
  return ((t.outputs ?? []) as { step: number; title: string; body: string; at: string }[])
}

// ---------- 下段タブ ----------

const tab = ref('board')
const tabs = computed(() => [
  { key: 'board', label: 'タスクボード', badge: tasks.value.filter(t => t.status === 'proposed').length },
  { key: 'logs', label: '活動ログ' },
  { key: 'daily', label: '日次報告' },
])

async function onApprove(taskId: string): Promise<void> {
  const res = await approveTask(taskId)
  show(res.ok
    ? '承認しました。全ステップを自動で遂行します（確認が必要な場合・完了時は通知が届きます）'
    : res.error.message, res.ok ? 'ok' : 'warn')
  if (res.ok) pollAutoRun()
}

async function onProgress(taskId: string): Promise<void> {
  const res = await progressTask(taskId)
  if (!res.ok) {
    // 自動実行が生きている最中の「再開」は競合（009）になる = エラーではなく進行中の案内（R1 M-4）
    if (res.error.code === 'AKO-AIC-009') {
      show('自動実行が進行中です。進捗は順次反映されます', 'info')
      pollAutoRun()
      return
    }
    show(res.error.message, 'warn')
    return
  }
  const task = tasks.value.find(t => t.id === taskId)
  if (task?.status === 'done') {
    show('全ステップを遂行し、成果を統合して依頼者へ報告しました', 'ok', { label: '通知を確認', to: '/inbox' })
  } else if ((task?.questions ?? []).some(q => q.status === 'open')) {
    // 実遂行で人間のアクションが必要と判定 = 依頼者へ確認（バッチ7f）
    show('遂行に確認が必要なため、依頼者へ質問しました（詳細から回答できます）', 'warn')
  } else {
    show('ステップを遂行しました。残りのステップも自動で遂行します')
    pollAutoRun()
  }
}

async function onBlock(taskId: string): Promise<void> {
  const before = tasks.value.find(t => t.id === taskId)?.status
  const res = await blockTask(taskId)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(before === 'blocked' ? 'ブロックを解除し、残りのステップを自動で遂行します' : 'タスクをブロックしました', before === 'blocked' ? 'ok' : 'warn')
  if (before === 'blocked') pollAutoRun()
}

async function onCancel(taskId: string): Promise<void> {
  const task = tasks.value.find(t => t.id === taskId)
  const okAsk = await ask('タスクの中止', `「${task?.title ?? taskId}」を中止しますか？`, { confirmLabel: '中止する', danger: true })
  if (!okAsk) return
  const res = await cancelTask(taskId)
  show(res.ok ? 'タスクを中止しました' : res.error.message, res.ok ? 'ok' : 'warn')
}

// ---------- 日次報告 ----------

const reportDate = ref(todayJst())
const aiReports = computed(() => aiReportsOn(reportDate.value))
/** 生成中フラグ（二重押下防止。サーバー側は部分一意 + ON CONFLICT で冪等だが UI でも抑止する） */
const generating = ref(false)

async function onGenerateReports(): Promise<void> {
  if (generating.value) return
  generating.value = true
  try {
    const { created, skipped } = await generateDailyReports(reportDate.value)
    if (created === 0 && skipped === 0) {
      show('この日の AI 活動ログがないため、生成対象がありません', 'warn')
      return
    }
    show(
      `日次報告を ${created} 件生成しました（既存 ${skipped} 件はスキップ）。日報・週報にも掲載されます`,
      'ok',
      { label: '日報を見る', to: '/reports' },
    )
  } finally {
    generating.value = false
  }
}
</script>

<template>
  <div>
    <UiPageHeader title="AIネイティブカンパニー" description="AI 社員のオフィス。クリックしてタスクを依頼できます">
      <template #actions>
        <NuxtLink v-if="isAdmin" to="/ai-company/employees" class="btn btn-sm">
          <Users class="h-3.5 w-3.5" aria-hidden="true" />
          AI 社員の管理
        </NuxtLink>
        <NuxtLink to="/ai-company/roles" class="btn btn-sm">
          <Settings2 class="h-3.5 w-3.5" aria-hidden="true" />
          ロール設定
        </NuxtLink>
      </template>
    </UiPageHeader>

    <!-- 上段: アイソメトリックオフィス -->
    <UiSectionCard title="AIオフィス" description="状態: 緑=実行中 / 橙=承認待ち / グレー=待機中">
      <OfficeIsometricOffice
        :employees="employees"
        :role-names="roleNames"
        :selected-id="selectedEmpId"
        @select="openEmployee"
      />
      <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-sub" aria-hidden="true">
        <span class="inline-flex items-center gap-1"><span class="h-2.5 w-2.5 rounded-full bg-ok" />実行中</span>
        <span class="inline-flex items-center gap-1"><span class="h-2.5 w-2.5 rounded-full bg-warn" />承認待ち</span>
        <span class="inline-flex items-center gap-1"><span class="h-2.5 w-2.5 rounded-full bg-muted" />待機中</span>
      </div>
    </UiSectionCard>

    <!-- 下段: タブ -->
    <div class="mt-3">
      <UiTabBar v-model="tab" :tabs="tabs" />
      <div class="mt-3">
        <OfficeAiTaskBoard
          v-if="tab === 'board'"
          :tasks="tasks"
          :employees="employeesAll"
          @approve="onApprove"
          @progress="onProgress"
          @block="onBlock"
          @cancel="onCancel"
          @detail="openDetail"
        />

        <UiSectionCard v-else-if="tab === 'logs'" title="活動ログ" description="AI 社員の活動を時系列で記録（tokens / コストはモック値）">
          <!-- 名前解決は無効化済み AI 社員も含む（過去ログの担当名を生 id にしない = タスクボードと同様） -->
          <OfficeActivityTimeline :logs="logs" :employees="employeesAll" :tasks="tasks" />
        </UiSectionCard>

        <div v-else-if="tab === 'daily'" class="grid gap-3">
          <UiSectionCard title="日次活動報告の生成" description="活動ログを AI 社員ごとに集約します。生成済みの日はスキップされます（冪等）">
            <div class="flex flex-wrap items-center gap-2">
              <input
                v-model="reportDate"
                type="date"
                class="input w-auto"
                aria-label="報告対象日"
              >
              <button type="button" class="btn btn-primary" :disabled="generating" @click="onGenerateReports">
                {{ generating ? '生成中…' : 'この日の報告を生成' }}
              </button>
              <NuxtLink to="/reports" class="link ml-auto text-xs">日報・週報タイムラインを見る →</NuxtLink>
            </div>
          </UiSectionCard>

          <UiEmptyState
            v-if="aiReports.length === 0"
            icon="FileText"
            title="この日の AI 日次報告はまだありません"
            hint="「この日の報告を生成」を押すと活動ログから作成されます"
          />
          <UiSectionCard
            v-for="r in aiReports"
            :key="r.id"
            :title="`${employeeById(r.aiEmployeeId ?? '')?.name ?? 'AI社員'} の日次報告`"
            :description="`${r.date} / 提出済み`"
          >
            <template #actions>
              <UiAvatar :name="employeeById(r.aiEmployeeId ?? '')?.name ?? 'AI'" kind="ai" size="sm" />
            </template>
            <ul class="grid gap-1.5">
              <li v-for="(e, i) in r.entries" :key="i" class="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span class="font-medium">{{ e.task }}</span>
                <span class="num text-[11px] text-muted">{{ e.hours }}h / 進捗 {{ e.progress }}%</span>
              </li>
            </ul>
            <dl class="mt-2 grid gap-1 border-t border-line pt-2 text-xs">
              <div class="flex gap-2">
                <dt class="shrink-0 font-semibold text-muted">所感</dt>
                <dd class="num text-sub">{{ r.reflection }}</dd>
              </div>
              <div v-if="r.issues" class="flex gap-2">
                <dt class="shrink-0 font-semibold text-warn">課題</dt>
                <dd class="text-sub">{{ r.issues }}</dd>
              </div>
              <div class="flex gap-2">
                <dt class="shrink-0 font-semibold text-muted">明日</dt>
                <dd class="text-sub">{{ r.tomorrow }}</dd>
              </div>
            </dl>
          </UiSectionCard>
        </div>
      </div>
    </div>

    <!-- タスク詳細（成果物・質問と回答 = バッチ7f 実遂行） -->
    <UiModal
      :open="!!detailTask"
      :title="detailTask?.title ?? ''"
      width="720px"
      @close="detailTaskId = null"
    >
      <div v-if="detailTask" class="grid gap-4">
        <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <UiAvatar :name="employeeById(detailTask.aiEmployeeId)?.name ?? 'AI'" kind="ai" size="sm" />
          <span>{{ employeeById(detailTask.aiEmployeeId)?.name ?? detailTask.aiEmployeeId }}</span>
          <UiStatusBadge :label="AI_TASK_STATUS_LABELS[detailTask.status]" :tone="AI_TASK_STATUS_TONES[detailTask.status]" />
          <span class="num ml-auto">{{ detailTask.createdAt.slice(0, 16).replace('T', ' ') }}</span>
        </div>

        <div v-if="detailTask.description" class="rounded-lg bg-page p-3">
          <p class="text-[11px] font-bold text-muted">依頼内容</p>
          <p class="mt-0.5 whitespace-pre-wrap text-[13px]">{{ detailTask.description }}</p>
        </div>

        <!-- 添付 -->
        <div v-if="(detailTask.files ?? []).length > 0">
          <p class="mb-1 text-[11px] font-bold text-muted">添付（{{ (detailTask.files ?? []).length }}件）</p>
          <ul class="flex flex-wrap gap-1.5">
            <li v-for="f in detailTask.files" :key="f.id">
              <button
                v-if="canDownloadFiles"
                type="button"
                class="rounded-full border border-line bg-surface-soft px-2.5 py-0.5 text-[11px] transition-colors hover:bg-brand-soft"
                :aria-label="`「${f.filename}」をダウンロード`"
                @click="downloadFile(f.id, f.filename)"
              >{{ f.filename }}<span class="num text-muted">（{{ Math.ceil(f.sizeBytes / 1024) }}KB）</span> ⬇</button>
              <span v-else class="rounded-full border border-line bg-surface-soft px-2.5 py-0.5 text-[11px]">
                {{ f.filename }}<span class="num text-muted">（{{ Math.ceil(f.sizeBytes / 1024) }}KB）</span>
              </span>
            </li>
          </ul>
        </div>

        <!-- 依頼者への質問と回答 -->
        <div v-if="(detailTask.questions ?? []).length > 0" class="grid gap-2">
          <p class="text-[11px] font-bold text-muted">確認事項（AI からの質問）</p>
          <div
            v-for="q in detailTask.questions"
            :key="q.id"
            class="rounded-lg border p-2.5 text-[13px]"
            :class="q.status === 'open' ? 'border-warn bg-warn-soft' : 'border-line bg-page'"
          >
            <p class="font-semibold">Q. {{ q.question }}</p>
            <p v-if="q.status === 'answered'" class="mt-1 whitespace-pre-wrap text-sub">A. {{ q.answer }}</p>
            <p v-else class="mt-1 text-[11px] text-warn">回答待ち（回答すると実行を再開できます）</p>
          </div>

          <!-- 回答フォーム（依頼者本人 or 管理者のみ） -->
          <div v-if="openQuestion && canAnswer" class="grid gap-2 rounded-lg border border-line p-3">
            <textarea
              v-model="answerText"
              class="textarea min-h-20"
              placeholder="回答・補足情報を入力（添付も可）"
              aria-label="AI への回答"
            />
            <ul v-if="answerFiles.length > 0" class="grid gap-1">
              <li
                v-for="(f, i) in answerFiles"
                :key="`${f.name}-${i}`"
                class="flex items-center gap-2 rounded-lg border border-line bg-page px-2.5 py-1 text-[12px]"
              >
                <span class="min-w-0 flex-1 truncate">{{ f.name }}</span>
                <span class="num text-muted">{{ Math.ceil(f.size / 1024) }}KB</span>
                <button type="button" class="btn btn-ghost btn-sm" :aria-label="`「${f.name}」を外す`" @click="removeAnswerFile(i)">
                  <X class="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            </ul>
            <div class="flex flex-wrap items-center gap-2">
              <input ref="answerFileInput" type="file" :accept="ATTACH_ACCEPT" multiple class="hidden" @change="onAnswerFilesSelected">
              <button type="button" class="btn btn-sm" @click="answerFileInput?.click()">
                <Paperclip class="h-3.5 w-3.5" aria-hidden="true" />
                資料を添付
              </button>
              <button type="button" class="btn btn-primary btn-sm ml-auto" :disabled="answering" @click="submitAnswer">
                <Send class="h-3.5 w-3.5" aria-hidden="true" />
                {{ answering ? '送信中…' : '回答を送信' }}
              </button>
            </div>
          </div>
          <p v-else-if="openQuestion" class="text-[11px] text-muted">回答できるのは依頼者本人（または管理者）です</p>
        </div>

        <!-- 成果物 -->
        <div class="grid gap-2">
          <div class="flex items-center justify-between">
            <p class="text-[11px] font-bold text-muted">成果物（{{ stepOutputs(detailTask).length }}件）</p>
            <button
              v-if="detailTask.status === 'in_progress'"
              type="button"
              class="btn btn-ghost btn-sm"
              title="自動実行が止まった場合に手動で再開します"
              @click="progressFromDetail"
            >実行を再開</button>
          </div>
          <p v-if="stepOutputs(detailTask).length === 0" class="text-[12px] text-muted">
            まだ成果物がありません（承認後、AI がステップを自動遂行すると生成されます）
          </p>
          <details
            v-for="o in stepOutputs(detailTask)"
            :key="`${o.step}-${o.at}`"
            class="rounded-lg border border-line"
            :open="o.step === -1"
          >
            <summary class="cursor-pointer px-3 py-2 text-[13px] font-semibold hover:bg-brand-soft">
              {{ o.step === -1 ? '📄 ' : '' }}{{ o.title }}
              <span class="num ml-2 text-[11px] font-normal text-muted">{{ o.at.slice(0, 16).replace('T', ' ') }}</span>
            </summary>
            <div class="border-t border-line p-3">
              <UiMarkdown :source="o.body" />
            </div>
          </details>
        </div>
      </div>
    </UiModal>

    <!-- AI 社員詳細ドロワー -->
    <UiDrawer
      :open="!!selectedEmp"
      :title="selectedEmp ? `${selectedEmp.name}（AI社員）` : ''"
      @close="selectedEmpId = null"
    >
      <div v-if="selectedEmp" class="grid gap-4">
        <div class="flex items-center gap-3">
          <UiAvatar :name="selectedEmp.name" kind="ai" size="lg" />
          <div class="min-w-0">
            <p class="text-[15px] font-bold">{{ selectedEmp.name }}</p>
            <p class="flex items-center gap-1.5 text-xs text-sub">
              {{ selectedRole?.name ?? 'ロール未設定' }}
              <UiStatusBadge
                v-if="selectedRole?.permissions.includes(DELEGATE_PERMISSION)"
                label="マネージャー"
                tone="brand"
              />
            </p>
          </div>
          <UiStatusBadge
            class="ml-auto"
            :label="AI_EMPLOYEE_STATUS_LABELS[selectedEmp.status]"
            :tone="AI_EMPLOYEE_STATUS_TONES[selectedEmp.status]"
            dot
          />
        </div>

        <div v-if="selectedRole" class="rounded-lg bg-page p-3">
          <p class="text-[11px] font-bold text-muted">ミッション</p>
          <p class="mt-0.5 text-[13px]">{{ selectedRole.mission }}</p>
          <p class="mt-2 text-[11px] font-bold text-muted">モデル層</p>
          <p class="mt-0.5 text-[13px]">{{ AI_MODEL_TIER_LABELS[selectedRole.modelTier] }}</p>
        </div>

        <section>
          <h3 class="mb-1.5 text-xs font-bold text-muted">現在のタスク</h3>
          <p v-if="selectedTasks.length === 0" class="text-xs text-muted">進行中のタスクはありません</p>
          <ul v-else class="grid gap-1.5">
            <li v-for="t in selectedTasks" :key="t.id" class="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
              <span class="min-w-0 flex-1 truncate text-[13px]">{{ t.title }}</span>
              <UiStatusBadge :label="AI_TASK_STATUS_LABELS[t.status]" :tone="AI_TASK_STATUS_TONES[t.status]" />
            </li>
          </ul>
        </section>

        <section class="border-t border-line pt-3">
          <h3 class="mb-2 flex items-center gap-1.5 text-xs font-bold text-muted">
            <Sparkles class="h-3.5 w-3.5 text-brand" aria-hidden="true" />
            タスクを依頼
          </h3>
          <div class="grid gap-2.5">
            <UiFormField label="件名" required :error="reqError">
              <input v-model="reqTitle" type="text" class="input" placeholder="例: 競合サービスの価格調査">
            </UiFormField>
            <UiFormField label="内容" hint="キーワード（調査 / 資料 / 分析 / レビュー）に応じて分解案が変わります">
              <textarea v-model="reqDesc" class="textarea" rows="3" placeholder="依頼の背景・期待する成果物など" />
            </UiFormField>
            <!-- 添付（画像 / ドキュメント）。選択で即送信せず、依頼の送信時にまとめて渡す -->
            <div class="grid gap-1.5">
              <div class="flex flex-wrap items-center gap-2">
                <input ref="reqFileInput" type="file" :accept="ATTACH_ACCEPT" multiple class="hidden" @change="onReqFilesSelected">
                <button type="button" class="btn btn-sm" @click="reqFileInput?.click()">
                  <Paperclip class="h-3.5 w-3.5" aria-hidden="true" />
                  参考資料を添付
                </button>
                <span class="text-[11px] text-muted">.md / .txt / .pdf / .docx / .pptx / .jpg / .png（10MB×5 件まで）</span>
              </div>
              <ul v-if="reqFiles.length > 0" class="grid gap-1">
                <li
                  v-for="(f, i) in reqFiles"
                  :key="`${f.name}-${i}`"
                  class="flex items-center gap-2 rounded-lg border border-line bg-page px-2.5 py-1 text-[12px]"
                >
                  <span class="min-w-0 flex-1 truncate">{{ f.name }}</span>
                  <span class="num text-muted">{{ Math.ceil(f.size / 1024) }}KB</span>
                  <button type="button" class="btn btn-ghost btn-sm" :aria-label="`「${f.name}」を外す`" @click="removeReqFile(i)">
                    <X class="h-3 w-3" aria-hidden="true" />
                  </button>
                </li>
              </ul>
            </div>
            <button type="button" class="btn btn-primary" @click="submitRequest">分解案を作成</button>
          </div>

          <!-- 分解案の即時表示 -->
          <div v-if="proposedTask" class="mt-3 rounded-lg border border-brand bg-brand-soft/40 p-3">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-bold text-brand">AI による分解案</p>
              <UiStatusBadge
                :label="AI_CONFIDENCE_META[proposedTask.confidence].label"
                :tone="AI_CONFIDENCE_META[proposedTask.confidence].tone"
              />
            </div>
            <ol class="mt-2 grid list-decimal gap-1 pl-5 text-[13px]">
              <li v-for="(s, i) in proposedTask.decomposition" :key="i">{{ s.title }}</li>
            </ol>
            <p v-if="proposedTask.confidence === 'low'" class="mt-2 text-[11px] text-warn">
              依頼内容が短い・曖昧なため確信度が低い分解案です。内容を具体化して再依頼するか、このまま承認してください。
            </p>
            <div v-if="proposedTask.status === 'proposed'" class="mt-2.5 flex flex-wrap gap-2">
              <button type="button" class="btn btn-primary btn-sm" @click="approveProposal">この分解で承認</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="proposedTaskId = null">提案のまま保留</button>
            </div>
            <p v-else class="mt-2.5 text-[11px] font-semibold text-ok">承認済み。タスクボードで進捗を確認できます</p>
          </div>
        </section>
      </div>
    </UiDrawer>
  </div>
</template>
