/**
 * 非同期操作の実行中フィードバック（共通・オペレーター指示 2026-07-21 #3）。
 * ボタン押下で「リクエストが受け付けられた」ことを可視化する 2 点セットを一元化する:
 *  (1) スナックバー（useToast）で押下直後にメッセージを表示（任意）
 *  (2) キー単位の pending フラグを立て、UiButton の :loading（プログレスサークル）+ 二重押下防止に使う
 *
 * 1 コンポーネントで複数ボタンを扱えるようキー付き。key は 'submit' や `ai-review:${id}` のように
 * ボタン（や行）ごとに一意にする。同一キーの実行中は再実行を無視する（連打・二重送信の防止）。
 */
import type { Tone } from '~/types/ui'

export interface RunOptions {
  /** 押下直後に出すスナックバー文言（省略時はトーストを出さない） */
  message?: string
  /** スナックバーのトーン（既定 info = 処理中の通知） */
  tone?: Tone
}

export function useAsyncAction() {
  const running = ref<Set<string>>(new Set())
  const { show } = useToast()

  /** key の操作が実行中か（UiButton の :loading・:disabled に束ねる） */
  function isRunning(key = '_'): boolean {
    return running.value.has(key)
  }

  /**
   * 非同期処理をラップして実行する。実行中は pending を立て、任意で押下直後のトーストを出す。
   * 実行中の同一キー再実行は無視する（二重送信防止）。完了・失敗いずれでも pending を必ず戻す。
   */
  async function run<T>(key: string, fn: () => Promise<T>, opts: RunOptions = {}): Promise<T | undefined> {
    if (running.value.has(key)) return
    running.value = new Set(running.value).add(key)
    if (opts.message) show(opts.message, opts.tone ?? 'info')
    try {
      return await fn()
    } finally {
      const next = new Set(running.value)
      next.delete(key)
      running.value = next
    }
  }

  return { isRunning, run }
}
