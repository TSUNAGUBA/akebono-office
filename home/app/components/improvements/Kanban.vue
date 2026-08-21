<script setup lang="ts">
/**
 * 改修案件のカンバン表示（F-42 → 3 状態再編 = 改修依頼 2026-08-21）。
 * ステータス別（未対応/対応中/対応済 = IMPROVEMENT_ITEM_VIEWS の 3 列）に改修案件カードを並べ、
 * 進捗を一望する。旧 7 値語彙の保存値は improvementItemViewOf で正規化して列に置く（原則7）。
 * カードクリックで詳細ドロワー（open）、許可された遷移先へのクイック操作（status）を親へ通知する。
 * 注: 対応中への遷移は担当者アサインを伴うため、親（improvements.vue）は status イベントの
 * to='in_progress' をドロワーの担当者入力へ誘導する（このコンポーネントは遷移先の列挙のみ）。
 * カードには担当者（assigneeName）を表示する（対応中アサインの関連画面表示 = 改修依頼 2026-08-21）。
 * 列は横スクロール（原則8: モバイル 375px でも自身の overflow-x コンテナ内でスクロール）。
 */
import { Calendar, UserRound } from 'lucide-vue-next'
import {
  IMPROVEMENT_ITEM_NEXT, IMPROVEMENT_ITEM_STATUS_META, IMPROVEMENT_ITEM_VIEWS,
  type ImprovementItem, type ImprovementItemView, improvementItemViewOf,
} from '~/types/improvement'
import { fmtDate } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const props = defineProps<{ items: ImprovementItem[]; reqCount: (id: string) => number }>()
const emit = defineEmits<{ open: [item: ImprovementItem]; status: [id: string, to: ImprovementItemView] }>()

const columns = computed(() => IMPROVEMENT_ITEM_VIEWS.map(status => ({
  status,
  meta: IMPROVEMENT_ITEM_STATUS_META[status],
  items: props.items.filter(it => improvementItemViewOf(it.status) === status),
})))

function planLabel(it: ImprovementItem): string {
  if (!it.planStart) return ''
  return it.planEnd && it.planEnd !== it.planStart
    ? `${fmtDate(it.planStart)}〜${fmtDate(it.planEnd)}`
    : fmtDate(it.planStart)
}
function statusLabel(s: ImprovementItemView): string { return IMPROVEMENT_ITEM_STATUS_META[s].label }
/** 遷移先（保存値を 3 状態へ正規化して状態機械から列挙 = ボタン活性と API 検証の一致・原則6） */
function nextOf(it: ImprovementItem): ImprovementItemView[] {
  return IMPROVEMENT_ITEM_NEXT[improvementItemViewOf(it.status)] ?? []
}
</script>

<template>
  <div class="flex gap-3 overflow-x-auto pb-2">
    <section
      v-for="col in columns"
      :key="col.status"
      class="flex w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-soft"
    >
      <header class="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <UiStatusBadge :tone="col.meta.tone" :label="col.meta.label" dot />
        <span class="num text-[12px] font-bold text-muted">{{ col.items.length }}</span>
      </header>

      <div class="grid gap-2 p-2">
        <!-- カードは非対話コンテナ。見出しボタンが「開く」主アクション、遷移ボタンは兄弟（入れ子対話を避け a11y 準拠） -->
        <article
          v-for="it in col.items"
          :key="it.id"
          class="card min-w-0 p-2.5 transition focus-within:border-brand hover:border-brand"
        >
          <button
            type="button"
            class="block w-full truncate text-left text-[13px] font-semibold text-ink hover:text-brand"
            :title="it.title"
            @click="emit('open', it)"
          >{{ it.title }}</button>
          <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
            <span v-if="it.pagePaths.length" class="min-w-0 max-w-full truncate" :title="it.pagePaths.map(pageDisplay).join(' / ')">{{ it.pagePaths.map(pageDisplay).join(' / ') }}</span>
            <span class="num">要望 {{ reqCount(it.id) }}</span>
          </div>
          <!-- 担当者（対応中でアサイン = 関連画面に表示する要件。改修依頼 2026-08-21） -->
          <p v-if="it.assigneeName" class="mt-1 inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[11px] text-sub">
            <UserRound class="h-3 w-3" aria-hidden="true" />
            {{ it.assigneeName }}
          </p>
          <p v-if="it.planStart" class="mt-1 inline-flex items-center gap-1 rounded bg-brand-soft px-1.5 py-0.5 text-[11px] text-brand">
            <Calendar class="h-3 w-3" aria-hidden="true" />
            <span class="num">{{ planLabel(it) }}</span>
          </p>
          <div v-if="nextOf(it).length" class="mt-2 flex flex-wrap gap-1">
            <button
              v-for="to in nextOf(it)"
              :key="to"
              type="button"
              class="btn btn-ghost btn-sm"
              @click="emit('status', it.id, to)"
            >
              {{ statusLabel(to) }}へ
            </button>
          </div>
        </article>

        <p v-if="col.items.length === 0" class="px-1 py-4 text-center text-[12px] text-muted">なし</p>
      </div>
    </section>
  </div>
</template>
