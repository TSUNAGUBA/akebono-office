<script setup lang="ts">
/**
 * メディア分析ハブ（F-40-1）。独立したメディアチャンネルの入口。
 * チャンネル一覧（連携済み/単体を区別表示）・チャンネル追加・各機能（分析 / AIレポート / 改善施策 / 記事生成 / 設定）への導線。
 * メディア分析は業態と 1:1 ではなく、任意で連携する（連携は必須でない）。
 */
import { Link2, Plus, Radio } from 'lucide-vue-next'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import { fmtInt, fmtPct } from '~/utils/format'
import { weeklyCompareOf } from '../../../../shared/domain/media-weekly-report'
import type { MenuCard } from '~/types/ui'

const { activeChannels, effectiveChannelId, currentChannel, switchChannel } = useCurrentChannel()
const { settingFor, createChannel } = useMediaChannels()
const { metricsFor, metricsReady, metricsUnavailableFor } = useMediaAnalytics()
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

// メニュー構成（改善要望 2026-08-21）: 「AIレポート」「改善施策一覧」を追加し、役割が重複する
// 「業務 × メディア PDCA」メニューカードは廃止（レポート → 改善施策 → 実行 → 効果検証のループは
// AIレポート + 改善施策一覧が担う。業態連携の統合分析タブ自体は /media/analytics?tab=pdca に残置 =
// 売上×流入の統合指標は別役割のため。オペレーターコメント「役割が重複するメニューは廃止」への対応）
const featureCards = computed<MenuCard[]>(() => {
  const cards: MenuCard[] = [
    { id: 'analytics', title: 'メディア分析（GA × AI）', description: 'アクセス指標の可視化と、サイト構成・記事へのインサイト + 次アクション提案', icon: 'LineChart', to: '/media/analytics' },
    { id: 'reports', title: 'AIレポート', description: '週次の AI 分析レポート（重要変化・原因仮説・コンテンツ評価・推奨アクション）を自動生成', icon: 'FileChartColumn', to: '/media/reports' },
    { id: 'measures', title: '改善施策一覧', description: 'AIレポートで「実行する」と判断した施策の実行・効果検証を管理', icon: 'ClipboardCheck', to: '/media/measures' },
    { id: 'articles', title: 'AI 記事生成スタジオ', description: '目的・質・雰囲気を指定して記事を生成。過去の分析からお題も提案', icon: 'PenLine', to: '/media/articles' },
  ]
  if (isAdmin.value) {
    cards.push({ id: 'settings', title: 'チャンネル設定', description: 'GA 連携・連携業態・AI 分析設定・外部投稿記事の管理（画面操作で完結）', icon: 'Settings2', to: '/media/settings' })
  }
  return cards
})

/** サマリーカードの比較値（前週比 / 4週平均比 / 前年同期比。改善要望 2026-08-21。直近 7 日の値に対する比較）。
 *  日別内訳が取得できていないとき（unavailable 'daily' = ゼロ埋め系列）は null = 比較なしの従来カードへ
 *  フォールバック（ゼロ埋め値での誤比較を作らない = レビュー R2） */
const compare = computed(() => {
  const m = metrics.value
  if (!m) return null
  if (metricsUnavailableFor(effectiveChannelId.value, 28).includes('daily')) return null
  return weeklyCompareOf(m)
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

      <!-- 連携済み: サマリー KPI（前週比 / 4週平均比 / 前年同期比 = 改善要望 2026-08-21。
           比較値が算出できないとき〔daily 内訳の取得失敗〕は従来カードへフォールバック = ゼロ埋め比較を出さない -->
      <template v-else-if="metrics">
        <div v-if="compare" class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MediaKpiCompareCard
            label="セッション（28日）" :value="fmtInt(metrics.sessions)"
            :sub="`直近7日 ${fmtInt(compare.current.sessions)}`"
            :wow="compare.wow.sessions" :four-week-avg="compare.fourWeekAvg.sessions" :yoy="compare.yoy.sessions"
            icon="MousePointerClick" to="/media/analytics"
          />
          <MediaKpiCompareCard
            label="ユーザー（28日）" :value="fmtInt(metrics.users)"
            :sub="`直近7日 ${fmtInt(compare.current.users)}・新規 ${fmtInt(metrics.newUsers)}`"
            :wow="compare.wow.users" :four-week-avg="compare.fourWeekAvg.users" :yoy="compare.yoy.users"
            icon="Users" to="/media/analytics"
          />
          <MediaKpiCompareCard
            label="コンバージョン（28日）" :value="fmtInt(metrics.conversions)"
            :sub="`直近7日 ${fmtInt(compare.current.conversions)}`"
            :wow="compare.wow.conversions" :four-week-avg="compare.fourWeekAvg.conversions" :yoy="compare.yoy.conversions"
            icon="Target" to="/media/analytics"
          />
          <MediaKpiCompareCard
            label="CVR（28日）" :value="fmtPct(metrics.conversionRate)"
            :sub="compare.current.cvr !== null ? `直近7日 ${fmtPct(compare.current.cvr)}` : `直帰率 ${fmtPct(metrics.bounceRate)}`"
            :wow="compare.wow.cvr" :four-week-avg="compare.fourWeekAvg.cvr" :yoy="compare.yoy.cvr"
            icon="Percent" to="/media/analytics"
          />
        </div>
        <div v-else class="grid grid-cols-2 gap-3 md:grid-cols-4">
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
        <p v-if="compare" class="text-[11px] text-muted">前週比・4週平均比・前年同期比は直近 7 日の値に対する比較です（前年同期 = 52 週前の同じ曜日並びの 7 日間・4週平均 = 当該週を含む直近 4 週。データが無い期間は「—」）。</p>
      </template>

      <!-- 機能カード -->
      <UiCardMenu :items="featureCards" />

      <!-- 全チャンネルの状況 -->
      <UiSectionCard title="メディアチャンネル" description="各チャンネルの連携状況と直近 28 日の主要指標（連携済み/単体を区別）" flush>
        <ul class="divide-y divide-line">
          <li v-for="o in pagedOverview" :key="o.id" class="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <component :is="o.linkedName ? Link2 : Radio" class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <!-- min-w-40: flex-1(basis 0) のままだと右側の指標グループに幅を奪われ名前が 2〜3 文字に
                 潰れる（モバイル・UnitI 検出）。下限を確保し、収まらない指標は flex-wrap で次行へ -->
            <div class="min-w-40 flex-1">
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
