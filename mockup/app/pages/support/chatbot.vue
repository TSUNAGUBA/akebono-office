<script setup lang="ts">
/**
 * F-09-2 AIチャットボット: 会話 UI（吹き出し・擬似ストリーミング・出典バッジ・サジェストチップ）
 * リンクはテキスト分解で描画（v-html 禁止）。Enter 送信 / Shift+Enter 改行 / 2000 字制限。
 */
import { SendHorizontal, Trash2 } from 'lucide-vue-next'
import type { ChatMessage } from '~/types/domain'
import { fmtTime } from '~/utils/format'

const { isEnabled } = useAppSettings()
const {
  messages, isStreaming, streamingText, send, clear, finalize, escalate,
} = useChatbot()
const toast = useToast()
const confirm = useConfirm()

const draft = ref('')
const listEl = ref<HTMLElement | null>(null)

const rows = computed(() => Math.min(4, Math.max(1, draft.value.split('\n').length)))

/** 内部リンクのテキスト分解描画（content 中のパスをリンク化） */
const LINK_LABELS: Record<string, string> = {
  '/support/documents': 'ドキュメント管理',
  '/attendance': '勤怠管理',
  '/workflow': 'ワークフロー',
  '/status': '稼働状況',
}
const LINK_RE = /(\/support\/documents|\/attendance|\/workflow|\/status)/g

function segmentsOf(content: string): { link: boolean; text: string }[] {
  return content.split(LINK_RE)
    .filter(s => s !== '')
    .map(s => ({ link: LINK_LABELS[s] !== undefined, text: s }))
}

const lastAssistantId = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i]
    if (m && m.role === 'assistant') return m.id
  }
  return ''
})

function onSend(): void {
  if (!draft.value.trim() || isStreaming.value) return
  send(draft.value)
  draft.value = ''
}

/** Enter 送信 / Shift+Enter 改行。IME 変換確定の Enter では送信しない */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    onSend()
  }
}

/** サジェストチップ: エスカレーション用チップだけは送信せず起票する */
async function onSuggestion(msg: ChatMessage, s: string): Promise<void> {
  if (s === ESCALATE_SUGGESTION) {
    const question = questionBefore(msg.id)
    const r = await escalate(question)
    if (r.ok) toast.show('管理者にエスカレーションしました。回答があれば通知されます', 'ok', { label: '確認', to: '/inbox' })
    else toast.show(r.error.message, 'info')
    return
  }
  send(s)
}

/** フォールバック応答の直前のユーザー質問を取得（起票コンテキスト用） */
function questionBefore(assistantId: string): string {
  const idx = messages.value.findIndex(m => m.id === assistantId)
  for (let i = idx - 1; i >= 0; i--) {
    const m = messages.value[i]
    if (m && m.role === 'user') return m.content
  }
  return '(質問不明)'
}

async function onClear(): Promise<void> {
  const ok = await confirm.ask('会話をクリア', 'チャット履歴をすべて削除します。よろしいですか？', { danger: true, confirmLabel: 'クリア' })
  if (!ok) return
  clear()
  toast.show('会話をクリアしました')
}

function scrollToBottom(): void {
  nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  })
}

watch(() => messages.value.length, scrollToBottom)
watch(streamingText, scrollToBottom)
onMounted(scrollToBottom)

/** unmount 時: タイマ解除 + ストリーミング中の応答を確定保存 */
onBeforeUnmount(() => {
  finalize()
})
</script>

<template>
  <div>
    <UiEmptyState
      v-if="!isEnabled('chatbot')"
      icon="Bot"
      title="AIチャットボットは無効化されています"
      hint="設定 > 機能トグル で有効にできます"
    >
      <template #action>
        <NuxtLink to="/support" class="btn btn-sm">業務支援ツールへ戻る</NuxtLink>
      </template>
    </UiEmptyState>

    <template v-else>
      <UiPageHeader title="AIチャットボット" description="社内データを参照して回答します（モック応答）">
        <template #actions>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="messages.length === 0" @click="onClear">
            <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
            会話をクリア
          </button>
        </template>
      </UiPageHeader>

      <div
        class="card flex min-h-[320px] flex-col overflow-hidden"
        style="height: calc(100dvh - var(--header-h) - var(--bottomnav-h) - 150px)"
      >
        <!-- メッセージ一覧 -->
        <div ref="listEl" class="flex-1 overflow-y-auto p-3 scroll-slim" aria-live="polite">
          <UiEmptyState
            v-if="messages.length === 0 && !isStreaming"
            icon="Bot"
            title="AIチャットボットに質問してみましょう"
            hint="勤怠・有給・顧客情報・規程・稼働状況を実データから回答します"
          >
            <template #action>
              <div class="flex flex-wrap justify-center gap-1.5">
                <button
                  v-for="s in INITIAL_SUGGESTIONS"
                  :key="s"
                  type="button"
                  class="rounded-full border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-sub transition-colors hover:border-brand hover:text-brand"
                  @click="send(s)"
                >
                  {{ s }}
                </button>
              </div>
            </template>
          </UiEmptyState>

          <div v-else class="grid gap-3">
            <div
              v-for="m in messages"
              :key="m.id"
              class="flex gap-2"
              :class="m.role === 'user' ? 'justify-end' : ''"
            >
              <UiAvatar v-if="m.role === 'assistant'" name="AI" kind="ai" size="sm" class="mt-1" />
              <div class="min-w-0 max-w-[85%] md:max-w-[72%]">
                <div
                  class="whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[13px] leading-relaxed"
                  :class="m.role === 'user'
                    ? 'rounded-br-sm bg-brand text-white'
                    : 'rounded-bl-sm border border-line bg-surface-soft'"
                >
                  <template v-if="m.role === 'user'">{{ m.content }}</template>
                  <template v-else>
                    <template v-for="(seg, i) in segmentsOf(m.content)" :key="i">
                      <NuxtLink v-if="seg.link" :to="seg.text" class="link font-semibold">{{ LINK_LABELS[seg.text] }}</NuxtLink>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </template>
                </div>

                <!-- 出典バッジ + 時刻 -->
                <div class="mt-1 flex flex-wrap items-center gap-1" :class="m.role === 'user' ? 'justify-end' : ''">
                  <UiStatusBadge v-for="src in m.sources" :key="src" :label="src" tone="brand" />
                  <span class="num text-[10px] text-muted">{{ fmtTime(m.at) }}</span>
                </div>

                <!-- サジェスト（最新の AI 応答のみ） -->
                <div
                  v-if="m.role === 'assistant' && m.id === lastAssistantId && !isStreaming && m.suggestions.length > 0"
                  class="mt-1.5 flex flex-wrap gap-1.5"
                >
                  <button
                    v-for="s in m.suggestions"
                    :key="s"
                    type="button"
                    class="rounded-full border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-sub transition-colors hover:border-brand hover:text-brand"
                    @click="onSuggestion(m, s)"
                  >
                    {{ s }}
                  </button>
                </div>
              </div>
            </div>

            <!-- ストリーミング中の吹き出し -->
            <div v-if="isStreaming" class="flex gap-2">
              <UiAvatar name="AI" kind="ai" size="sm" class="mt-1" />
              <div class="min-w-0 max-w-[85%] md:max-w-[72%]">
                <div class="whitespace-pre-wrap break-words rounded-xl rounded-bl-sm border border-line bg-surface-soft px-3 py-2 text-[13px] leading-relaxed">
                  <span v-if="streamingText === ''" class="text-muted">回答を生成中…</span>
                  <template v-else>{{ streamingText }}</template>
                  <span class="typing-caret" aria-hidden="true" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 入力欄 -->
        <div class="border-t border-line p-2 md:p-3">
          <div class="flex items-end gap-2">
            <textarea
              v-model="draft"
              :rows="rows"
              maxlength="2000"
              class="textarea flex-1"
              style="min-height: 40px"
              placeholder="質問を入力（Enter で送信 / Shift+Enter で改行）"
              aria-label="質問を入力"
              :disabled="isStreaming"
              @keydown="onKeydown"
            />
            <button
              type="button"
              class="btn btn-primary btn-lg shrink-0"
              :disabled="isStreaming || !draft.trim()"
              @click="onSend"
            >
              <SendHorizontal class="h-4 w-4" aria-hidden="true" />
              送信
            </button>
          </div>
          <p v-if="draft.length >= 1800" class="num mt-1 text-right text-[11px] text-muted">{{ draft.length }} / 2000</p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.typing-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--c-brand);
  animation: caret-blink 0.9s steps(2) infinite;
}
@keyframes caret-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
</style>
