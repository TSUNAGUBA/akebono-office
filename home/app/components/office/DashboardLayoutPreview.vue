<script setup lang="ts">
/**
 * ダッシュボードレイアウトの軽量プレビュー（実データ不要のミニ描画。オペレーター指示 2026-08-03）。
 * PC シーンとモバイルシーンを分けて図示する（2026-08-10）:
 *  - PC: セクション見出し + カード数チップ + 通知欄の位置（side/bottom/hidden）を反映。
 *    options.showOther=false（「その他」非表示 = 改修依頼 2026-08-20）はヒント文で反映する（プレビューを誤解させない）。
 *  - モバイル: メニュー最優先（通知欄はトップに出さない）。通知はヘッダーのベル（未読バッジ付き）から開く。
 * テンプレート選択時に「PC ではどう並ぶか」「モバイルでは常にメニュー最優先」を掴むための概念図（実カードは描画しない）。
 */
import { Bell, BellOff, Monitor, Smartphone } from 'lucide-vue-next'
import type { DashboardLayout } from '~/utils/dashboard-layout'
import { MENU_CARDS } from '~/utils/menu-registry'

const props = defineProps<{ layout: DashboardLayout }>()

const knownIds = new Set(MENU_CARDS.dashboard.map(c => c.id))

/** セクションごとの「見出し + 実在カード数」。空セクションはプレビューでも省く（本番の categorize と同じ） */
const sections = computed(() =>
  props.layout.sections
    .map(s => ({ id: s.id, label: s.label, count: s.cardIds.filter(id => knownIds.has(id)).length }))
    .filter(s => s.count > 0))

/** 通知欄の位置（PC シーン専用。モバイルは常にベル導線） */
const notif = computed(() => props.layout.options.notifications)

/** セクション「その他」を表示するか（未定義 = 表示。false のとき未配置メニューは出ない = 改修依頼 2026-08-20） */
const showOther = computed(() => props.layout.options.showOther !== false)
</script>

<template>
  <div class="grid gap-1.5" aria-hidden="true">
    <!-- PC シーン: 通知欄の配置（side/bottom/hidden）はここに適用される -->
    <div class="rounded-lg border border-line bg-[var(--c-bg,transparent)] p-2">
      <p class="mb-1 flex items-center gap-1 text-[9px] font-bold text-muted">
        <Monitor class="h-2.5 w-2.5" /> PC
      </p>

      <!-- side: 左にセクション・右に通知バー / top: 通知バーを先頭に / それ以外: セクションを縦積み -->
      <div class="flex gap-1.5" :class="notif === 'side' ? '' : 'flex-col'">
        <!-- 通知バー（top = 最上段に全幅配置。改善要望 2026-08-17） -->
        <div
          v-if="notif === 'top'"
          class="w-full rounded border border-line bg-brand-soft/40 px-1.5 py-1"
        >
          <span class="flex items-center gap-1 text-[9px] font-semibold text-brand">
            <Bell class="h-2.5 w-2.5" /> 通知
          </span>
        </div>
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
          <p v-if="sections.length === 0" class="text-[9px] text-muted">
            {{ showOther ? '（すべて「その他」に表示）' : '（未配置メニューは非表示）' }}
          </p>
          <p v-else-if="!showOther" class="text-[9px] text-muted">その他は非表示</p>
        </div>

        <!-- 通知バー（side = 右カラム / bottom = 最下段。top は上で描画済み） -->
        <div
          v-if="notif === 'side' || notif === 'bottom'"
          class="rounded border border-line bg-brand-soft/40 px-1.5 py-1"
          :class="notif === 'side' ? 'w-12 shrink-0' : 'w-full'"
        >
          <span class="flex items-center gap-1 text-[9px] font-semibold text-brand">
            <Bell class="h-2.5 w-2.5" /> 通知
          </span>
        </div>
        <div v-else-if="notif === 'hidden'" class="flex items-center gap-1 text-[9px] text-muted">
          <BellOff class="h-2.5 w-2.5" /> 通知オフ
        </div>
      </div>
    </div>

    <!-- モバイルシーン: メニュー最優先（通知欄はトップに出さない）・通知はヘッダーのベルから開く -->
    <div class="rounded-lg border border-line bg-[var(--c-bg,transparent)] p-2">
      <p class="mb-1 flex items-center justify-between text-[9px] font-bold text-muted">
        <span class="flex items-center gap-1"><Smartphone class="h-2.5 w-2.5" /> モバイル</span>
        <!-- 疑似ヘッダーのベル（未読バッジ付き） -->
        <span class="relative inline-flex items-center">
          <Bell class="h-2.5 w-2.5 text-brand" />
          <span class="absolute -right-0.5 -top-0.5 h-1 w-1 rounded-full bg-crit" />
        </span>
      </p>

      <!-- メニューを縦積みで最優先（通知欄はここに出さない = 毎回スクロールしない） -->
      <div class="grid gap-0.5">
        <div
          v-for="s in (sections.length > 0 ? sections : [{ id: 'other', label: 'メニュー', count: 0 }])"
          :key="s.id"
          class="flex items-center gap-1 rounded border border-line px-1.5 py-0.5"
        >
          <span class="truncate text-[9px] font-semibold text-sub">{{ s.label }}</span>
        </div>
      </div>
      <p class="mt-1 text-[8px] leading-tight text-muted">通知はヘッダーのベルから</p>
    </div>
  </div>
</template>
