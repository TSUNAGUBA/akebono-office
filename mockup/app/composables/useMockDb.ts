/**
 * モックデータの中核ストア（SoT）
 * - 初期値は決定的シード。ユーザー操作による変更のみ localStorage に永続化。
 * - 「デモデータをリセット」でシード状態へ戻せる（記録系も含めて初期化 = デモ専用操作）。
 * - 各業務 composable は必ずここを経由して読み書きする（SoT → 派生の一方向）。
 */
import type { Ref } from 'vue'
import { buildSeed, type MockDbShape } from '~/data/seed'

const STORAGE_KEY = 'ako.mockdb.v1'
/** シード世代。シード構造を変えたらインクリメントすると保存済みデータを破棄して再生成する */
const SEED_VERSION = 1

interface PersistedDb {
  version: number
  /** 生成日（日付が変わったら履歴系の鮮度のため再シードする） */
  seededOn: string
  data: MockDbShape
}

function todayKey(): string {
  return todayJst()
}

function load(): MockDbShape {
  if (import.meta.client) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedDb
        if (parsed.version === SEED_VERSION && parsed.seededOn === todayKey() && parsed.data) {
          return parsed.data
        }
      }
    } catch {
      // 壊れた保存データは捨ててシードから再生成（非ブロッキング）
    }
  }
  return buildSeed()
}

export function useMockDb() {
  const db = useState<MockDbShape>('ako-db', () => load())

  function persist(): void {
    if (!import.meta.client) return
    try {
      const payload: PersistedDb = { version: SEED_VERSION, seededOn: todayKey(), data: db.value }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // 容量超過等は無視（モックのため非致命）
    }
  }

  /** 型付きコレクション参照。変更後は commit() を呼ぶ */
  function tbl<K extends keyof MockDbShape>(name: K): Ref<MockDbShape[K]> {
    return computed({
      get: () => db.value[name],
      set: (v) => { db.value[name] = v },
    }) as Ref<MockDbShape[K]>
  }

  /** 変更を永続化する（書込系操作の最後に必ず呼ぶ） */
  function commit(): void {
    persist()
  }

  /** prefix-#### 形式の次 ID を採番する */
  function nextId(name: keyof MockDbShape, prefix: string): string {
    const rows = db.value[name] as { id?: string }[]
    let max = 0
    for (const r of rows) {
      const id = r.id ?? ''
      if (id.startsWith(prefix)) {
        const n = Number(id.slice(prefix.length).replace(/^-/, ''))
        if (Number.isFinite(n) && n > max) max = n
      }
    }
    return `${prefix}-${String(max + 1).padStart(4, '0')}`
  }

  /** デモデータをシード状態へ戻す（設定画面からのみ呼ぶ） */
  function resetDemo(): void {
    db.value = buildSeed()
    if (import.meta.client) {
      try { localStorage.removeItem(STORAGE_KEY) } catch { /* noop */ }
    }
  }

  return { db, tbl, commit, nextId, resetDemo }
}
