<script setup lang="ts">
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-vue-next'

const { toasts, dismiss } = useToast()

const iconOf = (tone: string) =>
  tone === 'ok' ? CheckCircle2 : tone === 'crit' || tone === 'serious' ? XCircle : tone === 'warn' ? TriangleAlert : Info

const toneClass = (tone: string) =>
  tone === 'ok' ? 'text-ok' : tone === 'crit' || tone === 'serious' ? 'text-crit' : tone === 'warn' ? 'text-warn' : 'text-info'
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-3 bottom-[calc(var(--bottomnav-h)+12px)] z-[60] flex flex-col items-center gap-2 md:inset-x-auto md:bottom-6 md:right-6 md:items-end"
    role="status"
    aria-live="polite"
  >
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="card pointer-events-auto flex w-full max-w-sm items-start gap-2 px-3 py-2.5 shadow-lg"
      >
        <component :is="iconOf(t.tone)" class="mt-0.5 h-4 w-4 shrink-0" :class="toneClass(t.tone)" aria-hidden="true" />
        <div class="min-w-0 flex-1 text-[13px]">
          <p>{{ t.message }}</p>
          <NuxtLink v-if="t.link" :to="t.link.to" class="link text-xs font-medium" @click="dismiss(t.id)">
            {{ t.link.label }} →
          </NuxtLink>
        </div>
        <button type="button" class="text-muted hover:text-ink" aria-label="閉じる" @click="dismiss(t.id)">
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active, .toast-leave-active { transition: all 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(6px); }
</style>
