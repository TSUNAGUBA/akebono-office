import { describe, expect, it } from 'vitest'
import type {
  Company, CustomerLog, DailyReport, Project, SalesActivity, SupportActivity,
} from '../app/types/domain'
import type { IntelAction } from '../app/types/intelligence'
import { addMonths, generateInsightDraft, type EngineData } from '../app/utils/insight-engine'

const TODAY = '2026-08-20'

function emptyData(): EngineData {
  return {
    daily: [], weekly: [], monthly: [], support: [], sales: [], partner: [],
    customerLogs: [], salesMonthly: [], companies: [], projects: [], members: [],
  }
}

function company(id: string, name: string): Company {
  return {
    id, kind: 'customer', name, aliases: [], industryIds: [], primaryIndustryId: null,
    size: '', location: '', description: '', ownerMemberId: null, fiscalStartMonth: null,
    active: true, custom: {},
  } as Company
}

function project(id: string, name: string): Project {
  return {
    id, name, companyId: 'c-01', type: 'development', status: 'active', priority: 'mid',
    ownerMemberId: 'm-01', memberIds: ['m-01'], startDate: '2026-01-01', endDate: '2026-12-31',
    budget: 1000000, objective: '', active: true, custom: {},
  } as Project
}

function salesActivity(partial: Partial<SalesActivity> & { id: string }): SalesActivity {
  return {
    memberId: 'm-03', companyId: 'c-01', title: '商談', dealType: '新規', staffMemberId: 'm-03',
    phase: '提案', amount: 1_000_000, probability: 50, expectedCloseDate: null,
    customerIssue: '', proposal: '', nextAction: '', nextActionDate: null,
    createdAt: '2026-08-01T10:00:00+09:00', active: true,
    ...partial,
  } as SalesActivity
}

function supportActivity(partial: Partial<SupportActivity> & { id: string }): SupportActivity {
  return {
    memberId: 'm-03', receivedDate: '2026-08-05', receivedTime: null, companyId: 'c-01',
    inquirerName: '', targetSystem: '', category: '操作', title: '問い合わせ', body: '',
    priority: '通常', status: '未対応', staffMemberId: 'm-03', response: '', cause: '',
    resolution: '', completedDate: null, completedTime: null, knowledgeNote: '',
    createdAt: '2026-08-05T10:00:00+09:00', active: true,
    ...partial,
  } as SupportActivity
}

function customerLog(partial: Partial<CustomerLog> & { id: string }): CustomerLog {
  return {
    memberId: 'm-03', logDate: '2026-08-10', logTime: null, endTime: null, companyId: 'c-01',
    contactId: null, staffMemberId: 'm-03', tags: ['定例'], method: '訪問', title: '', body: 'メモ',
    createdAt: '2026-08-10T10:00:00+09:00', active: true,
    ...partial,
  } as CustomerLog
}

function dailyReport(partial: Partial<DailyReport> & { id: string; date: string }): DailyReport {
  return {
    authorKind: 'human', memberId: 'm-03', aiEmployeeId: null,
    entries: [], reflection: '', issues: '', tomorrow: '', status: 'submitted',
    submittedAt: `${partial.date}T18:00:00+09:00`,
    ...partial,
  } as DailyReport
}

function action(partial: Partial<IntelAction> & { id: string }): IntelAction {
  return {
    insightId: null, proposalId: null, theme: 'management', targetId: null, targetName: '全社',
    title: 'アクション', description: '', status: 'done', dueDate: null, ownerId: 'm-03',
    result: '', feedbackRating: null, feedbackNote: '', feedbackNext: '',
    createdAt: '2026-08-01T10:00:00+09:00', updatedAt: '2026-08-01T10:00:00+09:00', active: true,
    ...partial,
  }
}

describe('addMonths', () => {
  it('年跨ぎを含む月演算ができる', () => {
    expect(addMonths('2026-08', -1)).toBe('2026-07')
    expect(addMonths('2026-01', -2)).toBe('2025-11')
    expect(addMonths('2025-12', 1)).toBe('2026-01')
  })
})

describe('generateInsightDraft: 経営テーマ', () => {
  it('データが無い場合は AKI-INS-001 を返す', () => {
    const res = generateInsightDraft(emptyData(), { theme: 'management', targetId: null, today: TODAY, pastActions: [] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('AKI-INS-001')
  })

  it('停滞商談（Next Action 未設定・期限超過）を検出して提案する', () => {
    const data = emptyData()
    data.sales = [
      salesActivity({ id: 's1', phase: '提案', nextActionDate: null }),
      salesActivity({ id: 's2', phase: '見積', nextActionDate: '2026-08-01' }),
      salesActivity({ id: 's3', phase: '受注', nextActionDate: null }),
      salesActivity({ id: 's4', phase: 'ヒアリング', nextActionDate: '2026-09-01' }),
    ]
    const res = generateInsightDraft(data, { theme: 'management', targetId: null, today: TODAY, pastActions: [] })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.findings.some(f => f.includes('3 件') && f.includes('2 件'))).toBe(true)
      expect(res.proposals.some(p => p.title === '停滞商談の Next Action 再設定')).toBe(true)
    }
  })

  it('決定的（同じ入力 → 同じ出力）', () => {
    const data = emptyData()
    data.sales = [salesActivity({ id: 's1' })]
    data.support = [supportActivity({ id: 'p1' })]
    const opts = { theme: 'management' as const, targetId: null, today: TODAY, pastActions: [] }
    expect(generateInsightDraft(data, opts)).toEqual(generateInsightDraft(data, opts))
  })
})

describe('generateInsightDraft: 顧客テーマ', () => {
  it('30 日以上接点がない顧客にフォローアップを提案する', () => {
    const data = emptyData()
    data.companies = [company('c-07', 'シーサイドホテルズ')]
    data.customerLogs = [customerLog({ id: 'l1', companyId: 'c-07', logDate: '2026-07-01' })]
    const res = generateInsightDraft(data, { theme: 'customer', targetId: 'c-07', today: TODAY, pastActions: [] })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.targetName).toBe('シーサイドホテルズ')
      expect(res.proposals.some(p => p.title.includes('フォローアップ'))).toBe(true)
    }
  })

  it('対象顧客が見つからない場合は AKI-INS-002', () => {
    const res = generateInsightDraft(emptyData(), { theme: 'customer', targetId: 'c-99', today: TODAY, pastActions: [] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('AKI-INS-002')
  })
})

describe('generateInsightDraft: 案件テーマ', () => {
  it('日報エントリから工数・進捗を集計する', () => {
    const data = emptyData()
    data.projects = [project('pj-01', 'SCM 導入')]
    data.daily = [
      dailyReport({ id: 'd1', date: '2026-08-10', entries: [{ theme: '開発', projectId: 'pj-01', task: 't', hours: 4, progress: 60 }] }),
      dailyReport({ id: 'd2', date: '2026-08-11', entries: [{ theme: '開発', projectId: 'pj-01', task: 't', hours: 2.5, progress: 70 }] }),
      dailyReport({ id: 'd3', date: '2026-08-12', entries: [{ theme: '別件', projectId: 'pj-99', task: 't', hours: 8, progress: 10 }] }),
    ]
    const res = generateInsightDraft(data, { theme: 'project', targetId: 'pj-01', today: TODAY, pastActions: [] })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.findings[0]).toContain('6.5h')
      expect(res.findings.some(f => f.includes('65%'))).toBe(true)
    }
  })
})

describe('フィードバックループ（FI-05）', () => {
  function baseData(): EngineData {
    const data = emptyData()
    data.sales = [salesActivity({ id: 's1', phase: '提案', nextActionDate: null })]
    return data
  }

  it('done + 高評価（4-5）→ 継続・横展開の提案（reinforce）', () => {
    const past = [action({ id: 'a1', title: '営業定例の週次化', status: 'done', feedbackRating: 5, feedbackNote: '停滞が減った' })]
    const res = generateInsightDraft(baseData(), { theme: 'management', targetId: null, today: TODAY, pastActions: past })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.feedbackConsidered).toEqual([{ actionId: 'a1', title: '営業定例の週次化', rating: 5, effect: 'reinforce' }])
      expect(res.proposals.some(p => p.title === '「営業定例の週次化」の継続・横展開')).toBe(true)
    }
  })

  it('done + 低評価（1-2）→ 代替アプローチの提案（alternative）', () => {
    const past = [action({ id: 'a2', title: '営業定例の週次化', status: 'done', feedbackRating: 2, feedbackNext: '非同期共有へ' })]
    const res = generateInsightDraft(baseData(), { theme: 'management', targetId: null, today: TODAY, pastActions: past })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.feedbackConsidered[0]!.effect).toBe('alternative')
      expect(res.proposals.some(p => p.title === '「営業定例の週次化」に代わるアプローチの検討')).toBe(true)
    }
  })

  it('実行中のアクション → 同種の提案を抑制（dedupe）', () => {
    // baseData は「停滞商談の Next Action 再設定」を提案する状態
    const past = [action({ id: 'a3', title: '停滞商談の Next Action 再設定', status: 'in_progress' })]
    const res = generateInsightDraft(baseData(), { theme: 'management', targetId: null, today: TODAY, pastActions: past })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.feedbackConsidered[0]!.effect).toBe('dedupe')
      expect(res.proposals.some(p => p.title === '停滞商談の Next Action 再設定')).toBe(false)
    }
  })

  it('別テーマ・別対象のアクションは反映しない', () => {
    const past = [action({ id: 'a4', theme: 'customer', targetId: 'c-01', status: 'done', feedbackRating: 5 })]
    const res = generateInsightDraft(baseData(), { theme: 'management', targetId: null, today: TODAY, pastActions: past })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.feedbackConsidered).toEqual([])
  })
})
