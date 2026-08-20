/** 操作フィードバックのトースト（UiToastHost が描画。aria-live で通知） */
import type { Tone } from '~/types/ui'

export interface ToastItem {
  id: number
  tone: Tone
  message: string
  /** 波及先の確認リンク（任意） */
  link?: { label: string; to: string }
}

let toastSeq = 0

export function useToast() {
  const toasts = useState<ToastItem[]>('ako-toasts', () => [])

  function show(message: string, tone: Tone = 'ok', link?: ToastItem['link']): void {
    const id = ++toastSeq
    toasts.value = [...toasts.value, { id, tone, message, link }]
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, 3600)
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }

  return { toasts, show, dismiss }
}
