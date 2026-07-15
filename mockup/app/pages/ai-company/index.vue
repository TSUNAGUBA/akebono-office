<script setup lang="ts">
/**
 * AIネイティブカンパニー（F-08）
 * 上段: アイソメトリックオフィス（クリック → 詳細ドロワー → タスク依頼 → 分解案承認）
 * 下段: タスクボード / 活動ログ / 日次報告
 */
import { Settings2, Sparkles } from 'lucide-vue-next'
import type { AiTask } from '~/types/domain'
import { toDateKey } from '~/utils/format'
import { AI_EMPLOYEE_STATUS_LABELS, AI_TASK_STATUS_LABELS } from '~/utils/labels'

const {
  employees, roleOf, employeeById, tasks, tasksOf, logs, aiReportsOn,
  requestTask, approveTask, progressTask, blockTask, cancelTask, generateDailyReports,
} = useAiCompany()
const { show } = useToast()
const { ask } = useConfirm()

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
  proposedTaskId.value = null
}

// ---------- タスク依頼フォーム ----------

const reqTitle = ref('')
const reqDesc = ref('')
const reqError = ref('')
const proposedTaskId = ref<string | null>(null)
const proposedTask = computed<AiTask | undefined>(() =>
  proposedTaskId.value ? tasks.value.find(t => t.id === proposedTaskId.value) : undefined)

function submitRequest(): void {
  reqError.value = ''
  if (!selectedEmpId.value) return
  if (!reqTitle.value.trim()) {
    reqError.value = '件名を入力してください'
    return
  }
  const res = requestTask(selectedEmpId.value, reqTitle.value, reqDesc.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  proposedTaskId.value = res.id
  if (res.confidence === 'low') {
    show('確信度が低いため、分解案の確認を推奨します（管理者へエスカレーション済み）', 'warn', { label: '通知を確認', to: '/inbox' })
  } else {
    show('分解案を作成しました。内容を確認して承認してください')
  }
}

function approveProposal(): void {
  if (!proposedTaskId.value) return
  const res = approveTask(proposedTaskId.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(`${selectedEmp.value?.name ?? 'AI社員'} が実行を開始しました`)
  reqTitle.value = ''
  reqDesc.value = ''
  proposedTaskId.value = null
}

// ---------- 下段タブ ----------

const tab = ref('board')
const tabs = computed(() => [
  { key: 'board', label: 'タスクボード', badge: tasks.value.filter(t => t.status === 'proposed').length },
  { key: 'logs', label: '活動ログ' },
  { key: 'daily', label: '日次報告' },
])

function onApprove(taskId: string): void {
  const res = approveTask(taskId)
  show(res.ok ? '承認しました。実行を開始します' : res.error.message, res.ok ? 'ok' : 'warn')
}

function onProgress(taskId: string): void {
  const res = progressTask(taskId)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  const task = tasks.value.find(t => t.id === taskId)
  if (task?.status === 'done') {
    show('全ステップが完了し、依頼者へ報告しました', 'ok', { label: '通知を確認', to: '/inbox' })
  } else {
    show('1 ステップ進めました')
  }
}

function onBlock(taskId: string): void {
  const before = tasks.value.find(t => t.id === taskId)?.status
  const res = blockTask(taskId)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(before === 'blocked' ? 'ブロックを解除し実行を再開しました' : 'タスクをブロックしました', before === 'blocked' ? 'ok' : 'warn')
}

async function onCancel(taskId: string): Promise<void> {
  const task = tasks.value.find(t => t.id === taskId)
  const okAsk = await ask('タスクの中止', `「${task?.title ?? taskId}」を中止しますか？`, { confirmLabel: '中止する', danger: true })
  if (!okAsk) return
  const res = cancelTask(taskId)
  show(res.ok ? 'タスクを中止しました' : res.error.message, res.ok ? 'ok' : 'warn')
}

// ---------- 日次報告 ----------

const reportDate = ref(todayJst())
const aiReports = computed(() => aiReportsOn(reportDate.value))

function onGenerateReports(): void {
  const { created, skipped } = generateDailyReports(reportDate.value)
  if (created === 0 && skipped === 0) {
    show('この日の AI 活動ログがないため、生成対象がありません', 'warn')
    return
  }
  show(
    `日次報告を ${created} 件生成しました（既存 ${skipped} 件はスキップ）。日報・週報にも掲載されます`,
    'ok',
    { label: '日報を見る', to: '/reports' },
  )
}
</script>

<template>
  <div>
    <UiPageHeader title="AIネイティブカンパニー" description="AI 社員のオフィス。クリックしてタスクを依頼できます">
      <template #actions>
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
          :employees="employees"
          @approve="onApprove"
          @progress="onProgress"
          @block="onBlock"
          @cancel="onCancel"
        />

        <UiSectionCard v-else-if="tab === 'logs'" title="活動ログ" description="AI 社員の活動を時系列で記録（tokens / コストはモック値）">
          <OfficeActivityTimeline :logs="logs" :employees="employees" :tasks="tasks" />
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
              <button type="button" class="btn btn-primary" @click="onGenerateReports">この日の報告を生成</button>
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
            <p class="text-xs text-sub">{{ selectedRole?.name ?? 'ロール未設定' }}</p>
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
