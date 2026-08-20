/**
 * AKEBONO Company モック DB の形と決定的シード（デモ・体感検証用）。
 * API モードでは members / aiRoles / aiEmployees は API ハイドレーション、
 * aiTasks / aiActivityLogs / dailyReports は /v1/ai-company・/v1/reports が SoT となり、
 * ここは完全モック動作（NUXT_PUBLIC_API_BASE 未設定）のときのみ使われる。
 */
import type {
  AiActivityLog, AiEmployee, AiRole, AiTask, AppNotification, AuditLog,
  DailyReport, Escalation, EscalationRule, Member,
} from '~/types/domain'
import {
  seedAiEmployees, seedAiRoles, seedEscalationRules, seedMembers,
} from './core'
import { seedAiActivityLogs, seedAiTasks, seedEscalations, seedNotifications } from './ai-company'

export interface MockDbShape {
  members: Member[]
  aiRoles: AiRole[]
  aiEmployees: AiEmployee[]
  aiTasks: AiTask[]
  aiActivityLogs: AiActivityLog[]
  dailyReports: DailyReport[]
  notifications: AppNotification[]
  escalations: Escalation[]
  escalationRules: EscalationRule[]
  auditLogs: AuditLog[]
}

export function buildSeed(): MockDbShape {
  return {
    members: seedMembers,
    aiRoles: seedAiRoles,
    aiEmployees: seedAiEmployees,
    aiTasks: seedAiTasks,
    aiActivityLogs: seedAiActivityLogs,
    dailyReports: [],
    notifications: seedNotifications,
    escalations: seedEscalations,
    escalationRules: seedEscalationRules,
    auditLogs: [],
  }
}
