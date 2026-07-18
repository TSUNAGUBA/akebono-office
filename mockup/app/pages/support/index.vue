<script setup lang="ts">
/** F-09-1 業務支援ツールハブ: 内部アプリ + 設定された外部リンクをカード型メニューで混在表示 */
import { Settings } from 'lucide-vue-next'
import type { MenuCard } from '~/types/ui'

const { isAdmin } = useCurrentUser()
const { isEnabled } = useAppSettings()
const { canPath } = usePermissions()
const { activeList: links } = useMasterCrud('externalLinks', 'el')
const { activeFiles } = useDocuments()

/** 内部アプリ（機能トグルに追従） */
const internalItems = computed<MenuCard[]>(() => {
  const items: MenuCard[] = []
  if (isEnabled('chatbot') && canPath('/support/chatbot')) {
    items.push({
      id: 'app-chatbot',
      title: 'AIチャットボット',
      description: '勤怠・有給・顧客情報・規程・稼働状況を実データから回答します',
      icon: 'Bot',
      to: '/support/chatbot',
    })
  }
  if (isEnabled('documents') && canPath('/support/documents')) {
    items.push({
      id: 'app-documents',
      title: 'ドキュメント管理',
      description: `規程・議事録・提案書などの社内文書（${activeFiles.value.length} ファイル）`,
      icon: 'FolderOpen',
      to: '/support/documents',
    })
  }
  return items
})

/** 外部リンク（active を displayOrder 順に。新規タブで開く） */
const externalItems = computed<MenuCard[]>(() =>
  [...links.value]
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map(el => ({
      id: el.id,
      title: el.title,
      description: el.description,
      icon: el.icon,
      href: el.url,
    })),
)

const allItems = computed<MenuCard[]>(() => [...internalItems.value, ...externalItems.value])
</script>

<template>
  <div>
    <UiPageHeader title="業務支援ツール" description="社内アプリと外部ツールの入り口">
      <template #actions>
        <NuxtLink v-if="isAdmin" to="/settings" class="btn btn-sm">
          <Settings class="h-3.5 w-3.5" aria-hidden="true" />
          リンクを追加・編集
        </NuxtLink>
      </template>
    </UiPageHeader>

    <UiEmptyState
      v-if="allItems.length === 0"
      icon="Wrench"
      title="表示できるツールがありません"
      hint="機能トグルまたは外部リンクの設定を確認してください"
    >
      <template v-if="isAdmin" #action>
        <NuxtLink to="/settings" class="btn btn-primary btn-sm">設定を開く</NuxtLink>
      </template>
    </UiEmptyState>

    <UiCardMenu v-else :items="allItems" />

    <p v-if="isAdmin" class="mt-3 text-[11px] text-muted">
      外部リンクは 設定 &gt; 外部リンク で追加・編集・並べ替えできます（変更は即このページに反映されます）
    </p>
  </div>
</template>
