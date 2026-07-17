<script setup lang="ts">
/**
 * 意思決定支援（F-02）テーマ一覧 + 判断履歴
 */
import { ArrowRight, Target } from 'lucide-vue-next'
import type { TableColumn } from '~/types/ui'
import { fmtDateTime } from '~/utils/format'

const decision = useDecision()
const { themes, logs } = decision
// サーバー側で進んだ判断ログ（他者の記録）を表示時に取り込む
onMounted(() => { void decision.refresh() })
const { tbl } = useMockDb()
const members = tbl('members')

const historyColumns: TableColumn[] = [
  { key: 'themeTitle', label: 'テーマ', primary: true },
  { key: 'slot', label: '選択', width: '110px', primary: true },
  { key: 'decidedByName', label: '判断者', width: '110px' },
  { key: 'atText', label: '日時', width: '130px', primary: true },
  { key: 'reason', label: '理由' },
]

const historyRows = computed(() =>
  logs.value.map(l => ({
    ...l,
    themeTitle: themes.value.find(t => t.id === l.themeId)?.title ?? l.themeId,
    slot: l.chosenSlot,
    decidedByName: members.value.find(m => m.id === l.decidedBy)?.name ?? l.decidedBy,
    atText: fmtDateTime(l.at),
  })))
</script>

<template>
  <div>
    <UiPageHeader
      title="意思決定支援"
      description="①意味 ②関係 ③制約 のオントロジーで判断テーマを整理し、制約を通った打ち手だけを選択肢に昇格させます"
    />

    <!-- テーマカード一覧 -->
    <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      <NuxtLink
        v-for="t in themes"
        :key="t.id"
        :to="`/decision/${t.id}`"
        class="card group flex flex-col gap-2 p-3 transition-colors hover:border-brand"
      >
        <div class="flex items-center gap-2">
          <UiStatusBadge :label="DECISION_CATEGORY_LABELS[t.category]" :tone="DECISION_CATEGORY_TONES[t.category]" />
          <span class="num ml-auto text-[11px] text-muted">選択肢 {{ t.options.length }} / 打ち手 {{ t.actions.length }}</span>
        </div>
        <h2 class="text-[14px] font-bold leading-snug">{{ t.title }}</h2>
        <p class="flex items-start gap-1.5 text-xs text-sub">
          <Target class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
          {{ t.objective }}
        </p>
        <span class="mt-auto inline-flex items-center gap-1 self-end text-xs font-semibold text-brand">
          検討する
          <ArrowRight class="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </span>
      </NuxtLink>
    </div>

    <!-- 判断履歴 -->
    <UiSectionCard class="mt-4" title="判断履歴" description="記録された意思決定ログ（分析基盤への蓄積対象）" flush>
      <UiDataTable
        :columns="historyColumns"
        :rows="historyRows"
        clickable
        empty-title="判断履歴はまだありません"
        empty-hint="テーマを検討して「判断を記録」すると、ここに履歴が残ります"
        @row-click="row => navigateTo(`/decision/${row.themeId}`)"
      >
        <template #cell-slot="{ value }">
          <UiStatusBadge :label="`選択肢 ${value}`" tone="brand" />
        </template>
      </UiDataTable>
    </UiSectionCard>
  </div>
</template>
