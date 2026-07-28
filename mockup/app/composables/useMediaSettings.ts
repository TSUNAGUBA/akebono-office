/**
 * メディア設定（セグメント 1:1）。GA 連携（擬似 OAuth）と AI 分析設定を画面操作で完結させる。
 * - SoT: mediaSettings コレクション（未移行 = モック直書き可。書込後は commit）
 * - 未設定セグメントは既定設定を materialize（原則1: 初期化をコードで完結。空設定にしない）
 * - GA 連携状態のアプリ側 SoT（本実装では GA OAuth のトークン保管に置き換わる）
 * - 取消可能性（原則9.5）: 連携は解除でき、設定は再編集で上書きできる
 */
import type { ArticleTone } from '../../../shared/domain/media-article'
import type { MediaGoal, MediaSetting } from '~/types/media'
import { defaultMediaSetting } from '~/utils/media'

export function useMediaSettings() {
  const { tbl, commit, nextId } = useMockDb()
  const settings = tbl('mediaSettings')
  const { activeSegments, effectiveSegmentId, segmentById } = useCurrentSegment()

  function rawFor(segmentId: string): MediaSetting | undefined {
    return (settings.value as MediaSetting[]).find(s => s.segmentId === segmentId)
  }

  /**
   * セグメントの設定を取得する（無ければ既定を materialize して保存）。
   * segmentId 無効時は null。
   */
  function ensureSetting(segmentId: string): MediaSetting | null {
    const existing = rawFor(segmentId)
    if (existing) return existing
    const seg = segmentById(segmentId)
    if (!seg) return null
    const created = defaultMediaSetting(seg, nextId('mediaSettings', 'ms'))
    settings.value = [...settings.value, created]
    commit()
    return created
  }

  /** 設定を取得する（読み取り専用・materialize しない。表示既定は defaultMediaSetting で補う） */
  function settingFor(segmentId: string): MediaSetting | null {
    const existing = rawFor(segmentId)
    if (existing) return existing
    const seg = segmentById(segmentId)
    return seg ? defaultMediaSetting(seg, 'ms-preview') : null
  }

  /** 現在の業態の設定（表示用。materialize しない） */
  const currentSetting = computed<MediaSetting | null>(() => settingFor(effectiveSegmentId.value))

  /** GA 連携済みのセグメント設定のみ */
  const connectedSettings = computed<MediaSetting[]>(() =>
    activeSegments.value.map(s => rawFor(s.id)).filter((s): s is MediaSetting => !!s && s.gaConnected))

  /**
   * 部分更新（渡したキーのみ上書き = 未指定フィールドを保持）。
   * 呼び出し側は変更するキーだけを渡す（undefined を渡さない）ため、スプレッドで安全に合成できる。
   */
  function save(segmentId: string, patch: Partial<Omit<MediaSetting, 'id' | 'segmentId'>>): { ok: boolean; error?: { code: string; message: string } } {
    const base = ensureSetting(segmentId)
    if (!base) return { ok: false, error: { code: 'AKO-MEDIA-001', message: 'メディア設定の対象セグメントが見つかりません' } }
    const next: MediaSetting = { ...base, ...patch }
    settings.value = (settings.value as MediaSetting[]).map(s => s.segmentId === segmentId ? next : s)
    commit()
    return { ok: true }
  }

  /** GA4 を連携する（擬似 OAuth 同意後に呼ぶ。接続状態と接続日時・プロパティを保存） */
  function connectGa(segmentId: string, propertyId: string, propertyName: string): { ok: boolean; error?: { code: string; message: string } } {
    if (!propertyId.trim()) return { ok: false, error: { code: 'AKO-MEDIA-002', message: 'GA4 プロパティ ID を入力してください' } }
    return save(segmentId, {
      gaConnected: true,
      gaPropertyId: propertyId.trim(),
      gaPropertyName: propertyName.trim() || propertyId.trim(),
      gaConnectedAt: nowJstIso(),
    })
  }

  /** GA 連携を解除する（取消フロー。設定・記事は残す = 非破壊） */
  function disconnectGa(segmentId: string): { ok: boolean; error?: { code: string; message: string } } {
    return save(segmentId, { gaConnected: false, gaPropertyId: null, gaPropertyName: null, gaConnectedAt: null })
  }

  return {
    settings, currentSetting, connectedSettings,
    settingFor, ensureSetting, save, connectGa, disconnectGa,
  }
}

/** 設定の既定トーン（記事生成フォームの初期値解決） */
export function resolveDefaultTone(setting: MediaSetting | null): ArticleTone {
  return setting?.defaultTone ?? 'formal'
}
export function resolveGoal(setting: MediaSetting | null): MediaGoal {
  return setting?.analysisGoal ?? 'awareness'
}
