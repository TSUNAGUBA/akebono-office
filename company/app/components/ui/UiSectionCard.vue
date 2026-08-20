<script setup lang="ts">
defineProps<{
  title?: string
  description?: string
  /** カード内 padding をなくす（テーブル直置き用） */
  flush?: boolean
  /** 親が高さを制約している前提で、カードを縦いっぱいに広げ本文（slot）内をスクロール可能にする */
  fill?: boolean
}>()
</script>

<template>
  <section class="card overflow-hidden" :class="fill ? 'flex min-h-0 flex-col' : ''">
    <!-- flex-wrap: actions が多いカードでモバイル幅だとセレクトやラベルが潰れて判読不能になる
         （UnitI 検出）。収まらないときはタイトル下へ折り返す -->
    <header v-if="title || $slots.actions" class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
      <div>
        <h2 class="text-[13px] font-bold">{{ title }}</h2>
        <p v-if="description" class="text-[11px] text-muted">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="flex flex-wrap items-center justify-end gap-1.5">
        <slot name="actions" />
      </div>
    </header>
    <div :class="[flush ? '' : 'p-3', fill ? 'flex min-h-0 flex-1 flex-col' : '']">
      <slot />
    </div>
  </section>
</template>
