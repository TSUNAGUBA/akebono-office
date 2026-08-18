/**
 * コンボボックス自由入力からの顧客(会社)解決（モックモード用。useCustomerLogs から抽出した共通実装 = 原則3。
 * 顧客活動 / サポート活動 / 営業活動で共用。改修依頼 2026-08-18）。
 * API モードはサーバー側 lib/company-resolve が同一規則（正規化名の完全一致 → なければ新規登録）で解決する。
 * 「照合（lookup）」と「作成（create）」を分けるのは、後続検証の失敗時に孤児マスタを残さないため（原子性）。
 */
import { capCodePoints as capCp, CUSTOMER_LOG_NAME_CAP as NAME_CAP } from '../../../shared/domain/customer-log'
import { normalizeCompanyName } from '../../../shared/domain/name-match'
import type { Company } from '~/types/domain'

export function useCompanyResolve() {
  const { tbl, nextId } = useMockDb()
  const companiesTbl = tbl('companies')

  /**
   * 顧客(会社)の照合（作成なし）。id 指定はそのまま・自由入力名は正規化名
   * （法人格・空白ゆらぎ除去）の完全一致で既存の顧客(会社)へ照合する（API resolveCompany と同一規則）。
   */
  function lookupCompany(companyId: string, newCompanyName: string): string | null {
    if (companyId) return companyId
    const norm = normalizeCompanyName(capCp(newCompanyName.trim(), NAME_CAP))
    const hit = (companiesTbl.value as Company[]).find(c => c.active && c.kind === 'customer'
      && [c.name, ...(c.aliases ?? [])].some(n => n && normalizeCompanyName(String(n)) === norm))
    return hit?.id ?? null
  }

  /** 顧客(会社)のマスタ新規登録（全検証通過後にのみ呼ぶ。commit は呼び出し側の書込とまとめて行う） */
  function createCompany(newCompanyName: string): string {
    const id = nextId('companies', 'c')
    companiesTbl.value = [...(companiesTbl.value as Company[]), {
      id,
      kind: 'customer',
      name: capCp(newCompanyName.trim(), NAME_CAP),
      aliases: [],
      industryIds: [],
      primaryIndustryId: null,
      size: '',
      location: '',
      description: '',
      ownerMemberId: null,
      fiscalStartMonth: null,
      active: true,
      custom: {},
    } satisfies Company]
    return id
  }

  return { lookupCompany, createCompany }
}
