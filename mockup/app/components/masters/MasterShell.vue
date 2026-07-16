<script lang="ts">
/**
 * マスタ画面共通スキャフォールド（F-10 全マスタページで共用）
 * - 管理者ゲート: isAdmin でない場合は「管理者権限が必要です」の案内のみ表示し、内容を出さない
 * - レイアウト: UiPageHeader → UiFilterBar（#filter）→ 本体（default slot）→ #drawer
 * - 共有ヘルパー: 有効/無効フィルタ・エイリアス分割・カスタム項目値の表示整形（named export）
 */

/** 有効/無効フィルタの選択肢（全マスタ共通） */
export const ACTIVE_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: 'active', label: '有効のみ' },
  { value: 'inactive', label: '無効のみ' },
  { value: 'all', label: 'すべて' },
]

/** 有効/無効フィルタの判定（全マスタ共通） */
export function matchesActiveFilter(row: { active?: boolean }, filter: string): boolean {
  if (filter === 'active') return row.active !== false
  if (filter === 'inactive') return row.active === false
  return true
}

/** カンマ・読点区切りテキスト → エイリアス配列（2文字未満は除外） */
export function splitAliases(text: string): string[] {
  return text
    .split(/[,、]/)
    .map(s => s.trim())
    .filter(s => s.length >= 2)
}

/** カンマ・読点区切りテキスト → タグ等の配列（空要素は除外） */
export function splitTags(text: string): string[] {
  return text
    .split(/[,、]/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/** カスタム項目値の表示用整形（詳細ドロワーの dl 表示で共用） */
export function fmtCustomValue(v: unknown): string {
  if (v == null || v === '') return '—'
  if (Array.isArray(v)) return v.length > 0 ? v.map(String).join('、') : '—'
  if (typeof v === 'boolean') return v ? 'あり' : 'なし'
  return String(v)
}
</script>

<script setup lang="ts">
import { ShieldAlert } from 'lucide-vue-next'

defineProps<{
  title: string
  description?: string
}>()

const { isAdmin, switchableUsers, switchUser } = useCurrentUser()
const toast = useToast()

/** 切替候補（管理者ロールのユーザーのみ） */
const adminUsers = computed(() => switchableUsers.value.filter(u => u.role === 'admin'))

function switchTo(id: string, name: string): void {
  switchUser(id)
  toast.show(`${name} さんに切り替えました`)
}
</script>

<template>
  <div>
    <UiPageHeader :title="title" :description="description">
      <template v-if="isAdmin && $slots.actions" #actions>
        <slot name="actions" />
      </template>
    </UiPageHeader>

    <!-- 管理者ゲート（全マスタページ共通） -->
    <div v-if="!isAdmin" class="card mx-auto mt-6 max-w-md p-6 text-center">
      <ShieldAlert class="mx-auto h-8 w-8 text-warn" aria-hidden="true" />
      <p class="mt-2 text-[15px] font-bold">管理者権限が必要です</p>
      <p class="mt-1 text-xs leading-relaxed text-sub">
        マスタメンテナンスは管理者専用の機能です。画面右上の「デモユーザー切替」から管理者ユーザーに切り替えるとご利用いただけます。
      </p>
      <div v-if="adminUsers.length > 0" class="mt-4">
        <p class="mb-1.5 text-[11px] font-semibold text-muted">管理者ユーザーへ切替（デモ）</p>
        <div class="flex flex-wrap justify-center gap-2">
          <button
            v-for="u in adminUsers"
            :key="u.id"
            type="button"
            class="btn btn-sm"
            @click="switchTo(u.id, u.name)"
          >
            <UiAvatar :name="u.name" size="sm" />
            {{ u.name }}
          </button>
        </div>
      </div>
    </div>

    <template v-else>
      <UiFilterBar v-if="$slots.filter || $slots['filter-trailing']">
        <slot name="filter" />
        <template v-if="$slots['filter-trailing']" #trailing>
          <slot name="filter-trailing" />
        </template>
      </UiFilterBar>

      <div class="grid gap-3">
        <slot name="table" />
        <slot />
      </div>

      <slot name="drawer" />
    </template>
  </div>
</template>
