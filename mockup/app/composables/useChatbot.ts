/**
 * AIチャットボット（F-09-2）
 * - セッション管理（オペレーター指示 2026-07-17）: 会話はセッション単位で永続し、同一セッション内は
 *   マルチターン（API モードはサーバーが直近履歴を LLM へ渡す）。過去セッションの再開・新規開始に対応
 * - SoT: API モード = chat_sessions / chat_messages（DB）。モックモード = chatSessions / chatMessages（localStorage）
 * - 応答: API モードは LLM 一次応答 → fallback 時は決定的ルーティング（応答はセッションへ追記して履歴を忠実に保つ）
 * - 擬似ストリーミング: 30-50 文字ずつ setInterval で流す。unmount 時は finalize() で確定保存
 */
import { findCompanyIn, SELF_COMPANY_PATTERN } from '../../../shared/domain/name-match'
import { bigramCoverage } from '../../../shared/domain/text-match'
import type { ChatMessage, ChatSession, Company, Industry, Result } from '~/types/domain'
import { fmtDateLong, fmtHours } from '~/utils/format'
import { PROJECT_STATUS_LABELS } from '~/utils/labels'
import { irange } from '~/utils/rng'

/** フォールバック応答のエスカレーション用チップ（クリック時は送信せず起票する） */
export const ESCALATE_SUGGESTION = '管理者に確認する'

/** 空状態で提示する初期サジェスト */
export const INITIAL_SUGGESTIONS = ['有給の残りは何日？', '今月の残業時間は？', 'アケボノ商事について教えて']

interface BotAnswer {
  content: string
  sources: string[]
  suggestions: string[]
}

// ---------- セッション状態（SPA・モジュールスコープ単一 = ページ遷移しても会話を維持） ----------

/**
 * 表示中セッションはタブ内で永続（sessionStorage）し、リロード後も同じ会話を自動再開する
 * （オペレーター報告 2026-07-18: リロードで新しい会話になり履歴が途切れて見える問題への対応。
 * タブ単位のため別タブには波及しない。ログイン切替時は API モード = refresh/send のサーバー
 * 所有チェック（404 = AKO-CHT-001）、モックモード = ensureOwnSession が null 化 → 削除する）
 */
const SESSION_STORAGE_KEY = 'ako.chatSession.v1'

function restoreSessionId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY)
  } catch {
    return null
  }
}

const currentSessionId = ref<string | null>(import.meta.client ? restoreSessionId() : null)

watch(currentSessionId, (v) => {
  try {
    if (v) sessionStorage.setItem(SESSION_STORAGE_KEY, v)
    else sessionStorage.removeItem(SESSION_STORAGE_KEY)
  } catch { /* プライベートモード等の storage 不可は無視（会話自体は続けられる） */ }
})
/** API モード: 自分のセッション一覧・現在セッションのメッセージ（サーバーのローカルミラー） */
const apiSessions = ref<ChatSession[]>([])
const apiMessages = ref<ChatMessage[]>([])
/** API モードのローカル表示用 id 採番（サーバーが id を返さない表示ミラーの :key 用） */
let localSeq = 0

onApiReset(() => {
  // 認証の確立・切替時はサーバーミラーのみ破棄する。currentSessionId は保持し、復元可否は
  // refresh()/openSession のサーバー所有チェック（他人・不在 = 404 → 新しい会話へ）に委ねる。
  // 本フックは初回ロード（リロード含む）の認証確立でも走るため、ここで null 化すると
  // sessionStorage によるリロード後の自動再開が壊れる（オペレーター報告 2026-07-18 の対応で判明）
  apiSessions.value = []
  apiMessages.value = []
})

export function useChatbot() {
  const { tbl, commit, nextId } = useMockDb()
  const { nameOf: deptNameOf } = useDepartments()
  const { currentUser } = useCurrentUser()
  const { monthSummary } = useAttendance()
  const { activeFiles, folderPath } = useDocuments()
  // 稼働状況はバッチ6c で移行済み: デュアルモードの useSystemStatus 経由で参照
  // （API モードの決定的フォールバックも実データで答える）
  const { services: statusServices, openIncidentsOf } = useSystemStatus()
  const isApi = useApiMode()

  const mockMessages = tbl('chatMessages')
  const mockSessions = tbl('chatSessions')

  // セッション導入前のモック会話（sessionId なし）を「以前の会話」セッションへ一度だけ移行（下位互換 = 原則7）。
  // 旧会話は全モックユーザー共有だったため、移行後は最初にページを開いたユーザーの所有になる（設計判断）
  if (!isApi && mockMessages.value.some(m => !m.sessionId)) {
    const legacyId = nextId('chatSessions', 'cs')
    mockSessions.value = [...mockSessions.value, {
      id: legacyId, memberId: currentUser.value.id, title: '以前の会話',
      createdAt: nowJstIso(), updatedAt: nowJstIso(),
    }]
    mockMessages.value = mockMessages.value.map(m => m.sessionId ? m : { ...m, sessionId: legacyId })
    commit()
  }

  /** 現在のセッションのメッセージ（時系列 = 挿入順を保持。API はサーバーの seq 順 + ローカル追記順） */
  const sorted = computed(() => isApi
    ? apiMessages.value
    : mockMessages.value.filter(m => m.sessionId === currentSessionId.value))

  /** 自分のセッション一覧（新しい順） */
  const sessions = computed<ChatSession[]>(() => {
    const rows = isApi
      ? apiSessions.value
      : mockSessions.value.filter(s => s.memberId === currentUser.value.id)
    return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  })

  // ---------- 擬似ストリーミング状態 ----------
  const isStreaming = ref(false)
  const streamingText = ref('')
  let timer: ReturnType<typeof setInterval> | null = null
  let pendingAnswer: BotAnswer | null = null

  function append(msg: Omit<ChatMessage, 'id' | 'at' | 'sessionId'>): void {
    const full: ChatMessage = {
      ...msg,
      id: isApi ? `ch-l${++localSeq}` : nextId('chatMessages', 'ch'),
      sessionId: currentSessionId.value ?? undefined,
      at: nowJstIso(),
    }
    if (isApi) {
      apiMessages.value = [...apiMessages.value, full]
      return
    }
    mockMessages.value = [...mockMessages.value, full]
    commit()
  }

  /** モックモード: セッションの最終更新を進める（一覧の並び用） */
  function touchMockSession(id: string): void {
    mockSessions.value = mockSessions.value.map(s => s.id === id ? { ...s, updatedAt: nowJstIso() } : s)
    commit()
  }

  /** ストリーミング中の応答を確定保存する（完了時・unmount 時） */
  function finalize(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (pendingAnswer) {
      append({ role: 'assistant', content: pendingAnswer.content, sources: pendingAnswer.sources, suggestions: pendingAnswer.suggestions })
      if (!isApi && currentSessionId.value) touchMockSession(currentSessionId.value)
      pendingAnswer = null
    }
    isStreaming.value = false
    streamingText.value = ''
  }

  // モックモード: ユーザー切替時に前ユーザーのセッションを引き継がない（他人の会話の表示・
  // 他人のセッションへの追記を防ぐ = C3。API モードは onApiReset が担う）
  function ensureOwnSession(): void {
    if (isApi || !currentSessionId.value) return
    const s = mockSessions.value.find(x => x.id === currentSessionId.value)
    if (!s || s.memberId !== currentUser.value.id) {
      finalize() // 前ユーザーのストリーミング中応答は前ユーザーのセッションへ確定保存
      currentSessionId.value = null
    }
  }
  ensureOwnSession()
  watch(() => currentUser.value.id, ensureOwnSession)

  function startStream(ans: BotAnswer): void {
    pendingAnswer = ans
    isStreaming.value = true
    streamingText.value = ''
    let pos = 0
    let step = 0
    timer = setInterval(() => {
      pos = Math.min(ans.content.length, pos + irange(`chat:${ans.content.length}:${step}`, 30, 50))
      step++
      streamingText.value = ans.content.slice(0, pos)
      if (pos >= ans.content.length) finalize()
    }, 90)
  }

  // ---------- セッション操作 ----------

  /** セッション一覧の取り直し（API モードのみ。履歴 UI を開くとき・ページ表示時） */
  async function refreshSessions(): Promise<void> {
    if (!isApi) return
    try {
      apiSessions.value = await apiFetch<ChatSession[]>('/v1/chatbot/sessions')
    } catch {
      // 一覧取得失敗は現在の会話を妨げない（非ブロッキング）
    }
  }

  /** 過去セッションを開いて続きから再開する（ストリーミング中の応答は元セッションへ確定保存） */
  async function openSession(id: string): Promise<Result> {
    finalize()
    if (isApi) {
      try {
        const rows = await apiFetch<ChatMessage[]>(`/v1/chatbot/sessions/${id}/messages`)
        apiMessages.value = rows
        currentSessionId.value = id
        return { ok: true, id }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    currentSessionId.value = id
    return { ok: true, id }
  }

  /** 新しいセッションを開始する（実体は最初の送信時に作成。過去の会話は履歴に残る） */
  function newSession(): void {
    finalize() // ストリーミング中の応答は元セッションへ確定保存してから切り替える
    currentSessionId.value = null
    if (isApi) apiMessages.value = []
  }

  /** ページ表示時の取り直し（セッション一覧 + 表示中セッションの復元。リロード後の自動再開もここ） */
  async function refresh(): Promise<void> {
    if (!isApi) return
    await refreshSessions()
    if (currentSessionId.value && apiMessages.value.length === 0) {
      const r = await openSession(currentSessionId.value)
      // 復元できないセッション（別アカウントの残骸・削除済み = 404）のみ新しい会話へフォールバック。
      // 一時的な通信失敗（AKO-GEN-NET 等）では保持し、次回の refresh で再試行する
      if (!r.ok && r.error.code === 'AKO-CHT-001') currentSessionId.value = null
    }
  }

  /**
   * 質問を送信する（user メッセージ即保存 → 応答をストリーミング）。
   * API モードは LLM 一次応答（POST /v1/chatbot/ask = セッション履歴つきマルチターン）を試み、
   * fallback 指示・通信失敗時は決定的ルーティング応答へ縮退する。縮退応答もセッションへ
   * 追記して履歴を忠実に保つ（POST /sessions/:id/messages・非ブロッキング）
   */
  async function send(rawText: string): Promise<void> {
    const text = [...rawText.trim()].slice(0, 2000).join('')
    if (!text || isStreaming.value) return
    if (!isApi && !currentSessionId.value) {
      // モックモード: 最初の送信でセッションを作成（タイトルは最初の質問）
      const id = nextId('chatSessions', 'cs')
      mockSessions.value = [...mockSessions.value, {
        id, memberId: currentUser.value.id, title: [...text].slice(0, 40).join(''),
        createdAt: nowJstIso(), updatedAt: nowJstIso(),
      }]
      commit()
      currentSessionId.value = id
    }
    append({ role: 'user', content: text, sources: [], suggestions: [] })
    if (!isApi && currentSessionId.value) touchMockSession(currentSessionId.value)
    if (isApi) {
      isStreaming.value = true // LLM 応答待ちの間も入力を抑止し「考え中」を表示
      try {
        const res = await apiFetch<{
          fallback: boolean; sessionId?: string; content?: string; sources?: string[]; suggestions?: string[]
        }>('/v1/chatbot/ask', { method: 'POST', body: { question: text, sessionId: currentSessionId.value } })
        if (res.sessionId) currentSessionId.value = res.sessionId
        if (!res.fallback && res.content) {
          startStream({
            content: res.content,
            sources: res.sources ?? [],
            suggestions: (res.suggestions?.length ? res.suggestions : INITIAL_SUGGESTIONS.slice(0, 2)),
          })
          return
        }
      } catch (e) {
        // 通信失敗も決定的応答へ縮退（下の共通経路）。この場合セッション未確定なら履歴追記はしない。
        // セッション不在（別アカウントの残骸等 = AKO-CHT-001）は保持をやめて新しい会話へ
        if (apiErrorOf(e).code === 'AKO-CHT-001') currentSessionId.value = null
      }
      // フォールバック: 決定的応答をセッションへ追記（履歴の忠実性。失敗しても表示は継続 = 非ブロッキング）。
      // ルーティングが参照するマスタキャッシュ（会社・業界・関係・PJ・ナレッジ等）は遅延ロードのため、
      // 初回質問ではロード未完了で照合が空振りし「回答できません」になる競合があった
      // （オペレーター報告 2026-07-18 #2 の実原因の一つ）。ロード完了を待ってから判定する
      await Promise.allSettled(
        ['companies', 'industries', 'relationTypes', 'companyRelations', 'projects', 'knowledge', 'members', 'departments']
          .map(n => loadApiCollection(n)))
      const ans = resolveAnswer(text)
      if (currentSessionId.value) {
        void apiFetch(`/v1/chatbot/sessions/${currentSessionId.value}/messages`, {
          method: 'POST',
          body: { content: ans.content, sources: ans.sources, suggestions: ans.suggestions },
        }).catch(() => { /* 追記失敗は表示を妨げない */ })
      }
      startStream(ans)
      return
    }
    startStream(resolveAnswer(text))
  }

  /**
   * フォールバック応答からのエスカレーション起票（補助処理・非ブロッキング）。
   * 応答生成はモックだが、質問は実際のユーザー入力のため API モードでも実データへ起票する
   */
  function escalate(question: string): Promise<Result> {
    return useEscalations().raise({
      reason: 'low_confidence',
      targetMemberId: currentUser.value.id,
      context: `チャットボットが回答できなかった質問: 「${question}」`,
      dedupeKey: `chatbot:${currentUser.value.id}:${todayJst()}`,
    })
  }

  // ---------- シナリオルーティング（実データ参照） ----------

  /**
   * キーワードルーティング（該当なしは null = 呼び出し側が履歴での再試行や定型応答を決める）。
   * 話題の選択は corpus（履歴込みのことがある）で行い、サブ分類（申請/取り方・規程トピック等）は
   * 今回の質問 subText だけで行う（履歴側のサブキーワードが今回の意図を上書きしないため）
   */
  function route(corpus: string, subText: string = corpus): BotAnswer | null {
    if (/有給|休暇/.test(corpus)) return answerLeave(subText)
    if (/残業|勤怠|労働時間/.test(corpus)) return answerOvertime()
    // 会社照合は正規化名寄せ（法人格・空白除去 + 最長一致）。「弊社/当社」等は自社を回答
    // （オペレーター報告 2026-07-18 #3: 「つなぐば」「弊社」が照合できない問題への対応）
    const company = matchCompany(corpus)
    if (company) return answerCompany(company)
    if (SELF_COMPANY_PATTERN.test(corpus)) {
      const self = tbl('companies').value.find(c => c.kind === 'self' && c.active)
      if (self) return answerCompany(self)
    }
    const industry = matchIndustry(corpus)
    if (industry) return answerIndustry(industry)
    if (/稼働|障害|システム/.test(corpus)) return answerStatus()
    if (/規程|ルール|就業/.test(corpus)) return answerRules(subText)
    if (/稟議|申請|承認/.test(corpus)) return answerWorkflow()
    // 最後の砦: ナレッジ全文の字句照合（解釈型の質問を蓄積ナレッジで補足。該当なしは null）
    return answerKnowledgeSearch(subText)
  }

  function unknownAnswer(): BotAnswer {
    return {
      content: 'すみません、この質問にはうまく回答できませんでした。管理者へエスカレーションしますか？（暗黙の情報共有として管理者に届き、回答があれば通知されます）',
      sources: [],
      suggestions: [ESCALATE_SUGGESTION, ...INITIAL_SUGGESTIONS.slice(0, 2)],
    }
  }

  /**
   * 2 段ルーティング（オペレーター報告 2026-07-18: フォールバック応答が会話履歴を無視する問題への対応）。
   * ①今回の質問だけで判定（従来どおり = 話題転換を優先）→ ②該当なしなら直近のユーザー発言を
   * 連結して再判定（「じゃあ去年は？」等のフォローアップを直前の話題で回答）→ ③それでも不明なら定型応答
   */
  function resolveAnswer(text: string): BotAnswer {
    const primary = route(text)
    if (primary) return primary
    // 直近のユーザー発言（今回分は表示リストに追加済みのため除く）から話題を引き継ぐ。
    // 新しい発言から 1 件ずつ再判定する（サーバー側と同じ「新しい順優先」= 連結コーパスだと
    // 古い発言の長い会社名が最長一致で勝ってしまうため）
    const recents = sorted.value
      .filter(m => m.role === 'user')
      .slice(-4, -1)
      .map(m => m.content)
    for (const t of [...recents].reverse()) {
      const followUp = route(`${t}\n${text}`, text)
      if (followUp) return followUp
    }
    return unknownAnswer()
  }

  /** a) 有給: leaveGrants / leaveRequests から currentUser の残数を計算 */
  function answerLeave(text: string): BotAnswer {
    const surname = currentUser.value.name.split(/\s+/)[0] ?? currentUser.value.name

    // 申請方法の質問は案内を返す
    if (/申請|取り方|取得方法|手続/.test(text)) {
      return {
        content: `有給の申請は /attendance の「有給」タブから行えます。日付と単位（全日/半休）・理由を入力して申請すると、承認者に通知されます。承認されると残数に反映されます。`,
        sources: ['勤怠データ'],
        suggestions: ['有給の残りは何日？', '今月の残業時間は？'],
      }
    }

    // 残数計算は useLeave.balance が SoT（FIFO 引当・失効・保有上限を含む）。二重実装しない
    const bal = useLeave().balance(currentUser.value.id)
    if (bal.allocations.length === 0) {
      return {
        content: `${surname}さんに現在有効な有給付与が見つかりませんでした。付与状況は /attendance の「有給」タブ、または管理者に確認してください。`,
        sources: ['勤怠データ'],
        suggestions: ['有給を申請するには？', '今月の残業時間は？'],
      }
    }
    const pending = tbl('leaveRequests').value
      .filter(r => r.memberId === currentUser.value.id && r.status === 'pending').length

    const lines = [
      `${surname}さんの有給残は ${bal.remaining} 日です（今年度取得 ${bal.usedThisFiscalYear} 日${pending > 0 ? `・申請中 ${pending} 件` : ''}）。`,
      bal.nextExpire
        ? `直近の失効予定は ${fmtDateLong(bal.nextExpire.date)} の ${bal.nextExpire.days} 日分です。計画的な取得をおすすめします。`
        : '現在、失効が近い付与はありません。',
    ]
    return {
      content: lines.join('\n'),
      sources: ['勤怠データ'],
      suggestions: ['有給を申請するには？', '今月の残業時間は？'],
    }
  }

  /** b) 残業・勤怠: useAttendance().monthSummary で当月実績を要約 */
  function answerOvertime(): BotAnswer {
    const month = todayJst().slice(0, 7)
    const s = monthSummary(currentUser.value.id, month)
    const otMin = s.total.statutoryOt + s.total.nonStatutoryOt + s.total.over60Ot
    const alertMin = s.total.nonStatutoryOt + s.total.over60Ot
    const lines = [
      `今月（${Number(month.slice(5, 7))}月）の実績: 出勤 ${s.workDays} 日、所定内 ${fmtHours(s.total.scheduled)}、残業 ${fmtHours(otMin)}（うち深夜 ${fmtHours(s.total.night)}・法定休日 ${fmtHours(s.total.legalHoliday)}）です。`,
    ]
    if (alertMin >= 30 * 60) {
      lines.push('法定外残業が月 30 時間を超えています。36 協定の上限（月 45 時間）に注意してください。詳細は /attendance の月次タブで確認できます。')
    } else {
      lines.push('日別の内訳は /attendance の月次タブで確認できます。')
    }
    return {
      content: lines.join('\n'),
      sources: ['勤怠データ'],
      suggestions: ['有給の残りは何日？', 'システムの稼働状況は？'],
    }
  }

  /** c) 会社名マッチ（自社/顧客とも。正規化名寄せ + 最長一致 = shared/domain/name-match） */
  function matchCompany(text: string): Company | undefined {
    return findCompanyIn(text, tbl('companies').value.filter(c => c.active))
  }

  /** c) 会社（自社/顧客）: 概要 + 業界 + 担当 + 関係 + 関連ナレッジ（空フィールドは出力しない） */
  function answerCompany(c: Company): BotAnswer {
    const industries = tbl('industries').value.filter(i => c.industryIds.includes(i.id)).map(i => i.name)
    const owner = tbl('members').value.find(m => m.id === c.ownerMemberId)
    const projects = tbl('projects').value.filter(p => p.active && p.companyId === c.id)
    const ks = tbl('knowledge').value
      .filter(k => k.active && k.domain === 'company' && k.targetId === c.id)
      .slice(0, 2)

    const facts: string[] = []
    if (industries.length > 0) facts.push(`業界は${industries.join('・')}`)
    if (c.size) facts.push(`規模 ${c.size}`)
    if (c.location) facts.push(`所在地 ${c.location}`)
    if (owner) facts.push(`担当は ${owner.name}（${deptNameOf(owner.departmentId)}）`)
    const lines = [
      `${c.kind === 'self' ? '自社' : '顧客'}「${c.name}」${c.description ? `: ${c.description}` : 'の情報です。'}`,
      ...(facts.length > 0 ? [`${facts.join('、')}。`] : []),
      ...(c.kind === 'self' && c.fiscalStartMonth ? [`会計年度は ${c.fiscalStartMonth} 月始まりです。`] : []),
    ]
    if (projects.length > 0) {
      lines.push(`関連プロジェクト: ${projects.map(p => `${p.name}（${PROJECT_STATUS_LABELS[p.status]}）`).join(' / ')}`)
    }
    // 会社間の関係（companyRelations は移行済みマスタ = API モードでも実データ。
    // オペレーター報告 2026-07-18 #2: フォールバック応答にも関係性を含める）
    const relTypes = tbl('relationTypes').value
    const compRels = tbl('companyRelations').value
      .filter(r => r.fromCompanyId === c.id || r.toCompanyId === c.id)
      .slice(0, 5)
    if (compRels.length > 0) {
      const compNameOf = (id: string): string => tbl('companies').value.find(x => x.id === id)?.name ?? id
      lines.push(`関係: ${compRels.map((r) => {
        const other = r.fromCompanyId === c.id ? r.toCompanyId : r.fromCompanyId
        const label = relTypes.find(t => t.id === r.relationTypeId)?.label ?? '関係'
        return `${compNameOf(other)}（${label}）`
      }).join(' / ')}`)
    }
    for (const k of ks) {
      const body = k.body.length > 60 ? `${k.body.slice(0, 60)}…` : k.body
      lines.push(`関連ナレッジ「${k.title}」: ${body}`)
    }
    return {
      content: lines.join('\n'),
      sources: [c.kind === 'self' ? '自社マスタ' : '顧客マスタ', ...ks.map(k => `ナレッジ ${k.id}`)],
      suggestions: ['システムの稼働状況は？', '経費精算の規程はある？'],
    }
  }

  /** c2) 業界マッチ（「小売」→「小売業」のような末尾「業」の省略にも対応） */
  function matchIndustry(text: string): Industry | undefined {
    return tbl('industries').value.find(i => i.active && i.name.length >= 2 && (
      text.includes(i.name)
      || (i.name.endsWith('業') && i.name.length >= 3 && text.includes(i.name.slice(0, -1)))))
  }

  /** c2) 業界: 該当顧客 + 業界ナレッジ（「小売はどんなところで困る?」等の解釈型に蓄積ナレッジで回答） */
  function answerIndustry(ind: Industry): BotAnswer {
    const customers = tbl('companies').value
      .filter(c => c.active && c.kind === 'customer' && c.industryIds.includes(ind.id))
    const ks = tbl('knowledge').value
      .filter(k => k.active && k.domain === 'industry' && k.targetId === ind.id)
      .slice(0, 2)
    const lines = [`業界「${ind.name}」の情報です。`]
    if (customers.length > 0) lines.push(`該当する顧客: ${customers.map(c => c.name).join('・')}`)
    for (const k of ks) {
      lines.push(`ナレッジ「${k.title}」: ${k.body.length > 160 ? `${k.body.slice(0, 160)}…` : k.body}`)
    }
    if (customers.length === 0 && ks.length === 0) {
      lines.push('この業界に紐付く顧客・ナレッジはまだ登録されていません。/masters/knowledge から蓄積できます。')
    }
    return {
      content: lines.join('\n'),
      sources: ['業界マスタ', ...ks.map(k => `ナレッジ ${k.id}`)],
      suggestions: [customers.length > 0 ? `${customers[0]!.name}について教えて` : '業界別の顧客は？', '有給の残りは何日？'],
    }
  }

  /** g) ナレッジ全文の字句照合（バイグラム被覆率。キーワードルートに乗らない質問の最後の砦） */
  function answerKnowledgeSearch(text: string): BotAnswer | null {
    const hits = tbl('knowledge').value
      .filter(k => k.active)
      .map(k => ({ k, score: bigramCoverage(text, `${k.title}\n${k.body}\n${k.tags.join(' ')}`) }))
      .filter(x => x.score >= 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
    if (hits.length === 0) return null
    const lines = ['関連しそうな社内ナレッジが見つかりました。']
    for (const { k } of hits) {
      lines.push(`「${k.title}」: ${k.body.length > 200 ? `${k.body.slice(0, 200)}…` : k.body}`)
    }
    return {
      content: lines.join('\n'),
      sources: hits.map(({ k }) => `ナレッジ ${k.id}`),
      suggestions: INITIAL_SUGGESTIONS.slice(0, 2),
    }
  }

  /** d) 稼働状況: useSystemStatus（デュアルモード）の open 状況を要約 */
  function answerStatus(): BotAnswer {
    const services = statusServices.value
    const openCount = services.reduce((s, svc) => s + openIncidentsOf(svc.id).length, 0)
    const lines: string[] = []
    lines.push(openCount === 0
      ? '現在、対応中の障害はありません。全サービスの稼働状況は次のとおりです。'
      : `現在 ${openCount} 件の障害・事象に対応中です。サービス別の状況は次のとおりです。`)
    for (const svc of services) {
      const inc = openIncidentsOf(svc.id)
      lines.push(inc.length === 0
        ? `・${svc.name}: 正常稼働`
        : `・${svc.name}: 対応中 — ${inc.map(i => i.title).join(' / ')}`)
    }
    lines.push('90 日間の稼働履歴やインシデント詳細は /status で確認できます。')
    return {
      content: lines.join('\n'),
      sources: ['稼働状況'],
      suggestions: ['アケボノ商事について教えて', '今月の残業時間は？'],
    }
  }

  /** e) 規程・ルール: documents から名称一致するファイルを案内 + knowledge 検索 */
  function answerRules(text: string): BotAnswer {
    const topics = ['就業', '経費', '育児', '介護', 'セキュリティ', '休業'].filter(t => text.includes(t))
    const ruleFiles = activeFiles.value.filter(f => f.tags.includes('規程') || /規程|規則/.test(f.name))
    const hits = topics.length > 0
      ? ruleFiles.filter(f => topics.some(t => f.name.includes(t) || f.summary.includes(t)))
      : ruleFiles
    const shown = (hits.length > 0 ? hits : ruleFiles).slice(0, 3)

    const ks = tbl('knowledge').value
      .filter(k => k.active && topics.some(t => k.title.includes(t) || k.body.includes(t)))
      .slice(0, 1)

    const lines: string[] = []
    if (shown.length === 0) {
      lines.push('該当する規程ドキュメントが見つかりませんでした。 /support/documents で検索してみてください。')
    } else {
      lines.push('以下の規程ドキュメントが見つかりました。')
      for (const f of shown) {
        lines.push(`・${f.name}（${folderPath(f.parentId)}） — ${f.summary.length > 50 ? `${f.summary.slice(0, 50)}…` : f.summary}`)
      }
      lines.push('全文は /support/documents から開けます。')
    }
    for (const k of ks) {
      lines.push(`関連ナレッジ「${k.title}」も参考になります。`)
    }
    return {
      content: lines.join('\n'),
      sources: ['ドキュメント管理', ...ks.map(k => `ナレッジ ${k.id}`)],
      suggestions: ['稟議を申請するには？', '有給の残りは何日？'],
    }
  }

  /** f) 稟議・申請・承認: ワークフローの使い方説明 */
  function answerWorkflow(): BotAnswer {
    return {
      content: [
        '稟議・申請は /workflow から起票できます。使い方は次のとおりです。',
        '1) 「新規申請」で区分（購買・契約・経費・採用・出張・その他）と金額・内容を入力',
        '2) 区分×金額帯に応じた承認経路（マネージャー→取締役→社長など）が自動で設定されます',
        '3) 申請すると承認者へ通知され、進捗は同じ画面で確認できます。差戻し時は修正して再申請できます',
        '経費の申請ルールは経費精算規程（ /support/documents ）もあわせて確認してください。',
      ].join('\n'),
      sources: [],
      suggestions: ['経費精算の規程はある？', '有給を申請するには？'],
    }
  }

  return {
    messages: sorted,
    sessions,
    currentSessionId,
    isStreaming,
    streamingText,
    send,
    newSession,
    openSession,
    refresh,
    refreshSessions,
    finalize,
    escalate,
  }
}
