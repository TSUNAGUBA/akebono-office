/**
 * コンボボックス自由入力からの顧客担当者(人)解決（モックモード用 = 原則3。useCustomerLogs から抽出）。
 * 顧客活動 / 営業活動 / パートナー活動で共用（改修依頼 2026-08-19 第4弾）。
 * API モードはサーバー側 lib/contact-resolve が同一規則で解決する。エラーコードの名前空間は呼び出し側が渡す。
 */
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import type { Contact } from '~/types/domain'

const CONTACT_NAME_CAP = 120

function normContactName(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

export function useContactResolve() {
  const { tbl, nextId } = useMockDb()
  const contactsTbl = tbl('contacts')

  /**
   * 担当者が選択会社に属するか（モック検証。API assertContactBelongs と同順: 存在 → 所属）。
   * companyId = null（新規会社 = 照合なし）は既存担当者が所属し得ないため所属エラー。errCode は名前空間（例 AKO-SAL）
   */
  function contactError(contactId: string | null, companyId: string | null, errCode: string): { code: string; message: string } | null {
    if (!contactId) return null
    const c = (contactsTbl.value as Contact[]).find(x => x.id === contactId)
    if (!c) return { code: `${errCode}-003`, message: '指定した顧客担当者が見つかりません' }
    if (c.companyId !== companyId) return { code: `${errCode}-003`, message: '顧客担当者は選択した会社に所属している必要があります' }
    return null
  }

  /** 顧客担当者(人)の解決（モック）。同一会社内の氏名一致 → なければ新規登録。空 = null（未設定） */
  function resolveContactMock(companyId: string, contactId: string | null, newContactName: string): string | null {
    if (contactId) return contactId
    const name = capCp(newContactName.trim(), CONTACT_NAME_CAP)
    if (!name) return null
    const contacts = contactsTbl.value as Contact[]
    const hit = contacts.find(c => c.active && c.companyId === companyId && normContactName(c.name) === normContactName(name))
    if (hit) return hit.id
    const id = nextId('contacts', 'p')
    contactsTbl.value = [...contacts, {
      id, companyId, name, dept: '', title: '', keyPerson: 1, email: '', phone: '', notes: '', active: true, custom: {},
    } satisfies Contact]
    return id
  }

  return { contactError, resolveContactMock }
}
