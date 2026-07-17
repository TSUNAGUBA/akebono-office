<script setup lang="ts">
/**
 * 通知・エスカレーションセンター（F-12）
 * 通知タブ: 自分宛て一覧（未読強調・クリックで既読+遷移・すべて既読）
 * エスカレーションタブ（管理者のみ）: open 一覧 → 3 択対応モーダル / 解決済み一覧 / 還流率 KPI
 */
import { CheckCheck } from 'lucide-vue-next'
import type { AppNotification, Escalation, EscalationResolutionType, KnowledgeDomain, NotificationKind } from '~/types/domain'
import type { TabItem, Tone } from '~/types/ui'
import { fmtDateTime, fmtPct } from '~/utils/format'
import { ESCALATION_RESOLUTION_LABELS, KNOWLEDGE_DOMAIN_LABELS, NOTIFICATION_KIND_LABELS } from '~/utils/labels'

const { isAdmin } = useCurrentUser()
const { mine, unreadCount, markRead, markAllRead } = useNotifications()
const { open, resolved, openCount, refluxRate, resolve, byId, refresh: refreshEscalations } = useEscalations()

// サーバー側で起票されたエスカレーション（日報提出・36協定等）を表示時に最新化する
onMounted(() => { void refreshEscalations() })
const { show } = useToast()

// 還流先候補の生成に使うマスタ（読み取りのみ）
const { tbl } = useMockDb()
const industries = tbl('industries')
const companies = tbl('companies')
const contacts = tbl('contacts')
const relationTypes = tbl('relationTypes')
const companyRelations = tbl('companyRelations')
const projects = tbl('projects')

// ---------- タブ ----------
const tab = ref('notifications')

const tabs = computed<TabItem[]>(() => {
  const base: TabItem[] = [{ key: 'notifications', label: '通知', badge: unreadCount.value }]
  if (isAdmin.value) base.push({ key: 'escalations', label: 'エスカレーション', badge: openCount.value })
  return base
})

// デモユーザー切替で管理者でなくなったらタブを戻す
watch(isAdmin, (v) => {
  if (!v && tab.value === 'escalations') tab.value = 'notifications'
})

// ---------- 通知タブ ----------
/** 種別トーン（共有 labels.ts は編集しないためローカル定義） */
const KIND_TONES: Record<NotificationKind, Tone> = {
  approval: 'brand',
  comment: 'info',
  reminder: 'warn',
  ai_report: 'info',
  system: 'neutral',
  escalation: 'serious',
}

function openNotification(n: AppNotification): void {
  markRead(n.id)
  if (n.link) navigateTo(n.link)
}

function onMarkAllRead(): void {
  markAllRead()
  show('すべての通知を既読にしました', 'ok')
}

// ---------- エスカレーションタブ ----------
const rulingCount = computed(() => resolved.value.filter(e => e.resolution?.type === 'ruling').length)
const refluxedCount = computed(() =>
  resolved.value.filter(e => e.resolution?.type === 'ruling' && e.knowledgeReflected).length)

// 対応モーダル
const respondTarget = ref<Escalation | null>(null)
const resType = ref<EscalationResolutionType>('answer')
const resBody = ref('')
const reflectKnowledge = ref(false)
const resError = ref('')

const RESOLUTION_HINTS: Record<EscalationResolutionType, string> = {
  answer: '本人へ回答を通知します（質問・相談への返信）',
  ruling: '判断・ルールとして記録します（ナレッジへ還流可能）',
  no_action: '対応不要としてクローズします（本文は任意）',
}

// ---------- ナレッジ還流先の選択 ----------

const knowledgeDomain = ref<KnowledgeDomain>('project')
const knowledgeTargetId = ref('')

const domainOptions = (Object.keys(KNOWLEDGE_DOMAIN_LABELS) as KnowledgeDomain[])
  .map(d => ({ value: d, label: KNOWLEDGE_DOMAIN_LABELS[d] }))

function companyNameOf(companyId: string): string {
  return companies.value.find(c => c.id === companyId)?.name ?? companyId
}

/** ドメインに応じた還流先候補（マスタ実データから生成） */
const targetOptions = computed<{ value: string; label: string }[]>(() => {
  switch (knowledgeDomain.value) {
    case 'industry':
      return industries.value.filter(i => i.active).map(i => ({ value: i.id, label: i.name }))
    case 'company':
      return companies.value.filter(c => c.active && c.kind === 'customer').map(c => ({ value: c.id, label: c.name }))
    case 'contact':
      return contacts.value.filter(c => c.active).map(c => ({ value: c.id, label: `${c.name}（${companyNameOf(c.companyId)}）` }))
    case 'relation':
      return companyRelations.value.map((r) => {
        const rt = relationTypes.value.find(t => t.id === r.relationTypeId)
        return { value: r.id, label: `${companyNameOf(r.fromCompanyId)} → ${companyNameOf(r.toCompanyId)}（${rt?.label ?? '関係'}）` }
      })
    case 'project':
      return projects.value.filter(p => p.active).map(p => ({ value: p.id, label: p.name }))
  }
})

// ドメイン切替・還流 ON 時は先頭候補を既定選択にする
watch([knowledgeDomain, reflectKnowledge], () => {
  knowledgeTargetId.value = targetOptions.value[0]?.value ?? ''
})

function openRespond(e: Escalation): void {
  respondTarget.value = e
  resType.value = 'answer'
  resBody.value = ''
  reflectKnowledge.value = false
  knowledgeDomain.value = 'project'
  knowledgeTargetId.value = targetOptions.value[0]?.value ?? ''
  resError.value = ''
}

async function submitRespond(): Promise<void> {
  const target = respondTarget.value
  if (!target) return
  if ((resType.value === 'answer' || resType.value === 'ruling') && !resBody.value.trim()) {
    resError.value = '本文を入力してください'
    return
  }
  const reflect = resType.value === 'ruling' && reflectKnowledge.value
  if (reflect && !knowledgeTargetId.value) {
    resError.value = '還流先の対象を選択してください'
    return
  }
  const r = await resolve(
    target.id,
    resType.value,
    resBody.value.trim(),
    reflect,
    reflect ? { domain: knowledgeDomain.value, targetId: knowledgeTargetId.value } : undefined,
  )
  if (!r.ok) {
    resError.value = r.error.message
    return
  }
  const after = byId(target.id)
  if (resType.value === 'ruling' && after?.knowledgeReflected) {
    show('裁定を記録し、ナレッジへ還流しました', 'ok', { label: 'ナレッジで確認', to: '/masters/knowledge' })
  } else if (resType.value === 'answer') {
    show('回答を送信し、本人へ通知しました', 'ok')
  } else if (resType.value === 'ruling') {
    show('裁定を記録しました', 'ok')
  } else {
    show('対応不要として記録しました', 'ok')
  }
  respondTarget.value = null
}
</script>

<template>
  <div>
    <UiPageHeader
      title="通知・エスカレーションセンター"
      description="あなた宛ての通知と、チームからのエスカレーションを横断確認"
    />

    <UiTabBar v-model="tab" :tabs="tabs" class="mb-3" />

    <!-- ================= 通知タブ ================= -->
    <div v-if="tab === 'notifications'" class="grid gap-3">
      <UiSectionCard title="自分宛ての通知" :description="`未読 ${unreadCount} 件`" flush>
        <template #actions>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="unreadCount === 0"
            @click="onMarkAllRead"
          >
            <CheckCheck class="h-3.5 w-3.5" aria-hidden="true" /> すべて既読
          </button>
        </template>
        <UiEmptyState
          v-if="mine.length === 0"
          icon="BellOff"
          title="通知はありません"
          hint="承認依頼・コメント・AI 報告などがここに届きます"
        />
        <ul v-else class="divide-y divide-[var(--c-line)]">
          <li v-for="n in mine" :key="n.id">
            <button
              type="button"
              class="flex w-full min-h-11 items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
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
                  <UiStatusBadge :label="NOTIFICATION_KIND_LABELS[n.kind]" :tone="KIND_TONES[n.kind]" />
                  <span class="text-[13px]" :class="n.read ? 'text-sub' : 'font-bold'">{{ n.title }}</span>
                </span>
                <span class="mt-0.5 block text-xs leading-relaxed text-muted">{{ n.body }}</span>
              </span>
              <span class="num shrink-0 pt-0.5 text-[11px] text-muted">{{ fmtDateTime(n.at) }}</span>
            </button>
          </li>
        </ul>
      </UiSectionCard>
    </div>

    <!-- ================= エスカレーションタブ（管理者のみ） ================= -->
    <div v-else-if="tab === 'escalations' && isAdmin" class="grid gap-3">
      <!-- KPI -->
      <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
        <UiKpiCard label="対応待ち" :value="`${openCount}件`" sub="open のエスカレーション" icon="Flame" />
        <UiKpiCard label="解決済み" :value="`${resolved.length}件`" sub="起票 → 解決の累計" icon="CircleCheck" />
        <UiKpiCard
          label="ナレッジ還流率"
          :value="refluxRate === null ? '—' : fmtPct(refluxRate, 0)"
          :sub="rulingCount === 0 ? '裁定の実績なし' : `裁定 ${rulingCount} 件中 ${refluxedCount} 件を還流`"
          icon="Recycle"
        />
      </div>

      <!-- 対応待ち一覧 -->
      <UiSectionCard title="対応待ち" description="「対応する」から 回答送信 / 裁定記録 / 対応不要 を選択">
        <UiEmptyState
          v-if="open.length === 0"
          icon="ShieldCheck"
          title="対応待ちのエスカレーションはありません"
          hint="日報の課題記入・タスク停滞・過負荷などのシグナルから自動起票されます"
        />
        <div v-else class="grid gap-2">
          <WidgetsEscalationCard
            v-for="e in open"
            :key="e.id"
            :escalation="e"
            @respond="openRespond(e)"
          />
        </div>
      </UiSectionCard>

      <!-- 解決済み一覧 -->
      <UiSectionCard title="対応履歴" description="解決済みのエスカレーションと対応内容">
        <UiEmptyState v-if="resolved.length === 0" icon="History" title="解決済みの記録はありません" />
        <div v-else class="grid gap-2">
          <WidgetsEscalationCard v-for="e in resolved" :key="e.id" :escalation="e" />
        </div>
      </UiSectionCard>
    </div>

    <!-- 対応モーダル -->
    <UiModal :open="!!respondTarget" title="エスカレーション対応" @close="respondTarget = null">
      <div v-if="respondTarget" class="grid gap-3">
        <div class="rounded-lg bg-surface-soft p-2.5">
          <p class="text-xs leading-relaxed text-sub">{{ respondTarget.context }}</p>
        </div>

        <fieldset>
          <legend class="label">対応方法 <span class="text-crit" aria-label="必須">*</span></legend>
          <div class="grid gap-1.5">
            <label
              v-for="t in (['answer', 'ruling', 'no_action'] as EscalationResolutionType[])"
              :key="t"
              class="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors"
              :class="resType === t ? 'border-brand bg-brand-soft' : 'border-line hover:border-line-strong'"
            >
              <input v-model="resType" type="radio" name="resolution-type" :value="t" class="mt-1">
              <span>
                <span class="block text-[13px] font-bold">{{ ESCALATION_RESOLUTION_LABELS[t] }}</span>
                <span class="block text-[11px] text-muted">{{ RESOLUTION_HINTS[t] }}</span>
              </span>
            </label>
          </div>
        </fieldset>

        <UiFormField
          label="本文"
          :required="resType !== 'no_action'"
          :hint="resType === 'answer' ? '本人へ通知として届きます' : resType === 'ruling' ? '裁定内容として記録されます' : '補足があれば記入してください（任意）'"
        >
          <textarea
            v-model="resBody"
            class="textarea"
            rows="4"
            :placeholder="resType === 'ruling' ? '例: 現場ボードに載せる KPI は 5 個まで…' : '対応内容を記入'"
          />
        </UiFormField>

        <label v-if="resType === 'ruling'" class="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line p-2.5">
          <input v-model="reflectKnowledge" type="checkbox">
          <span>
            <span class="block text-[13px] font-semibold">ナレッジへ還流する</span>
            <span class="block text-[11px] text-muted">裁定を出典付きでナレッジベースに登録します</span>
          </span>
        </label>

        <!-- 還流先の選択（ドメイン → 対象） -->
        <div
          v-if="resType === 'ruling' && reflectKnowledge"
          class="grid gap-2.5 rounded-lg border border-line bg-surface-soft p-2.5 sm:grid-cols-2"
        >
          <UiFormField label="還流先ドメイン" required>
            <select v-model="knowledgeDomain" class="select" aria-label="還流先ドメイン">
              <option v-for="o in domainOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </UiFormField>
          <UiFormField label="還流先対象" required>
            <select v-model="knowledgeTargetId" class="select" aria-label="還流先対象">
              <option v-if="targetOptions.length === 0" value="" disabled>候補がありません</option>
              <option v-for="o in targetOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </UiFormField>
        </div>

        <p v-if="resError" class="text-xs font-semibold text-crit" role="alert">{{ resError }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="respondTarget = null">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="submitRespond">記録する</button>
      </template>
    </UiModal>
  </div>
</template>
