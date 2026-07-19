<script setup lang="ts">
/**
 * システム詳細（F-11-2 / F-11-3）
 * コンポーネント一覧 + インシデント履歴フィード。
 * 管理者はインシデント登録・状況更新（investigating→identified→monitoring→resolved の正順のみ）が可能。
 */
import { ArrowLeft, ExternalLink as ExternalLinkIcon, Plus } from 'lucide-vue-next'
import type { IncidentImpact, IncidentStatus, ServiceIncident } from '~/types/domain'
import { INCIDENT_IMPACT_TONES } from '~/composables/useSystemStatus'
import { fmtDateTime, fmtPct } from '~/utils/format'
import {
  INCIDENT_IMPACT_LABELS, INCIDENT_STATUS_LABELS,
  SERVICE_STATE_LABELS, SERVICE_STATE_TONES,
} from '~/utils/labels'

const route = useRoute()
const { isAdmin } = useCurrentUser()
const { show } = useToast()
const {
  services, serviceById, stateOf, uptimeDaysOf, uptimePctOf,
  incidentsOf, incidentById, nextStatusesOf, createIncident, addIncidentUpdate, refresh,
} = useSystemStatus()

// 表示時に最新状態を取り込む（API モード。他管理者の登録・更新の反映）
onMounted(() => { void refresh() })

const serviceId = computed(() => String(route.params.id ?? ''))
const service = computed(() => serviceById(serviceId.value))

const state = computed(() => stateOf(serviceId.value))
const stateLabel = computed(() => SERVICE_STATE_LABELS[state.value] ?? state.value)
const stateTone = computed(() => SERVICE_STATE_TONES[state.value] ?? 'neutral')
const uptimeDays = computed(() => uptimeDaysOf(serviceId.value))
const uptimePct = computed(() => fmtPct(uptimePctOf(serviceId.value), 2))
const incidents = computed(() => incidentsOf(serviceId.value))

// ---------- インシデント登録モーダル（管理者） ----------
// UiSelect の v-model は string のため文字列で保持し、送信時に区分型へ絞り込む
const registerOpen = ref(false)
const regForm = reactive({ serviceId: '', title: '', impact: 'minor', body: '' })
const regError = ref('')

const serviceOptions = computed(() => services.value.map(s => ({ value: s.id, label: s.name })))
const impactOptions = (Object.keys(INCIDENT_IMPACT_LABELS) as IncidentImpact[])
  .map(k => ({ value: k, label: INCIDENT_IMPACT_LABELS[k] }))

function openRegister(): void {
  regForm.serviceId = serviceId.value
  regForm.title = ''
  regForm.impact = 'minor'
  regForm.body = ''
  regError.value = ''
  registerOpen.value = true
}

const regSaving = ref(false)
async function submitRegister(): Promise<void> {
  if (regSaving.value) return
  regSaving.value = true
  let r: Awaited<ReturnType<typeof createIncident>>
  try {
    r = await createIncident({
      serviceId: regForm.serviceId,
      title: regForm.title,
      impact: regForm.impact as IncidentImpact,
      body: regForm.body,
    })
  } finally {
    regSaving.value = false
  }
  if (!r.ok) {
    regError.value = r.error.message
    return
  }
  registerOpen.value = false
  const targetName = serviceById(regForm.serviceId)?.name ?? ''
  if (regForm.serviceId === serviceId.value) {
    show('インシデントを登録し、管理者へ通知しました', 'ok')
  } else {
    show(`${targetName} にインシデントを登録しました`, 'ok', { label: '該当サービスを確認', to: `/status/${regForm.serviceId}` })
  }
}

// ---------- 状況更新モーダル（管理者） ----------
const updateTarget = ref<ServiceIncident | null>(null)
const updForm = reactive({ status: 'identified', body: '' })
const updError = ref('')

const updStatusOptions = computed(() => {
  if (!updateTarget.value) return []
  const cur = incidentById(updateTarget.value.id) ?? updateTarget.value
  return nextStatusesOf(cur).map(s => ({ value: s, label: INCIDENT_STATUS_LABELS[s] }))
})

function openUpdate(incident: ServiceIncident): void {
  updateTarget.value = incident
  const next = nextStatusesOf(incident)[0]
  updForm.status = next ?? 'resolved'
  updForm.body = ''
  updError.value = ''
}

const updSaving = ref(false)
async function submitUpdate(): Promise<void> {
  if (!updateTarget.value || updSaving.value) return
  updSaving.value = true
  let r: Awaited<ReturnType<typeof addIncidentUpdate>>
  try {
    r = await addIncidentUpdate(updateTarget.value.id, updForm.status as IncidentStatus, updForm.body)
  } finally {
    updSaving.value = false
  }
  if (!r.ok) {
    updError.value = r.error.message
    return
  }
  const resolved = updForm.status === 'resolved'
  updateTarget.value = null
  show(resolved ? '解決済みとして記録し、管理者へ通知しました' : '状況を更新し、管理者へ通知しました', 'ok')
}

/** updates は古い順で時系列表示する */
function timelineOf(incident: ServiceIncident) {
  return [...incident.updates].sort((a, b) => a.at.localeCompare(b.at))
}
</script>

<template>
  <div>
    <!-- 不正な ID -->
    <UiEmptyState
      v-if="!service"
      icon="ServerOff"
      title="サービスが見つかりません"
      hint="URL が古いか、対象サービスが削除された可能性があります"
    >
      <template #action>
        <NuxtLink to="/status" class="btn"><ArrowLeft class="h-4 w-4" aria-hidden="true" /> 稼働状況一覧へ戻る</NuxtLink>
      </template>
    </UiEmptyState>

    <template v-else>
      <!-- 一覧への戻る導線はヘッダー共通の親リンク（nav-map.ts）に統一（バッチ7h） -->
      <UiPageHeader :title="service.name" :description="service.description">
        <template #actions>
          <a :href="service.url" target="_blank" rel="noopener noreferrer" class="btn btn-sm">
            サービスを開く <ExternalLinkIcon class="h-3.5 w-3.5" aria-hidden="true" />
          </a>
          <button v-if="isAdmin" type="button" class="btn btn-sm btn-primary" @click="openRegister">
            <Plus class="h-3.5 w-3.5" aria-hidden="true" /> インシデント登録
          </button>
        </template>
      </UiPageHeader>

      <div class="grid gap-3">
        <!-- 現在状態 + 90 日稼働率 -->
        <UiSectionCard title="現在の状態">
          <template #actions>
            <UiStatusBadge :label="stateLabel" :tone="stateTone" dot />
          </template>
          <div class="mb-2 flex items-baseline gap-2">
            <span class="text-[11px] text-muted">過去 90 日の稼働率</span>
            <span class="num text-lg font-bold">{{ uptimePct }}</span>
          </div>
          <WidgetsUptimeBar :days="uptimeDays" />
        </UiSectionCard>

        <!-- コンポーネント一覧 -->
        <UiSectionCard title="コンポーネント" description="サービスを構成する要素の現在状態">
          <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <li
              v-for="c in service.components"
              :key="c.id"
              class="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"
            >
              <span class="text-[13px] font-semibold">{{ c.name }}</span>
              <UiStatusBadge :label="stateLabel" :tone="stateTone" dot />
            </li>
          </ul>
        </UiSectionCard>

        <!-- インシデント履歴 -->
        <UiSectionCard title="インシデント履歴" description="状況更新のタイムスタンプ付きフィード" flush>
          <UiEmptyState
            v-if="incidents.length === 0"
            icon="ShieldCheck"
            title="インシデントの記録はありません"
          />
          <div v-else class="divide-y divide-[var(--c-line)]">
            <article v-for="inc in incidents" :key="inc.id" class="p-3">
              <div class="flex flex-wrap items-center gap-1.5">
                <UiStatusBadge :label="INCIDENT_IMPACT_LABELS[inc.impact]" :tone="INCIDENT_IMPACT_TONES[inc.impact]" />
                <UiStatusBadge
                  :label="INCIDENT_STATUS_LABELS[inc.status]"
                  :tone="inc.status === 'resolved' ? 'ok' : 'serious'"
                  dot
                />
                <h3 class="min-w-0 flex-1 text-[13px] font-bold">{{ inc.title }}</h3>
                <button
                  v-if="isAdmin && inc.status !== 'resolved'"
                  type="button"
                  class="btn btn-sm"
                  @click="openUpdate(inc)"
                >状況を更新</button>
              </div>
              <p class="num mt-0.5 text-[11px] text-muted">
                発生 {{ fmtDateTime(inc.startedAt) }}
                <template v-if="inc.resolvedAt"> ／ 解決 {{ fmtDateTime(inc.resolvedAt) }}</template>
              </p>
              <ol class="mt-2 border-l-2 border-line pl-3">
                <li v-for="(u, i) in timelineOf(inc)" :key="i" class="relative pb-2.5 last:pb-0">
                  <span
                    class="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full"
                    :class="u.status === 'resolved' ? 'bg-ok' : 'bg-brand'"
                    aria-hidden="true"
                  />
                  <p class="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                    <span class="font-bold text-ink">{{ INCIDENT_STATUS_LABELS[u.status] }}</span>
                    <span class="num text-muted">{{ fmtDateTime(u.at) }}</span>
                  </p>
                  <p class="text-xs leading-relaxed text-sub">{{ u.body }}</p>
                </li>
              </ol>
            </article>
          </div>
        </UiSectionCard>
      </div>

      <!-- インシデント登録モーダル -->
      <UiModal :open="registerOpen" title="インシデント登録" @close="registerOpen = false">
        <div class="grid gap-3">
          <UiFormField label="対象サービス" required>
            <UiSelect v-model="regForm.serviceId" :options="serviceOptions" aria-label="対象サービス" class="!w-full" />
          </UiFormField>
          <UiFormField label="タイトル" required>
            <input v-model="regForm.title" type="text" class="input" placeholder="例: API 応答遅延" maxlength="80">
          </UiFormField>
          <UiFormField label="影響度" required hint="軽微=性能低下 / 重大=一部障害 / 致命的=重大障害 として表示されます">
            <UiSelect v-model="regForm.impact" :options="impactOptions" aria-label="影響度" class="!w-full" />
          </UiFormField>
          <UiFormField label="初報（状況説明）" hint="空欄の場合は定型文で記録します">
            <textarea v-model="regForm.body" class="textarea" rows="3" placeholder="検知した事象・影響範囲・対応状況など" />
          </UiFormField>
          <p v-if="regError" class="text-xs font-semibold text-crit" role="alert">{{ regError }}</p>
        </div>
        <template #footer>
          <button type="button" class="btn" @click="registerOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="regSaving" @click="submitRegister">
            {{ regSaving ? '登録中…' : '登録して通知' }}
          </button>
        </template>
      </UiModal>

      <!-- 状況更新モーダル -->
      <UiModal :open="!!updateTarget" title="インシデント状況更新" @close="updateTarget = null">
        <div v-if="updateTarget" class="grid gap-3">
          <div class="rounded-lg bg-surface-soft p-2.5">
            <p class="text-[13px] font-bold">{{ updateTarget.title }}</p>
            <p class="mt-0.5 text-[11px] text-muted">
              現在: {{ INCIDENT_STATUS_LABELS[(incidentById(updateTarget.id) ?? updateTarget).status] }}
              （調査中 → 原因特定 → 経過観察 → 解決済み の順のみ更新できます）
            </p>
          </div>
          <UiFormField label="次のステータス" required>
            <UiSelect v-model="updForm.status" :options="updStatusOptions" aria-label="次のステータス" class="!w-full" />
          </UiFormField>
          <UiFormField label="状況の説明" required>
            <textarea v-model="updForm.body" class="textarea" rows="3" placeholder="原因・対応内容・利用者への影響など" />
          </UiFormField>
          <p v-if="updError" class="text-xs font-semibold text-crit" role="alert">{{ updError }}</p>
        </div>
        <template #footer>
          <button type="button" class="btn" @click="updateTarget = null">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="updSaving" @click="submitUpdate">
            {{ updSaving ? '更新中…' : '更新して通知' }}
          </button>
        </template>
      </UiModal>
    </template>
  </div>
</template>
