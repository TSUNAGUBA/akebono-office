/**
 * note（note.com）の非公式 API クライアント。
 *
 * **重要な前提（オペレーター確認済み 2026-08-12）:** note に公式の公開 API はない。
 * 本クライアントは note の Web 版が内部通信で使うエンドポイントを利用するため、
 * **予告なく仕様変更で動かなくなる可能性がある**。障害時に切り分けやすいよう、
 * - エンドポイントパスは本ファイル冒頭の定数へ集約する（仕様変更時はここだけ直す）
 * - 失敗は例外にせず Result 型（ok=false + note 応答の抜粋）で返し、呼び出し側が
 *   グレースフルに扱う（原則4。メッセージから運用者が自己診断できるようにする）
 *
 * 認証: note のログイン API は reCAPTCHA が必須のため自動ログインは行わない。
 * ブラウザでログイン済みの `_note_session_v5` Cookie 値をオペレーターが設定画面から登録する方式
 * （Cookie は AES-256-GCM で暗号化保存 = media_ga_tokens と同型。lib/crypto.ts）。
 *
 * 利用ポリシー: 書込は**下書き作成まで**（公開 API は呼ばない = 公開は人間が note 管理画面で行う）。
 * 読取（記事一覧・反応数）は公開エンドポイントのため Cookie 不要。
 */
import { capCp } from './text'

const NOTE_BASE = 'https://note.com'
/** 公開: クリエイターの記事一覧（スキ数・コメント数を含む。認証不要） */
const CONTENTS_PATH = (urlname: string, page: number): string =>
  `/api/v2/creators/${encodeURIComponent(urlname)}/contents?kind=note&page=${page}`
/** 認証: 下書き枠の確保（2 段階プロセスの 1 段目。id / key が採番される） */
const TEXT_NOTES_PATH = '/api/v1/text_notes'
/** 認証: 下書き本文の保存（2 段階プロセスの 2 段目。note エディタの「下書き保存」と同じ） */
const DRAFT_SAVE_PATH = (id: string): string => `/api/v1/text_notes/draft_save?id=${encodeURIComponent(id)}`
/** セッション Cookie 名（note の Web 版ログインで発行される） */
export const NOTE_SESSION_COOKIE = '_note_session_v5'

const TIMEOUT_MS = 15_000

export type NoteResult<T> = { ok: true; value: T } | { ok: false; status: number; detail: string }

/** note の公開記事 1 件（反応数付き） */
export interface NoteContentItem {
  key: string
  title: string
  likeCount: number
  commentCount: number
  /** 公開日時（note の publishAt 生値。日付部の抽出は呼び出し側） */
  publishAt: string
  noteUrl: string
}

function headers(cookie?: string): Record<string, string> {
  const h: Record<string, string> = {
    'accept': 'application/json',
    'content-type': 'application/json',
    // 素の fetch UA は note 側で拒否されることがあるためブラウザ相当を名乗る
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  }
  if (cookie) h.cookie = `${NOTE_SESSION_COOKIE}=${cookie}`
  return h
}

/** 失敗 Result（note 応答の先頭 150 字を detail へ。運用者の自己診断用 = 本番障害 2026-07-29 の教訓を踏襲） */
function fail(status: number, bodyTxt: string): { ok: false; status: number; detail: string } {
  return { ok: false, status, detail: capCp(bodyTxt.replace(/\s+/g, ' ').trim(), 150) }
}

/**
 * note API 応答（v2 contents）→ NoteContentItem[]（純粋関数・単体テスト対象）。
 * 型崩れ・欠落へ防御的に対応する（非公式 API = 応答形の保証がない）
 */
export function normalizeNoteContents(raw: unknown): { items: NoteContentItem[]; isLastPage: boolean } {
  const data = (raw as { data?: { contents?: unknown; isLastPage?: unknown } } | null)?.data
  const list = Array.isArray(data?.contents) ? data.contents : []
  const items = list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map(c => ({
      key: String(c.key ?? ''),
      title: capCp(String(c.name ?? '').trim(), 200),
      likeCount: Math.max(0, Math.round(Number(c.likeCount)) || 0),
      commentCount: Math.max(0, Math.round(Number(c.commentCount)) || 0),
      publishAt: String(c.publishAt ?? ''),
      noteUrl: String(c.noteUrl ?? ''),
    }))
    .filter(c => c.key.length > 0)
  // isLastPage が読めない応答（仕様変更等）は「最終ページ」とみなし、無限ページングを防ぐ
  return { items, isLastPage: data?.isLastPage !== false }
}

/**
 * クリエイターの公開記事を全ページ取得する（認証不要）。ページ上限で打ち切る（異常応答での無限ループ防止）。
 * 部分成功: 1 ページ目が取れて途中ページで失敗した場合は取得済み分を返し、warning を付ける。
 */
export async function fetchCreatorContents(
  urlname: string, maxPages = 10,
): Promise<NoteResult<{ items: NoteContentItem[]; warning?: string }>> {
  const all: NoteContentItem[] = []
  for (let page = 1; page <= maxPages; page++) {
    let res: Response
    try {
      res = await fetch(`${NOTE_BASE}${CONTENTS_PATH(urlname, page)}`, {
        headers: headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      if (page > 1) return { ok: true, value: { items: all, warning: `${page} ページ目以降の取得に失敗しました（${capCp((e as Error).message, 100)}）` } }
      return fail(0, (e as Error).message)
    }
    if (!res.ok) {
      const bodyTxt = await res.text().catch(() => '')
      if (page > 1) return { ok: true, value: { items: all, warning: `${page} ページ目以降の取得に失敗しました（HTTP ${res.status}）` } }
      return fail(res.status, bodyTxt)
    }
    const body = await res.json().catch(() => null)
    const { items, isLastPage } = normalizeNoteContents(body)
    all.push(...items)
    if (isLastPage || items.length === 0) return { ok: true, value: { items: all } }
  }
  // ページ上限で打ち切り（isLastPage 未到達）: 取得済み分は返しつつ、対象外の記事がある事実を告知する
  // （無告知の打ち切りは「古い記事の反応 = ゼロ」の誤読を生むため。原則4 の粒度）
  return { ok: true, value: { items: all, warning: `記事が多いため ${maxPages} ページで打ち切りました（それ以前の記事は今回の同期対象外です）` } }
}

/**
 * 下書きプッシュの結果。失敗時も、枠確保に成功していれば draftId を返す（呼び出し側が保存して
 * リトライ時に同じ下書きを再利用する = 失敗のたびに空の下書きが note 側へ溜まらない・冪等 = 原則2）
 */
export type PushDraftResult =
  | { ok: true; value: { draftId: string; key: string } }
  | { ok: false; status: number; detail: string; draftId?: string }

/** 下書き枠の確保（2 段階プロセスの 1 段目）。例外も Result へ畳む */
async function allocateDraft(cookie: string): Promise<PushDraftResult> {
  try {
    const res = await fetch(`${NOTE_BASE}${TEXT_NOTES_PATH}`, {
      method: 'POST',
      headers: headers(cookie),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ name: '', body: '', template_key: null }),
    })
    if (!res.ok) return fail(res.status, await res.text().catch(() => ''))
    const body = await res.json().catch(() => null) as { data?: { id?: unknown; key?: unknown } } | null
    const draftId = String(body?.data?.id ?? '')
    if (!draftId) return fail(res.status, '下書き枠の応答に id がありません（仕様変更の可能性）')
    return { ok: true, value: { draftId, key: String(body?.data?.key ?? '') } }
  } catch (e) {
    return fail(0, (e as Error).message)
  }
}

/** 本文保存（2 段階プロセスの 2 段目）。失敗（例外含む）にも draftId を載せる = 呼び出し側が枠を保全できる */
async function saveDraft(
  cookie: string, draftId: string, title: string, htmlBody: string,
): Promise<PushDraftResult> {
  try {
    const save = await fetch(`${NOTE_BASE}${DRAFT_SAVE_PATH(draftId)}`, {
      method: 'PUT',
      headers: headers(cookie),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ name: title, body: htmlBody }),
    })
    if (!save.ok) return { ...fail(save.status, await save.text().catch(() => '')), draftId }
    const saved = await save.json().catch(() => null) as { data?: { key?: unknown } } | null
    return { ok: true, value: { draftId, key: String(saved?.data?.key ?? '') } }
  } catch (e) {
    return { ...fail(0, (e as Error).message), draftId }
  }
}

/**
 * 下書きの作成・更新（要 Cookie。note の 2 段階プロセス: 枠確保 → 本文保存）。
 * - draftId 指定時は枠確保をスキップし同じ下書きを更新する（再プッシュ = 冪等。新規下書きを増やさない）
 * - 指定 draftId が note 側で削除済み（404）の場合は新しい枠を確保して保存し直す（自己回復 =
 *   「下書きを消されたら二度とプッシュできない」詰み導線を作らない。原則9.5）
 * - 本文保存に失敗しても確保済み draftId を失敗結果に載せる（呼び出し側が保存 → リトライで再利用）
 * - 公開は行わない（公開エンドポイントは呼ばない設計 = 誤公開を構造的に防ぐ）
 */
export async function pushDraft(
  cookie: string,
  input: { draftId?: string; title: string; htmlBody: string },
): Promise<PushDraftResult> {
  if (input.draftId) {
    const saved = await saveDraft(cookie, input.draftId, input.title, input.htmlBody)
    // 404 = 下書きが note 側で削除済み → 新しい枠で作り直す。それ以外の失敗はそのまま返す
    if (saved.ok || saved.status !== 404) return saved
  }
  const alloc = await allocateDraft(cookie)
  if (!alloc.ok) return alloc
  const saved = await saveDraft(cookie, alloc.value.draftId, input.title, input.htmlBody)
  if (saved.ok && !saved.value.key) saved.value.key = alloc.value.key
  return saved
}
