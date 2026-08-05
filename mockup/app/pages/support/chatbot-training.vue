<script setup lang="ts">
/**
 * チャットボット・トレーナー画面（オペレーター指示 2026-08-05: フィードバック還元ループ）。
 * - フィードバック一覧: 質問文 + 診断メタデータ（発火ブロック・検索ヒット・ツール呼出・confidence 等）。
 *   回答本文は質問者が「トレーナー共有」に同意したセッションのみ表示（5 層権限モデルの迂回防止）
 * - 同義語辞書: ユーザーの言い回し → 話題判定の正規語（例: 休み → 休暇）。登録は即時に
 *   文脈収集（buildContext）へ反映され、語彙ギャップ由来の取りこぼしを運用で埋める
 * 利用可否は canTrainChatbot（許可制。既定 = 管理者のみ。機能キー 'chatbot-training' の allow で付与）
 */
import { BookA, MessageSquareWarning, ThumbsDown, ThumbsUp } from 'lucide-vue-next'
import type { ChatSynonym } from '~/types/domain'
import { fmtDateTime } from '~/utils/format'

interface TrainingDiag {
  blocks?: string[]
  searchHits?: number
  contextCp?: number
  toolCalls?: { name: string; ok: boolean }[]
  rounds?: number
  usage?: { promptTokens: number; outputTokens: number; totalTokens: number } | null
  confidence?: number | null
  discarded?: boolean
  durationMs?: number
}

interface TrainingFeedbackRow {
  id: string
  rating: 'good' | 'bad'
  comment: string
  updatedAt: string
  kind: 'ai' | 'fallback' | null
  diag: TrainingDiag | null
  question: string
  askerName: string
  shared: boolean
  answer?: string
}

const { canTrainChatbot } = usePermissions()
const { tbl, commit, nextId } = useMockDb()
const { currentUser } = useCurrentUser()
const isApi = useApiMode()
const toast = useToast()

const feedback = ref<TrainingFeedbackRow[]>([])
const synonyms = ref<ChatSynonym[]>([])
const ratingFilter = ref<'all' | 'good' | 'bad'>('all')
const loading = ref(false)

/** モックモード: chatFeedback をローカルテーブルから合成（API と同じプライバシーガードを適用） */
function buildMockFeedback(): TrainingFeedbackRow[] {
  const messages = tbl('chatMessages').value
  const sessions = tbl('chatSessions').value
  const members = tbl('members').value
  return [...tbl('chatFeedback').value]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 100)
    .map((f) => {
      const msg = messages.find(m => m.id === f.messageId)
      const session = sessions.find(s => s.id === (f.sessionId || msg?.sessionId))
      const idx = messages.findIndex(m => m.id === f.messageId)
      const question = idx >= 0
        ? [...messages.slice(0, idx)].reverse().find(m => m.sessionId === msg?.sessionId && m.role === 'user')?.content ?? ''
        : ''
      const shared = session?.trainerShared === true
      return {
        id: f.id,
        rating: f.rating,
        comment: f.comment,
        updatedAt: f.updatedAt,
        kind: msg?.kind ?? null,
        diag: null, // モックモードは診断スナップショットなし（LLM 経路がないため）
        question: question.slice(0, 500),
        // API と同じプライバシーガード: 質問者は既定匿名。共有同意セッションのみ氏名を開示
        askerName: shared ? (members.find(m => m.id === f.memberId)?.name ?? '') : '',
        shared,
        ...(shared && msg ? { answer: msg.content.slice(0, 1000) } : {}),
      }
    })
}

async function reload(): Promise<void> {
  loading.value = true
  try {
    if (isApi) {
      const q = ratingFilter.value === 'all' ? '' : `?rating=${ratingFilter.value}`
      feedback.value = await apiFetch<TrainingFeedbackRow[]>(`/v1/chatbot/training/feedback${q}`)
      synonyms.value = await apiFetch<ChatSynonym[]>('/v1/chatbot/training/synonyms')
    } else {
      const all = buildMockFeedback()
      feedback.value = ratingFilter.value === 'all' ? all : all.filter(f => f.rating === ratingFilter.value)
      synonyms.value = [...tbl('chatSynonyms').value].sort((a, b) => a.term.localeCompare(b.term))
    }
  } catch (e) {
    toast.show(apiErrorOf(e).message, 'warn')
  } finally {
    loading.value = false
  }
}

watch(ratingFilter, () => { void reload() })
onMounted(() => { void reload() })

// ---------- 同義語辞書の管理 ----------

const termDraft = ref('')
const canonicalDraft = ref('')
const noteDraft = ref('')

async function onAddSynonym(): Promise<void> {
  const term = termDraft.value.trim()
  const canonical = canonicalDraft.value.trim()
  if (!term || !canonical) {
    toast.show('言い回しと正規語の両方を入力してください', 'info')
    return
  }
  if (term === canonical) {
    toast.show('言い回しと正規語が同一です', 'info')
    return
  }
  if (isApi) {
    try {
      await apiFetch('/v1/chatbot/training/synonyms', {
        method: 'POST', body: { term, canonical, note: noteDraft.value.trim() },
      })
    } catch (e) {
      toast.show(apiErrorOf(e).message, 'warn')
      return
    }
  } else {
    const syns = tbl('chatSynonyms')
    const existing = syns.value.find(s => s.term === term && s.canonical === canonical)
    // 同一ペアの再登録は再有効化（API と同じ冪等挙動）
    syns.value = existing
      ? syns.value.map(s => s.id === existing.id ? { ...s, note: noteDraft.value.trim(), active: true } : s)
      : [...syns.value, {
          id: nextId('chatSynonyms', 'syn'),
          term, canonical, note: noteDraft.value.trim(), active: true,
        }]
    commit()
  }
  termDraft.value = ''
  canonicalDraft.value = ''
  noteDraft.value = ''
  toast.show('同義語を登録しました（以降の質問の話題判定へ反映されます）')
  await reload()
}

/** 有効/無効の切替（無効化 = 取消。再有効化で復元できる = 原則9.5） */
async function onToggleSynonym(s: ChatSynonym): Promise<void> {
  if (isApi) {
    try {
      await apiFetch(`/v1/chatbot/training/synonyms/${s.id}`, {
        method: 'PUT', body: { active: !s.active },
      })
    } catch (e) {
      toast.show(apiErrorOf(e).message, 'warn')
      return
    }
  } else {
    const syns = tbl('chatSynonyms')
    syns.value = syns.value.map(x => x.id === s.id ? { ...x, active: !x.active } : x)
    commit()
  }
  toast.show(s.active ? '無効化しました（再度有効化できます）' : '有効化しました')
  await reload()
}

/**
 * 診断の要約行（トレーナーが原因を一目で判別するための圧縮表示）。
 * diag はフォールバック経路でクライアントを経由した改竄可能な値のため、
 * 形の崩れた値でも描画が落ちないよう全フィールドを防御的に読む（監査指摘 2026-08-05）
 */
function diagSummary(d: TrainingDiag | null): string {
  if (!d || typeof d !== 'object') return '診断なし'
  const parts: string[] = []
  if (d.discarded === true) parts.push('低確信度で破棄')
  if (typeof d.confidence === 'number' && Number.isFinite(d.confidence)) {
    parts.push(`確信度 ${d.confidence.toFixed(2)}`)
  }
  const blocksCount = Array.isArray(d.blocks)
    ? d.blocks.length
    : (typeof (d as { blocksCount?: unknown }).blocksCount === 'number'
        ? (d as { blocksCount: number }).blocksCount
        : 0)
  parts.push(`文脈ブロック ${blocksCount} 件`)
  parts.push(`検索ヒット ${typeof d.searchHits === 'number' ? d.searchHits : 0} 件`)
  if (Array.isArray(d.toolCalls) && d.toolCalls.length > 0) {
    parts.push(`ツール: ${d.toolCalls
      .filter(t => t && typeof t.name === 'string')
      .map(t => `${t.name}${t.ok ? '' : '(失敗)'}`).join('・')}`)
  }
  const total = d.usage && typeof d.usage.totalTokens === 'number' ? d.usage.totalTokens : null
  if (total !== null) parts.push(`${total.toLocaleString('ja-JP')} tokens`)
  return parts.join(' / ')
}
</script>

<template>
  <div>
    <UiEmptyState
      v-if="!canTrainChatbot"
      icon="Lock"
      title="トレーナー権限がありません"
      hint="この画面の利用には権限設定（機能キー: chatbot-training）の許可が必要です。管理者にお問い合わせください"
    >
      <template #action>
        <NuxtLink to="/support/chatbot" class="btn btn-sm">チャットボットへ戻る</NuxtLink>
      </template>
    </UiEmptyState>

    <template v-else>
      <UiPageHeader
        title="チャットボット・トレーナー"
        description="ユーザーのフィードバックから回答の取りこぼしを特定し、同義語辞書で話題判定を育てます。回答本文は質問者が共有に同意した会話のみ表示されます"
      />

      <!-- フィードバック一覧 -->
      <div class="card p-3">
        <div class="mb-2 flex items-center justify-between gap-2">
          <h2 class="flex items-center gap-1.5 text-sm font-bold">
            <MessageSquareWarning class="h-4 w-4" aria-hidden="true" />
            フィードバック
          </h2>
          <div class="flex gap-1">
            <button
              v-for="f in (['all', 'bad', 'good'] as const)"
              :key="f"
              type="button"
              class="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
              :class="ratingFilter === f ? 'border-brand bg-brand-soft text-brand' : 'border-line text-sub'"
              @click="ratingFilter = f"
            >
              {{ f === 'all' ? 'すべて' : f === 'bad' ? '役に立たなかった' : '役に立った' }}
            </button>
          </div>
        </div>

        <UiEmptyState
          v-if="!loading && feedback.length === 0"
          icon="Inbox"
          title="フィードバックはまだありません"
          hint="チャットボットの回答についた 👍/👎 がここに集まります"
        />
        <ul v-else class="grid gap-2">
          <li v-for="f in feedback" :key="f.id" class="rounded-lg border border-line p-2.5">
            <div class="flex flex-wrap items-center gap-1.5">
              <ThumbsUp v-if="f.rating === 'good'" class="h-3.5 w-3.5 text-ok" aria-hidden="true" />
              <ThumbsDown v-else class="h-3.5 w-3.5 text-crit" aria-hidden="true" />
              <UiStatusBadge
                v-if="f.kind === 'fallback'"
                label="定型応答"
                tone="warn"
              />
              <UiStatusBadge v-else-if="f.kind === 'ai'" label="AI応答" tone="brand" />
              <span class="text-xs text-sub">{{ f.askerName || '（匿名）' }}</span>
              <span class="num text-[11px] text-muted">{{ fmtDateTime(f.updatedAt) }}</span>
            </div>
            <p class="mt-1 break-words text-[13px] font-semibold">Q: {{ f.question || '（質問不明）' }}</p>
            <p v-if="f.comment" class="mt-0.5 break-words text-xs text-sub">コメント: {{ f.comment }}</p>
            <p class="num mt-1 text-[11px] text-muted">{{ diagSummary(f.diag) }}</p>
            <p v-if="f.shared && f.answer" class="mt-1 whitespace-pre-wrap break-words rounded bg-surface-soft p-2 text-xs">
              A: {{ f.answer }}
            </p>
            <p v-else class="mt-1 text-[11px] text-muted">
              回答本文は非共有です（質問者が会話の「トレーナー共有」に同意すると表示されます）
            </p>
          </li>
        </ul>
      </div>

      <!-- 同義語辞書 -->
      <div class="card mt-3 p-3">
        <h2 class="mb-1 flex items-center gap-1.5 text-sm font-bold">
          <BookA class="h-4 w-4" aria-hidden="true" />
          同義語辞書
        </h2>
        <p class="mb-2 text-xs text-sub">
          ユーザーの言い回しを話題判定の正規語へつなぎます（例: 「休み」→「休暇」で勤怠の文脈が届くようになる）。
          登録は以降の質問へ即時反映されます。無効化はいつでも取り消せます
        </p>
        <div class="mb-3 flex flex-wrap items-end gap-1.5">
          <label class="grid gap-0.5 text-[11px] text-muted">
            言い回し
            <input v-model="termDraft" type="text" maxlength="40" class="input w-32 text-xs" placeholder="休み">
          </label>
          <span class="pb-2 text-muted">→</span>
          <label class="grid gap-0.5 text-[11px] text-muted">
            正規語
            <input v-model="canonicalDraft" type="text" maxlength="40" class="input w-32 text-xs" placeholder="休暇">
          </label>
          <label class="grid gap-0.5 text-[11px] text-muted">
            メモ（任意）
            <input v-model="noteDraft" type="text" maxlength="200" class="input w-48 text-xs" placeholder="フィードバック #12 対応">
          </label>
          <button type="button" class="btn btn-primary btn-sm" @click="onAddSynonym">登録</button>
        </div>
        <UiEmptyState
          v-if="synonyms.length === 0"
          icon="BookA"
          title="同義語はまだ登録されていません"
          hint="「役に立たなかった」フィードバックの質問文から、拾えなかった言い回しを登録していきましょう"
        />
        <ul v-else class="grid gap-1">
          <li
            v-for="s in synonyms"
            :key="s.id"
            class="flex flex-wrap items-center gap-2 rounded-lg border border-line px-2.5 py-1.5"
            :class="s.active ? '' : 'opacity-50'"
          >
            <span class="text-[13px] font-semibold">{{ s.term }} → {{ s.canonical }}</span>
            <span v-if="s.note" class="text-xs text-muted">{{ s.note }}</span>
            <button type="button" class="btn btn-ghost btn-sm ml-auto" @click="onToggleSynonym(s)">
              {{ s.active ? '無効化' : '有効化' }}
            </button>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
