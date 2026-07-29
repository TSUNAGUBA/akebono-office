<script setup lang="ts">
/**
 * 次の一手（F-01 §3 ②: エンジン層）
 * 最優先 1 件を大カード（embed='punch' は WidgetsPunchClock flat を埋込 = 既存の修正申請フローが
 * 取消手段。原則9.5）。続く 2〜4 件はコンパクト行・6 件目以降は「ほか N 件」。
 * 0 件は ok トーンの完了表示（ゼロを祝う = UiEmptyState の空状態にしない）
 */
import { CheckCircle2, ChevronRight } from 'lucide-vue-next'
import * as icons from 'lucide-vue-next'
import type { CockpitMove } from '~/utils/cockpit'

const props = defineProps<{ moves: CockpitMove[] }>()

const hero = computed(() => props.moves[0] ?? null)
const rest = computed(() => props.moves.slice(1, 5))
const overflow = computed(() => Math.max(0, props.moves.length - 5))

function iconOf(name: string): unknown {
  return (icons as Record<string, unknown>)[name] ?? null
}
</script>

<template>
  <!-- 全消化: 完了を肯定的に表示（ゼロを祝う） -->
  <section v-if="!hero" class="card flex items-center gap-3 p-4" aria-label="次の一手">
    <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ok-soft">
      <CheckCircle2 class="h-5 w-5 text-ok" aria-hidden="true" />
    </span>
    <span>
      <p class="text-[13px] font-bold">本日の予定はすべて完了</p>
      <p class="text-xs text-muted">新しい承認依頼や通知が届いたら、ここに次の一手が表示されます</p>
    </span>
  </section>

  <UiSectionCard v-else title="今日の残り" :description="`次の一手 ${moves.length} 件`" flush>
    <!-- 最優先の 1 件（大カード） -->
    <div class="p-3">
      <div class="flex items-start gap-2.5">
        <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft">
          <component :is="iconOf(hero.icon)" class="h-4.5 w-4.5 text-brand" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="flex flex-wrap items-center gap-1.5 text-sm font-bold">
            {{ hero.title }}
            <UiStatusBadge v-if="hero.count" :label="`${hero.count} 件`" tone="brand" />
          </p>
          <p class="mt-0.5 text-xs text-sub">{{ hero.reason }}</p>
        </div>
      </div>
      <!-- punch 系は既存の打刻ウィジェットを埋込（新規の書込パスを作らない） -->
      <div v-if="hero.embed === 'punch'" class="mt-3 rounded-lg border border-line p-3">
        <WidgetsPunchClock flat />
      </div>
      <div v-else class="mt-3">
        <NuxtLink :to="hero.to" class="btn btn-primary btn-lg w-full sm:w-auto">
          {{ hero.cta }}
        </NuxtLink>
      </div>
    </div>

    <!-- 続く手（コンパクト行・最大 4 件） -->
    <ul v-if="rest.length > 0" class="divide-y divide-[var(--c-line)] border-t border-line">
      <li v-for="m in rest" :key="m.id">
        <NuxtLink
          :to="m.to"
          class="flex min-h-11 items-center gap-2.5 px-3 py-2 transition-colors hover:bg-brand-soft"
        >
          <component :is="iconOf(m.icon)" class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-1.5">
              <span class="truncate text-[13px] font-semibold">{{ m.title }}</span>
              <UiStatusBadge v-if="m.count" :label="`${m.count} 件`" tone="neutral" />
            </span>
            <span class="block truncate text-[11px] text-muted">{{ m.reason }}</span>
          </span>
          <ChevronRight class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        </NuxtLink>
      </li>
    </ul>

    <!-- 6 件目以降 -->
    <div v-if="overflow > 0" class="border-t border-line px-3 py-2">
      <NuxtLink to="/inbox" class="link text-xs font-semibold">ほか {{ overflow }} 件を通知・エスカレーションで確認</NuxtLink>
    </div>
  </UiSectionCard>
</template>
