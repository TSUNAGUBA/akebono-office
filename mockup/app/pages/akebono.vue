<script setup lang="ts">
/**
 * AKEBONO（F-03）: 要件定義中のプレースホルダ + 構想ロードマップ + 要望ボックス
 * 要望は useAkebono が SoT（API モードは /v1/akebono/wishes）。バナー・ロードマップは静的表示。
 */
import { CircleCheck, CircleDashed, CircleDot, Send, Sunrise } from 'lucide-vue-next'
import { fmtDateTime } from '~/utils/format'

const { tbl } = useMockDb()
const { show } = useToast()
const { wishes, submitWish: submitWishApi, refresh } = useAkebono()

const members = tbl('members')

// 表示時に最新の要望を取り込む（API モード。他メンバーの投稿の反映）
onMounted(() => { void refresh() })

// ---------- 構想ロードマップ（静的表示） ----------

const ROADMAP = [
  {
    phase: 'Phase 1',
    title: '構想策定',
    state: 'done' as const,
    period: '2026 上期',
    body: '社内業務の AI ネイティブ化構想を策定。AKEBONO Office（本アプリ）で業務データの蓄積基盤を先行整備',
  },
  {
    phase: 'Phase 2',
    title: '要件定義',
    state: 'current' as const,
    period: '2026 下期（現在）',
    body: '蓄積した業務データ・ナレッジ・意思決定ログを学習源とする「会社 OS」としての AKEBONO の要件を定義中',
  },
  {
    phase: 'Phase 3',
    title: 'プロトタイプ開発',
    state: 'planned' as const,
    period: '2027 上期（予定）',
    body: '社内での試験運用を経て、顧客企業への展開可能性を検証',
  },
]

// ---------- 要望ボックス ----------

const wishBody = ref('')
const wishError = ref('')
const wishSaving = ref(false)

function memberName(id: string): string {
  return members.value.find(m => m.id === id)?.name ?? id
}

async function submitWish(): Promise<void> {
  if (wishSaving.value) return
  wishError.value = ''
  wishSaving.value = true
  try {
    const res = await submitWishApi(wishBody.value)
    if (!res.ok) {
      wishError.value = res.error.message
      return
    }
    wishBody.value = ''
    show('受け付けました。要件定義の参考にします')
  } finally {
    wishSaving.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <UiPageHeader title="AKEBONO" description="次世代の AI ネイティブ会社基盤（構想中）" />

    <!-- 要件定義中バナー -->
    <div class="flex items-start gap-3 rounded-[10px] border border-warn bg-warn-soft p-4">
      <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface text-warn">
        <Sunrise class="h-5 w-5" aria-hidden="true" />
      </span>
      <div>
        <p class="flex items-center gap-2 text-[14px] font-bold">
          AKEBONO は要件定義中です
          <UiStatusBadge label="準備中" tone="warn" dot />
        </p>
        <p class="mt-1 text-[13px] text-sub">
          AKEBONO Office に蓄積される業務データ・ナレッジ・意思決定ログを学習源に、
          会社全体を AI ネイティブに運営する基盤を構想しています。
          下の要望ボックスから「こうなってほしい」を送ってください。
        </p>
      </div>
    </div>

    <!-- 構想ロードマップ -->
    <UiSectionCard class="mt-4" title="構想ロードマップ" description="3 フェーズで段階的に立ち上げます">
      <ol class="grid gap-0">
        <li
          v-for="(r, i) in ROADMAP"
          :key="r.phase"
          class="relative flex gap-3 pl-1"
          :class="i < ROADMAP.length - 1 ? 'pb-5' : ''"
        >
          <span
            v-if="i < ROADMAP.length - 1"
            class="absolute left-[15px] top-7 h-[calc(100%-28px)] w-0.5 bg-line"
            aria-hidden="true"
          />
          <span class="z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface">
            <CircleCheck v-if="r.state === 'done'" class="h-5 w-5 text-ok" aria-hidden="true" />
            <CircleDot v-else-if="r.state === 'current'" class="h-5 w-5 text-brand" aria-hidden="true" />
            <CircleDashed v-else class="h-5 w-5 text-muted" aria-hidden="true" />
          </span>
          <div>
            <p class="flex flex-wrap items-center gap-2 text-[13px] font-bold">
              <span class="text-muted">{{ r.phase }}</span>
              {{ r.title }}
              <UiStatusBadge
                :label="r.state === 'done' ? '完了' : r.state === 'current' ? '進行中' : '予定'"
                :tone="r.state === 'done' ? 'ok' : r.state === 'current' ? 'brand' : 'neutral'"
              />
              <span class="text-[11px] font-normal text-muted">{{ r.period }}</span>
            </p>
            <p class="mt-0.5 text-xs text-sub">{{ r.body }}</p>
          </div>
        </li>
      </ol>
    </UiSectionCard>

    <!-- 要望ボックス -->
    <UiSectionCard class="mt-4" title="要望ボックス" description="AKEBONO への期待・要望を受け付けています（要件定義のインプットになります）">
      <div class="grid gap-2">
        <UiFormField label="要望" required :error="wishError">
          <textarea
            v-model="wishBody"
            class="textarea"
            rows="3"
            placeholder="例: 過去の提案書から勝ちパターンを提示してほしい"
          />
        </UiFormField>
        <button type="button" class="btn btn-primary justify-self-end" :disabled="wishSaving" @click="submitWish">
          <Send class="h-3.5 w-3.5" aria-hidden="true" />
          {{ wishSaving ? '送信中…' : '送信' }}
        </button>
      </div>

      <ul v-if="wishes.length > 0" class="mt-3 grid gap-2 border-t border-line pt-3">
        <li v-for="w in wishes" :key="w.id" class="rounded-lg bg-page p-2.5">
          <p class="text-[13px]">{{ w.body }}</p>
          <p class="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
            <UiAvatar :name="memberName(w.memberId)" size="sm" />
            {{ memberName(w.memberId) }}
            <span class="num">{{ fmtDateTime(w.at) }}</span>
          </p>
        </li>
      </ul>
      <UiEmptyState v-else icon="MailQuestion" title="まだ要望はありません" hint="最初の要望を送ってみましょう" />
    </UiSectionCard>
  </div>
</template>
