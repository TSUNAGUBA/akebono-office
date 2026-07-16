/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { DocumentNode } from '~/types/domain'
import { addDays } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

/** back 日前の時刻付き ISO */
const at = (back: number, time: string): string => `${addDays(today, -back)}T${time}+09:00`

/**
 * ドキュメント管理（F-09-3）のシード。
 * - フォルダ 5 + サブフォルダ 1 + ファイル 13 件
 * - tags は codeMaster の documentTag ラベル（規程/議事録/提案書/設計書/マニュアル）と一致させる
 */
export const seedDocumentNodes: DocumentNode[] = [
  // ---------- フォルダ ----------
  { id: 'doc-root-rules', parentId: null, kind: 'folder', name: '社内規程', tags: [], updatedAt: at(30, '09:00:00'), updatedBy: 'm-02', size: null, summary: '' },
  { id: 'doc-root-minutes', parentId: null, kind: 'folder', name: '議事録', tags: [], updatedAt: at(2, '18:00:00'), updatedBy: 'm-03', size: null, summary: '' },
  { id: 'doc-sub-minutes-scm', parentId: 'doc-root-minutes', kind: 'folder', name: 'アケボノ商事 SCM 定例', tags: [], updatedAt: at(7, '17:30:00'), updatedBy: 'm-03', size: null, summary: '' },
  { id: 'doc-root-proposals', parentId: null, kind: 'folder', name: '提案書', tags: [], updatedAt: at(4, '15:00:00'), updatedBy: 'm-03', size: null, summary: '' },
  { id: 'doc-root-designs', parentId: null, kind: 'folder', name: '設計書', tags: [], updatedAt: at(6, '11:00:00'), updatedBy: 'm-05', size: null, summary: '' },
  { id: 'doc-root-manuals', parentId: null, kind: 'folder', name: 'マニュアル', tags: [], updatedAt: at(3, '10:00:00'), updatedBy: 'm-06', size: null, summary: '' },

  // ---------- ファイル: 社内規程 ----------
  { id: 'doc-0001', parentId: 'doc-root-rules', kind: 'file', name: '就業規則.pdf', tags: ['規程'], updatedAt: at(30, '09:00:00'), updatedBy: 'm-02', size: '1.2MB', summary: '就業時間・休暇・服務規律を定める。フレックスタイム制（コアタイム 10:00-15:00）と有給休暇の取得手続きを含む。' },
  { id: 'doc-0002', parentId: 'doc-root-rules', kind: 'file', name: '育児・介護休業規程.pdf', tags: ['規程'], updatedAt: at(120, '09:30:00'), updatedBy: 'm-02', size: '640KB', summary: '育児・介護に伴う休業、短時間勤務、深夜業の制限の取り扱いを定める。' },
  { id: 'doc-0003', parentId: 'doc-root-rules', kind: 'file', name: '経費精算規程.pdf', tags: ['規程'], updatedAt: at(45, '14:00:00'), updatedBy: 'm-02', size: '480KB', summary: '立替経費の申請区分・上限額・精算期限を定める。経費精算 SaaS の運用ルールと稟議（経費承認）との連動を含む。' },
  { id: 'doc-0004', parentId: 'doc-root-rules', kind: 'file', name: '情報セキュリティ基本規程.pdf', tags: ['規程'], updatedAt: at(60, '10:00:00'), updatedBy: 'm-01', size: '890KB', summary: '情報資産の分類・アクセス権限・社外持ち出しルールを定める。顧客データの取り扱い区分を含む。' },

  // ---------- ファイル: 議事録 ----------
  { id: 'doc-0005', parentId: 'doc-sub-minutes-scm', kind: 'file', name: 'SCM定例_第12回_議事録.md', tags: ['議事録'], updatedAt: at(21, '18:10:00'), updatedBy: 'm-03', size: '24KB', summary: '在庫スナップショットの粒度を「日次×SKU×拠点」で合意。棚卸月（2月・8月）はバッチ停止枠を設ける。次回までに連携 IF 案を提示。' },
  { id: 'doc-0006', parentId: 'doc-sub-minutes-scm', kind: 'file', name: 'SCM定例_第13回_議事録.md', tags: ['議事録'], updatedAt: at(7, '17:30:00'), updatedBy: 'm-03', size: '26KB', summary: 'Phase2 スコープを確定。データ連携の異常検知アラート追加を検討。春日部長より性能要件の再確認依頼あり。' },
  { id: 'doc-0007', parentId: 'doc-root-minutes', kind: 'file', name: '経営会議_2026-07_議事録.md', tags: ['議事録'], updatedAt: at(9, '19:00:00'), updatedBy: 'm-01', size: '18KB', summary: '月次業績レビューと下期採用計画の審議。AKEBONO Office の他社展開方針（設定・汎用化基盤の整備）を決定。' },

  // ---------- ファイル: 提案書 ----------
  { id: 'doc-0008', parentId: 'doc-root-proposals', kind: 'file', name: 'シーサイドホテルズ_DX構想策定_提案書_v2.pptx', tags: ['提案書'], updatedAt: at(12, '16:20:00'), updatedBy: 'm-03', size: '4.8MB', summary: '中期 DX ロードマップ策定支援の提案（3 フェーズ構成）。曙執行役員からの紹介案件。汐見取締役向けに投資対効果を前面に。' },
  { id: 'doc-0009', parentId: 'doc-root-proposals', kind: 'file', name: 'テクノパーツ工業_生産管理刷新_提案書_draft.pptx', tags: ['提案書'], updatedAt: at(4, '15:00:00'), updatedBy: 'm-05', size: '3.1MB', summary: '生産管理システム刷新の RFP 対応ドラフト。現行課題の整理・概算見積・体制案を含む。真鍋部長レビュー待ち。' },

  // ---------- ファイル: 設計書 ----------
  { id: 'doc-0010', parentId: 'doc-root-designs', kind: 'file', name: 'SCM_在庫連携IF_基本設計書.docx', tags: ['設計書'], updatedAt: at(18, '13:40:00'), updatedBy: 'm-05', size: '1.6MB', summary: '在庫データ連携 IF の基本設計。日次バッチとリアルタイム API の併用構成。エラー時のリトライ・手動再同期パスを定義。' },
  { id: 'doc-0011', parentId: 'doc-root-designs', kind: 'file', name: 'トクタケAI_データモデル設計書.xlsx', tags: ['設計書'], updatedAt: at(6, '11:00:00'), updatedBy: 'm-09', size: '760KB', summary: '問い合わせ・アンケート分析のスタースキーマ定義。ファクト 2 種・ディメンション 6 種。半加法メジャーの集計注意点を記載。' },

  // ---------- ファイル: マニュアル ----------
  { id: 'doc-0012', parentId: 'doc-root-manuals', kind: 'file', name: 'AKEBONO_Office_操作マニュアル.pdf', tags: ['マニュアル'], updatedAt: at(3, '10:00:00'), updatedBy: 'm-06', size: '2.4MB', summary: '社内オフィスアプリの操作手順。打刻・日報・稟議・シフト希望提出の基本操作を画面つきで収録。' },
  { id: 'doc-0013', parentId: 'doc-root-manuals', kind: 'file', name: '経費精算SaaS_利用マニュアル.pdf', tags: ['マニュアル'], updatedAt: at(40, '09:15:00'), updatedBy: 'm-10', size: '1.1MB', summary: '経費精算 SaaS のアカウント発行から精算申請・承認までの手順。経費精算規程とあわせて参照。' },
]

// ---------- AKEBONO 要望 / 監査ログ ----------
