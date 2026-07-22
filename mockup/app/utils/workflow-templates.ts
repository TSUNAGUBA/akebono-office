/**
 * 稟議「内容」のテンプレート（オペレーター指示 2026-07-22。SoT = 本ファイル）。
 * 新規申請フォームで稟議の種類（WorkflowCategory）に応じて呼び出し、「内容」欄へ挿入する。
 * 全区分共通の標準構成 + 区分別の定型構成を提供する（文面はマークダウン見出し + 箇条書き）
 */
import type { WorkflowCategory } from '~/types/domain'

export interface WorkflowContentTemplate {
  key: string
  label: string
  body: string
}

/** 全区分で使える標準テンプレート（現状と課題 → 効果 → 緊急度） */
const STANDARD_TEMPLATE: WorkflowContentTemplate = {
  key: 'standard',
  label: '標準（現状と課題・理由・効果）',
  body: [
    '# 現状と課題',
    '・',
    '',
    '# 実施する理由',
    '・',
    '',
    '# 実施しない場合の影響',
    '・',
    '',
    '# 期待する効果',
    '・',
    '',
    '# 緊急度・優先度',
    '・',
  ].join('\n'),
}

/** 区分別テンプレート（標準に加えて選択できる） */
const CATEGORY_TEMPLATES: Record<WorkflowCategory, WorkflowContentTemplate[]> = {
  purchase: [{
    key: 'purchase',
    label: '購買（品目・見積・選定理由）',
    body: [
      '# 購入品と数量',
      '・',
      '',
      '# 見積・比較（相見積があれば記載）',
      '・',
      '',
      '# 選定理由',
      '・',
      '',
      '# 期待する効果',
      '・',
    ].join('\n'),
  }],
  contract: [{
    key: 'contract',
    label: '契約（契約先・期間・条件）',
    body: [
      '# 契約先と契約内容',
      '・',
      '',
      '# 契約期間・金額条件',
      '・',
      '',
      '# 契約しない場合の影響',
      '・',
      '',
      '# リスクと対応',
      '・',
    ].join('\n'),
  }],
  expense: [{
    key: 'expense',
    label: '経費（内訳・必要性）',
    body: [
      '# 経費の内訳',
      '・',
      '',
      '# 必要性・背景',
      '・',
      '',
      '# 期待する効果',
      '・',
    ].join('\n'),
  }],
  hiring: [{
    key: 'hiring',
    label: '採用（職種・人数・背景）',
    body: [
      '# 募集職種・人数',
      '・',
      '',
      '# 採用の背景（現状と課題）',
      '・',
      '',
      '# 採用しない場合の影響',
      '・',
      '',
      '# 期待する効果',
      '・',
    ].join('\n'),
  }],
  trip: [{
    key: 'trip',
    label: '出張（目的地・行程・概算費用）',
    body: [
      '# 目的地・期間',
      '・',
      '',
      '# 行程・訪問先',
      '・',
      '',
      '# 概算費用（交通・宿泊）',
      '・',
      '',
      '# 期待する成果',
      '・',
    ].join('\n'),
  }],
  other: [],
}

/** 区分に応じて選択できるテンプレート一覧（区分別 + 標準） */
export function workflowTemplatesFor(category: WorkflowCategory): WorkflowContentTemplate[] {
  return [...(CATEGORY_TEMPLATES[category] ?? []), STANDARD_TEMPLATE]
}
