<script setup lang="ts">
defineProps<{
  title?: string
  description?: string
  /** カード内 padding をなくす（テーブル直置き用） */
  flush?: boolean
  /** 親が高さを制約している前提で、カードを縦いっぱいに広げ本文（slot）内をスクロール可能にする */
  fill?: boolean
  /**
   * カード外へはみ出す UI（コンボボックスの候補リスト等）をクリップしない（改修依頼 2026-08-21）。
   * 既定はカードの角丸を保つ overflow-hidden。候補リストがカード下端で切れる画面
   * （顧客コンテキストの会社セレクタ等）だけ true にする（fill のスクロールとは併用しない前提）
   */
  overflowVisible?: boolean
}>()
</script>

<template>
  <section class="card" :class="[overflowVisible ? 'overflow-visible' : 'overflow-hidden', fill ? 'flex min-h-0 flex-col' : '']">
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
