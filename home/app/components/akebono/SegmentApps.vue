<script setup lang="ts">
/**
 * 業態別 Akebono 業務アプリ（トップ配置。F-20 拡張。2026-07-28）。
 * 業態ごとの Akebono 業務を「アプリ」としてトップに並べ、押下でその業態の業務へ入る
 * （従来の「単一 AKEBONO カード → ヘッダで業態切替」を、業態別アプリの直接入場に置き換える）。
 * - 表示名（appName）とアイコン（画像 or 選択式）で業態アプリを直感識別（AkebonoSegmentIcon）。
 * - 押下先は /akebono?seg=<id>。入場時に現在業態を切り替える（pages/akebono/index.vue）。
 * - segmentIds（任意）: 指定時はその業態のみ表示（順序も指定順）。未指定は従来どおり全 active 業態
 *   （ダッシュボードのメニューカテゴリ配置で「未割当業態のみ」を専用セクションに出すために使う。2026-08-03 #24）。
 */
import { ChevronRight } from 'lucide-vue-next'
import { INDUSTRY_TYPE_LABELS, segmentAppName } from '~/utils/akebono'

const props = defineProps<{ segmentIds?: string[] }>()

const { activeSegments } = useCurrentSegment()
const apps = useAkebonoApps()

/** 表示対象の業態（segmentIds 指定時はその順で絞り込み・無効 id は除外） */
const shownSegments = computed(() => {
  if (!props.segmentIds) return activeSegments.value
  const byId = new Map(activeSegments.value.map(s => [s.id, s]))
  return props.segmentIds.map(id => byId.get(id)).filter((s): s is (typeof activeSegments.value)[number] => !!s)
})

/** 各業態で使用中のアプリ数（この業態でいくつの業務が使えるか） */
function enabledCount(segmentId: string): number {
  return apps.enabledAppsOf(segmentId).length
}
</script>

<template>
  <ul v-if="shownSegments.length > 0" class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
    <li v-for="s in shownSegments" :key="s.id">
      <NuxtLink
        :to="`/akebono?seg=${s.id}`"
        class="card group flex h-full items-center gap-3 p-3 transition-colors hover:border-brand"
      >
        <AkebonoSegmentIcon :segment="s" :size="40" />
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5">
            <span class="truncate text-[13px] font-bold">{{ segmentAppName(s) }}</span>
          </span>
          <span class="mt-0.5 flex flex-wrap items-center gap-1.5">
            <UiStatusBadge :label="INDUSTRY_TYPE_LABELS[s.industryType]" tone="info" />
            <span class="text-[11px] text-muted">{{ enabledCount(s.id) }} アプリ</span>
          </span>
        </span>
        <ChevronRight class="h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-brand" aria-hidden="true" />
      </NuxtLink>
    </li>
  </ul>
  <UiEmptyState
    v-else
    icon="Layers"
    title="業態が登録されていません"
    hint="共通マスタ管理から事業セグメント（業態）を登録してください"
  />
</template>
