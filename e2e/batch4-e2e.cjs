// 改修依頼 2026-08-21（4 単位）のモックモード E2E。
// 単位1: 受付箱の「対象箇所」列 + 詳細ドロワーでの編集
// 単位2: 設定の 3 タブ化（システム設定/運用設定/監査ログ）+ 監査ログのフィルタ
// 単位3: AI 判定（ナレッジベース照合）+ チャットボットのマニュアル回答（RAG）
// 単位4: 受付箱/改修案件のステータス再編（状態機械・継続検討の再検討日・担当者アサイン・取消フロー）
// 既定ユーザー m-03 = 管理者（モックモード配信 :4173）
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

async function main() {
  await withPage(async (page) => {
    console.log('suite: 改修依頼 2026-08-21（対象箇所・設定タブ+監査ログ・AI 知識ベース・ステータス再編）')

    // ---- 受付箱: ステータス再編（単位4） ----
    await page.goto(`${BASE}/#/improvements`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: '改善要望' }).waitFor()
    await page.getByRole('tab', { name: /受付箱/ }).click()
    await page.getByRole('tablist', { name: '投稿者で絞り込み' }).getByRole('tab', { name: '全員' }).click()

    // 既定フィルタ = 未確認（起票直後の初期ステータス）。シードの未確認要望（imreq-0008）が出る
    await page.getByText('月別の残業時間の推移をグラフでも').first().waitFor()
    check('受付箱: 既定フィルタ「未確認」に起票直後の要望が出る', true)

    // 行内のステータス変更: 未確認 → 検討中（機械が許す遷移のみが選択肢に出る）。
    // テーブル表示とモバイルカード表示（dl）の両方が DOM に載るため first() で先頭（テーブル側）を使う
    const rowSelect = page.getByLabel(/要望「月別の残業時間.*ステータスを変更/).first()
    const optionValues = await rowSelect.locator('option').evaluateAll(els => els.map(e => e.value).filter(Boolean))
    check('受付箱: 未確認の行の遷移候補は「検討中」のみ（状態機械）', optionValues.length === 1 && optionValues[0] === 'reviewing')
    await rowSelect.selectOption('reviewing')
    await page.getByText('「検討中」にしました').first().waitFor()
    check('受付箱: 行内セレクトで 未確認 → 検討中 に遷移しトーストが出る', true)
    await page.getByText('未確認の要望はありません').waitFor()
    check('受付箱: 遷移した要望が「未確認」の絞り込みから消える', true)

    // 検討中フィルタへ移動 → ドロワーで AI 判定（単位3: ナレッジベース照合）
    await page.getByRole('tab', { name: '検討中' }).click()
    await page.getByText('月別の残業時間の推移をグラフでも').first().click()
    await page.getByRole('button', { name: 'AI で判定', exact: true }).click()
    await page.getByText('AI 判定を実行しました').first().waitFor()
    check('AI 判定: ドロワーの「AI で判定」で判定が実行される', true)
    await page.getByText('簡易判定').first().waitFor()
    check('AI 判定: 判定結果（モック = 簡易判定バッジ）と根拠が表示される', true)
    check('AI 判定: 推奨アクションが表示される', (await page.getByText('推奨アクション:').count()) >= 1)

    // 継続検討 = 再検討日必須（未入力はインラインエラー → 入力で成立 = 単位4）
    await page.getByRole('button', { name: '継続検討へ' }).click()
    await page.getByRole('button', { name: '「継続検討」にする' }).click()
    await page.getByText('継続検討にするには再検討日を設定してください').waitFor()
    check('継続検討: 再検討日なしはインラインエラーで案内される', true)
    await page.getByLabel('継続検討の再検討日').fill('2099-12-31')
    await page.getByRole('button', { name: '「継続検討」にする' }).click()
    await page.getByText(/「継続検討」にしました（再検討日/).first().waitFor()
    check('継続検討: 再検討日を設定すると遷移できる', true)
    // 取消可能性（原則9.5）: 継続検討 → 検討中へ戻せる
    await page.getByRole('button', { name: '検討中へ' }).click()
    await page.getByText('「検討中」にしました').first().waitFor()
    check('継続検討: 「検討中へ」で戻せる（取消フロー）', true)

    // ---- 対象箇所の編集（単位1） ----
    await page.getByRole('button', { name: '要望を編集' }).click()
    await page.getByLabel('対象箇所').fill('勤怠サマリーのグラフ')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByText('要望を編集しました').first().waitFor()
    check('対象箇所: 詳細ドロワーの編集フォームで入力・保存できる', true)
    // Escape はドロワー内にフォーカスがあるときだけ効く（保存後はフォーカスが外れる）ため、
    // ドロワー（role=dialog）内の閉じるボタンで閉じる（トーストの閉じるボタンと混同しない）
    await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.getByRole('columnheader', { name: '対象箇所' }).waitFor()
    await page.getByText('勤怠サマリーのグラフ').first().waitFor()
    check('対象箇所: 保存した値が受付箱の一覧セルに表示される', true)

    // ---- シードの各ステータスが絞り込みで引ける（運用対応 / 継続検討 / 対応済み〔案件連動の導出〕） ----
    await page.getByRole('tab', { name: '運用対応' }).click()
    await page.getByText('先週の週報をまとめて印刷したい').first().waitFor()
    check('受付箱: 「運用対応」の絞り込みにシードの要望が出る', true)
    await page.getByRole('tab', { name: '継続検討' }).click()
    await page.getByText('棚卸しの結果を CSV で一括取込').first().waitFor()
    check('受付箱: 「継続検討」の絞り込みに再検討日つきの要望が出る',
      (await page.getByText(/継続検討（/).count()) >= 1)
    await page.getByRole('tab', { name: '対応済み' }).click()
    await page.getByText('通知をまとめて既読にしたい').first().waitFor()
    check('受付箱: 集約先の案件が対応済の要望は「対応済み」に導出される（案件連動）', true)
    // 一括変更バー（複数選択 → まとめて変更。まとめて未確認に戻す = 取消の一括）
    await page.getByRole('tab', { name: 'すべて' }).click()
    check('受付箱: 一括変更バー（すべて選択 + まとめて変更/戻す）がある',
      (await page.getByText('すべて選択（全ページ）').count()) >= 1
      && (await page.getByRole('button', { name: 'まとめて未確認に戻す' }).count()) >= 1)

    // ---- 改修案件: 3 状態 + 担当者アサイン（単位4） ----
    await page.getByRole('tab', { name: '改修案件' }).click()
    await page.getByRole('columnheader', { name: '担当者' }).waitFor()
    await page.getByText('葛西 大輔').first().waitFor()
    check('改修案件: 一覧に担当者列があり、シードの担当者が出る', true)
    // 未対応の案件（imp-0002）を開いて 対応中（担当者アサイン）→ 対応済 → reopen → 未対応 と一周
    await page.getByText('「タイムカード」の打刻取消を可能にする').first().click()
    await page.getByRole('button', { name: '対応中へ' }).click()
    await page.getByLabel('対応中の担当者').selectOption({ label: '三浦 彩' })
    await page.getByRole('button', { name: '「対応中」にする' }).click()
    await page.getByText('「対応中」にしました（担当者をアサイン）').first().waitFor()
    check('改修案件: 対応中への遷移で担当者をアサインできる', true)
    await page.getByText('担当: 三浦 彩').waitFor()
    check('改修案件: アサインした担当者がドロワーに表示される', true)
    await page.getByRole('button', { name: '対応済へ' }).click()
    await page.getByText('ステータスを「対応済」に変更しました').first().waitFor()
    check('改修案件: 対応済へ遷移できる', true)
    // reopen（対応済 → 対応中 → 未対応 = 原則9.5）
    await page.getByRole('button', { name: '対応中へ' }).click()
    await page.getByRole('button', { name: '「対応中」にする' }).click()
    await page.getByText(/「対応中」にしました/).first().waitFor()
    await page.getByRole('button', { name: '未対応へ' }).click()
    await page.getByText('ステータスを「未対応」に変更しました').first().waitFor()
    check('改修案件: 対応済からの reopen と未対応への差し戻しができる（取消フロー）', true)
    await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })

    // ---- チャットボット: マニュアル RAG 回答（単位3） ----
    await page.goto(`${BASE}/#/support/chatbot`)
    await page.getByLabel('質問を入力').fill('打刻のやり方を教えてください')
    await page.keyboard.press('Enter')
    await page.getByText('アプリのマニュアル・仕様に該当する記載が見つかりました。').waitFor()
    check('チャットボット: 使い方の質問にマニュアル（ナレッジベース）を根拠に回答する', true)

    // ---- 設定: 3 タブ + 監査ログ（単位2） ----
    await page.goto(`${BASE}/#/settings`)
    await page.getByRole('tab', { name: 'システム設定' }).waitFor()
    check('設定: システム設定/運用設定/監査ログ の 3 タブがある',
      (await page.getByRole('tab', { name: '運用設定' }).count()) >= 1
      && (await page.getByRole('tab', { name: '監査ログ' }).count()) >= 1)
    await page.getByRole('tab', { name: '監査ログ' }).click()
    await page.getByRole('columnheader', { name: '操作日時' }).waitFor()
    check('監査ログ: 操作日時/ユーザー/対象ページ/対象データ/操作内容 の列で一覧される',
      (await page.getByRole('columnheader', { name: '操作ユーザー' }).count()) >= 1
      && (await page.getByRole('columnheader', { name: '操作対象ページ' }).count()) >= 1
      && (await page.getByRole('columnheader', { name: '操作対象データ' }).count()) >= 1
      && (await page.getByRole('columnheader', { name: '操作内容' }).count()) >= 1)
    // 直前の要望編集（対象箇所）が監査ログに記録されている（操作対象ページ列 = 改善要望）
    await page.getByRole('cell', { name: '改善要望', exact: true }).first().waitFor()
    check('監査ログ: 要望編集の操作が記録される（操作対象ページ = 改善要望）', true)
    // ページのプルダウン（オートコンプリート）で絞り込み
    const pageFilter = page.getByLabel('操作対象ページで絞り込み')
    await pageFilter.click()
    await pageFilter.fill('改善要望')
    await page.getByRole('option', { name: /^改善要望（/ }).first().click() // 選択肢ラベルは「改善要望（/improvements）」
    await page.getByRole('cell', { name: '改善要望', exact: true }).first().waitFor()
    check('監査ログ: 操作対象ページのプルダウンで絞り込める', true)
    // ?tab= ディープリンクで監査ログタブを直接開ける
    await page.goto(`${BASE}/#/settings?tab=audit`)
    await page.getByRole('columnheader', { name: '操作日時' }).waitFor()
    check('監査ログ: /settings?tab=audit で直接開ける', true)

    // ---- モバイル 375px: 主要変更ページで横スクロールが出ない ----
    await page.setViewportSize({ width: 375, height: 800 })
    for (const [path, label] of [['/improvements', '改善要望'], ['/settings', '設定']]) {
      await page.goto(`${BASE}/#${path}`)
      await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      check(`モバイル375px: ${label} でページ全体の横スクロールが出ない`, overflow <= 1)
    }
  })
  summary('batch4-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
