<script setup lang="ts">
/**
 * フィードバックループ履歴（FI-05）: 分析サイクルの記録（追記のみの記録系）。
 * 各サイクルの入力スナップショット・反映フィードバック・生成インサイト・紐づくアクションを時系列で可視化する。
 */
import { Database, Info, Lightbulb, ListChecks, RefreshCw } from 'lucide-vue-next'
import type { IntelCycle } from '~/types/intelligence'
import {
  ACTION_STATUS_LABELS, ACTION_STATUS_TONES, FEEDBACK_EFFECT_LABELS,
  INSIGHT_THEME_LABELS, INSIGHT_THEME_TONES,
} from '~/utils/labels'
import { fmtDateTime, fmtInt } from '~/utils/format'

const { cycles, insights, actions } = useIntelStore()
const data = useIntelligenceData()

const sorted = computed(() =>
  [...cycles.value].filter(c => c.active).sort((a, b) => b.at.localeCompare(a.at)))

const { page, pageSize, rows: pagedCycles, total } = useListView<IntelCycle>({ source: sorted })

function insightsOf(c: IntelCycle) {
  return insights.value.filter(i => c.insightIds.includes(i.id))
}

/** サイクルのインサイト由来で作られたアクション */
function actionsOf(c: IntelCycle) {
  return actions.value.filter(a => a.active && a.insightId && c.insightIds.includes(a.insightId))
}
</script>

<template>
  <div>
    <UiPageHeader
      title="フィードバックループ履歴"
      description="分析のたびにサイクルを記録します（データ → 分析 → アクション → フィードバック → 次の分析）"
    />

    <!-- モック境界の明示（N-4。R1 監査指摘: 記録の保存先と制約を画面で伝える） -->
    <div class="mb-3 flex items-start gap-2 rounded-lg border border-info/40 bg-info-soft p-3 text-xs leading-relaxed">
      <Info class="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
      <p class="text-sub">
        サイクル履歴は<span class="font-semibold">このブラウザに保存されます（端末間同期なし。ブラウザデータの消去で失われます）。</span>
        共通 API での本実装（サーバー保存）までの暫定機能です。
      </p>
    </div>

    <!-- ループ構造の説明 -->
    <UiSectionCard class="mb-3">
      <div class="flex flex-wrap items-center justify-center gap-2 text-[12px]">
        <span class="flex items-center gap-1.5 rounded-full border border-line bg-surface-soft px-3 py-1">
          <Database class="h-3.5 w-3.5 text-sub" aria-hidden="true" /> 共通基盤データ
        </span>
        <span class="text-muted">→</span>
        <span class="flex items-center gap-1.5 rounded-full border border-line bg-surface-soft px-3 py-1">
          <Lightbulb class="h-3.5 w-3.5 text-sub" aria-hidden="true" /> 分析・インサイト・提案
        </span>
        <span class="text-muted">→</span>
        <span class="flex items-center gap-1.5 rounded-full border border-line bg-surface-soft px-3 py-1">
          <ListChecks class="h-3.5 w-3.5 text-sub" aria-hidden="true" /> アクション実行・結果
        </span>
        <span class="text-muted">→</span>
        <span class="flex items-center gap-1.5 rounded-full border border-brand bg-brand-soft px-3 py-1 font-semibold text-brand">
          <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" /> フィードバック → 次の分析へ反映
        </span>
      </div>
    </UiSectionCard>

    <UiEmptyState
      v-if="sorted.length === 0"
      icon="RefreshCw"
      title="分析サイクルがまだありません"
      hint="インサイトから「分析を実行」すると 1 サイクルが記録されます"
    />

    <ol class="grid gap-0">
      <li
        v-for="c in pagedCycles"
        :key="c.id"
        class="relative border-l-2 border-line pb-4 pl-5 last:pb-0"
      >
        <span class="absolute -left-[9px] top-1 h-4 w-4 rounded-full border-2 border-brand bg-surface" aria-hidden="true" />
        <div class="card p-3">
          <div class="flex flex-wrap items-center gap-1.5">
            <UiStatusBadge :label="INSIGHT_THEME_LABELS[c.theme]" :tone="INSIGHT_THEME_TONES[c.theme]" />
            <span class="text-[13px] font-semibold">{{ c.targetName }}</span>
            <span class="num ml-auto text-[11px] text-muted">{{ fmtDateTime(c.at) }} / {{ data.memberName(c.createdBy) }}</span>
          </div>

          <div class="mt-2 grid gap-3 md:grid-cols-2">
            <div>
              <p class="mb-1 text-[11px] font-bold text-muted">入力スナップショット</p>
              <ul class="flex flex-wrap gap-1.5">
                <li
                  v-for="(e, i) in c.inputSnapshot"
                  :key="i"
                  class="rounded-full border border-line bg-surface-soft px-2.5 py-0.5 text-[11px]"
                >
                  {{ e.label }} <span class="num text-muted">{{ fmtInt(e.count) }}件</span>
                </li>
              </ul>

              <p class="mb-1 mt-2.5 text-[11px] font-bold" :class="c.feedbackConsidered.length > 0 ? 'text-brand' : 'text-muted'">
                反映したフィードバック（{{ c.feedbackConsidered.length }} 件）
              </p>
              <p v-if="c.feedbackConsidered.length === 0" class="text-[11px] text-muted">
                このサイクルでは反映対象の過去アクションがありませんでした
              </p>
              <ul v-else class="grid gap-1 text-[12px]">
                <li v-for="fb in c.feedbackConsidered" :key="fb.actionId" class="rounded-lg bg-brand-soft/50 px-2.5 py-1.5">
                  <span class="font-medium">{{ fb.title }}</span>
                  <span v-if="fb.rating !== null" class="num text-muted">（評価 {{ fb.rating }}/5）</span>
                  <span class="block text-[11px] text-sub">{{ FEEDBACK_EFFECT_LABELS[fb.effect] }}</span>
                </li>
              </ul>
            </div>

            <div>
              <p class="mb-1 text-[11px] font-bold text-muted">生成したインサイト</p>
              <ul class="grid gap-1.5">
                <li v-for="ins in insightsOf(c)" :key="ins.id" class="rounded-lg border border-line px-2.5 py-1.5">
                  <NuxtLink to="/insights" class="link text-[13px] font-medium">{{ ins.title }}</NuxtLink>
                  <span v-if="!ins.active" class="ml-1 text-[10px] text-muted">（アーカイブ済み）</span>
                  <p class="mt-0.5 line-clamp-2 text-[11px] text-sub">{{ ins.summary }}</p>
                </li>
              </ul>

              <p class="mb-1 mt-2.5 text-[11px] font-bold text-muted">紐づくアクション（{{ actionsOf(c).length }} 件）</p>
              <p v-if="actionsOf(c).length === 0" class="text-[11px] text-muted">まだアクション化されていません</p>
              <ul v-else class="grid gap-1">
                <li v-for="a in actionsOf(c)" :key="a.id" class="flex items-center gap-1.5 text-[12px]">
                  <UiStatusBadge :label="ACTION_STATUS_LABELS[a.status]" :tone="ACTION_STATUS_TONES[a.status]" dot />
                  <span class="min-w-0 flex-1 truncate">{{ a.title }}</span>
                  <span v-if="a.feedbackRating !== null" class="num shrink-0 text-[11px] text-brand">{{ a.feedbackRating }}/5</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </li>
    </ol>
    <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
  </div>
</template>
