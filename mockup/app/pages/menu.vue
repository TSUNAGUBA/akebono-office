<script setup lang="ts">
/** モバイル用の全機能メニュー（ナビ SoT から導出） */
import * as icons from 'lucide-vue-next'
import { isActivePath, NAV_GROUPS } from '~/utils/navigation'

const route = useRoute()
const { isAdmin } = useCurrentUser()
const { isEnabled } = useAppSettings()

function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.Circle
}

const visibleGroups = computed(() =>
  NAV_GROUPS
    .map(g => ({
      ...g,
      items: g.items.filter(i =>
        (!i.adminOnly || isAdmin.value) && (!i.featureKey || isEnabled(i.featureKey)),
      ),
    }))
    .filter(g => g.items.length > 0),
)
</script>

<template>
  <div class="mx-auto max-w-lg">
    <UiPageHeader title="メニュー" description="全機能の一覧" />
    <div v-for="g in visibleGroups" :key="g.id" class="mb-4">
      <p class="mb-1.5 text-[11px] font-bold text-muted">{{ g.label }}</p>
      <div class="card divide-y divide-[var(--c-line)] overflow-hidden">
        <NuxtLink
          v-for="item in g.items"
          :key="item.path"
          :to="item.path"
          class="flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium"
          :class="isActivePath(route.path, item) ? 'text-brand' : ''"
        >
          <component :is="iconOf(item.icon)" class="h-4.5 w-4.5 text-sub" aria-hidden="true" />
          {{ item.label }}
          <UiMockBadge v-if="isMockPage(item.path)" label="モック" />
        </NuxtLink>
      </div>
    </div>
  </div>
</template>
