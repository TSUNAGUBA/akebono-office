// AKEBONO Intelligence（intelligence/）モックモード E2E。
// ダッシュボード / データソース / インサイト生成（フィードバックループ反映）/
// 提案のアクション化 / アクションのフィードバック記録 / サイクル履歴 /
// モバイル幅（375px）の崩れなしを確認する。
// 実行: e2e/run-new-apps-mock.sh（ビルド + 配信 + 本スイート）
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4182'

async function main() {
  await withPage(async (page) => {
    console.log('suite: AKEBONO Intelligence モックモード')

    // ===== ダッシュボード =====
    await page.goto(`${BASE}/#/`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'ダッシュボード' }).waitFor()
    check('ダッシュボード: ループ 4 ステップが表示される',
      (await page.getByText('分析・インサイト').count()) >= 1
      && (await page.getByText('フィードバック', { exact: true }).count()) >= 1)
    check('ダッシュボード: 未完了アクションが表示される（シードの実行中 1 件）',
      (await page.getByText('操作系 FAQ の整備').count()) >= 1)

    // ===== データソース =====
    await page.goto(`${BASE}/#/data`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'データソース' }).waitFor()
    const dailyCount = await page.evaluate(() => {
      const row = [...document.querySelectorAll('main table tbody tr')]
        .find(r => r.textContent.includes('日報'))
      return row ? Number(row.querySelectorAll('td')[1].textContent.replace(/,/g, '')) : 0
    })
    check('データソース: 日報の件数が 0 より大きい（決定的シード）', dailyCount > 0)
    check('データソース: 月別チャートカードがある',
      (await page.getByText('月別 活動件数（直近 6 ヶ月）').count()) >= 1)

    // ===== インサイト生成（経営テーマ = フィードバックループの反映を確認） =====
    await page.goto(`${BASE}/#/insights`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'インサイト' }).waitFor()
    await page.getByRole('button', { name: '分析を実行' }).first().click()
    await page.getByText('参照するデータ（RAG 入力）').waitFor()
    check('生成モーダル: RAG 入力のプレビューが表示される', true)
    check('生成モーダル: 過去アクションの反映予告が表示される',
      (await page.getByText(/過去アクション \d+ 件.*ループ入力として反映/).count()) === 1)
    check('生成モーダル: Web 検索は本実装時有効化の注記（モック明示）',
      (await page.getByText(/Web 検索の併用は共通 API での本実装時に有効化/).count()) === 1)
    // モーダルのフッター側の実行ボタンを押す
    await page.getByRole('dialog').getByRole('button', { name: '分析を実行' }).click()
    await page.getByText(/フィードバック \d+ 件を反映/).waitFor()
    check('生成: フィードバックを反映してインサイトが生成される', true)

    // 生成されたインサイトカード（先頭）にループ反映の明細と提案がある
    check('インサイト: 反映したフィードバックの明細が表示される',
      (await page.getByText('反映したフィードバック（前回サイクルから）').count()) >= 1)
    check('インサイト: 高評価アクションの継続・横展開が提案される（reinforce）',
      (await page.getByText(/「停滞商談の Next Action 再設定」の継続・横展開/).count()) >= 1)
    check('インサイト: 低評価アクションの代替アプローチが提案される（alternative）',
      (await page.getByText(/「営業定例の週次化」に代わるアプローチの検討/).count()) >= 1)

    // 提案のアクション化
    await page.getByRole('button', { name: 'アクション化' }).first().click()
    await page.getByRole('heading', { name: '提案をアクション化' }).waitFor()
    await page.getByRole('button', { name: '登録', exact: true }).click()
    await page.getByText('アクションに登録しました').waitFor()
    check('提案: アクション化できる', true)
    check('提案: アクション化済み表示に変わる（重複作成の抑止）',
      (await page.getByText(/アクション化済み/).count()) >= 1)

    // ===== アクション（フィードバック記録 = ループの入力） =====
    await page.goto(`${BASE}/#/actions`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'アクション' }).waitFor()
    check('アクション: シードの完了 + 評価済みが表示される',
      (await page.getByText('評価 5/5').count()) >= 1)
    // 実行中のシードアクションを開いて完了 → フィードバック記録
    await page.getByRole('button', { name: /操作系 FAQ の整備/ }).click()
    await page.getByRole('button', { name: '完了にする' }).click()
    await page.getByText(/ステータスを「完了」へ変更しました/).waitFor()
    check('アクション: 完了へ遷移できる', true)
    await page.getByRole('radiogroup', { name: '評価' }).getByRole('radio', { name: '4' }).click()
    await page.getByPlaceholder(/施策の効果/).fill('FAQ 公開後、操作系の問い合わせが減少')
    await page.getByRole('button', { name: 'フィードバックを保存' }).click()
    await page.getByText(/フィードバックを記録しました/).waitFor()
    check('アクション: フィードバック（5 段階 + コメント）を記録できる', true)
    await page.keyboard.press('Escape')

    // ===== サイクル履歴 =====
    await page.goto(`${BASE}/#/cycles`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'フィードバックループ履歴' }).waitFor()
    check('サイクル: 今回の生成が記録されている（入力スナップショット付き）',
      (await page.getByText('入力スナップショット').count()) >= 1)
    check('サイクル: 反映したフィードバックの明細が表示される',
      (await page.getByText(/高評価 → 継続・強化を提案/).count()) >= 1)

    // ===== モバイル幅（375px） =====
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(`${BASE}/#/insights`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'インサイト' }).waitFor()
    check('モバイル: ボトムナビが表示される',
      await page.getByRole('navigation', { name: 'モバイルナビ' }).isVisible())
    check('モバイル: 横スクロールが発生しない',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  })

  summary('intelligence-mock-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
