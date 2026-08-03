<script setup lang="ts">
/**
 * ダッシュボードレイアウトの軽量プレビュー（実データ不要のミニ描画。オペレーター指示 2026-08-03）。
 * セクション見出し + 各セクションのカード数チップ + 通知欄の位置を図示する。
 * テンプレート選択時に「適用するとどう並ぶか」を掴めるようにするための概念図（実カードは描画しない）。
 */
import { Bell, BellOff } from 'lucide-vue-next'
import type { DashboardLayout } from '~/utils/dashboard-layout'
import { MENU_CARDS } from '~/utils/menu-registry'

const props = defineProps<{ layout: DashboardLayout }>()

const knownIds = new Set(MENU_CARDS.dashboard.map(c => c.id))

/** セクションごとの「見出し + 実在カード数」。空セクションはプレビューでも省く（本番の categorize と同じ） */
const sections = computed(() =>
  props.layout.sections
    .map(s => ({ id: s.id, label: s.label, count: s.cardIds.filter(id => knownIds.has(id)).length }))
    .filter(s => s.count > 0))

const notif = computed(() => props.layout.options.notifications)
</script>

<template>
  <div
    class="rounded-lg border border-line bg-[var(--c-bg,transparent)] p-2"
    aria-hidden="true"
  >
    <!-- AKEBONO 業務バンド（表示時のみ） -->
    <div
      v-if="layout.options.showAkebono"
      class="mb-1.5 rounded bg-brand-soft px-1.5 py-1 text-[9px] font-bold text-brand"
    >
      AKEBONO 業務
    </div>

    <!-- side: 左にセクション・右に通知バー / それ以外: セクションを縦積み -->
    <div class="flex gap-1.5" :class="notif === 'side' ? '' : 'flex-col'">
      <div class="flex-1 grid gap-1">
        <div
          v-for="s in sections"
          :key="s.id"
          class="rounded border border-line px-1.5 py-1"
        >
          <div class="flex items-center justify-between gap-1">
            <span class="truncate text-[9px] font-semibold text-sub">{{ s.label }}</span>
            <span class="num shrink-0 rounded-full bg-line px-1 text-[8px] leading-3 text-muted">{{ s.count }}</span>
          </div>
          <!-- カード枠のダミー（密度で高さを変える） -->
          <div class="mt-0.5 grid grid-cols-3 gap-0.5">
            <span
              v-for="i in Math.min(s.count, 3)"
              :key="i"
              class="rounded bg-line"
              :class="layout.options.density === 'compact' ? 'h-1' : 'h-1.5'"
            />
          </div>
        </div>
        <p v-if="sections.length === 0" class="text-[9px] text-muted">（すべて「その他」に表示）</p>
      </div>

      <!-- 通知バー -->
      <div
        v-if="notif !== 'hidden'"
        class="rounded border border-line bg-brand-soft/40 px-1.5 py-1"
        :class="notif === 'side' ? 'w-12 shrink-0' : 'w-full'"
      >
        <span class="flex items-center gap-1 text-[9px] font-semibold text-brand">
          <Bell class="h-2.5 w-2.5" /> 通知
        </span>
      </div>
      <div v-else class="flex items-center gap-1 text-[9px] text-muted">
        <BellOff class="h-2.5 w-2.5" /> 通知オフ
      </div>
    </div>
  </div>
</template>
