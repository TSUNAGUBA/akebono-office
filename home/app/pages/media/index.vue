<script setup lang="ts">
/**
 * メディア分析ハブ（F-40-1）。独立したメディアチャンネルの入口。
 * チャンネル一覧（連携済み/単体を区別表示）・チャンネル追加・各機能（分析 / 記事生成 / PDCA / 設定）への導線。
 * メディア分析は業態と 1:1 ではなく、任意で連携する（連携は必須でない）。
 */
import { Link2, Plus, Radio } from 'lucide-vue-next'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import { fmtInt, fmtPct } from '~/utils/format'
import type { MenuCard } from '~/types/ui'

const { activeChannels, effectiveChannelId, currentChannel, switchChannel } = useCurrentChannel()
const { settingFor, createChannel } = useMediaChannels()
const { metricsFor, metricsReady } = useMediaAnalytics()
const { activeSegments, segmentById } = useCurrentSegment()
const { isAdmin } = useCurrentUser()
const { show } = useToast()
const router = useRouter()

/** 一覧からチャンネルを選んで各画面へ（対象チャンネルを切り替えてから遷移） */
function goToChannel(id: string, connected: boolean): void {
  switchChannel(id)
  void router.push(connected ? '/media/analytics' : '/media/settings')
}

const setting = computed(() => settingFor(effectiveChannelId.value))
const connected = computed(() => setting.value?.gaConnected === true)
const metrics = computed(() => (connected.value ? metricsFor(effectiveChannelId.value, 28) : null))

const featureCards = computed<MenuCard[]>(() => {
  const linked = currentChannel.value?.segmentId != null
  const cards: MenuCard[] = [
    { id: 'analytics', title: 'メディア分析（GA × AI）', description: 'アクセス指標の可視化と、サイト構成・記事へのインサイト + 次アクション提案', icon: 'LineChart', to: '/media/analytics' },
    { id: 'articles', title: 'AI 記事生成スタジオ', description: '目的・質・雰囲気を指定して記事を生成。過去の分析からお題も提案', icon: 'PenLine', to: '/media/articles' },
    {
      id: 'pdca',
      title: '業務 × メディア PDCA',
      description: linked
        ? '売上と流入を突き合わせ、相関・PDCA・次アクションを AI が提示'
        : '業態と連携すると、売上と流入の統合 PDCA が使えます',
      icon: 'RefreshCw',
      to: linked ? '/media/analytics?tab=pdca' : '/media/settings',
    },
  ]
  if (isAdmin.value) {
    cards.push({ id: 'settings', title: 'チャンネル設定', description: 'GA 連携・連携業態・AI 分析設定・外部投稿記事の管理（画面操作で完結）', icon: 'Settings2', to: '/media/settings' })
  }
  return cards
})

/** 全チャンネルの状況（一覧サマリー） */
const overview = computed(() => activeChannels.value.map((ch) => {
  const st = settingFor(ch.id)
  const m = st?.gaConnected ? metricsFor(ch.id, 28) : null
  const seg = ch.segmentId ? segmentById(ch.segmentId) : null
  return {
    id: ch.id,
    name: ch.name,
    siteName: st?.siteName ?? '',
    linkedName: seg?.name ?? null,
    connected: st?.gaConnected === true,
    sessions: m?.sessions ?? null,
    conversions: m?.conversions ?? null,
  }
}))

// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング）
const { page, pageSize, rows: pagedOverview, total } = useListView({ source: overview })

// ---------- チャンネル追加 ----------
const createOpen = ref(false)
const createForm = ref<{ name: string; segmentId: string }>({ name: '', segmentId: '' })
const creating = ref(false)

function openCreate(): void {
  createForm.value = { name: '', segmentId: '' }
  createOpen.value = true
}

async function submitCreate(): Promise<void> {
  if (creating.value) return
  if (!createForm.value.name.trim()) { show('チャンネル名を入力してください', 'warn'); return }
  creating.value = true
  try {
    const res = await createChannel({
      name: createForm.value.name.trim(),
      segmentId: createForm.value.segmentId || null,
    })
    if (!res.ok || !res.channel) { show(`${res.error?.code}: ${res.error?.message}`, 'crit'); return }
    createOpen.value = false
    show('メディアチャンネルを作成しました', 'ok')
    switchChannel(res.channel.id)
    void router.push('/media/settings')
  } finally { creating.value = false }
}

const segmentOptions = computed(() => [
  { value: '', label: '連携しない（単体チャンネル）' },
  ...activeSegments.value.map(s => ({ value: s.id, label: `${s.name}（${INDUSTRY_TYPE_LABELS[s.industryType]}）` })),
])
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <UiPageHeader
      title="メディア分析"
      description="オウンドメディアのアクセス解析を AI が分析し、サイト構成・記事のインサイトと次アクションを提示します。チャンネルは任意で Akebono 業務アプリ（業態）と連携でき、連携すると売上と合わせた PDCA が使えます。"
    >
      <template #actions>
        <button v-if="isAdmin" type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" /> チャンネルを追加
        </button>
      </template>
    </UiPageHeader>

    <div class="grid gap-4">
      <MediaChannelBar />

      <!-- 未連携: 連携を促す -->
      <template v-if="!connected">
        <MediaGaConnect variant="gate" />
        <p class="text-center text-[11px] text-muted">
          連携後、{{ currentChannel?.name }} のアクセス指標をもとに分析・記事生成が利用できます。
        </p>
      </template>

      <!-- API: GA 集計のロード中 / 取得失敗（詳細と再試行は分析ページが担う） -->
      <template v-else-if="!metrics">
        <p class="py-6 text-center text-[12px] text-muted" aria-live="polite" :aria-busy="!metricsReady(effectiveChannelId, 28)">
          {{ metricsReady(effectiveChannelId, 28)
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

      <!-- 全チャンネルの状況 -->
      <UiSectionCard title="メディアチャンネル" description="各チャンネルの連携状況と直近 28 日の主要指標（連携済み/単体を区別）" flush>
        <ul class="divide-y divide-line">
          <li v-for="o in pagedOverview" :key="o.id" class="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <component :is="o.linkedName ? Link2 : Radio" class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="truncate text-[13px] font-bold">{{ o.name }}</span>
                <span v-if="o.siteName" class="truncate text-[11px] text-muted">{{ o.siteName }}</span>
              </div>
              <UiStatusBadge
                v-if="o.linkedName" :label="`連携: ${o.linkedName}`" tone="info"
              />
              <UiStatusBadge v-else label="単体（業態未連携）" tone="neutral" />
            </div>
            <UiStatusBadge :label="o.connected ? 'GA 連携済み' : '未連携'" :tone="o.connected ? 'ok' : 'neutral'" dot />
            <span v-if="o.connected" class="num text-[12px] text-sub">
              セッション {{ o.sessions === null ? '—' : fmtInt(o.sessions) }} / CV {{ o.conversions === null ? '—' : fmtInt(o.conversions) }}
            </span>
            <button type="button" class="link text-[11px]" @click="goToChannel(o.id, o.connected)">
              {{ o.connected ? '分析を見る' : '連携する' }}
            </button>
          </li>
        </ul>
        <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
      </UiSectionCard>
    </div>

    <!-- チャンネル追加モーダル -->
    <UiModal :open="createOpen" title="メディアチャンネルを追加" width="460px" @close="createOpen = false">
      <div class="grid gap-3">
        <UiFormField label="チャンネル名" hint="必須">
          <input v-model="createForm.name" type="text" class="input" placeholder="例）暮らしの器マガジン" aria-label="チャンネル名">
        </UiFormField>
        <UiFormField label="連携する Akebono 業務アプリ（業態）" hint="連携すると売上との統合 PDCA が使えます">
          <UiSelect v-model="createForm.segmentId" :options="segmentOptions" aria-label="連携する業態" />
        </UiFormField>
        <p class="text-[11px] text-muted">作成後、設定画面で GA 連携・サイト情報・AI 分析設定を行えます。</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="createOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" :disabled="creating || !createForm.name.trim()" @click="submitCreate">
          {{ creating ? '作成中…' : '作成する' }}
        </button>
      </template>
    </UiModal>
  </div>
</template>
