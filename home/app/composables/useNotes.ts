/**
 * ノート（ぽいぽいポスト / 議事録。バッチ7c/7e）
 * - poipoi = ぽいぽいポスト（本人 + 管理者閲覧 = C3 + フィードバック用途。AI の参照は本人のみのまま）/
 *   minutes = 議事録（全員参照 = C2）。記録系 = 追記 + 取消/復元（論理削除）
 * - プロジェクト・顧客・業務種別は任意の紐付け
 * - デュアルモード: API = /v1/notes（SoT。AI 検索インデックスへ自動反映）/ モック = notes コレクション
 * - アップロード（.md/.txt/.pdf/.docx）は API モードのみ（抽出はサーバー。モックは .md/.txt をクライアント読取）
 */
import type { Member, Note, NoteKind, NoteOrigin, Result } from '~/types/domain'
import type { NotifyRecipientTarget } from '~/utils/notify-recipients'
import { addedNotifyRecipientIds, parseNotifyRecipients, resolveNotifyRecipientIds } from '~/utils/notify-recipients'

const apiNotes = ref<Record<string, Note[]>>({})

function loadNotes(kind: NoteKind, force = false): Promise<void> {
  return apiLoadOnce(`notes:${kind}`, async () => {
    // 取消済みも取得して復元 UI に使う（取消済みの可視範囲はサーバーが復元権限者へ絞る）
    const rows = await apiFetch<Note[]>('/v1/notes', { query: { kind, includeArchived: '1' } })
    apiNotes.value = { ...apiNotes.value, [kind]: rows }
  }, force)
}

// 管理者の全ポスト閲覧（バッチ7e。scope=all はサーバーが管理者権限を検証）
const apiAdminPosts = ref<Note[]>([])

function loadAdminPosts(force = false): Promise<void> {
  return apiLoadOnce('notes:poipoi:all', async () => {
    apiAdminPosts.value = await apiFetch<Note[]>('/v1/notes', { query: { kind: 'poipoi', scope: 'all' } })
  }, force)
}

onApiReset(() => {
  apiNotes.value = {}
  apiAdminPosts.value = []
})

export interface NoteInput {
  kind: NoteKind
  title: string
  body: string
  projectId: string | null
  companyId: string | null
  workCategoryId: string | null
  /** 登録経路（poipoi のみ。改善要望 2026-08-21）。'report' = 日報提出時 / 未指定 = 'direct'（直接投稿） */
  origin?: NoteOrigin
  /** 議事録の Google Meet 連携（AI メモ/録画の Drive 参照。API モードのみ設定される。2026-08-03 ③b） */
  meetFileId?: string | null
  meetFileName?: string | null
  meetWebLink?: string | null
}

export function useNotes(kind: NoteKind) {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser, isAdmin } = useCurrentUser()
  const isApi = useApiMode()
  const appSettings = useAppSettings()
  const notifications = useNotifications()
  const mockNotes = tbl('notes')

  /** テナント既定の通知先（configs 'poipoi-notify-recipients'）。壊れは空扱い（原則4） */
  function tenantPoipoiTargets(): NotifyRecipientTarget[] {
    return parseNotifyRecipients(appSettings.getConfig('poipoi-notify-recipients', ''))
  }

  /**
   * ぽいぽいポスト登録・通知先編集時に、宛先へ原文を通知する（mock のみ）。
   * 宛先 = ポスト単位の上書き（targetsOverride）> テナント設定（'poipoi-notify-recipients'）。
   * 「ロール/役職/個人」指定を解決した在籍メンバー（投稿者本人は除外）。非ブロッキング（原則4）。
   * API モードはサーバー（POST /v1/notes・PUT /v1/notes/:id/notify-targets）が発火するため呼ばない。
   * onlyMemberIds 指定時はその id のみへ配信（通知先編集の追加分だけへ届ける = 重複通知の防止・原則2）。
   */
  function firePoipoiNotify(
    body: string, noteId: string,
    targetsOverride?: NotifyRecipientTarget[] | null, onlyMemberIds?: string[],
    author?: { id: string; name: string },
  ): void {
    try {
      const poster = author ?? { id: currentUser.value.id, name: currentUser.value.name }
      const targets = targetsOverride ?? tenantPoipoiTargets()
      if (targets.length === 0) return
      const members = tbl('members').value as Member[]
      let recipientIds = resolveNotifyRecipientIds(targets, members, poster.id)
      if (onlyMemberIds) recipientIds = recipientIds.filter(id => onlyMemberIds.includes(id))
      if (recipientIds.length === 0) return
      const title = `新しい改善のタネ（${poster.name}）`
      const preview = [...body].slice(0, 140).join('')
      // リンクは対象ポストの詳細モーダルへのディープリンク（改修依頼 2026-08-18）。
      // 他人のポスト詳細を開けるのは管理者のみ（/poipoi の参照モデル）のため、
      // 閲覧権限の無い受信者には従来どおり一覧リンクを送る（開けないリンクを配らない = レビュー R8。API と同一）
      const roleById = new Map(members.map(m => [m.id, m.role]))
      for (const mid of recipientIds) {
        const link = roleById.get(mid) === 'admin' ? `/poipoi?open=${noteId}` : '/poipoi'
        notifications.notify(mid, 'poipoi', title, preview, link)
      }
    } catch {
      // 補助処理: 通知失敗は主フロー（ポスト登録）を止めない（原則4）
    }
  }
  if (isApi) {
    void loadNotes(kind)
    // 管理者のみ全ポスト一覧を取得（非管理者は 403 になるため呼ばない）
    if (kind === 'poipoi' && isAdmin.value) void loadAdminPosts()
  }

  /** 取消・復元の権限（poipoi = 本人のみ / minutes = 登録者 or 管理者） */
  function canUndo(n: Note): boolean {
    return n.memberId === currentUser.value.id || (n.kind === 'minutes' && isAdmin.value)
  }

  /** 一覧（新しい順。poipoi は本人のみ） */
  const list = computed<Note[]>(() => {
    if (isApi) return (apiNotes.value[kind] ?? []).filter(n => n.active !== false)
    return (mockNotes.value as Note[])
      .filter(n => n.kind === kind && n.active !== false
        && (kind === 'minutes' || n.memberId === currentUser.value.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })

  /** 管理者の全ポスト一覧（kind='poipoi' + 管理者のみ。フィードバック・チーム改善のオリジナル閲覧用。
   *  自分のポストは通常一覧（list）に出るため除外 = 二重表示を避ける） */
  const adminList = computed<Note[]>(() => {
    if (kind !== 'poipoi' || !isAdmin.value) return []
    if (isApi) return apiAdminPosts.value.filter(n => n.memberId !== currentUser.value.id)
    return (mockNotes.value as Note[])
      .filter(n => n.kind === 'poipoi' && n.active !== false && n.memberId !== currentUser.value.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })

  /** 取消済み一覧（復元 UI 用。復元権限のあるものだけ = poipoi 本人 / minutes 登録者 or 管理者） */
  const archived = computed<Note[]>(() => {
    if (isApi) return (apiNotes.value[kind] ?? []).filter(n => n.active === false && canUndo(n))
    return (mockNotes.value as Note[])
      .filter(n => n.kind === kind && n.active === false && canUndo(n))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })

  /**
   * テキスト登録。opts.notifyPoipoi=false のときは poipoi 通知を発火しない
   * （ドキュメント取込は「入力原文」ではないため通知対象外 = API の /import と挙動を揃える。§54 レビュー MINOR-2）。
   */
  async function add(input: Omit<NoteInput, 'kind'>, opts?: { notifyPoipoi?: boolean }): Promise<Result> {
    const body = input.body.trim()
    if (!body) return { ok: false, error: { code: 'AKO-GEN-001', message: '本文を入力してください' } }
    if (isApi) {
      const res = await apiResult(() => apiFetch('/v1/notes', { method: 'POST', body: { ...input, kind } }))
      if (res.ok) await refresh() // 管理者の全ポスト一覧も同時に反映
      return res
    }
    const id = nextId('notes', 'nt')
    mockNotes.value = [...(mockNotes.value as Note[]), {
      id,
      memberId: currentUser.value.id,
      kind,
      title: input.title.trim() || ([...body.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).filter(Boolean)][0] ?? 'ノート').slice(0, 40),
      body,
      projectId: input.projectId,
      companyId: input.companyId,
      workCategoryId: input.workCategoryId,
      source: 'text',
      createdAt: nowJstIso(),
      // 登録経路（poipoi のみ。'report' 明示以外は直接投稿 = API の originOf と同一判定。改善要望 2026-08-21）
      origin: kind === 'poipoi' ? (input.origin === 'report' ? 'report' : 'direct') : null,
      notifyTargets: null,
      meetFileId: input.meetFileId ?? null,
      meetFileName: input.meetFileName ?? null,
      meetWebLink: input.meetWebLink ?? null,
    }]
    commit()
    // ぽいぽいポストは設定された宛先へ原文を通知（mock。API はサーバー発火。オペレーター指示 2026-08-03）。
    // 取込（importFile）経由は notifyPoipoi=false で発火しない（API の /import と揃える）
    if (kind === 'poipoi' && opts?.notifyPoipoi !== false) firePoipoiNotify(body, id)
    return { ok: true, id }
  }

  /** ドキュメント取込（API = サーバー抽出（.md/.txt/.pdf/.docx）/ モック = .md/.txt のみクライアント読取） */
  async function importFile(file: File, meta: Omit<NoteInput, 'kind' | 'body'>): Promise<Result> {
    if (file.size > 10 * 1024 * 1024) {
      return { ok: false, error: { code: 'AKO-NOTE-002', message: 'ファイルは 10MB 以下にしてください' } }
    }
    if (isApi) {
      const buf = new Uint8Array(await file.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      const res = await apiResult(() => apiFetch('/v1/notes/import', {
        method: 'POST',
        body: { ...meta, kind, filename: file.name, contentBase64: btoa(bin) },
      }))
      if (res.ok) await refresh() // 管理者の全ポスト一覧も同時に反映
      return res
    }
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (ext !== 'md' && ext !== 'txt') {
      return { ok: false, error: { code: 'AKO-NOTE-001', message: 'モックモードは .md / .txt のみ対応です（.pdf / .docx は API モードで）' } }
    }
    const text = (await file.text()).trim()
    if (!text) return { ok: false, error: { code: 'AKO-NOTE-003', message: 'ファイルからテキストを抽出できませんでした' } }
    // 取込は「入力原文」ではないため poipoi 通知は発火しない（API /import と挙動を揃える。§54 MINOR-2）
    return add({ ...meta, title: meta.title || file.name.replace(/\.[^.]+$/, ''), body: text }, { notifyPoipoi: false })
  }

  /** 取消（論理削除。本アプリ共通原則: 操作の取消可能性）。poipoi = 本人 / minutes = 登録者 or 管理者 */
  async function archive(noteId: string): Promise<Result> {
    return setActive(noteId, false, `/v1/notes/${noteId}/archive`, '取り消せます')
  }

  /** 復元（取消の取消 = 原則 9.5 の対称性）。権限は取消と同一 */
  async function restore(noteId: string): Promise<Result> {
    return setActive(noteId, true, `/v1/notes/${noteId}/restore`, '復元できます')
  }

  async function setActive(noteId: string, active: boolean, apiPath: string, verb: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch(apiPath, { method: 'POST' }))
      if (res.ok) await refresh() // 管理者の全ポスト一覧も同時に反映
      return res
    }
    const target = (mockNotes.value as Note[]).find(n => n.id === noteId)
    if (!target) return { ok: false, error: { code: 'AKO-GEN-002', message: 'ノートが見つかりません' } }
    if (!canUndo(target)) {
      return { ok: false, error: { code: 'AKO-PRM-001', message: `登録者本人（議事録は管理者も可）のみ${verb}` } }
    }
    mockNotes.value = (mockNotes.value as Note[]).map(n => n.id === noteId ? { ...n, active } : n)
    commit()
    return { ok: true, id: noteId }
  }

  /**
   * ポスト単位の通知先の編集（poipoi のみ・投稿者本人または管理者。改善要望 2026-08-21 = 登録後の通知先編集）。
   * targets = 宛先配列（空配列 = このポストは通知しない）/ null = テナント設定へ戻す（取消フロー = 原則9.5）。
   * 保存後、変更前の実効宛先に含まれていなかった解決済みメンバーへだけ原文を再通知する（重複通知を作らない = 原則2）。
   */
  async function updateNotifyTargets(noteId: string, targets: NotifyRecipientTarget[] | null): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch(`/v1/notes/${noteId}/notify-targets`, {
        method: 'PUT', body: { targets },
      }))
      if (res.ok) await refresh()
      return res
    }
    const target = (mockNotes.value as Note[]).find(n => n.id === noteId)
    if (!target) return { ok: false, error: { code: 'AKO-GEN-002', message: 'ノートが見つかりません' } }
    if (target.kind !== 'poipoi') {
      return { ok: false, error: { code: 'AKO-GEN-001', message: '通知先の編集は改善のタネ（ぽいぽいポスト）のみです' } }
    }
    if (target.memberId !== currentUser.value.id && !isAdmin.value) {
      return { ok: false, error: { code: 'AKO-PRM-001', message: '通知先の編集は投稿者本人または管理者のみです' } }
    }
    const next = targets === null ? null : parseNotifyRecipients(targets)
    // 変更前の実効宛先（上書き > テナント設定）を解決し、追加分だけ再通知する（共有純関数 addedNotifyRecipientIds = API と同一判定）
    const members = tbl('members').value as Member[]
    const prevEffective = target.notifyTargets != null
      ? parseNotifyRecipients(target.notifyTargets) : tenantPoipoiTargets()
    const prevRows = mockNotes.value as Note[]
    mockNotes.value = prevRows.map(n => n.id === noteId ? { ...n, notifyTargets: next } : n)
    if (!commit()) {
      mockNotes.value = prevRows // 容量不足はロールバック（無反応の成功を返さない）
      return { ok: false, error: { code: 'AKO-NOTE-090', message: '保存容量が不足しています' } }
    }
    if (target.active !== false) {
      const nextEffective = next ?? tenantPoipoiTargets()
      const addedIds = addedNotifyRecipientIds(prevEffective, nextEffective, members, target.memberId)
      if (addedIds.length > 0) {
        const author = members.find(m => m.id === target.memberId)
        firePoipoiNotify(target.body, noteId, nextEffective, addedIds,
          { id: target.memberId, name: author?.name ?? target.memberId })
      }
    }
    return { ok: true, id: noteId }
  }

  async function refresh(): Promise<void> {
    if (isApi) {
      await loadNotes(kind, true)
      if (kind === 'poipoi' && isAdmin.value) await loadAdminPosts(true)
    }
  }

  return { list, adminList, archived, add, importFile, archive, restore, updateNotifyTargets, refresh }
}
