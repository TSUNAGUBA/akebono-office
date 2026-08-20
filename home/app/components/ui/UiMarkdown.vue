<script setup lang="ts">
/**
 * マークダウン描画（安全なサブセット。バッチ7e）。
 * utils/markdown.ts の AST を VNode で直接描画する（v-html 不使用 = XSS が構造的に成立しない）。
 * 議事録・日報・週報・ぽいぽいポスト・AI チャット応答の本文表示に使う。
 * routes（AI チャット対応 2026-08-20）: アプリ内パス → 表示名の許可リスト。指定時は本文中の
 * 一致パスを画面リンクへ変換する（ハッシュルーティングのため href="#<path>" のアンカーで遷移できる =
 * NuxtLink 非依存。未指定時は従来どおり = 既存呼び出し元の挙動不変）
 */
import { h } from 'vue'
import type { VNode } from 'vue'
import type { MdInline } from '~/utils/markdown'
import { linkifyRoutes, parseMarkdown } from '~/utils/markdown'

const props = defineProps<{ source: string; routes?: Record<string, string> }>()

function inline(nodes: MdInline[]): (VNode | string)[] {
  return nodes.map((n) => {
    if (n.t === 'bold') return h('strong', n.text)
    if (n.t === 'code') return h('code', { class: 'rounded bg-surface-soft border border-line px-1 text-[12px]' }, n.text)
    if (n.t === 'link') {
      return h('a', {
        href: n.href, target: '_blank', rel: 'noopener noreferrer',
        class: 'text-brand underline underline-offset-2',
      }, n.text)
    }
    if (n.t === 'route') return h('a', { href: `#${n.path}`, class: 'link font-semibold' }, n.label)
    return n.text
  })
}

/** 行配列を <br> 区切りで並べる（パラグラフ・引用内の改行保持） */
function joinLines(lines: MdInline[][]): (VNode | string)[] {
  return lines.flatMap((l, idx) => (idx === 0 ? inline(l) : [h('br'), ...inline(l)]))
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[15px] font-bold mt-2',
  2: 'text-[14px] font-bold mt-2',
  3: 'text-[13px] font-bold mt-1.5',
  4: 'text-[13px] font-semibold mt-1',
}

function render(): VNode {
  const parsed = parseMarkdown(props.source)
  const blocks = props.routes ? linkifyRoutes(parsed, props.routes) : parsed
  return h('div', { class: 'grid gap-1.5 text-[13px] leading-relaxed' }, blocks.map((b) => {
    if (b.t === 'heading') return h(`h${b.level}`, { class: HEADING_CLASS[b.level] }, inline(b.inline))
    if (b.t === 'ul') return h('ul', { class: 'list-disc pl-5 grid gap-0.5' }, b.items.map(it => h('li', inline(it))))
    if (b.t === 'ol') {
      return h('ol', { class: 'list-decimal pl-5 grid gap-0.5', start: b.start !== 1 ? b.start : undefined },
        b.items.map(it => h('li', inline(it))))
    }
    if (b.t === 'quote') {
      return h('blockquote', { class: 'border-l-2 border-line pl-3 text-sub' }, joinLines(b.lines))
    }
    if (b.t === 'codeblock') {
      return h('pre', { class: 'overflow-x-auto rounded-lg bg-surface-soft border border-line p-2.5 text-[12px]' },
        h('code', b.code))
    }
    if (b.t === 'hr') return h('hr', { class: 'border-line' })
    if (b.t === 'table') {
      // 横に長い表は表内スクロール（モバイル対応 = 原則8。吹き出し・カードの幅を壊さない）
      return h('div', { class: 'overflow-x-auto' }, h('table', { class: 'w-full border-collapse text-[12px]' }, [
        h('thead', h('tr', b.header.map(cell =>
          h('th', { scope: 'col', class: 'border border-line bg-surface-soft px-2 py-1 text-left font-semibold' }, inline(cell))))),
        h('tbody', b.rows.map(row => h('tr', row.map(cell =>
          h('td', { class: 'border border-line px-2 py-1 align-top' }, inline(cell)))))),
      ]))
    }
    return h('p', { class: 'whitespace-normal' }, joinLines(b.lines))
  }))
}
</script>

<template>
  <render />
</template>
