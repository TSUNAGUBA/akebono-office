<script setup lang="ts">
/**
 * タスクボード: かんばん（提案中 / 実行中 / ブロック / 完了）+ タスク詳細モーダル。
 * ?task=<id> ディープリンクで詳細を直接開く（通知からの到達導線）。
 * 承認はトークン予算ガード（FC-06）を通す。
 */
import { Download, FileText, Paperclip, Send, X } from 'lucide-vue-next'
import { AI_TASK_STATUS_LABELS } from '~/utils/labels'

const {
  employeesAll, employeeById, tasks,
  approveTask, progressTask, answerTask, blockTask, cancelTask, reloadAi,
} = useAiCompany()
const { guardSpend } = useTokenBudget()
const { show } = useToast()
const { ask } = useConfirm()
const { currentUser, isAdmin } = useCurrentUser()

const apiModeActive = useApiMode()
let pollTimer: ReturnType<typeof setTimeout> | null = null
function pollAutoRun(times = 36): void {
  if (!apiModeActive || times <= 0) return
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    await reloadAi()
    if (tasks.value.some(t => t.status === 'in_progress')) pollAutoRun(times - 1)
  }, 5000)
}
onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer)
})

/** 添付の受付形式（サーバーの AKO-AIC-010/011 と同じ基準） */
const ATTACH_ACCEPT = '.md,.txt,.pdf,.docx,.pptx,.jpg,.jpeg,.png'
const ATTACH_EXTS = new Set(['md', 'txt', 'pdf', 'docx', 'pptx', 'jpg', 'jpeg', 'png'])
const ATTACH_MAX_BYTES = 10 * 1024 * 1024
const ATTACH_MAX_COUNT = 5

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

// ---------- タスク詳細（成果物・質問と回答） ----------

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

// 通知ディープリンク: ?task=<タスクid> で詳細モーダルを直接開く
useRouteDeepLink('task', taskId => openDetail(taskId))

function onAnswerFilesSelected(ev: Event): void {
  const list = (ev.target as HTMLInputElement).files
  if (answerFileInput.value) answerFileInput.value.value = ''
  if (!list) return
  answerFiles.value = validateAttachments(answerFiles.value, Array.from(list))
}

function removeAnswerFile(i: number): void {
  answerFiles.value = answerFiles.value.filter((_, x) => x !== i)
}

// 添付原本のダウンロード（依頼者 or 管理者。API モードのみ = モックは原本を保存しない設計判断）
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

/** 詳細モーダルからの再開（自動実行が止まった場合のフォールバック導線） */
async function progressFromDetail(): Promise<void> {
  if (!detailTaskId.value) return
  await onProgress(detailTaskId.value)
}

function stepOutputs(t: { outputs?: { step: number }[] }): { step: number; title: string; body: string; at: string }[] {
  return ((t.outputs ?? []) as { step: number; title: string; body: string; at: string }[])
}

// ---------- ボード操作 ----------

/** 承認の実行中フラグ（API モードの二重送信防止 = R1 監査指摘。ボードのボタン連打を再入で無視する） */
let approveBusy = false
async function onApprove(taskId: string): Promise<void> {
  if (approveBusy) return
  // トークン予算ガード（FC-06。block 設定時のみ拒否）
  const task = tasks.value.find(t => t.id === taskId)
  const guard = guardSpend(task?.aiEmployeeId)
  if (!guard.ok) {
    show(`${guard.error.code}: ${guard.error.message}`, 'warn', { label: 'トークン管理へ', to: '/tokens' })
    return
  }
  approveBusy = true
  try {
    const res = await approveTask(taskId)
    show(res.ok
      ? '承認しました。全ステップを自動で遂行します（確認が必要な場合・完了時は通知が届きます）'
      : res.error.message, res.ok ? 'ok' : 'warn')
    if (res.ok) pollAutoRun()
  } finally {
    approveBusy = false
  }
}

async function onProgress(taskId: string): Promise<void> {
  const res = await progressTask(taskId)
  if (!res.ok) {
    // 自動実行が生きている最中の「再開」は競合（009）になる = エラーではなく進行中の案内
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
    show('全ステップを遂行し、成果を統合して依頼者へ報告しました', 'ok')
  } else if ((task?.questions ?? []).some(q => q.status === 'open')) {
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
</script>

<template>
  <div>
    <UiPageHeader title="タスクボード" description="AI 社員へのタスクの提案・実行・ブロック・完了を管理します" />

    <OfficeAiTaskBoard
      :tasks="tasks"
      :employees="employeesAll"
      @approve="onApprove"
      @progress="onProgress"
      @block="onBlock"
      @cancel="onCancel"
      @detail="openDetail"
    />

    <!-- タスク詳細（成果物・質問と回答） -->
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
              >{{ f.filename }}<span class="num text-muted">（{{ Math.ceil(f.sizeBytes / 1024) }}KB）</span>
                <Download class="inline h-3 w-3" aria-hidden="true" /></button>
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
              <FileText v-if="o.step === -1" class="inline h-3.5 w-3.5 text-brand" aria-hidden="true" />
              {{ o.title }}
              <span class="num ml-2 text-[11px] font-normal text-muted">{{ o.at.slice(0, 16).replace('T', ' ') }}</span>
            </summary>
            <div class="border-t border-line p-3">
              <UiMarkdown :source="o.body" />
            </div>
          </details>
        </div>
      </div>
    </UiModal>
  </div>
</template>
