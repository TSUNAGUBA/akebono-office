<script setup lang="ts">
/**
 * ダッシュボード: KPI + アイソメトリックオフィス（クリック → ドロワー → タスク依頼）+
 * 直近の活動 + エスカレーション対応（管理者）。
 * タスク依頼・承認はトークン予算ガード（useTokenBudget.guardSpend）を通す（FC-06 の抑制・制限）。
 */
import { Paperclip, Sparkles, TriangleAlert, X } from 'lucide-vue-next'
import { DELEGATE_PERMISSION } from '../../../shared/domain/ai-tasks'
import type { AiTask } from '~/types/domain'
import { AI_EMPLOYEE_STATUS_LABELS, AI_TASK_STATUS_LABELS, ESCALATION_REASON_LABELS, ESCALATION_REASON_TONES } from '~/utils/labels'
import { fmtDateTime, fmtInt } from '~/utils/format'

const {
  employees, employeesAll, roleOf, employeeById, tasks, tasksOf, logs,
  requestTask, approveTask, evaluateWorkloadSignals, reloadAi,
} = useAiCompany()
const { usage, budgetState, tokenBudgetPct, costBudgetPct, settings, guardSpend, usageMayBeTruncated } = useTokenBudget()
const { open: openEscalations, resolve: resolveEscalation, refresh: refreshEscalations } = useEscalations()
const { show } = useToast()
const { isAdmin } = useCurrentUser()

const apiModeActive = useApiMode()
// 承認後の自動実行は API モードではサーバー側で走るため、数回ポーリングして画面へ反映する（Home 版と同一）
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

// ---------- KPI ----------

const workingCount = computed(() => employees.value.filter(e => e.status === 'working').length)
const inProgressCount = computed(() => tasks.value.filter(t => t.status === 'in_progress' || t.status === 'blocked').length)
const proposedCount = computed(() => tasks.value.filter(t => t.status === 'proposed').length)

// ---------- シグナル検知（補助処理・非ブロッキング） ----------

onMounted(async () => {
  void refreshEscalations()
  const { raised } = await evaluateWorkloadSignals()
  if (raised > 0) {
    show(`${raised}件のシグナルをエスカレーションしました`, 'warn')
  }
})

// ---------- オフィス + 詳細ドロワー + タスク依頼 ----------

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

const reqTitle = ref('')
const reqDesc = ref('')
const reqError = ref('')
const reqFiles = ref<File[]>([])
const reqFileInput = ref<HTMLInputElement | null>(null)
/** 依頼・承認の実行中フラグ（API モードの二重送信防止 = R1 監査指摘。submitAnswer の answering と同型） */
const requesting = ref(false)
const approving = ref(false)

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
  if (requesting.value) return
  reqError.value = ''
  if (!selectedEmpId.value) return
  if (!reqTitle.value.trim()) {
    reqError.value = '件名を入力してください'
    return
  }
  // トークン予算ガード（FC-06。block 設定時のみ拒否。モック = UI 層の抑止）
  const guard = guardSpend(selectedEmpId.value)
  if (!guard.ok) {
    show(`${guard.error.code}: ${guard.error.message}`, 'warn', { label: 'トークン管理へ', to: '/tokens' })
    return
  }
  requesting.value = true
  try {
    const res = await requestTask(selectedEmpId.value, reqTitle.value, reqDesc.value, reqFiles.value)
    if (!res.ok) {
      show(res.error.message, 'warn')
      return
    }
    proposedTaskId.value = res.id
    reqFiles.value = []
    if (res.confidence === 'low') {
      show('確信度が低いため、分解案の確認を推奨します（管理者へエスカレーション済み）', 'warn')
    } else {
      show('分解案を作成しました。内容を確認して承認してください')
    }
  } finally {
    requesting.value = false
  }
}

async function approveProposal(): Promise<void> {
  if (approving.value || !proposedTaskId.value) return
  const guard = guardSpend(proposedTask.value?.aiEmployeeId)
  if (!guard.ok) {
    show(`${guard.error.code}: ${guard.error.message}`, 'warn', { label: 'トークン管理へ', to: '/tokens' })
    return
  }
  approving.value = true
  try {
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
  } finally {
    approving.value = false
  }
}

// ---------- エスカレーション対応（管理者） ----------

const escAnswer = ref<Record<string, string>>({})
// 通知ディープリンク（/?open=<エスカレーション id>）: 対象を強調表示する（R1 #9）
const highlightEscId = ref('')
useRouteDeepLink('open', (id) => { highlightEscId.value = id })

async function onResolveEscalation(id: string, type: 'answer' | 'no_action'): Promise<void> {
  const res = await resolveEscalation(id, type, escAnswer.value[id] ?? '')
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'warn')
    return
  }
  delete escAnswer.value[id]
  show(type === 'answer' ? '回答を送信しました' : '対応不要として解決しました')
}

const recentLogs = computed(() => logs.value.slice(0, 6))
</script>

<template>
  <div>
    <UiPageHeader title="ダッシュボード" description="AI 社員のオフィス。社員をクリックしてタスクを依頼できます" />

    <!-- 予算アラート（FC-06） -->
    <div
      v-if="budgetState !== 'ok'"
      class="mb-3 flex items-start gap-2 rounded-lg border p-3"
      :class="budgetState === 'over' ? 'border-crit/50 bg-crit-soft' : 'border-warn/50 bg-warn-soft'"
      role="alert"
    >
      <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" :class="budgetState === 'over' ? 'text-crit' : 'text-warn'" aria-hidden="true" />
      <div class="text-xs leading-relaxed">
        <p class="font-semibold">
          {{ budgetState === 'over' ? '月間予算を超過しています' : `月間予算の ${settings.alertThresholdPct}% を超えました` }}
          <span class="num">（トークン {{ tokenBudgetPct ?? '—' }}% / コスト {{ costBudgetPct ?? '—' }}%）</span>
        </p>
        <p class="mt-0.5 text-sub">
          {{ budgetState === 'over' && settings.overBudgetAction === 'block'
            ? '新規のタスク依頼・承認をブロック中です。'
            : '消費ペースを確認してください。' }}
          <NuxtLink to="/tokens" class="link">トークン管理で確認 →</NuxtLink>
        </p>
      </div>
    </div>

    <!-- KPI -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <UiKpiCard label="稼働中の AI 社員" :value="`${workingCount} / ${employees.length}`" icon="Bot" />
      <UiKpiCard label="進行中タスク" :value="String(inProgressCount)" :sub="proposedCount > 0 ? `承認待ち ${proposedCount} 件` : ''" icon="ClipboardList" to="/tasks" />
      <UiKpiCard label="当月トークン" :value="fmtInt(usage.totalTokens)" :sub="usageMayBeTruncated ? '直近 200 件基準（過小の可能性）' : tokenBudgetPct !== null ? `予算の ${tokenBudgetPct}%` : '予算未設定'" icon="Gauge" to="/tokens" />
      <UiKpiCard label="当月概算コスト" :value="`$${usage.totalCostUsd.toFixed(2)}`" :sub="`月末予測 $${usage.forecastCostUsd.toFixed(2)}`" icon="CircleDollarSign" to="/tokens" />
    </div>

    <!-- オフィス -->
    <UiSectionCard class="mt-3" title="AIオフィス" description="状態: 緑=実行中 / 橙=承認待ち / グレー=待機中">
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

    <div class="mt-3 grid gap-3 lg:grid-cols-2">
      <!-- 直近の活動 -->
      <UiSectionCard title="直近の活動" description="最新 6 件">
        <template #actions>
          <NuxtLink to="/activity" class="link text-xs">すべて見る →</NuxtLink>
        </template>
        <UiEmptyState v-if="recentLogs.length === 0" icon="Activity" title="活動ログがありません" />
        <ul v-else class="grid gap-2">
          <li v-for="l in recentLogs" :key="l.id" class="flex items-start gap-2">
            <UiAvatar :name="employeeById(l.aiEmployeeId)?.name ?? l.aiEmployeeId" kind="ai" size="sm" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px]">{{ l.summary }}</p>
              <p class="num text-[11px] text-muted">
                {{ employeeById(l.aiEmployeeId)?.name ?? l.aiEmployeeId }} ・ {{ fmtDateTime(l.at) }} ・ {{ fmtInt(l.tokens) }} tokens
              </p>
            </div>
          </li>
        </ul>
      </UiSectionCard>

      <!-- エスカレーション（管理者） -->
      <UiSectionCard
        v-if="isAdmin"
        title="エスカレーション"
        :description="`未対応 ${openEscalations.length} 件`"
      >
        <UiEmptyState v-if="openEscalations.length === 0" icon="CircleCheck" title="未対応のエスカレーションはありません" />
        <ul v-else class="grid gap-2">
          <li
            v-for="e in openEscalations"
            :key="e.id"
            class="rounded-lg border p-2.5"
            :class="e.id === highlightEscId ? 'border-brand ring-2 ring-brand/40' : 'border-line'"
          >
            <div class="flex flex-wrap items-center gap-1.5">
              <UiStatusBadge :label="ESCALATION_REASON_LABELS[e.reason]" :tone="ESCALATION_REASON_TONES[e.reason]" />
              <span class="num text-[11px] text-muted">{{ fmtDateTime(e.raisedAt) }}</span>
            </div>
            <p class="mt-1 text-[13px]">{{ e.context }}</p>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <input
                v-model="escAnswer[e.id]"
                type="text"
                class="input h-8 min-w-0 flex-1"
                placeholder="回答・裁定の内容"
                :aria-label="`エスカレーション ${e.id} への回答`"
              >
              <button type="button" class="btn btn-sm" @click="onResolveEscalation(e.id, 'answer')">回答</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="onResolveEscalation(e.id, 'no_action')">対応不要</button>
            </div>
          </li>
        </ul>
      </UiSectionCard>
    </div>

    <!-- AI 社員詳細ドロワー（タスク依頼） -->
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
            <button type="button" class="btn btn-primary" :disabled="requesting" @click="submitRequest">
              {{ requesting ? '作成中…' : '分解案を作成' }}
            </button>
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
              <button type="button" class="btn btn-primary btn-sm" :disabled="approving" @click="approveProposal">
                {{ approving ? '承認中…' : 'この分解で承認' }}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" @click="proposedTaskId = null">提案のまま保留</button>
            </div>
            <p v-else class="mt-2.5 text-[11px] font-semibold text-ok">承認済み。タスクボードで進捗を確認できます</p>
          </div>
        </section>
      </div>
    </UiDrawer>
  </div>
</template>
