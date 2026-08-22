<script setup lang="ts">
/**
 * データ項目の一覧 + 詳細（改善要望 2026-08-22: 共通 UI 構造「データ項目 → 一覧 → 詳細」）。
 * /data/<item> で全データ項目に同じ構造を適用する:
 * - 一覧: 検索 + 20 件/ページ（UiDataTable = PC テーブル / モバイル カードの自動切替）
 * - 詳細: 行押下でドロワー（全文・明細を表示）
 * 表示のみ（本アプリは業務データへ書込しない読み取り層）。編集は各 SoT の画面（AKEBONO Home）で行う。
 */
import { ArrowLeft } from 'lucide-vue-next'
import type { TableColumn, Tone } from '~/types/ui'
import { foundationItemOf } from '~/utils/data-foundation'
import { fmtDate, fmtDateTime, fmtInt, fmtYen } from '~/utils/format'

interface DetailSection { label: string; text: string }
interface RowVm {
  id: string
  [k: string]: unknown
  _title: string
  _badges: { label: string; tone: Tone }[]
  _sections: DetailSection[]
}

const route = useRoute()
const itemKey = computed(() => String(route.params.item ?? ''))
const item = computed(() => foundationItemOf(itemKey.value))

const data = useIntelligenceData()
const foundation = useFoundationData()

const EMPLOYMENT_LABELS: Record<string, string> = {
  director: '役員', employee: '正社員', contract: '契約社員', parttime: 'アルバイト', outsource: '業務委託',
}
const PROJECT_STATUS_LABELS: Record<string, string> = {
  planned: '計画中', active: '進行中', closed: '完了',
}
const PROJECT_STATUS_TONES: Record<string, Tone> = { planned: 'neutral', active: 'info', closed: 'ok' }

function section(label: string, text: string | null | undefined): DetailSection[] {
  const t = (text ?? '').trim()
  return t ? [{ label, text: t }] : []
}

/** データ項目ごとの一覧定義（列 + 行 VM。詳細ドロワーの内容も行 VM に持たせる） */
const view = computed<{ columns: TableColumn[]; rows: RowVm[] }>(() => {
  switch (itemKey.value) {
    case 'company': {
      const rows = data.companies.value.filter(c => c.kind === 'self').map(c => ({
        id: c.id,
        name: c.name,
        size: c.size || '—',
        location: c.location || '—',
        _title: c.name,
        _badges: [{ label: '自社', tone: 'brand' as Tone }],
        _sections: [
          ...section('規模', c.size),
          ...section('所在地', c.location),
          ...section('会社概要', c.description),
          ...section('別名', (c.aliases ?? []).join('・')),
          ...section('会計年度開始月', c.fiscalStartMonth ? `${c.fiscalStartMonth} 月` : ''),
        ],
      }))
      return {
        columns: [
          { key: 'name', label: '会社名', primary: true },
          { key: 'size', label: '規模' },
          { key: 'location', label: '所在地', primary: true },
        ],
        rows,
      }
    }
    case 'projects': {
      const rows = [...data.projects.value].filter(p => p.active)
        .sort((a, b) => b.startDate.localeCompare(a.startDate))
        .map(p => ({
          id: p.id,
          name: p.name,
          status: PROJECT_STATUS_LABELS[p.status] ?? p.status,
          company: data.companyName(p.companyId) || '—',
          period: `${fmtDate(p.startDate)} 〜 ${p.endDate ? fmtDate(p.endDate) : ''}`,
          owner: data.memberName(p.ownerMemberId),
          _title: p.name,
          _badges: [{ label: PROJECT_STATUS_LABELS[p.status] ?? p.status, tone: PROJECT_STATUS_TONES[p.status] ?? 'neutral' }],
          _sections: [
            ...section('顧客', data.companyName(p.companyId)),
            ...section('期間', `${fmtDate(p.startDate)} 〜 ${p.endDate ? fmtDate(p.endDate) : '未定'}`),
            ...section('オーナー', data.memberName(p.ownerMemberId)),
            ...section('メンバー', p.memberIds.map(id => data.memberName(id)).join('・')),
            ...section('予算', p.budget > 0 ? fmtYen(p.budget) : ''),
            ...section('目的', p.objective),
          ],
        }))
      return {
        columns: [
          { key: 'name', label: 'プロジェクト', primary: true },
          { key: 'status', label: '状態', primary: true },
          { key: 'company', label: '顧客' },
          { key: 'period', label: '期間' },
          { key: 'owner', label: 'オーナー' },
        ],
        rows,
      }
    }
    case 'members': {
      const rows = data.members.value.filter(m => m.active !== false).map(m => ({
        id: m.id,
        name: m.name,
        title: m.title || '—',
        employment: EMPLOYMENT_LABELS[m.employmentType] ?? m.employmentType,
        email: m.email || '—',
        _title: m.name,
        _badges: m.title ? [{ label: m.title, tone: 'neutral' as Tone }] : [],
        _sections: [
          ...section('雇用区分', EMPLOYMENT_LABELS[m.employmentType] ?? m.employmentType),
          ...section('メール', m.email),
          ...section('入社日', m.hireDate ? fmtDate(m.hireDate) : ''),
        ],
      }))
      return {
        columns: [
          { key: 'name', label: '氏名', primary: true },
          { key: 'title', label: '役職', primary: true },
          { key: 'employment', label: '雇用区分' },
          { key: 'email', label: 'メール' },
        ],
        rows,
      }
    }
    case 'media-reports': {
      const rows = [...foundation.mediaReports.value]
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
        .map(r => ({
          id: r.id,
          week: `${fmtDate(r.periodFrom)} 週`,
          channel: foundation.mediaChannelName(r.channelId),
          summary: r.content.executiveSummary[0] ?? '',
          actions: r.content.actions.length,
          _title: `AI週次レポート（${fmtDate(r.periodFrom)} 週）`,
          _badges: [{ label: r.llm ? 'AI生成' : '自動集計', tone: (r.llm ? 'brand' : 'neutral') as Tone }],
          _sections: [
            ...section('対象期間', `${fmtDate(r.periodFrom)} 〜 ${fmtDate(r.periodTo)}`),
            ...section('サマリー', r.content.executiveSummary.map(s => `・${s}`).join('\n')),
            ...section('重要な変化', r.content.changes.map(ch => `・[${ch.direction === 'up' ? '伸長' : '低下'}] ${ch.label} ${ch.value} — ${ch.detail}`).join('\n')),
            ...section('仮説', r.content.hypotheses.map(h => `・${h}`).join('\n')),
            ...section('推奨アクション', r.content.actions.map(a => `・${a.title}（${a.decision}）\n  理由: ${a.reason}`).join('\n')),
          ],
        }))
      return {
        columns: [
          { key: 'week', label: '対象週', primary: true },
          { key: 'channel', label: 'チャンネル' },
          { key: 'summary', label: 'サマリー', primary: true },
          { key: 'actions', label: '推奨', align: 'right' },
        ],
        rows,
      }
    }
    case 'ec-reports': {
      const rows = [...foundation.ecReports.value]
        .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
        .map(r => ({
          id: r.id,
          target: r.scope === 'company' ? '会社全体' : (r.segmentName || r.segmentId || '業態'),
          period: r.periodKey,
          summary: (r.insight?.executiveSummary ?? '').split('\n')[0] ?? '',
          generated: fmtDateTime(r.generatedAt),
          _title: `${r.scope === 'company' ? '会社全体' : (r.segmentName || '業態')} レポート（${r.periodKey}）`,
          _badges: [{ label: r.llm ? 'AI生成' : '自動集計', tone: (r.llm ? 'brand' : 'neutral') as Tone }],
          _sections: [
            ...section('レポート', r.insight?.executiveSummary),
            ...section('インサイト', (r.insight?.findings ?? [])
              .map(f => `・[${f.kind === 'win' ? '好調' : f.kind === 'issue' ? '課題' : '機会'}] ${f.title} — ${f.detail}`).join('\n')),
            ...section('次アクション', (r.insight?.actions ?? []).map(a => `・${a.title} — ${a.detail}`).join('\n')),
            ...section('生成', `${fmtDateTime(r.generatedAt)}${r.generatedByName ? ` / ${r.generatedByName}` : ''}`),
          ],
        }))
      return {
        columns: [
          { key: 'target', label: '対象', primary: true },
          { key: 'period', label: '期間', primary: true },
          { key: 'summary', label: 'レポート' },
          { key: 'generated', label: '生成' },
        ],
        rows,
      }
    }
    case 'consignment-reports': {
      const rows = [...foundation.consignmentReports.value]
        .sort((a, b) => b.periodTo.localeCompare(a.periodTo))
        .map(r => ({
          id: r.id,
          code: r.code,
          partner: data.companyName(r.companyId) || r.companyId,
          period: `${fmtDate(r.periodFrom)} 〜 ${fmtDate(r.periodTo)}`,
          amount: fmtYen(r.payableAmount),
          status: r.voidedAt ? '取消済み' : r.status,
          _title: `支払通知書 ${r.code}`,
          _badges: r.voidedAt ? [{ label: '取消済み', tone: 'crit' as Tone }] : [],
          _sections: [
            ...section('作家（委託元）', data.companyName(r.companyId) || r.companyId),
            ...section('対象期間', `${fmtDate(r.periodFrom)} 〜 ${fmtDate(r.periodTo)}`),
            ...section('支払金額', fmtYen(r.payableAmount)),
            ...section('明細', (r.lines ?? []).map(l => `・${l.description} — ${fmtYen(l.amount)}`).join('\n')),
          ],
        }))
      return {
        columns: [
          { key: 'code', label: '通知書番号', primary: true },
          { key: 'partner', label: '作家' },
          { key: 'period', label: '対象期間' },
          { key: 'amount', label: '支払金額', align: 'right', primary: true },
          { key: 'status', label: '状態' },
        ],
        rows,
      }
    }
    case 'internal-supports': {
      const rows = foundation.internalSupports.value.filter(r => r.active !== false)
        .slice()
        .sort((a, b) => b.activityDate.localeCompare(a.activityDate) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
        .map(r => ({
          id: r.id,
          date: r.activityTime ? `${fmtDate(r.activityDate)} ${r.activityTime}` : fmtDate(r.activityDate),
          performer: data.memberName(r.performerMemberId),
          target: data.memberName(r.targetMemberId),
          method: r.method,
          task: r.taskDescription,
          _title: `${data.memberName(r.targetMemberId)}さんへのフォローアップ`,
          _badges: [{ label: r.method, tone: 'info' as Tone }],
          _sections: [
            ...section('活動日時', r.activityTime ? `${fmtDate(r.activityDate)} ${r.activityTime}` : fmtDate(r.activityDate)),
            ...section('フォローアップ実施者', data.memberName(r.performerMemberId)),
            ...section('フォローアップ対象者', data.memberName(r.targetMemberId)),
            ...section('対象業務内容', r.taskDescription),
            ...section('活動結果・効果のフィードバック', r.feedback || '（未記録）'),
          ],
        }))
      return {
        columns: [
          { key: 'date', label: '活動日時', primary: true },
          { key: 'performer', label: '実施者' },
          { key: 'target', label: '対象者', primary: true },
          { key: 'method', label: '方法' },
          { key: 'task', label: '対象業務内容' },
        ],
        rows,
      }
    }
    case 'monthly-reports': {
      const rows = data.monthly.value.filter(r => r.status === 'submitted')
        .slice()
        .sort((a, b) => b.monthStart.localeCompare(a.monthStart))
        .map(r => ({
          id: r.id,
          month: r.monthStart.slice(0, 7),
          member: data.memberName(r.memberId),
          mainWork: r.mainWork,
          _title: `${r.monthStart.slice(0, 7)} 月報（${data.memberName(r.memberId)}）`,
          _badges: [],
          _sections: [
            ...section('今月の成果・達成感', r.goalReview),
            ...section('今月の主要業務', r.mainWork),
            ...section('課題・原因仮説', r.issues),
            ...section('来月の最重要テーマ', r.nextWeek),
            ...section('うまくいったこと', r.goodPoints),
          ],
        }))
      return {
        columns: [
          { key: 'month', label: '対象月', primary: true },
          { key: 'member', label: 'メンバー', primary: true },
          { key: 'mainWork', label: '主要業務' },
        ],
        rows,
      }
    }
    case 'minutes': {
      const rows = foundation.minutes.value.filter(r => r.active !== false)
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(r => ({
          id: r.id,
          date: fmtDateTime(r.createdAt),
          title: r.title,
          author: data.memberName(r.memberId),
          project: r.projectId ? data.projectName(r.projectId) : '—',
          _title: r.title,
          _badges: [],
          _sections: [
            ...section('登録', `${fmtDateTime(r.createdAt)} / ${data.memberName(r.memberId)}`),
            ...section('紐付け', [r.projectId ? data.projectName(r.projectId) : '', r.companyId ? data.companyName(r.companyId) : ''].filter(Boolean).join('・')),
            ...section('本文', r.body),
          ],
        }))
      return {
        columns: [
          { key: 'date', label: '日時', primary: true },
          { key: 'title', label: 'タイトル', primary: true },
          { key: 'author', label: '登録者' },
          { key: 'project', label: 'プロジェクト' },
        ],
        rows,
      }
    }
    case 'daily-reports': {
      const rows = data.daily.value.filter(r => r.status === 'submitted')
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date))
        .map(r => ({
          id: r.id,
          date: fmtDate(r.date),
          member: data.memberName(r.memberId),
          entries: r.entries.length,
          hasIssues: r.issues.trim() ? 'あり' : '—',
          _title: `${fmtDate(r.date)} の日報（${data.memberName(r.memberId)}）`,
          _badges: r.issues.trim() ? [{ label: '課題あり', tone: 'warn' as Tone }] : [],
          _sections: [
            ...section('業務エントリ', r.entries.map(e => `・${e.theme || data.projectName(e.projectId ?? '') || '業務'}: ${e.task}（${e.hours}h / 進捗 ${e.progress}%）`).join('\n')),
            ...section('ふりかえり', r.reflection),
            ...section('本日の課題', r.issues),
            ...section('明日の予定', r.tomorrow),
          ],
        }))
      return {
        columns: [
          { key: 'date', label: '日付', primary: true },
          { key: 'member', label: 'メンバー', primary: true },
          { key: 'entries', label: 'エントリ', align: 'right' },
          { key: 'hasIssues', label: '課題' },
        ],
        rows,
      }
    }
    case 'weekly-reports': {
      const rows = data.weekly.value.filter(r => r.status === 'submitted')
        .slice()
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
        .map(r => ({
          id: r.id,
          week: `${fmtDate(r.weekStart)} 週`,
          member: data.memberName(r.memberId),
          mainWork: r.mainWork,
          _title: `${fmtDate(r.weekStart)} 週の週報（${data.memberName(r.memberId)}）`,
          _badges: [],
          _sections: [
            ...section('今週の成果・達成感', r.goalReview),
            ...section('今週の主要業務', r.mainWork),
            ...section('課題・原因仮説', r.issues),
            ...section('来週の最重要テーマ', r.nextWeek),
            ...section('うまくいったこと', r.goodPoints),
          ],
        }))
      return {
        columns: [
          { key: 'week', label: '週', primary: true },
          { key: 'member', label: 'メンバー', primary: true },
          { key: 'mainWork', label: '主要業務' },
        ],
        rows,
      }
    }
    default:
      return { columns: [], rows: [] }
  }
})

const source = computed(() => view.value.rows)
const { query, page, pageSize, rows: paged, total } = useListView<RowVm>({
  source,
  match: (row, q) => Object.entries(row)
    .filter(([k]) => !k.startsWith('_'))
    .some(([, v]) => String(v ?? '').toLowerCase().includes(q))
    || row._title.toLowerCase().includes(q)
    || row._sections.some(s => s.text.toLowerCase().includes(q)),
})

// ---------- 詳細ドロワー ----------
const detailId = ref<string | null>(null)
const detail = computed(() => view.value.rows.find(r => r.id === detailId.value) ?? null)

function openDetail(rowId: unknown): void {
  detailId.value = String(rowId)
}
</script>

<template>
  <div>
    <template v-if="item">
      <UiPageHeader :title="item.label" :description="`${item.description}。行を押すと詳細を表示します`">
        <template #actions>
          <NuxtLink to="/data" class="btn btn-sm">
            <ArrowLeft class="h-3.5 w-3.5" aria-hidden="true" />
            データソース
          </NuxtLink>
        </template>
      </UiPageHeader>

      <UiFilterBar>
        <UiSearchInput v-model="query" :placeholder="`${item.label}をキーワードで検索`" />
        <template #trailing>
          <span class="num text-xs text-muted">{{ fmtInt(total) }} 件</span>
        </template>
      </UiFilterBar>

      <UiEmptyState
        v-if="total === 0"
        icon="Database"
        :title="`${item.label}のデータがありません`"
        hint="アクセス権の範囲で取得できたデータのみ表示しています（データの登録は AKEBONO Home で行います）"
      />
      <template v-else>
        <UiDataTable
          :columns="view.columns"
          :rows="paged"
          row-key="id"
          clickable
          @row-click="row => openDetail(row.id)"
        />
        <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
      </template>

      <!-- 詳細ドロワー（共通 UI 構造の「詳細」） -->
      <UiDrawer :open="!!detail" :title="detail?._title ?? ''" width="560px" @close="detailId = null">
        <div v-if="detail" class="grid gap-3">
          <div v-if="detail._badges.length > 0" class="flex flex-wrap items-center gap-1.5">
            <UiStatusBadge v-for="b in detail._badges" :key="b.label" :label="b.label" :tone="b.tone" />
          </div>
          <div v-for="s in detail._sections" :key="s.label" class="grid gap-1 rounded-lg border border-line p-3">
            <p class="label">{{ s.label }}</p>
            <p class="whitespace-pre-wrap text-[12px]">{{ s.text }}</p>
          </div>
          <p class="text-[11px] text-muted">
            表示のみ（このアプリは読み取り層です）。編集・登録は AKEBONO Home の各画面で行います
          </p>
        </div>
      </UiDrawer>
    </template>

    <UiEmptyState
      v-else
      icon="Database"
      title="データ項目が見つかりません"
      hint="データソースから項目を選び直してください"
    >
      <template #action>
        <NuxtLink to="/data" class="btn btn-primary btn-sm">データソースへ</NuxtLink>
      </template>
    </UiEmptyState>
  </div>
</template>
