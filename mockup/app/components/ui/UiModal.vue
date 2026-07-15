<script setup lang="ts">
import { X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  width?: string
}>(), { width: '560px' })

const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)

watch(() => props.open, (v) => {
  if (v) nextTick(() => panel.value?.focus())
})

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
  // 簡易フォーカストラップ
  if (e.key === 'Tab' && panel.value) {
    const focusables = panel.value.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus()
    }
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="fixed inset-0 z-50 flex items-end justify-center md:items-center" @keydown="onKeydown">
        <div class="absolute inset-0 bg-black/30" aria-hidden="true" @click="emit('close')" />
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          tabindex="-1"
          class="relative flex max-h-[92dvh] w-full flex-col rounded-t-xl bg-surface shadow-xl outline-none md:max-w-[var(--modal-w)] md:rounded-xl"
          :style="{ '--modal-w': width }"
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
          <footer v-if="$slots.footer" class="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active, .modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
