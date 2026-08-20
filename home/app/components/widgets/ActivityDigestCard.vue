<script setup lang="ts">
/**
 * 案件の AI集約カード（案件詳細ページの中段。改修依頼 2026-08-20）。
 * 営業活動（kind='sales'）とビジネスパートナー活動（kind='partner'）で**同一実装**を共有する（原則3）。
 * - 保存済み digest（活動ログの時系列集約）を表示し、「AIで集約」で生成 → 保管 → 再生成で上書き。
 * - モック = 決定的ヒューリスティック / API = LLM → 失敗時ヒューリスティック（原則4。生成は失敗しない設計）。
 * - 生成失敗（通信断・保存容量超過等）はカード内のインライン領域（role="alert"）へ表示（トースト任せにしない）。
 */
import { AlertCircle, Sparkles } from 'lucide-vue-next'
import type { ActivityAiDigest } from '~/types/domain'
import { fmtDateTime } from '~/utils/format'

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
const error = ref('')

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
    show('AI集約を生成しました')
  } finally {
    generating.value = false
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
