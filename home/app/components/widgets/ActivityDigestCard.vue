<script setup lang="ts">
/**
 * 案件の AI集約カード（案件詳細ページの中段。改修依頼 2026-08-20）。
 * 営業活動（kind='sales'）とビジネスパートナー活動（kind='partner'）で**同一実装**を共有する（原則3）。
 * - 保存済み digest（活動ログの時系列集約）を表示し、「AIで集約」で生成 → 保管 → 再生成で上書き。
 * - モック = 決定的ヒューリスティック / API = LLM → 失敗時ヒューリスティック（原則4。生成は失敗しない設計）。
 * - 生成失敗（通信断・保存容量超過等）はカード内のインライン領域（role="alert"）へ表示（トースト任せにしない）。
 * - 基本情報の更新提案（BP のみ・改善要望 2026-08-21）: digest.proposal を現在値との差分で表示し、
 *   「基本情報へ反映」で確認 → 反映。反映後は「反映を取り消す」で元の値へ戻せる（原則9.5）。
 */
import { AlertCircle, Sparkles, Undo2 } from 'lucide-vue-next'
import type { ActivityAiDigest, ActivityDigestProposal } from '~/types/domain'
import { fmtDate, fmtDateTime } from '~/utils/format'

const props = defineProps<{
  kind: 'sales' | 'partner'
  activityId: string
  /** 保存済みの AI集約（未生成は null/undefined） */
  digest?: ActivityAiDigest | null
}>()

// 両 composable とも軽量（tbl 参照のみ）のため常時初期化し、kind で使い分ける
const sal = useSalesActivities()
const pact = usePartnerActivities()
const { show } = useToast()

const generating = ref(false)
const applying = ref(false)
const error = ref('')
/** 反映済みの取消用スナップショット（反映のたびに更新。再生成・別提案で破棄） */
const undoSource = ref<ActivityDigestProposal | null>(null)

// 表示対象の活動が切り替わったら前の活動のスナップショット・エラーを破棄する
// （残したまま「取消」すると別活動の before を新活動へ書き込んでしまう）
watch(() => props.activityId, () => {
  undoSource.value = null
  error.value = ''
})

async function generate(): Promise<void> {
  if (generating.value) return
  generating.value = true
  error.value = ''
  try {
    const res = props.kind === 'sales'
      ? await sal.generateDigest(props.activityId)
      : await pact.generateDigest(props.activityId)
    if (!res.ok) {
      error.value = `${res.error.code}: ${res.error.message}`
      return
    }
    undoSource.value = null // 新しい集約 = 過去の反映取消スナップショットは無効
    show('AI集約を生成しました')
  } finally {
    generating.value = false
  }
}

// ---------- 基本情報の更新提案（BP のみ。現在値との差分表示 → 反映 → 取消） ----------

const PROPOSAL_LABELS: Record<keyof ActivityDigestProposal, string> = {
  currentState: '現在状況',
  status: 'ステータス',
  nextAction: 'Next Action',
  nextActionDate: 'Next Action日',
  nextActionNote: 'Next Action メモ',
}

const current = computed(() => (props.kind === 'partner' ? pact.byId(props.activityId) : null))

/** 表示する差分行（提案があり、かつ現在値と異なるフィールドのみ。反映後は自然に消える） */
const proposalRows = computed(() => {
  const proposal = props.digest?.proposal
  const cur = current.value
  if (props.kind !== 'partner' || !proposal || !cur) return []
  const currentOf: Record<keyof ActivityDigestProposal, string> = {
    currentState: cur.currentState,
    status: cur.status,
    nextAction: cur.nextAction,
    nextActionDate: cur.nextActionDate ?? '',
    nextActionNote: cur.nextActionNote ?? '',
  }
  return (Object.keys(PROPOSAL_LABELS) as (keyof ActivityDigestProposal)[])
    .filter(k => proposal[k] !== undefined && String(proposal[k] ?? '') !== currentOf[k])
    .map(k => ({
      key: k,
      label: PROPOSAL_LABELS[k],
      from: k === 'nextActionDate' ? (currentOf[k] ? fmtDate(currentOf[k]) : '—') : (currentOf[k] || '—'),
      to: k === 'nextActionDate' ? fmtDate(String(proposal[k])) : String(proposal[k]),
    }))
})

async function applyProposal(): Promise<void> {
  const proposal = props.digest?.proposal
  if (!proposal || applying.value) return
  // 現在値と差のあるフィールドだけを反映する（表示している差分と反映内容を一致させる）
  const target: ActivityDigestProposal = {}
  for (const row of proposalRows.value) target[row.key] = proposal[row.key] as never
  if (Object.keys(target).length === 0) return // 全フィールドが現在値と同値 = 反映するものがない
  applying.value = true
  error.value = ''
  try {
    const res = await pact.applyDigestProposal(props.activityId, target)
    if (!res.ok) {
      error.value = `${res.error.code}: ${res.error.message}`
      return
    }
    undoSource.value = res.before ?? null
    show('AI集約の提案を基本情報へ反映しました')
  } finally {
    applying.value = false
  }
}

async function undoApply(): Promise<void> {
  if (!undoSource.value || applying.value) return
  applying.value = true
  error.value = ''
  try {
    const res = await pact.applyDigestProposal(props.activityId, undoSource.value)
    if (!res.ok) {
      error.value = `${res.error.code}: ${res.error.message}`
      return
    }
    undoSource.value = null
    show('基本情報への反映を取り消しました')
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <UiSectionCard title="AI集約" description="活動ログを時系列で読み、経緯と現在地を要約します（再生成で上書き）">
    <template #actions>
      <button type="button" class="btn btn-sm" :class="digest ? '' : 'btn-primary'" :disabled="generating" @click="generate">
        <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
        {{ generating ? '生成中…' : digest ? '再生成' : 'AIで集約' }}
      </button>
    </template>

    <div v-if="digest" class="grid gap-2">
      <p class="whitespace-pre-wrap text-[13px] leading-relaxed">{{ digest.summary }}</p>
      <ul v-if="(digest.highlights ?? []).length > 0" class="grid gap-1">
        <li v-for="(h, i) in digest.highlights" :key="i" class="flex items-start gap-1.5 text-xs text-sub">
          <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand" aria-hidden="true" />
          {{ h }}
        </li>
      </ul>
      <p class="text-[11px] text-muted">
        {{ fmtDateTime(digest.generatedAt) }} 生成・ログ {{ digest.logCount }} 件時点
        <UiStatusBadge class="ml-1" :label="digest.llm ? 'AI生成' : '簡易集約'" :tone="digest.llm ? 'brand' : 'neutral'" />
      </p>

      <!-- 基本情報の更新提案（BP のみ。AI 入力 → 確認 → 反映 = 改善要望 2026-08-21。
           反映は差分フィールドのみの部分更新で、「反映を取り消す」で元の値へ戻せる = 原則9.5） -->
      <div v-if="proposalRows.length > 0" class="rounded-lg border border-brand bg-brand-soft p-3">
        <p class="text-[12px] font-bold text-brand">活動ログから読み取った基本情報の更新案</p>
        <ul class="mt-1.5 grid gap-1">
          <li v-for="row in proposalRows" :key="row.key" class="grid gap-0.5 text-xs">
            <span class="font-semibold">{{ row.label }}</span>
            <span class="min-w-0 text-sub">
              <span class="line-through opacity-70">{{ row.from }}</span>
              <span class="mx-1" aria-hidden="true">→</span>
              <span class="font-medium text-ink">{{ row.to }}</span>
            </span>
          </li>
        </ul>
        <div class="mt-2 flex items-center gap-2">
          <button type="button" class="btn btn-sm btn-primary" :disabled="applying" @click="applyProposal">
            {{ applying ? '反映中…' : '基本情報へ反映' }}
          </button>
          <span class="text-[11px] text-muted">内容を確認してから反映してください</span>
        </div>
      </div>
      <div v-else-if="undoSource" class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-brand-soft px-3 py-2">
        <p class="text-[12px] font-medium text-brand">提案を基本情報へ反映しました</p>
        <button type="button" class="btn btn-sm" :disabled="applying" @click="undoApply">
          <Undo2 class="h-3.5 w-3.5" aria-hidden="true" />
          反映を取り消す
        </button>
      </div>
    </div>
    <UiEmptyState
      v-else
      icon="Sparkles"
      title="AI集約は未生成です"
      hint="「AIで集約」を押すと、活動ログを時系列で読み取って経緯を要約します"
    />

    <p v-if="error" role="alert" class="mt-2 flex items-start gap-1.5 rounded-lg border border-crit bg-crit-soft px-3 py-2 text-[13px] font-medium text-crit">
      <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {{ error }}
    </p>
  </UiSectionCard>
</template>
