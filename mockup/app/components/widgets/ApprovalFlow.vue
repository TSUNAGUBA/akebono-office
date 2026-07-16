<script setup lang="ts">
/**
 * 承認経路の可視化（プレビュー・詳細ドロワー共用）
 * 表示用データは useWorkflow().flowSteps / previewSteps が生成する（FlowStepView）。
 * 状態: done=承認済 / current=現在ステップ / future=未来 / rejected=却下 / remanded=差戻し
 */
import { Check, Undo2, X } from 'lucide-vue-next'

interface FlowStepItem {
  label: string
  name: string
  state: 'done' | 'current' | 'future' | 'rejected' | 'remanded'
}

const props = defineProps<{ steps: FlowStepItem[] }>()

const STATE_LABELS: Record<FlowStepItem['state'], string> = {
  done: '承認済',
  current: '承認待ち',
  future: '未到達',
  rejected: '却下',
  remanded: '差戻し',
}

function circleClass(state: FlowStepItem['state']): string {
  switch (state) {
    case 'done': return 'bg-ok text-white'
    case 'current': return 'bg-brand text-white ring-4 ring-brand-soft'
    case 'rejected': return 'bg-crit text-white'
    case 'remanded': return 'bg-warn text-white'
    default: return 'border border-line-strong bg-surface text-muted'
  }
}

/** i 番目のノードへ入る接続線（直前ステップが完了していれば ok 色） */
function lineClass(i: number): string {
  const prev = props.steps[i - 1]
  return prev && prev.state === 'done' ? 'bg-ok' : 'bg-line-strong'
}
</script>

<template>
  <ol
    v-if="steps.length > 0"
    class="flex items-start overflow-x-auto py-1 scroll-slim"
    aria-label="承認経路"
  >
    <li
      v-for="(s, i) in steps"
      :key="i"
      class="relative flex min-w-[92px] flex-1 flex-col items-center gap-1 px-1 text-center"
    >
      <div
        v-if="i > 0"
        class="absolute right-[calc(50%+16px)] top-[15px] left-[calc(-50%+16px)] h-0.5 rounded-full"
        :class="lineClass(i)"
        aria-hidden="true"
      />
      <span
        class="relative z-[1] inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold"
        :class="circleClass(s.state)"
      >
        <Check v-if="s.state === 'done'" class="h-4 w-4" aria-hidden="true" />
        <X v-else-if="s.state === 'rejected'" class="h-4 w-4" aria-hidden="true" />
        <Undo2 v-else-if="s.state === 'remanded'" class="h-4 w-4" aria-hidden="true" />
        <template v-else>{{ i + 1 }}</template>
      </span>
      <div class="min-w-0">
        <p class="text-[10px] font-semibold text-muted">{{ s.label }}</p>
        <p
          class="truncate text-xs font-semibold"
          :class="s.state === 'current' ? 'text-brand' : s.state === 'future' ? 'text-muted' : 'text-ink'"
        >{{ s.name }}</p>
        <p class="text-[10px]" :class="{
          'text-ok': s.state === 'done',
          'text-brand': s.state === 'current',
          'text-crit': s.state === 'rejected',
          'text-warn': s.state === 'remanded',
          'text-muted': s.state === 'future',
        }">{{ STATE_LABELS[s.state] }}</p>
      </div>
    </li>
  </ol>
  <p v-else class="text-xs text-muted">承認経路が未確定です</p>
</template>
