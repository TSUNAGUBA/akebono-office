<script setup lang="ts">
/**
 * ダッシュボード（F-01）
 * カード型メニュー + 通知フィードのみを配置する（2026-07-16 オペレーター指示）。
 * - 打刻はヘッダーの「タイムカード」ボタン → モーダル（layouts/default.vue）
 * - 売上サマリは 売上管理（/sales）、稼働状況サマリは 提供システム稼働状況（/status）へ独立
 */
import type { AppNotification } from '~/types/domain'
import type { MenuCard } from '~/types/ui'
import { fmtDateLong, fmtDateTime } from '~/utils/format'
import { NOTIFICATION_KIND_LABELS } from '~/utils/labels'

const { currentUser, currentUserId, isAdmin } = useCurrentUser()
const { mine, unreadCount, markRead } = useNotifications()
const { isEnabled } = useAppSettings()
const { pendingFor } = useWorkflow()

// ---------- 挨拶 ----------
const greeting = computed(() => {
  const h = Number(jstClock().h)
  if (h < 5) return 'お疲れさまです'
  if (h < 11) return 'おはようございます'
  if (h < 18) return 'こんにちは'
  return 'こんばんは'
})
const todayLong = computed(() => fmtDateLong(nowJstIso()))

const { canPath } = usePermissions()

// ---------- 承認待ち件数（useWorkflow.pendingFor が SoT。代理承認・個人指定も考慮済み） ----------
const pendingApprovals = computed(() => pendingFor(currentUserId.value).length)

// ---------- カード型メニュー ----------
interface MenuSection { id: string; label: string; cards: MenuCard[] }

const menuSections = computed<MenuSection[]>(() => {
  const sections: MenuSection[] = []
  if (isEnabled('decision')) {
    sections.push({
      id: 'decision', label: '意思決定支援',
      cards: [{ id: 'decision', title: '意思決定支援', description: 'AI が意味・関係・制約を整理し、選択肢と根拠を提示', icon: 'Scale', to: '/decision' }],
    })
  }
  if (isEnabled('akebono')) {
    sections.push({
      id: 'akebono', label: 'AKEBONO',
      cards: [{ id: 'akebono', title: 'AKEBONO', description: 'あなた専属の AI アシスタント。要望も受付中', icon: 'Sunrise', to: '/akebono' }],
    })
  }
  const work: MenuCard[] = [
    { id: 'attendance', title: '勤怠管理', description: '打刻・月次集計・36 協定アラート・休暇', icon: 'Clock', to: '/attendance' },
  ]
  if (isEnabled('shift')) {
    work.push({ id: 'shift', title: 'シフト表', description: '希望提出・調整・確定シフトの確認', icon: 'CalendarRange', to: '/shift' })
  }
  work.push(
    { id: 'reports', title: '日報・週報', description: '日々の報告とチームの提出状況', icon: 'NotebookPen', to: '/reports' },
    { id: 'ai-assistant', title: 'AI業務アシスタント', description: '明日の計画と当日の振り返りを AI と。日報へ自動反映', icon: 'Sparkles', to: '/ai-assistant' },
    { id: 'poipoi', title: 'ぽいぽいポスト', description: '気づき・改善アイデアを投げ込むポスト。AI の参照対象（自分のみ）・管理者はチーム改善のため閲覧可', icon: 'StickyNote', to: '/poipoi' },
    { id: 'minutes', title: '議事録', description: '会議の記録を蓄積。全員が参照でき AI の参照対象', icon: 'NotebookPen', to: '/minutes' },
    { id: 'workflow', title: 'ワークフロー', description: '稟議の申請・承認（職務権限マトリクス準拠）', icon: 'GitPullRequestArrow', to: '/workflow', badge: pendingApprovals.value },
  )
  sections.push({ id: 'work', label: '業務ツール', cards: work })
  if (isEnabled('aiCompany')) {
    sections.push({
      id: 'ai-company', label: 'AIネイティブカンパニー',
      cards: [{ id: 'ai-company', title: 'AIネイティブカンパニー', description: 'AI 社員の執務室。タスク依頼と活動モニタリング', icon: 'Building2', to: '/ai-company' }],
    })
  }
  // 経営・状況（売上管理 / 提供システム稼働状況 は独立ページ）
  const insightCards: MenuCard[] = [
    { id: 'sales', title: '売上管理', description: '月次売上の推移・前年比・事業種別/顧客別の内訳', icon: 'TrendingUp', to: '/sales' },
  ]
  if (isEnabled('status')) {
    insightCards.push({ id: 'status', title: '提供システム稼働状況', description: '提供システムの現在状態・稼働率・インシデント履歴', icon: 'Activity', to: '/status' })
  }
  sections.push({ id: 'insights', label: '経営・状況', cards: insightCards })
  // サイドメニュー廃止に伴い、全遷移先をカードメニューで網羅する
  sections.push({
    id: 'support', label: '業務支援',
    cards: [
      { id: 'support', title: '業務支援ツール', description: 'AI チャットボット・ドキュメント管理・外部ツール', icon: 'Wrench', to: '/support' },
      { id: 'inbox', title: '通知・エスカレーション', description: '通知の確認と、現場からの暗黙の情報共有への対応', icon: 'Inbox', to: '/inbox', badge: unreadCount.value },
    ],
  })
  if (isAdmin.value) {
    sections.push({
      id: 'admin', label: '管理',
      cards: [
        { id: 'masters', title: 'マスタメンテナンス', description: 'メンバー・部署・顧客・案件・休暇種別等の基礎データ管理', icon: 'Database', to: '/masters' },
        { id: 'settings', title: '設定', description: 'カスタム項目・汎用区分・外部リンク・機能トグル・監査ログ', icon: 'Settings', to: '/settings' },
      ],
    })
  }
  // 権限ルールで deny された機能のカードを隠す（F-16。空になったセクションごと落とす）
  return sections
    .map(sec => ({ ...sec, cards: sec.cards.filter(card => !card.to || canPath(card.to)) }))
    .filter(sec => sec.cards.length > 0)
})

// ---------- 通知フィード ----------
const recentNotifications = computed(() => mine.value.slice(0, 5))

function openNotification(n: AppNotification): void {
  markRead(n.id)
  if (n.link) navigateTo(n.link)
}
</script>

<template>
  <div>
    <UiPageHeader
      :title="`${greeting}、${currentUser.name} さん`"
      :description="todayLong"
    />

    <div class="grid gap-3">
      <!-- カード型メニュー -->
      <section class="grid gap-3" aria-label="メニュー">
        <div v-for="sec in menuSections" :key="sec.id">
          <p class="mb-1.5 text-[11px] font-bold text-muted">{{ sec.label }}</p>
          <UiCardMenu :items="sec.cards" />
        </div>
      </section>

      <!-- 通知フィード -->
      <UiSectionCard
        title="通知"
        description="直近 5 件。クリックで既読にしてリンク先へ"
        flush
      >
        <template #actions>
          <NuxtLink to="/inbox" class="link text-xs font-semibold">すべて見る</NuxtLink>
        </template>
        <UiEmptyState v-if="recentNotifications.length === 0" icon="BellOff" title="通知はありません" />
        <ul v-else class="divide-y divide-[var(--c-line)]">
          <li v-for="n in recentNotifications" :key="n.id">
            <button
              type="button"
              class="flex w-full min-h-11 items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-brand-soft"
              :class="n.read ? '' : 'bg-brand-soft/50'"
              @click="openNotification(n)"
            >
              <span
                class="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                :class="n.read ? 'bg-transparent' : 'bg-brand'"
                :aria-label="n.read ? undefined : '未読'"
              />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-1.5">
                  <UiStatusBadge :label="NOTIFICATION_KIND_LABELS[n.kind]" tone="neutral" />
                  <span class="truncate text-[13px]" :class="n.read ? 'text-sub' : 'font-bold'">{{ n.title }}</span>
                </span>
                <span class="mt-0.5 block truncate text-xs text-muted">{{ n.body }}</span>
              </span>
              <span class="num shrink-0 pt-0.5 text-[11px] text-muted">{{ fmtDateTime(n.at) }}</span>
            </button>
          </li>
        </ul>
      </UiSectionCard>
    </div>
  </div>
</template>
