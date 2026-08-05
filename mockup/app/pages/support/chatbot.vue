<script setup lang="ts">
/**
 * F-09-2 AIチャットボット: 会話 UI（吹き出し・擬似ストリーミング・出典バッジ・サジェストチップ）
 * セッション管理: 「新しい会話」で新規開始・「履歴」ドロワーから過去セッションを再開（続きから質問できる）。
 * リンクはテキスト分解で描画（v-html 禁止）。Enter 送信 / Shift+Enter 改行 / 2000 字制限。
 */
import { History, MessageSquarePlus, SendHorizontal, Share2, ThumbsDown, ThumbsUp } from 'lucide-vue-next'
import type { ChatMessage } from '~/types/domain'
import { fmtDateTime, fmtTime } from '~/utils/format'

const { isEnabled } = useAppSettings()
const {
  messages, sessions, currentSessionId, currentSessionShared, isStreaming, streamingText,
  send, newSession, openSession, refresh, refreshSessions, finalize, escalate,
  sendFeedback, clearFeedback, setSessionShared,
} = useChatbot()
const { canTrainChatbot } = usePermissions()
const toast = useToast()

const draft = ref('')
const listEl = ref<HTMLElement | null>(null)

const rows = computed(() => Math.min(4, Math.max(1, draft.value.split('\n').length)))

/** 内部リンクのテキスト分解描画（content 中のパスをリンク化） */
const LINK_LABELS: Record<string, string> = {
  '/support/documents': 'ドキュメント管理',
  '/attendance': '勤怠管理',
  '/workflow': '稟議',
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

// ---------- good/bad フィードバック（観測基盤 = オペレーター指示 2026-08-05） ----------

/** bad 選択後の任意コメント入力の対象メッセージ id（null = 非表示） */
const commentFor = ref<string | null>(null)
const commentDraft = ref('')

/**
 * フィードバック対象の id（API モードのローカル表示 id「ch-l*」= サーバー未永続は対象外。
 * モックモードとサーバー発番 id はそのまま対象にできる）
 */
function feedbackTargetId(m: ChatMessage): string | null {
  return m.role === 'assistant' && !m.id.startsWith('ch-l') ? m.id : null
}

/** 評価の登録・変更。同じ評価をもう一度押すと取消（原則9.5） */
async function onFeedback(m: ChatMessage, rating: 'good' | 'bad'): Promise<void> {
  const id = feedbackTargetId(m)
  if (!id) return
  if (m.feedback === rating) {
    const r = await clearFeedback(id)
    if (r.ok) {
      if (commentFor.value === id) commentFor.value = null
      toast.show('評価を取り消しました')
    } else {
      toast.show(`${r.error.code}: ${r.error.message}`, 'warn')
    }
    return
  }
  const r = await sendFeedback(id, rating)
  if (!r.ok) {
    toast.show(`${r.error.code}: ${r.error.message}`, 'warn')
    return
  }
  if (rating === 'bad') {
    commentFor.value = id
    commentDraft.value = ''
    toast.show('記録しました。よろしければ改善のヒント（任意）も教えてください')
  } else {
    if (commentFor.value === id) commentFor.value = null
    toast.show('フィードバックを記録しました')
  }
}

/** bad の任意コメント送信（rating と一緒に上書き保存） */
async function onSendComment(m: ChatMessage): Promise<void> {
  const id = feedbackTargetId(m)
  if (!id) return
  const r = await sendFeedback(id, 'bad', commentDraft.value.trim())
  if (r.ok) {
    commentFor.value = null
    toast.show('コメントを送信しました')
  } else {
    toast.show(`${r.error.code}: ${r.error.message}`, 'warn')
  }
}

/** トレーナー共有の同意トグル（本文開示の明示同意。いつでも解除できる = 原則9.5） */
async function onToggleShare(): Promise<void> {
  const next = !currentSessionShared.value
  const r = await setSessionShared(next)
  if (r.ok) {
    toast.show(next
      ? 'この会話をトレーナーへ共有しました（回答本文が閲覧可能になります。いつでも解除できます）'
      : 'トレーナーへの共有を解除しました')
  } else {
    toast.show(`${r.error.code}: ${r.error.message}`, 'warn')
  }
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

// ---------- セッション操作（新しい会話・履歴からの再開） ----------

const historyOpen = ref(false)

function onNewSession(): void {
  newSession()
  toast.show('新しい会話を開始しました（過去の会話は履歴から再開できます）')
}

async function onOpenHistory(): Promise<void> {
  await refreshSessions()
  historyOpen.value = true
}

async function onOpenSession(id: string): Promise<void> {
  const r = await openSession(id)
  historyOpen.value = false
  if (!r.ok) {
    toast.show(`${r.error.code}: ${r.error.message}`, 'warn')
    return
  }
  scrollToBottom()
}

function scrollToBottom(): void {
  nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  })
}

watch(() => messages.value.length, scrollToBottom)
watch(streamingText, scrollToBottom)
onMounted(() => {
  void refresh() // API モード: セッション一覧 + 表示中セッションの復元
  scrollToBottom()
})

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
      <UiPageHeader title="AIチャットボット" description="社内データを参照して AI が回答します。会話はセッションとして保存され、履歴から続きを再開できます">
        <template #actions>
          <NuxtLink v-if="canTrainChatbot" to="/support/chatbot-training" class="btn btn-ghost btn-sm">
            トレーナー
          </NuxtLink>
          <button
            v-if="currentSessionId"
            type="button"
            class="btn btn-ghost btn-sm"
            :title="currentSessionShared
              ? 'この会話の回答本文をトレーナーが閲覧できます（クリックで解除）'
              : 'この会話の回答本文をトレーナーへ共有します（いつでも解除できます）'"
            @click="onToggleShare"
          >
            <Share2 class="h-3.5 w-3.5" aria-hidden="true" />
            {{ currentSessionShared ? '共有中' : 'トレーナー共有' }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="onOpenHistory">
            <History class="h-3.5 w-3.5" aria-hidden="true" />
            履歴
          </button>
          <button type="button" class="btn btn-sm" :disabled="messages.length === 0 && !currentSessionId" @click="onNewSession">
            <MessageSquarePlus class="h-3.5 w-3.5" aria-hidden="true" />
            新しい会話
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
            hint="勤怠・有給・顧客情報・売上・稼働状況・規程・保管ドキュメントを実データから回答します"
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

                <!-- 応答種別 + 出典バッジ + 時刻 + フィードバック -->
                <div class="mt-1 flex flex-wrap items-center gap-1" :class="m.role === 'user' ? 'justify-end' : ''">
                  <UiStatusBadge
                    v-if="m.role === 'assistant' && m.kind === 'fallback'"
                    label="定型応答（AI回答ではありません）"
                    tone="warn"
                  />
                  <UiStatusBadge v-for="src in m.sources" :key="src" :label="src" tone="brand" />
                  <span class="num text-[10px] text-muted">{{ fmtTime(m.at) }}</span>
                  <template v-if="feedbackTargetId(m)">
                    <button
                      type="button"
                      class="rounded p-1 transition-colors"
                      :class="m.feedback === 'good' ? 'text-ok' : 'text-muted hover:text-sub'"
                      :aria-label="m.feedback === 'good' ? '「役に立った」を取り消す' : '役に立った'"
                      :title="m.feedback === 'good' ? '「役に立った」を取り消す' : '役に立った'"
                      @click="onFeedback(m, 'good')"
                    >
                      <ThumbsUp class="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class="rounded p-1 transition-colors"
                      :class="m.feedback === 'bad' ? 'text-crit' : 'text-muted hover:text-sub'"
                      :aria-label="m.feedback === 'bad' ? '「役に立たなかった」を取り消す' : '役に立たなかった'"
                      :title="m.feedback === 'bad' ? '「役に立たなかった」を取り消す' : '役に立たなかった'"
                      @click="onFeedback(m, 'bad')"
                    >
                      <ThumbsDown class="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </template>
                </div>

                <!-- bad 選択後の任意コメント（改善ヒント） -->
                <div v-if="commentFor === m.id" class="mt-1.5 flex items-center gap-1.5">
                  <input
                    v-model="commentDraft"
                    type="text"
                    maxlength="500"
                    class="input flex-1 text-xs"
                    placeholder="改善のヒント（任意。例: 先月分も知りたかった）"
                    aria-label="フィードバックのコメント"
                    @keydown.enter.prevent="onSendComment(m)"
                  >
                  <button type="button" class="btn btn-sm" @click="onSendComment(m)">送信</button>
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

      <!-- 会話履歴（セッション一覧。クリックで続きから再開） -->
      <UiDrawer :open="historyOpen" title="会話の履歴" @close="historyOpen = false">
        <UiEmptyState
          v-if="sessions.length === 0"
          icon="History"
          title="保存された会話はまだありません"
          hint="質問を送信すると会話がセッションとして保存されます"
        />
        <ul v-else class="grid gap-1.5">
          <li v-for="s in sessions" :key="s.id">
            <button
              type="button"
              class="w-full rounded-lg border p-2.5 text-left transition-colors hover:bg-surface-soft"
              :class="s.id === currentSessionId ? 'border-brand bg-brand-soft' : 'border-line'"
              @click="onOpenSession(s.id)"
            >
              <p class="truncate text-[13px] font-semibold">{{ s.title || '（無題の会話）' }}</p>
              <p class="num mt-0.5 text-[11px] text-muted">
                {{ fmtDateTime(s.updatedAt) }}{{ s.messageCount !== undefined ? ` ・ ${s.messageCount} 件` : '' }}
                {{ s.id === currentSessionId ? ' ・ 表示中' : '' }}
              </p>
            </button>
          </li>
        </ul>
      </UiDrawer>
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
