<script setup lang="ts">
/**
 * 組織図ノード（F-10-9）。部署カード + 所属メンバー + 子部署を再帰描画する。
 * PC は縦ツリー（接続線付きインデント）、モバイルもそのまま可読な構造。
 */
import type { DeptNode } from '~/composables/useDepartments'

defineProps<{
  node: DeptNode
  depth: number
}>()

const emit = defineEmits<{ select: [deptId: string] }>()
</script>

<template>
  <div :class="depth > 0 ? 'relative mt-2 pl-5 md:pl-7' : 'mt-2 first:mt-0'">
    <!-- 接続線（子ノードのみ） -->
    <span
      v-if="depth > 0"
      class="absolute left-1.5 top-0 h-full w-3 rounded-bl-lg border-b-0 border-l-2 border-line md:left-2.5"
      aria-hidden="true"
    />
    <button
      type="button"
      class="card w-full p-3 text-left transition-colors hover:border-[var(--c-brand)]"
      :aria-label="`部署「${node.dept.name}」の詳細を開く`"
      @click="emit('select', node.dept.id)"
    >
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="text-[14px] font-bold">{{ node.dept.name }}</span>
        <UiStatusBadge v-if="node.manager" :label="`責任者: ${node.manager.name}`" tone="brand" />
        <span class="num ml-auto text-[11px] text-muted">{{ node.members.length }}名</span>
      </div>
      <p v-if="node.dept.description" class="mt-0.5 text-[11px] text-muted">{{ node.dept.description }}</p>
      <ul v-if="node.members.length > 0" class="mt-2 flex flex-wrap gap-1.5">
        <li
          v-for="m in node.members"
          :key="m.id"
          class="flex items-center gap-1 rounded-full bg-surface-soft py-0.5 pl-0.5 pr-2"
        >
          <UiAvatar :name="m.name" size="sm" />
          <span class="text-[11px] font-semibold">{{ m.name }}</span>
          <span class="text-[10px] text-muted">{{ m.title }}</span>
        </li>
      </ul>
      <p v-else class="mt-2 text-[11px] text-muted">直属メンバーなし</p>
    </button>

    <MastersDeptOrgNode
      v-for="child in node.children"
      :key="child.dept.id"
      :node="child"
      :depth="depth + 1"
      @select="emit('select', $event)"
    />
  </div>
</template>
