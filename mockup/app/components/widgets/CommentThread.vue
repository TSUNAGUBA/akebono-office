<script setup lang="ts">
/**
 * 日報のコメントスレッド（一覧 + 入力 + リアクション）
 * コメント時の作成者通知（kind 'comment'）は useReports.addComment が担う。
 */
import { Send } from 'lucide-vue-next'
import type { ReportComment } from '~/types/domain'
import { REPORT_REACTION_EMOJIS } from '~/composables/useReports'
import { fmtDateTime } from '~/utils/format'

const props = defineProps<{ reportId: string }>()

const reports = useReports()
const { currentUser } = useCurrentUser()
const { show } = useToast()

const body = ref('')
const comments = computed(() => reports.commentsOf(props.reportId))

function send(): void {
  const res = reports.addComment(props.reportId, body.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  body.value = ''
  show('コメントしました')
}

function react(commentId: string, emoji: string): void {
  const res = reports.toggleReaction(commentId, emoji)
  if (!res.ok) show(res.error.message, 'warn')
}

function countOf(c: ReportComment, emoji: string): number {
  return c.reactions.filter(r => r.emoji === emoji).length
}

function mineHas(c: ReportComment, emoji: string): boolean {
  return c.reactions.some(r => r.memberId === currentUser.value.id && r.emoji === emoji)
}
</script>

<template>
  <section aria-label="コメントスレッド">
    <h3 class="mb-2 text-xs font-bold text-sub">コメント（{{ comments.length }}）</h3>

    <ul v-if="comments.length > 0" class="grid gap-2">
      <li v-for="c in comments" :key="c.id" class="flex items-start gap-2">
        <UiAvatar :name="reports.memberName(c.memberId)" size="sm" />
        <div class="min-w-0 flex-1 rounded-lg border border-line bg-surface-soft px-3 py-2">
          <p class="flex flex-wrap items-baseline gap-x-2">
            <span class="text-xs font-bold">{{ reports.memberName(c.memberId) }}</span>
            <span class="num text-[10px] text-muted">{{ fmtDateTime(c.at) }}</span>
          </p>
          <p class="mt-0.5 whitespace-pre-wrap text-[13px]">{{ c.body }}</p>
          <div class="mt-1.5 flex flex-wrap gap-1" role="group" aria-label="リアクション">
            <button
              v-for="emoji in REPORT_REACTION_EMOJIS"
              :key="emoji"
              type="button"
              class="inline-flex h-7 min-w-9 items-center justify-center gap-1 rounded-full border px-2 text-xs transition-colors"
              :class="mineHas(c, emoji)
                ? 'border-brand bg-brand-soft font-semibold text-brand'
                : 'border-line bg-surface text-sub hover:border-line-strong'"
              :aria-pressed="mineHas(c, emoji)"
              :aria-label="`リアクション ${emoji}`"
              @click="react(c.id, emoji)"
            >
              <span aria-hidden="true">{{ emoji }}</span>
              <span v-if="countOf(c, emoji) > 0" class="num">{{ countOf(c, emoji) }}</span>
            </button>
          </div>
        </div>
      </li>
    </ul>
    <p v-else class="rounded-lg border border-dashed border-line px-3 py-3 text-center text-xs text-muted">
      まだコメントはありません
    </p>

    <form class="mt-2 flex items-center gap-2" @submit.prevent="send">
      <UiAvatar :name="currentUser.name" size="sm" />
      <input
        v-model="body"
        type="text"
        class="input flex-1"
        placeholder="コメントを入力"
        aria-label="コメント入力"
      >
      <button type="submit" class="btn btn-primary" :disabled="!body.trim()">
        <Send class="h-3.5 w-3.5" aria-hidden="true" />
        送信
      </button>
    </form>
  </section>
</template>
