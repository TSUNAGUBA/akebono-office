<script setup lang="ts">
/**
 * メディア設定（F-40-4・管理者ゲート必須）— /media/settings。
 * セグメント（業態）ごとに Google Analytics 連携と AI 分析設定を「画面操作だけで」完結させる。
 * - GA 連携: 擬似 OAuth（MediaGaConnect）。本実装では OAuth + GA4 プロパティ選択に置き換わる
 * - AI 分析設定: サイト名・URL・分析の目的・ターゲット読者・既定トーン・重点キーワード
 * 取消可能性（原則9.5）: 連携は解除でき、設定は再編集で上書きできる。
 */
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import { ARTICLE_TONE_OPTIONS, MEDIA_GOAL_OPTIONS } from '~/utils/media'
import type { ArticleTone } from '~/utils/media'
import type { MediaGoal } from '~/types/media'

const { activeSegments, effectiveSegmentId } = useCurrentSegment()
const { settingFor, save } = useMediaSettings()
const { show } = useToast()

const selectedId = ref(effectiveSegmentId.value || activeSegments.value[0]?.id || '')
const selectedSegment = computed(() => activeSegments.value.find(s => s.id === selectedId.value) ?? null)

interface Form {
  siteName: string
  siteUrl: string
  analysisGoal: MediaGoal
  targetAudience: string
  defaultTone: ArticleTone
  keywords: string
}
const form = ref<Form>({ siteName: '', siteUrl: '', analysisGoal: 'awareness', targetAudience: '', defaultTone: 'formal', keywords: '' })

/** 選択セグメントの保存済み設定をフォームへ読み込む */
function loadForm(): void {
  const s = settingFor(selectedId.value)
  if (!s) return
  form.value = {
    siteName: s.siteName,
    siteUrl: s.siteUrl,
    analysisGoal: s.analysisGoal,
    targetAudience: s.targetAudience,
    defaultTone: s.defaultTone,
    keywords: s.keywords.join('、'),
  }
}
watch(selectedId, loadForm, { immediate: true })

// GA 連携状態（connected）はコンポーネント（MediaGaConnect）が mediaSettings を直接更新し、
// この computed が反応して案内文へ反映される。フォーム（サイト名等）は GA 連携で変化しないため同期不要。
const connected = computed(() => settingFor(selectedId.value)?.gaConnected === true)

function splitKeywords(text: string): string[] {
  return text.split(/[,、]/).map(s => s.trim()).filter(s => s.length > 0)
}

function saveForm(): void {
  const res = save(selectedId.value, {
    siteName: form.value.siteName.trim() || (selectedSegment.value?.name ?? 'メディア'),
    siteUrl: form.value.siteUrl.trim(),
    analysisGoal: form.value.analysisGoal,
    targetAudience: form.value.targetAudience.trim(),
    defaultTone: form.value.defaultTone,
    keywords: splitKeywords(form.value.keywords),
  })
  if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'crit'); return }
  show('メディア設定を保存しました', 'ok')
}
</script>

<template>
  <MastersMasterShell
    title="メディア設定"
    description="セグメント（業態）ごとに Google Analytics 連携と AI 分析設定を行います。連携・設定は画面操作だけで完結します。"
  >
    <div class="grid gap-4">
      <!-- 業態セレクタ -->
      <UiSectionCard title="設定する業態" description="メディア分析は Akebono 業務のセグメントと 1:1 で対になります">
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="s in activeSegments"
            :key="s.id"
            type="button"
            class="rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors"
            :class="s.id === selectedId ? 'border-brand bg-brand-soft text-brand' : 'border-line hover:border-muted'"
            :aria-pressed="s.id === selectedId"
            @click="selectedId = s.id"
          >
            {{ s.name }}<span class="ml-1 text-[10px] text-muted">{{ INDUSTRY_TYPE_LABELS[s.industryType] }}</span>
          </button>
        </div>
        <UiEmptyState v-if="activeSegments.length === 0" icon="Layers" title="業態がありません" hint="共通マスタ管理から事業セグメント（業態）を登録してください" />
      </UiSectionCard>

      <template v-if="selectedSegment">
        <!-- GA 連携 -->
        <UiSectionCard title="Google Analytics 連携" :description="`「${selectedSegment.name}」のアクセス解析データを取得します`">
          <MediaGaConnect :segment-id="selectedId" variant="gate" />
        </UiSectionCard>

        <!-- AI 分析設定 -->
        <UiSectionCard title="AI 分析設定" description="分析・記事生成の前提になります。目的・ターゲット・トーン・キーワードを設定します">
          <div class="grid gap-3">
            <div class="grid gap-3 sm:grid-cols-2">
              <UiFormField label="サイト名">
                <input v-model="form.siteName" type="text" class="input" :placeholder="selectedSegment.name" aria-label="サイト名">
              </UiFormField>
              <UiFormField label="サイト URL">
                <input v-model="form.siteUrl" type="url" class="input" placeholder="https://example.com" aria-label="サイト URL">
              </UiFormField>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <UiFormField label="分析の目的">
                <UiSelect v-model="form.analysisGoal" :options="MEDIA_GOAL_OPTIONS" aria-label="分析の目的" />
              </UiFormField>
              <UiFormField label="既定の記事トーン" hint="記事生成フォームの初期値になります">
                <UiSelect v-model="form.defaultTone" :options="ARTICLE_TONE_OPTIONS" aria-label="既定の記事トーン" />
              </UiFormField>
            </div>
            <UiFormField label="ターゲット読者" hint="記事生成・インサイトの前提">
              <input v-model="form.targetAudience" type="text" class="input" placeholder="例）手仕事の器に関心のある 30〜50 代" aria-label="ターゲット読者">
            </UiFormField>
            <UiFormField label="重点キーワード・テーマ" hint="カンマ・読点区切りで複数指定できます">
              <input v-model="form.keywords" type="text" class="input" placeholder="例）作家もの 器, 陶磁器 選び方" aria-label="重点キーワード">
            </UiFormField>
            <div class="flex items-center justify-between gap-2">
              <p class="text-[11px] text-muted">
                {{ connected ? 'GA 連携済み。分析・記事生成が利用できます' : 'GA 連携すると分析・PDCA が利用できます（記事生成は連携なしでも可）' }}
              </p>
              <button type="button" class="btn btn-primary" @click="saveForm">保存</button>
            </div>
          </div>
        </UiSectionCard>
      </template>
    </div>
  </MastersMasterShell>
</template>
