/** 破壊的操作の確認ダイアログ（UiConfirmHost が描画） */

export interface ConfirmState {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  danger: boolean
  resolve: ((ok: boolean) => void) | null
}

export function useConfirm() {
  const state = useState<ConfirmState>('ako-confirm', () => ({
    open: false, title: '', message: '', confirmLabel: '実行', danger: false, resolve: null,
  }))

  function ask(title: string, message: string, opts?: { confirmLabel?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      state.value = {
        open: true,
        title,
        message,
        confirmLabel: opts?.confirmLabel ?? '実行',
        danger: opts?.danger ?? false,
        resolve,
      }
    })
  }

  function answer(ok: boolean): void {
    state.value.resolve?.(ok)
    state.value = { ...state.value, open: false, resolve: null }
  }

  return { state, ask, answer }
}
