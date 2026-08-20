/**
 * 通知宛先の解決（shared/domain/notify-recipients。オペレーター指示 2026-08-03）。
 * - parseNotifyRecipients: JSON 文字列 / オブジェクト配列の正規化・不正要素の除去
 * - resolveNotifyRecipientIds: 役職/ロール/個人 → 在籍メンバー id（重複排除・投稿者除外・id 昇順）
 */
import { describe, expect, it } from 'vitest'
import {
  type NotifyRecipientTarget,
  parseNotifyRecipients,
  resolveNotifyRecipientIds,
} from '~/utils/notify-recipients'

const members = [
  { id: 'm-01', role: 'admin', title: '部長', active: true },
  { id: 'm-02', role: 'hr', title: '課長', active: true },
  { id: 'm-03', role: 'member', title: '課長', active: true },
  { id: 'm-04', role: 'member', title: '一般', active: false }, // 退職者
  { id: 'm-05', role: 'member', title: '一般', active: true },
]

describe('parseNotifyRecipients', () => {
  it('JSON 文字列 / オブジェクト配列の妥当な要素を残す', () => {
    const json = JSON.stringify([
      { type: 'role', role: 'admin' },
      { type: 'title', title: '課長' },
      { type: 'member', memberId: 'm-05' },
    ])
    expect(parseNotifyRecipients(json)).toEqual([
      { type: 'role', role: 'admin' },
      { type: 'title', title: '課長' },
      { type: 'member', memberId: 'm-05' },
    ])
    expect(parseNotifyRecipients(JSON.parse(json))).toHaveLength(3)
  })

  it('不正・欠落要素は捨てる（type と対応フィールドが揃わないもの）', () => {
    const raw = [
      { type: 'role', role: 'ceo' }, // 不正ロール
      { type: 'title' }, // title 欠落
      { type: 'member', memberId: '' }, // 空 id
      { type: 'unknown', x: 1 }, // 不明 type
      { type: 'role', role: 'member' }, // 妥当
    ]
    expect(parseNotifyRecipients(raw)).toEqual([{ type: 'role', role: 'member' }])
  })

  it('空文字・壊れ JSON・非配列は空配列', () => {
    expect(parseNotifyRecipients('')).toEqual([])
    expect(parseNotifyRecipients('   ')).toEqual([])
    expect(parseNotifyRecipients('{bad')).toEqual([])
    expect(parseNotifyRecipients(null)).toEqual([])
    expect(parseNotifyRecipients(undefined)).toEqual([])
    expect(parseNotifyRecipients({ not: 'array' })).toEqual([])
  })
})

describe('resolveNotifyRecipientIds', () => {
  it('role 指定はそのロールの在籍者すべて（退職者は除外）', () => {
    const targets: NotifyRecipientTarget[] = [{ type: 'role', role: 'member' }]
    // m-04 は active=false のため除外。m-03, m-05 のみ
    expect(resolveNotifyRecipientIds(targets, members)).toEqual(['m-03', 'm-05'])
  })

  it('title 指定は役職一致の在籍者すべて', () => {
    expect(resolveNotifyRecipientIds([{ type: 'title', title: '課長' }], members)).toEqual(['m-02', 'm-03'])
  })

  it('member 指定は在籍していれば追加・退職者や不在は無視', () => {
    expect(resolveNotifyRecipientIds([{ type: 'member', memberId: 'm-01' }], members)).toEqual(['m-01'])
    expect(resolveNotifyRecipientIds([{ type: 'member', memberId: 'm-04' }], members)).toEqual([]) // 退職者
    expect(resolveNotifyRecipientIds([{ type: 'member', memberId: 'nope' }], members)).toEqual([])
  })

  it('複数指定は重複排除して id 昇順で返す', () => {
    const targets: NotifyRecipientTarget[] = [
      { type: 'title', title: '課長' }, // m-02, m-03
      { type: 'role', role: 'admin' }, // m-01
      { type: 'member', memberId: 'm-03' }, // 重複
    ]
    expect(resolveNotifyRecipientIds(targets, members)).toEqual(['m-01', 'm-02', 'm-03'])
  })

  it('excludeMemberId（投稿者本人）は結果から除外する', () => {
    const targets: NotifyRecipientTarget[] = [{ type: 'role', role: 'member' }]
    expect(resolveNotifyRecipientIds(targets, members, 'm-03')).toEqual(['m-05'])
  })

  it('空の宛先指定は空配列', () => {
    expect(resolveNotifyRecipientIds([], members)).toEqual([])
  })
})
