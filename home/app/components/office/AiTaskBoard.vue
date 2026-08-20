<script setup lang="ts">
/**
 * AI タスクボード（F-08-3 カンバン）
 * proposed / in_progress(approved 含む) / blocked / done の 4 カラム。
 * カードに分解チェックリストと操作ボタン。モバイルは縦積み。
 */
import { CheckCircle2, Circle, FileText, MessageCircleQuestion, Share2 } from 'lucide-vue-next'
import type { AiEmployee, AiTask, AiTaskStatus } from '~/types/domain'
import { AI_TASK_STATUS_LABELS } from '~/utils/labels'

const props = defineProps<{
  tasks: AiTask[]
  employees: AiEmployee[]
}>()

const emit = defineEmits<{
  approve: [taskId: string]
  progress: [taskId: string]
  block: [taskId: string]
  cancel: [taskId: string]
  detail: [taskId: string]
}>()

/** 依頼者の回答待ち（open な質問）か（バッチ7f: 実遂行で AI が確認を求めた状態） */
function hasOpenQuestion(t: AiTask): boolean {
  return (t.questions ?? []).some(q => q.status === 'open')
}

function outputCount(t: AiTask): number {
  return (t.outputs ?? []).length
}

const COLUMNS: { key: string; label: string; statuses: AiTaskStatus[] }[] = [
  { key: 'proposed', label: AI_TASK_STATUS_LABELS.proposed, statuses: ['proposed'] },
  { key: 'in_progress', label: AI_TASK_STATUS_LABELS.in_progress, statuses: ['approved', 'in_progress'] },
  { key: 'blocked', label: AI_TASK_STATUS_LABELS.blocked, statuses: ['blocked'] },
  { key: 'done', label: AI_TASK_STATUS_LABELS.done, statuses: ['done'] },
]

const columns = computed(() =>
  COLUMNS.map(c => ({ ...c, tasks: props.tasks.filter(t => c.statuses.includes(t.status)) })))

function empName(id: string): string {
  return props.employees.find(e => e.id === id)?.name ?? id
}

/** 分担先（子タスク）の件数・完了数（連携の進捗をマネージャーカードで可視化） */
function childCount(taskId: string): number {
  return props.tasks.filter(t => t.parentTaskId === taskId && t.status !== 'cancelled').length
}

function childDoneCount(taskId: string): number {
  return props.tasks.filter(t => t.parentTaskId === taskId && t.status === 'done').length
}

function doneCount(t: AiTask): number {
  return t.decomposition.filter(s => s.done).length
}
</script>

<template>
  <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
    <section
      v-for="col in columns"
      :key="col.key"
      class="rounded-[10px] border border-line bg-page p-2"
      :aria-label="`${col.label}のタスク`"
    >
      <header class="mb-2 flex items-center justify-between px-1">
        <h3 class="text-xs font-bold text-sub">{{ col.label }}</h3>
        <span class="num rounded-full bg-surface px-2 text-[11px] font-bold text-muted">{{ col.tasks.length }}</span>
      </header>

      <p v-if="col.tasks.length === 0" class="px-1 py-4 text-center text-xs text-muted">タスクなし</p>

      <ul class="grid gap-2">
        <li v-for="t in col.tasks" :key="t.id" class="card p-2.5">
          <div class="flex items-start justify-between gap-2">
            <p class="text-[13px] font-bold leading-snug">{{ t.title }}</p>
            <UiStatusBadge
              :label="AI_CONFIDENCE_META[t.confidence].label"
              :tone="AI_CONFIDENCE_META[t.confidence].tone"
            />
          </div>
          <div class="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
            <UiAvatar :name="empName(t.aiEmployeeId)" kind="ai" size="sm" />
            <span>{{ empName(t.aiEmployeeId) }}</span>
            <span class="num ml-auto">{{ doneCount(t) }}/{{ t.decomposition.length }}</span>
          </div>

          <!-- 実遂行（バッチ7f）: 回答待ち・成果物の可視化 -->
          <p v-if="hasOpenQuestion(t)" class="mt-1 flex items-center gap-1 text-[11px] font-semibold text-warn">
            <MessageCircleQuestion class="h-3 w-3" aria-hidden="true" />
            依頼者の回答待ち（詳細から回答できます）
          </p>
          <p v-else-if="outputCount(t) > 0" class="mt-1 flex items-center gap-1 text-[11px] text-sub">
            <FileText class="h-3 w-3" aria-hidden="true" />
            成果物 {{ outputCount(t) }} 件
          </p>

          <!-- AI 社員間の連携（オペレーター指示 2026-07-19 #3）: 分担元 / 分担先の可視化 -->
          <p v-if="t.requesterAiEmployeeId" class="mt-1 flex items-center gap-1 text-[11px] text-brand">
            <Share2 class="h-3 w-3" aria-hidden="true" />
            {{ empName(t.requesterAiEmployeeId) }} からの分担依頼
          </p>
          <p v-else-if="childCount(t.id) > 0" class="mt-1 flex items-center gap-1 text-[11px] text-brand">
            <Share2 class="h-3 w-3" aria-hidden="true" />
            {{ childCount(t.id) }} 名の AI 社員へ分担中（完了 {{ childDoneCount(t.id) }}）
          </p>

          <!-- 分解チェックリスト -->
          <ul class="mt-2 grid gap-1 border-t border-line pt-2">
            <li
              v-for="(s, i) in t.decomposition"
              :key="i"
              class="flex items-start gap-1.5 text-xs"
              :class="s.done ? 'text-muted line-through' : 'text-sub'"
            >
              <CheckCircle2 v-if="s.done" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden="true" />
              <Circle v-else class="mt-0.5 h-3.5 w-3.5 shrink-0 text-line-strong" aria-hidden="true" />
              {{ s.title }}
            </li>
          </ul>

          <!-- 操作 -->
          <div class="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
            <template v-if="t.status === 'proposed'">
              <button type="button" class="btn btn-primary btn-sm" @click="emit('approve', t.id)">承認して開始</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="emit('cancel', t.id)">中止</button>
            </template>
            <template v-else-if="t.status === 'in_progress' || t.status === 'approved'">
              <!-- バッチ7i: 承認後は全自動実行。ボタンは自動実行が止まった場合（サーバー再起動等）の再開用 -->
              <span class="inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
                <span class="h-2 w-2 animate-pulse rounded-full bg-brand" aria-hidden="true" />
                自動実行中
              </span>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                title="自動実行が止まった場合に手動で再開します"
                @click="emit('progress', t.id)"
              >再開</button>
              <button type="button" class="btn btn-sm" @click="emit('block', t.id)">ブロック</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="emit('cancel', t.id)">中止</button>
            </template>
            <template v-else-if="t.status === 'blocked'">
              <button
                v-if="hasOpenQuestion(t)"
                type="button"
                class="btn btn-primary btn-sm"
                @click="emit('detail', t.id)"
              >回答する</button>
              <button v-else type="button" class="btn btn-primary btn-sm" @click="emit('block', t.id)">再開</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="emit('cancel', t.id)">中止</button>
            </template>
            <button type="button" class="btn btn-ghost btn-sm ml-auto" @click="emit('detail', t.id)">
              詳細・成果物
            </button>
          </div>
          <p v-if="t.status === 'done'" class="mt-1 text-[11px] text-ok">
            全ステップ完了・依頼者へ報告済み（成果物は「詳細・成果物」から）
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>
