<script setup lang="ts">
import { X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  width?: string
}>(), { width: '480px' })

const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)

watch(() => props.open, (v) => {
  if (v) nextTick(() => panel.value?.focus())
})

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="open" class="fixed inset-0 z-40" @keydown="onKeydown">
        <div class="absolute inset-0 bg-black/25" aria-hidden="true" @click="emit('close')" />
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          tabindex="-1"
          class="absolute inset-y-0 right-0 flex w-full flex-col bg-surface shadow-xl outline-none md:max-w-[var(--drawer-w)]"
          :style="{ '--drawer-w': width }"
        >
          <header class="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h2 class="text-[15px] font-bold">{{ title }}</h2>
            <button type="button" class="btn btn-ghost btn-sm" aria-label="閉じる" @click="emit('close')">
              <X class="h-4 w-4" />
            </button>
          </header>
          <div class="flex-1 overflow-y-auto p-4 scroll-slim">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="border-t border-line px-4 py-3">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.drawer-enter-active, .drawer-leave-active { transition: opacity 0.15s; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
</style>
