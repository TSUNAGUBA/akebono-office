<script setup lang="ts">
/** カード型メニュー（ダッシュボード・業務支援ツールハブ共用。内部遷移/外部リンク混在対応） */
import * as icons from 'lucide-vue-next'
import { ExternalLink as ExternalLinkIcon } from 'lucide-vue-next'
import type { MenuCard } from '~/types/ui'

defineProps<{
  items: MenuCard[]
  /** グリッド列数（md 以上） */
  cols?: number
}>()

function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.LayoutGrid
}
</script>

<template>
  <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2" :class="cols === 2 ? 'lg:grid-cols-2' : 'lg:grid-cols-3'">
    <li v-for="item in items" :key="item.id">
      <component
        :is="item.href ? 'a' : resolveComponent('NuxtLink')"
        :to="item.href ? undefined : item.to"
        :href="item.href || undefined"
        :target="item.href ? '_blank' : undefined"
        :rel="item.href ? 'noopener noreferrer' : undefined"
        class="card group flex h-full items-start gap-3 p-3 transition-colors"
        :class="item.disabled ? 'opacity-55' : 'hover:border-brand'"
      >
        <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <component :is="iconOf(item.icon)" class="h-5 w-5" aria-hidden="true" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5">
            <span class="text-[13px] font-bold">{{ item.title }}</span>
            <ExternalLinkIcon v-if="item.href" class="h-3 w-3 text-muted" aria-hidden="true" />
            <UiStatusBadge v-if="item.disabled" label="準備中" tone="neutral" />
            <span
              v-else-if="item.badge !== undefined && Number(item.badge) > 0"
              class="num rounded-full bg-crit px-1.5 text-[10px] font-bold leading-4 text-white"
            >{{ item.badge }}</span>
          </span>
          <span class="mt-0.5 block text-xs leading-relaxed text-sub">{{ item.description }}</span>
        </span>
      </component>
    </li>
  </ul>
</template>
