/**
 * 中核マスタのシードデータ（決定的・固定値。AKEBONO Office の core.ts から本アプリで使う分を抜粋）
 * メンバーは Office のデモメンバーと同一（同じ世界観のデモにするため）。
 */
import type { AiEmployee, AiRole, EscalationRule, Member } from '~/types/domain'

export const seedMembers: Member[] = [
  { id: 'm-01', name: '山下 誠', email: 'yamashita@tsunaguba.co.jp', employmentType: 'director', departmentId: 'dp-01', title: '代表取締役', role: 'admin', hireDate: '2018-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: false, googleCalendarConnected: true, attendanceRuleId: null, birthDate: '1980-06-15', active: true, custom: {} },
  { id: 'm-02', name: '佐伯 玲子', email: 'saeki@tsunaguba.co.jp', employmentType: 'director', departmentId: 'dp-01', title: '取締役', role: 'admin', hireDate: '2018-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: false, googleCalendarConnected: true, attendanceRuleId: null, birthDate: '1983-11-02', active: true, custom: {} },
  { id: 'm-03', name: '葛西 大輔', email: 'kasai@tsunaguba.co.jp', employmentType: 'employee', departmentId: 'dp-02', title: 'マネージャー', role: 'admin', hireDate: '2019-07-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, googleCalendarConnected: false, attendanceRuleId: null, birthDate: '1987-03-21', active: true, custom: {} },
  { id: 'm-04', name: '三浦 彩', email: 'miura@tsunaguba.co.jp', employmentType: 'employee', departmentId: 'dp-02', title: 'リーダー', role: 'member', hireDate: '2020-04-01', weeklyDays: 5, weeklyHours: 30, punchRequired: true, googleCalendarConnected: true, attendanceRuleId: 'ar-04', birthDate: '1991-08-09', active: true, custom: {} },
  { id: 'm-05', name: '小野寺 岳', email: 'onodera@tsunaguba.co.jp', employmentType: 'employee', departmentId: 'dp-04', title: 'リーダー', role: 'member', hireDate: '2020-10-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, googleCalendarConnected: true, attendanceRuleId: null, birthDate: '1990-01-30', active: true, custom: {} },
  { id: 'm-06', name: '澤村 拓海', email: 'sawamura@tsunaguba.co.jp', employmentType: 'employee', departmentId: 'dp-04', title: 'メンバー', role: 'member', hireDate: '2022-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, googleCalendarConnected: true, attendanceRuleId: null, birthDate: '1996-12-05', active: true, custom: {} },
  { id: 'm-07', name: '井関 美咲', email: 'iseki@tsunaguba.co.jp', employmentType: 'employee', departmentId: 'dp-05', title: 'メンバー', role: 'member', hireDate: '2023-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, googleCalendarConnected: true, attendanceRuleId: null, birthDate: '1998-05-18', active: true, custom: {} },
  { id: 'm-08', name: '玉井 蓮', email: 'tamai@tsunaguba.co.jp', employmentType: 'employee', departmentId: 'dp-05', title: 'メンバー', role: 'member', hireDate: '2024-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, googleCalendarConnected: true, attendanceRuleId: null, birthDate: '2000-02-27', active: true, custom: {} },
  { id: 'm-09', name: '深田 遥', email: 'fukada@tsunaguba.co.jp', employmentType: 'contract', departmentId: 'dp-04', title: 'メンバー', role: 'member', hireDate: '2024-01-01', weeklyDays: 5, weeklyHours: 37.5, punchRequired: true, googleCalendarConnected: true, attendanceRuleId: null, birthDate: '1993-09-14', active: true, custom: {} },
  { id: 'm-10', name: '村瀬 光', email: 'murase@tsunaguba.co.jp', employmentType: 'parttime', departmentId: 'dp-01', title: '人事・労務', role: 'hr', hireDate: '2024-09-01', weeklyDays: 3, weeklyHours: 18, punchRequired: true, googleCalendarConnected: true, attendanceRuleId: null, birthDate: '2003-04-22', active: true, custom: {} },
  { id: 'm-11', name: '有田 望', email: 'arita@tsunaguba.co.jp', employmentType: 'parttime', departmentId: 'dp-05', title: 'アシスタント', role: 'member', hireDate: '2025-11-01', weeklyDays: 2, weeklyHours: 12, punchRequired: true, googleCalendarConnected: true, attendanceRuleId: null, birthDate: '2008-10-03', active: true, custom: {} },
  { id: 'm-12', name: '外川 亘', email: 'togawa@partner.example.com', employmentType: 'outsource', departmentId: 'dp-04', title: 'パートナー', role: 'member', hireDate: '2025-05-01', weeklyDays: 5, weeklyHours: 40, punchRequired: false, googleCalendarConnected: true, attendanceRuleId: null, birthDate: '1985-07-07', active: true, custom: {} },
]


export const seedAiRoles: AiRole[] = [
  { id: 'r-01', name: 'リサーチャー', mission: '業界・競合・技術動向の調査と要約', systemPrompt: 'あなたは調査専門の AI 社員です。一次情報を優先し、出典を必ず示してください。', permissions: ['knowledge:read', 'web:search'], modelTier: 'standard', active: true },
  { id: 'r-02', name: 'ドキュメンター', mission: '議事録・提案書ドラフト・ナレッジ整備', systemPrompt: 'あなたは文書作成専門の AI 社員です。社内テンプレートに従い、簡潔に書いてください。', permissions: ['knowledge:read', 'knowledge:write', 'documents:write'], modelTier: 'standard', active: true },
  { id: 'r-03', name: 'データアナリスト', mission: '業務データ・スタースキーマの分析と示唆出し', systemPrompt: 'あなたはデータ分析専門の AI 社員です。半加法メジャーの時間軸集計に注意してください。', permissions: ['mart:read', 'knowledge:read'], modelTier: 'pro', active: true },
  { id: 'r-04', name: 'QA サポート', mission: '社内からの質問対応と一次切り分け', systemPrompt: 'あなたは社内サポートの AI 社員です。わからないことは推測せずエスカレーションしてください。', permissions: ['knowledge:read', 'masters:read'], modelTier: 'lite', active: true },
]

export const seedAiEmployees: AiEmployee[] = [
  { id: 'ai-01', name: 'アキ', roleId: 'r-01', status: 'working', deskPosition: { x: 1, y: 1 }, active: true },
  { id: 'ai-02', name: 'ハル', roleId: 'r-02', status: 'idle', deskPosition: { x: 2, y: 1 }, active: true },
  { id: 'ai-03', name: 'ソラ', roleId: 'r-03', status: 'working', deskPosition: { x: 1, y: 2 }, active: true },
  { id: 'ai-04', name: 'レン', roleId: 'r-04', status: 'waiting_approval', deskPosition: { x: 2, y: 2 }, active: true },
  { id: 'ai-05', name: 'ユキ', roleId: 'r-02', status: 'idle', deskPosition: { x: 3, y: 1 }, active: true },
]

export const seedEscalationRules: EscalationRule[] = [
  { key: 'issue_reported', label: '日報の課題記入', enabled: true, threshold: null, thresholdLabel: null, cooldownDays: 3 },
  { key: 'stalled_task', label: 'タスク停滞', enabled: true, threshold: 3, thresholdLabel: '停滞日数', cooldownDays: 7 },
  { key: 'overload', label: '過負荷', enabled: true, threshold: 7, thresholdLabel: '保有タスク数', cooldownDays: 7 },
  { key: 'low_confidence', label: 'AI 確信度低', enabled: true, threshold: null, thresholdLabel: null, cooldownDays: 1 },
  { key: 'overtime_alert', label: '残業アラート', enabled: true, threshold: 36, thresholdLabel: '月間時間外(h)', cooldownDays: 7 },
]
