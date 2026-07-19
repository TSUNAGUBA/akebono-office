/**
 * UiMarkdown のコンポーネントレベル検証（バッチ7e・PR #53 レビュー指摘 11）。
 * パーサ単体では担保できない VNode 生成側（リンク属性・テキストのエスケープ実挙動）を
 * vue/server-renderer（vue 同梱 = 依存追加なし）の HTML 出力で確認する
 */
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import UiMarkdown from '../app/components/ui/UiMarkdown.vue'

async function render(source: string): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(UiMarkdown, { source }) }))
}

describe('UiMarkdown コンポーネント描画（XSS 安全性・リンク属性）', () => {
  it('リンクは href / target=_blank / rel=noopener noreferrer 付きの <a> になる', async () => {
    const html = await render('[社内](https://example.com/x)')
    expect(html).toContain('href="https://example.com/x"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('>社内</a>')
  })

  it('生 HTML はエスケープされたテキストとして描画され、要素にならない', async () => {
    const html = await render('<script>alert(1)</script> と <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('javascript: スキームはリンク化されず平文のまま', async () => {
    const html = await render('[x](javascript:alert(1))')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href')
    expect(html).toContain('javascript:alert(1)')
  })

  it('太字・コード・見出し・番号リスト（開始番号）が対応タグで描画される', async () => {
    const html = await render('# 見出し\n**太字**と`code`\n\n3. 三\n4. 四')
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>太字</strong>')
    expect(html).toContain('<code')
    expect(html).toContain('start="3"')
  })
})
