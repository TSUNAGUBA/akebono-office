<script setup lang="ts">
/**
 * メディア分析ハブ（F-40-1）。Akebono 業務の各セグメント（業態）と 1:1 で対になるメディア分析の入口。
 * 現在の業態を対象に、GA 連携状況・主要指標のサマリーと、各機能（分析 / 記事生成 / PDCA / 設定）への導線を出す。
 */
import { fmtInt, fmtPct } from '~/utils/format'
import type { MenuCard } from '~/types/ui'

const { effectiveSegmentId, currentSegment, activeSegments, switchSegment } = useCurrentSegment()
const { settingFor } = useMediaSettings()
const { metricsFor, metricsReady } = useMediaAnalytics()
const { isAdmin } = useCurrentUser()
const router = useRouter()

/** 一覧から業態を選んで各画面へ（対象業態を切り替えてから遷移） */
function goToSegment(id: string, connected: boolean): void {
  switchSegment(id)
  void router.push(connected ? '/media/analytics' : '/media/settings')
}

const setting = computed(() => settingFor(effectiveSegmentId.value))
const connected = computed(() => setting.value?.gaConnected === true)
const metrics = computed(() => (connected.value ? metricsFor(effectiveSegmentId.value, 28) : null))

const featureCards = computed<MenuCard[]>(() => {
  const cards: MenuCard[] = [
    { id: 'analytics', title: 'メディア分析（GA × AI）', description: 'アクセス指標の可視化と、サイト構成・記事へのインサイト + 次アクション提案', icon: 'LineChart', to: '/media/analytics' },
    { id: 'articles', title: 'AI 記事生成スタジオ', description: '目的・質・雰囲気を指定して記事を生成。過去の分析からお題も提案', icon: 'PenLine', to: '/media/articles' },
    { id: 'pdca', title: '業務 × メディア PDCA', description: '売上と流入を突き合わせ、相関・PDCA・次アクションを AI が提示', icon: 'RefreshCw', to: '/media/analytics?tab=pdca' },
  ]
  if (isAdmin.value) {
    cards.push({ id: 'settings', title: 'メディア設定', description: 'セグメントごとの GA 連携・AI 分析設定（画面操作で完結）', icon: 'Settings2', to: '/media/settings' })
  }
  return cards
})

/** 全業態のメディア状況（一覧サマリー） */
const overview = computed(() => activeSegments.value.map((s) => {
  const st = settingFor(s.id)
  const m = st?.gaConnected ? metricsFor(s.id, 28) : null
  return {
    id: s.id,
    name: s.name,
    siteName: st?.siteName ?? '',
    connected: st?.gaConnected === true,
    sessions: m?.sessions ?? null,
    conversions: m?.conversions ?? null,
  }
}))
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <UiPageHeader
      title="メディア分析"
      description="オウンドメディアのアクセス解析を AI が分析し、サイト構成・記事のインサイトと次アクションを提示します。業務データと合わせた PDCA、記事生成まで、業態ごとに完結します。"
    />

    <div class="grid gap-4">
      <MediaSegmentBar />

      <!-- 未連携: 連携を促す -->
      <template v-if="!connected">
        <MediaGaConnect variant="gate" />
        <p class="text-center text-[11px] text-muted">
          連携後、{{ currentSegment?.name }} のアクセス指標をもとに分析・記事生成・PDCA が利用できます。
        </p>
      </template>

      <!-- API: GA 集計のロード中 / 取得失敗（詳細と再試行は分析ページが担う） -->
      <template v-else-if="!metrics">
        <p class="py-6 text-center text-[12px] text-muted" aria-live="polite" :aria-busy="!metricsReady(effectiveSegmentId, 28)">
          {{ metricsReady(effectiveSegmentId, 28)
            ? 'アクセス指標を取得できませんでした（メディア分析ページで再試行できます）'
            : 'アクセス指標を取得中…' }}
        </p>
      </template>

      <!-- 連携済み: サマリー KPI -->
      <template v-else-if="metrics">
        <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <UiKpiCard
            label="セッション（28日）" :value="fmtInt(metrics.sessions)"
            :delta="metrics.prevSessions > 0 ? (metrics.sessions - metrics.prevSessions) / metrics.prevSessions : null"
            sub="前期比" icon="MousePointerClick" to="/media/analytics"
          />
          <UiKpiCard
            label="ユーザー" :value="fmtInt(metrics.users)"
            :sub="`新規 ${fmtInt(metrics.newUsers)}`" icon="Users" to="/media/analytics"
          />
          <UiKpiCard
            label="コンバージョン" :value="fmtInt(metrics.conversions)"
            :delta="metrics.prevConversions > 0 ? (metrics.conversions - metrics.prevConversions) / metrics.prevConversions : null"
            sub="前期比" icon="Target" to="/media/analytics"
          />
          <UiKpiCard
            label="CVR" :value="fmtPct(metrics.conversionRate)"
            :sub="`直帰率 ${fmtPct(metrics.bounceRate)}`" icon="Percent" to="/media/analytics"
          />
        </div>
      </template>

      <!-- 機能カード -->
      <UiCardMenu :items="featureCards" />

      <!-- 全業態のメディア状況 -->
      <UiSectionCard title="全業態のメディア" description="各業態のメディアの連携状況と直近 28 日の主要指標" flush>
        <ul class="divide-y divide-line">
          <li v-for="o in overview" :key="o.id" class="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="truncate text-[13px] font-bold">{{ o.name }}</span>
                <span v-if="o.siteName" class="truncate text-[11px] text-muted">{{ o.siteName }}</span>
              </div>
            </div>
            <UiStatusBadge :label="o.connected ? 'GA 連携済み' : '未連携'" :tone="o.connected ? 'ok' : 'neutral'" dot />
            <span v-if="o.connected" class="num text-[12px] text-sub">
              <!-- API モードのロード中（null）は 0 と区別して — 表示 -->
              セッション {{ o.sessions === null ? '—' : fmtInt(o.sessions) }} / CV {{ o.conversions === null ? '—' : fmtInt(o.conversions) }}
            </span>
            <button type="button" class="link text-[11px]" @click="goToSegment(o.id, o.connected)">
              {{ o.connected ? '分析を見る' : '連携する' }}
            </button>
          </li>
        </ul>
      </UiSectionCard>
    </div>
  </div>
</template>
