<script setup lang="ts">
/**
 * ヘッダーのクイックアクセス設定（ヘッダーカスタマイズ）。
 * どのメニューをヘッダーのクイックアクセスとして表示するかを、自分（ユーザー）/ 全社（組織）で設定する。
 * 解決順はユーザー > 組織 > 既定で、ユーザー個人設定が優先（useHeaderQuickAccess）。
 */
import * as icons from 'lucide-vue-next'
import { QUICK_ACCESS_CATALOG, quickAccessPermPath } from '~/utils/header-quick-access'
import type { QuickAccessApplyScope } from '~/composables/useHeaderQuickAccess'

const { effectiveIds, resolvedScope, userIds, tenantIds, isAdmin, persist, reset } = useHeaderQuickAccess()
const { canPath } = usePermissions()
const { isEnabled } = useAppSettings()
const { show } = useToast()

function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.Circle
}

/** 権限・機能トグルで利用可能なカタログのみ候補にする */
const candidates = computed(() =>
  QUICK_ACCESS_CATALOG.filter((i) => {
    if (i.featureKey && !isEnabled(i.featureKey)) return false
    const p = quickAccessPermPath(i)
    return !p || canPath(p)
  }))

/** 編集対象スコープ（自分 / 全社）。全社は管理者のみ。UiChipTabs は string モデルのため string で保持 */
const scope = ref<string>('user')
const scopeOptions = computed(() => {
  const opts: { value: string; label: string }[] = [{ value: 'user', label: '自分（個人設定・優先）' }]
  if (isAdmin.value) opts.push({ value: 'tenant', label: '全社（組織の既定）' })
  return opts
})

/** 選択中スコープに保存済みの id（無ければ有効値を土台にする） */
function baseIdsFor(s: string): string[] {
  const saved = s === 'tenant' ? tenantIds.value : userIds.value
  return saved ? [...saved] : [...effectiveIds.value]
}

const draft = ref<string[]>(baseIdsFor('user'))
watch(scope, (s) => { draft.value = baseIdsFor(s) })

function toggle(id: string): void {
  draft.value = draft.value.includes(id)
    ? draft.value.filter(x => x !== id)
    : [...draft.value, id]
}

const saving = ref(false)

async function onSave(): Promise<void> {
  saving.value = true
  try {
    // 候補外（権限で消えた等）の id は落として保存する
    const allowed = new Set(candidates.value.map(c => c.id))
    const ids = draft.value.filter(id => allowed.has(id))
    const res = await persist(ids, scope.value as QuickAccessApplyScope)
    if (res.ok) {
      show(scope.value === 'tenant' ? '全社のクイックアクセスを保存しました' : 'クイックアクセスを保存しました', 'ok')
    }
  } finally {
    saving.value = false
  }
}

async function onReset(): Promise<void> {
  saving.value = true
  try {
    const res = await reset(scope.value as QuickAccessApplyScope)
    if (res.ok) {
      draft.value = baseIdsFor(scope.value)
      show(scope.value === 'tenant' ? '全社設定を解除しました' : '個人設定を解除しました（上位・既定に戻ります）', 'ok')
    }
  } finally {
    saving.value = false
  }
}

const scopeLabel: Record<string, string> = { user: 'あなたの個人設定', tenant: '全社の組織設定', default: '既定' }
</script>

<template>
  <div class="grid gap-3">
    <p class="text-[13px] text-sub">
      ヘッダーにクイックアクセスとして表示するメニューを選びます。設定は
      <b>自分</b>と<b>全社</b>で行え、<b>自分の設定が優先</b>されます。
    </p>
    <p class="text-[11px] text-muted">
      現在の表示は「{{ scopeLabel[resolvedScope] ?? '既定' }}」が有効です。
    </p>

    <UiChipTabs v-model="scope" :options="scopeOptions" aria-label="設定スコープ" />

    <div class="grid gap-1.5">
      <label
        v-for="c in candidates"
        :key="c.id"
        class="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 transition-colors"
        :class="draft.includes(c.id) ? 'border-brand bg-brand-soft' : 'border-line hover:border-line-strong'"
      >
        <input
          type="checkbox"
          :checked="draft.includes(c.id)"
          @change="toggle(c.id)"
        >
        <component :is="iconOf(c.icon)" class="h-4 w-4 text-brand" aria-hidden="true" />
        <span class="flex-1 text-[13px] font-semibold">{{ c.label }}</span>
      </label>
      <UiEmptyState v-if="candidates.length === 0" icon="Info" title="利用できるメニューがありません" />
    </div>

    <div class="flex flex-wrap items-center justify-end gap-2">
      <button type="button" class="btn btn-sm" :disabled="saving" @click="onReset">既定に戻す</button>
      <button type="button" class="btn btn-primary btn-sm" :disabled="saving" @click="onSave">保存</button>
    </div>
  </div>
</template>
