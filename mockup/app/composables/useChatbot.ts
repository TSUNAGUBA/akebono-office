/**
 * AIチャットボット（F-09-2）
 * - 会話は chatMessages コレクションで永続（ユーザー発言は即 commit、AI 応答はストリーミング完了後に commit）
 * - 応答はキーワードルーティング + マスタ/業務実データ参照で決定的に生成（乱数・API なし）
 * - 擬似ストリーミング: 30-50 文字ずつ setInterval で流す。unmount 時は finalize() で確定保存
 */
import type { ChatMessage, Result } from '~/types/domain'
import { fmtDateLong, fmtHours, toDateKey } from '~/utils/format'
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

export function useChatbot() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { monthSummary } = useAttendance()
  const { activeFiles, folderPath } = useDocuments()

  const messages = tbl('chatMessages')
  const sorted = computed(() => [...messages.value].sort((a, b) => a.at.localeCompare(b.at)))

  // ---------- 擬似ストリーミング状態 ----------
  const isStreaming = ref(false)
  const streamingText = ref('')
  let timer: ReturnType<typeof setInterval> | null = null
  let pendingAnswer: BotAnswer | null = null

  function append(msg: Omit<ChatMessage, 'id' | 'at'>): void {
    messages.value = [...messages.value, {
      ...msg,
      id: nextId('chatMessages', 'ch'),
      at: new Date().toISOString(),
    }]
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
      pendingAnswer = null
    }
    isStreaming.value = false
    streamingText.value = ''
  }

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

  /** 質問を送信する（user メッセージ即保存 → 応答をストリーミング） */
  function send(rawText: string): void {
    const text = rawText.trim().slice(0, 2000)
    if (!text || isStreaming.value) return
    append({ role: 'user', content: text, sources: [], suggestions: [] })
    startStream(answer(text))
  }

  /** 会話クリア（確認ダイアログは呼び出し側で。ストリーミング中の応答は破棄） */
  function clear(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    pendingAnswer = null
    isStreaming.value = false
    streamingText.value = ''
    messages.value = []
    commit()
  }

  /** フォールバック応答からのエスカレーション起票（補助処理・非ブロッキング） */
  function escalate(question: string): Result {
    return useEscalations().raise({
      reason: 'low_confidence',
      targetMemberId: currentUser.value.id,
      context: `チャットボットが回答できなかった質問: 「${question}」`,
      dedupeKey: `chatbot:${currentUser.value.id}:${toDateKey(new Date())}`,
    })
  }

  // ---------- シナリオルーティング（実データ参照） ----------

  function answer(text: string): BotAnswer {
    if (/有給|休暇/.test(text)) return answerLeave(text)
    if (/残業|勤怠|労働時間/.test(text)) return answerOvertime()
    const company = matchCompany(text)
    if (company) return answerCompany(company)
    if (/稼働|障害|システム/.test(text)) return answerStatus()
    if (/規程|ルール|就業/.test(text)) return answerRules(text)
    if (/稟議|申請|承認/.test(text)) return answerWorkflow()
    return {
      content: 'すみません、この質問にはうまく回答できませんでした。管理者へエスカレーションしますか？（暗黙の情報共有として管理者に届き、回答があれば通知されます）',
      sources: [],
      suggestions: [ESCALATE_SUGGESTION, ...INITIAL_SUGGESTIONS.slice(0, 2)],
    }
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

    const today = toDateKey(new Date())
    const grants = tbl('leaveGrants').value
      .filter(g => g.memberId === currentUser.value.id && g.grantDate <= today && g.expireDate >= today)
      .sort((a, b) => a.expireDate.localeCompare(b.expireDate))
    if (grants.length === 0) {
      return {
        content: `${surname}さんに現在有効な有給付与が見つかりませんでした。付与状況は /attendance の「有給」タブ、または管理者に確認してください。`,
        sources: ['勤怠データ'],
        suggestions: ['有給を申請するには？', '今月の残業時間は？'],
      }
    }
    const granted = grants.reduce((s, g) => s + g.days, 0)
    const oldestGrantDate = grants.reduce((min, g) => (g.grantDate < min ? g.grantDate : min), grants[0]!.grantDate)
    const requests = tbl('leaveRequests').value
      .filter(r => r.memberId === currentUser.value.id && r.date >= oldestGrantDate)
    const used = requests.filter(r => r.status === 'approved')
      .reduce((s, r) => s + (r.unit === 'half' ? 0.5 : 1), 0)
    const pending = requests.filter(r => r.status === 'pending').length
    const remaining = Math.max(0, granted - used)
    const nearest = grants[0]!

    const lines = [
      `${surname}さんの有給残は ${remaining} 日です（付与 ${granted} 日・取得済 ${used} 日${pending > 0 ? `・申請中 ${pending} 件` : ''}）。`,
      `直近の失効予定は ${fmtDateLong(nearest.expireDate)} の ${nearest.days} 日分です。計画的な取得をおすすめします。`,
    ]
    return {
      content: lines.join('\n'),
      sources: ['勤怠データ'],
      suggestions: ['有給を申請するには？', '今月の残業時間は？'],
    }
  }

  /** b) 残業・勤怠: useAttendance().monthSummary で当月実績を要約 */
  function answerOvertime(): BotAnswer {
    const month = toDateKey(new Date()).slice(0, 7)
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

  /** c) 顧客会社名マッチ（name / aliases） */
  function matchCompany(text: string) {
    const lower = text.toLowerCase()
    return tbl('companies').value.find(c =>
      c.kind === 'customer' && c.active
      && [c.name, ...c.aliases].some(n => n && lower.includes(n.toLowerCase())),
    )
  }

  /** c) 顧客: 概要 + 業界 + 担当 + 関連ナレッジ */
  function answerCompany(c: { id: string; name: string; description: string; industryIds: string[]; size: string; location: string; ownerMemberId: string | null }): BotAnswer {
    const industries = tbl('industries').value.filter(i => c.industryIds.includes(i.id)).map(i => i.name)
    const owner = tbl('members').value.find(m => m.id === c.ownerMemberId)
    const projects = tbl('projects').value.filter(p => p.active && p.companyId === c.id)
    const ks = tbl('knowledge').value
      .filter(k => k.active && k.domain === 'company' && k.targetId === c.id)
      .slice(0, 2)

    const lines = [
      `${c.name}: ${c.description}。`,
      `業界は${industries.join('・') || '未設定'}、規模 ${c.size}（${c.location}）。担当は ${owner ? `${owner.name}（${owner.dept}）` : '未設定'} です。`,
    ]
    if (projects.length > 0) {
      lines.push(`関連プロジェクト: ${projects.map(p => `${p.name}（${PROJECT_STATUS_LABELS[p.status]}）`).join(' / ')}`)
    }
    for (const k of ks) {
      const body = k.body.length > 60 ? `${k.body.slice(0, 60)}…` : k.body
      lines.push(`関連ナレッジ「${k.title}」: ${body}`)
    }
    return {
      content: lines.join('\n'),
      sources: ['顧客マスタ', ...ks.map(k => `ナレッジ ${k.id}`)],
      suggestions: ['システムの稼働状況は？', '経費精算の規程はある？'],
    }
  }

  /** d) 稼働状況: systemServices + serviceIncidents の open 状況を要約 */
  function answerStatus(): BotAnswer {
    const services = tbl('systemServices').value
    const openIncidents = tbl('serviceIncidents').value.filter(i => i.status !== 'resolved')
    const lines: string[] = []
    lines.push(openIncidents.length === 0
      ? '現在、対応中の障害はありません。全サービスの稼働状況は次のとおりです。'
      : `現在 ${openIncidents.length} 件の障害・事象に対応中です。サービス別の状況は次のとおりです。`)
    for (const svc of services) {
      const inc = openIncidents.filter(i => i.serviceId === svc.id)
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
    isStreaming,
    streamingText,
    send,
    clear,
    finalize,
    escalate,
  }
}
