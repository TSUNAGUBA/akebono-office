/**
 * コンボボックス自由入力からの事業区分（Village）解決（モックモード用 = 原則3。改修依頼 2026-08-19 第4弾）。
 * API モードはサーバー側 lib/village-resolve が同一規則（正規化名の完全一致 → なければ新規登録）で解決する。
 * 「照合（lookup）」と「作成（create）」を分けるのは、後続検証の失敗時に孤児マスタを残さないため（原子性）。
 * 事業区分は任意項目のため、id も新規名も空なら null（未設定）を返す。
 */
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import type { Village } from '~/types/domain'

const VILLAGE_NAME_CAP = 120

/** 照合用の正規化（trim + 小文字化 + 連続空白の圧縮。API lib/village-resolve と同一規則） */
function normalizeVillageName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function useVillageResolve() {
  const { tbl, nextId } = useMockDb()
  const villagesTbl = tbl('villages')

  /** 事業区分の照合（作成なし）。id 指定はそのまま・自由入力名は正規化名の完全一致で照合。空 = null（未設定） */
  function lookupVillage(villageId: string, newVillageName: string): string | null {
    if (villageId) return villageId
    const name = capCp(newVillageName.trim(), VILLAGE_NAME_CAP)
    if (!name) return null
    const norm = normalizeVillageName(name)
    const hit = (villagesTbl.value as Village[]).find(v => v.active && normalizeVillageName(v.name) === norm)
    return hit?.id ?? null
  }

  /** 事業区分のマスタ新規登録（全検証通過後にのみ呼ぶ。commit は呼び出し側の書込とまとめて行う）。空名は作成しない = null */
  function createVillage(newVillageName: string): string | null {
    const name = capCp(newVillageName.trim(), VILLAGE_NAME_CAP)
    if (!name) return null
    const id = nextId('villages', 'vil')
    const maxOrder = Math.max(0, ...(villagesTbl.value as Village[]).map(v => v.displayOrder))
    villagesTbl.value = [...(villagesTbl.value as Village[]), {
      id, name, displayOrder: maxOrder + 1, active: true,
    } satisfies Village]
    return id
  }

  /** id 指定 → そのまま / 自由入力名 → 照合 or 新規作成 / 空 → null（未設定）。書込直前に 1 回だけ呼ぶ */
  function resolveVillage(villageId: string, newVillageName: string): string | null {
    return lookupVillage(villageId, newVillageName) ?? createVillage(newVillageName)
  }

  return { lookupVillage, createVillage, resolveVillage }
}
