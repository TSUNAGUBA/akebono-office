/**
 * 関係グラフの force-directed レイアウト純ロジック（utils/force-graph.ts）。
 * - 決定性（同じ入力 → 同じ配置。乱数不使用の担保）
 * - 数値安定性（多ステップ後も NaN なし・alpha 単調減衰）
 * - レイアウト品質（接続ペアは非接続ペアより近くに整定する統計的性質）
 * - ビュー変換（カーソル不動点ズーム・クランプ・フィット）・次数・平行エッジオフセット
 * - RelationGraph.vue の SSR スモーク描画（マークアップが壊れていないこと）
 */
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import {
  ALPHA_MIN,
  clampScale,
  computeDegrees,
  DEFAULT_SIM_CONFIG,
  fitToBounds,
  initialPositions,
  nodeRadius,
  parallelEdgeOffsets,
  SCALE_MAX,
  SCALE_MIN,
  settle,
  type SimNode,
  simulateStep,
  zoomAtPoint,
} from '~/utils/force-graph'
import RelationGraph from '../app/components/widgets/RelationGraph.vue'

const ids = (n: number, prefix = 'n'): { id: string }[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}` }))

describe('initialPositions', () => {
  it('同じ入力は常に同じ配置（決定的シード）', () => {
    const a = initialPositions(ids(8))
    const b = initialPositions(ids(8))
    expect(a).toEqual(b)
  })
  it('ノードごとに異なる位置・速度ゼロ・ピンなしで初期化', () => {
    const nodes = initialPositions(ids(6))
    const keys = new Set(nodes.map(n => `${n.x.toFixed(4)},${n.y.toFixed(4)}`))
    expect(keys.size).toBe(6)
    for (const n of nodes) {
      expect(n.vx).toBe(0)
      expect(n.vy).toBe(0)
      expect(n.fx).toBeNull()
      expect(n.fy).toBeNull()
    }
  })
})

describe('simulateStep / settle', () => {
  const edges = [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
    { from: 'n3', to: 'n3' }, // 自己ループはスキップ
    { from: 'n1', to: 'ghost' }, // 欠損端点はスキップ
  ]

  it('多ステップ後も NaN / Infinity が発生しない', () => {
    const nodes = initialPositions(ids(9))
    let alpha = 1
    for (let s = 0; s < 500; s++) alpha = simulateStep(nodes, edges, alpha)
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
      expect(Number.isFinite(n.vx)).toBe(true)
      expect(Number.isFinite(n.vy)).toBe(true)
    }
  })

  it('alpha は単調に減衰し、settle で ALPHA_MIN を下回る', () => {
    const nodes = initialPositions(ids(5))
    let alpha = 1
    for (let s = 0; s < 50; s++) {
      const next = simulateStep(nodes, edges, alpha)
      expect(next).toBeLessThan(alpha)
      alpha = next
    }
    const final = settle(initialPositions(ids(5)), edges)
    expect(final).toBeLessThan(ALPHA_MIN)
  })

  it('同じ入力から settle した結果は完全に一致する（決定性）', () => {
    const a = initialPositions(ids(7))
    const b = initialPositions(ids(7))
    settle(a, edges)
    settle(b, edges)
    expect(a).toEqual(b)
  })

  it('空グラフは 0 を返し、ノード 0 件でも壊れない', () => {
    expect(simulateStep([], [], 1)).toBe(0)
  })

  it('ピン留め（fx/fy）ノードは指定座標に固定される', () => {
    const nodes = initialPositions(ids(4))
    const pinned = nodes[0]!
    pinned.fx = 123
    pinned.fy = -45
    let alpha = 1
    for (let s = 0; s < 30; s++) alpha = simulateStep(nodes, [{ from: 'n1', to: 'n2' }], alpha)
    expect(pinned.x).toBe(123)
    expect(pinned.y).toBe(-45)
    expect(pinned.vx).toBe(0)
    expect(pinned.vy).toBe(0)
  })

  it('接続されたノード群は非接続ノード群より近くに整定する（統計的性質）', () => {
    // 三角形クラスタ 2 つ（クラスタ間エッジなし）
    const nodes = initialPositions([...ids(3, 'a'), ...ids(3, 'b')])
    const connected: [string, string][] = [
      ['a1', 'a2'], ['a2', 'a3'], ['a1', 'a3'],
      ['b1', 'b2'], ['b2', 'b3'], ['b1', 'b3'],
    ]
    settle(nodes, connected.map(([from, to]) => ({ from, to })))
    const pos = new Map(nodes.map(n => [n.id, n]))
    const dist = (p: string, q: string): number => {
      const a = pos.get(p)!
      const b = pos.get(q)!
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const connMean = connected.reduce((s, [p, q]) => s + dist(p, q), 0) / connected.length
    const cross: number[] = []
    for (const a of ['a1', 'a2', 'a3']) {
      for (const b of ['b1', 'b2', 'b3']) cross.push(dist(a, b))
    }
    const crossMean = cross.reduce((s, d) => s + d, 0) / cross.length
    expect(connMean).toBeLessThan(crossMean)
  })
})

describe('computeDegrees / nodeRadius', () => {
  it('次数を数える（自己ループ・未知端点は無視）', () => {
    const deg = computeDegrees(['a', 'b', 'c'], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'c' },
      { from: 'a', to: 'zzz' },
    ])
    expect(deg.get('a')).toBe(1)
    expect(deg.get('b')).toBe(2)
    expect(deg.get('c')).toBe(1)
    expect(deg.has('zzz')).toBe(false)
  })
  it('半径は次数でスケールし上限あり', () => {
    expect(nodeRadius(0)).toBe(8)
    expect(nodeRadius(2)).toBe(11)
    expect(nodeRadius(100)).toBe(18) // 8 + min(10, ...)
  })
})

describe('zoomAtPoint / clampScale', () => {
  it('カーソル直下のワールド座標が不動点になる', () => {
    const t = { x: 40, y: -20, k: 1.2 }
    const [px, py] = [300, 180]
    const before = { x: (px - t.x) / t.k, y: (py - t.y) / t.k }
    const z = zoomAtPoint(t, px, py, 1.5)
    expect(z.k).toBeCloseTo(1.8)
    expect((px - z.x) / z.k).toBeCloseTo(before.x)
    expect((py - z.y) / z.k).toBeCloseTo(before.y)
  })
  it('スケールは [SCALE_MIN, SCALE_MAX] にクランプされる', () => {
    expect(zoomAtPoint({ x: 0, y: 0, k: 3 }, 0, 0, 10).k).toBe(SCALE_MAX)
    expect(zoomAtPoint({ x: 0, y: 0, k: 0.3 }, 0, 0, 0.01).k).toBe(SCALE_MIN)
    expect(clampScale(999)).toBe(SCALE_MAX)
    expect(clampScale(0)).toBe(SCALE_MIN)
    expect(clampScale(1)).toBe(1)
  })
})

describe('fitToBounds', () => {
  it('バウンディングボックスを padding 込みで中央に収める', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1000, y: 500 }, { x: 400, y: 200 }]
    const t = fitToBounds(pts, 800, 600, 48)
    expect(t.k).toBeCloseTo(Math.min((800 - 96) / 1000, (600 - 96) / 500))
    // bbox 中心 (500, 250) が画面中心 (400, 300) に写る
    expect(500 * t.k + t.x).toBeCloseTo(400)
    expect(250 * t.k + t.y).toBeCloseTo(300)
  })
  it('単一ノードでも拡大しすぎない（k <= 1.5）・空でも壊れない', () => {
    const one = fitToBounds([{ x: 10, y: 10 }], 800, 420)
    expect(one.k).toBeLessThanOrEqual(1.5)
    expect(10 * one.k + one.x).toBeCloseTo(400)
    const empty = fitToBounds([], 800, 420)
    expect(empty.k).toBe(1)
  })
})

describe('parallelEdgeOffsets', () => {
  it('単独エッジはオフセット 0・自己ループは対象外', () => {
    const m = parallelEdgeOffsets([
      { id: 'e1', from: 'a', to: 'b' },
      { id: 'e2', from: 'c', to: 'c' },
    ])
    expect(m.get('e1')).toBe(0)
    expect(m.has('e2')).toBe(false)
  })
  it('同方向の平行エッジは対称に振り分けられる', () => {
    const m = parallelEdgeOffsets([
      { id: 'e1', from: 'a', to: 'b' },
      { id: 'e2', from: 'a', to: 'b' },
    ])
    expect(m.get('e1')).toBe(-7)
    expect(m.get('e2')).toBe(7)
  })
  it('逆方向どうしでも重ならない（ソート済みペア基準で符号正規化）', () => {
    const m = parallelEdgeOffsets([
      { id: 'e1', from: 'a', to: 'b' },
      { id: 'e2', from: 'b', to: 'a' },
    ])
    // 各エッジ自身の法線フレームの値を、共通（ソート済みペア）フレームへ戻して比較
    // e1 は from(a) < to(b) なので符号 +1、e2 は from(b) > to(a) なので符号 -1
    const c1 = (m.get('e1') ?? 0) * 1
    const c2 = (m.get('e2') ?? 0) * -1
    expect(Math.abs(c1 - c2)).toBeCloseTo(14)
  })
  it('3 本は中央 0 を挟んで等間隔', () => {
    const m = parallelEdgeOffsets([
      { id: 'e1', from: 'a', to: 'b' },
      { id: 'e2', from: 'a', to: 'b' },
      { id: 'e3', from: 'a', to: 'b' },
    ])
    expect([m.get('e1'), m.get('e2'), m.get('e3')]).toEqual([-14, 0, 14])
  })
})

describe('RelationGraph.vue スモーク描画（SSR）', () => {
  const stub = defineComponent({
    props: { icon: { type: String, default: '' }, title: { type: String, default: '' } },
    setup: props => () => h('div', { class: 'empty-stub' }, props.title),
  })

  interface GraphProps {
    nodes: { id: string, label: string, kind?: string }[]
    edges: { id: string, from: string, to: string, label: string, directed: boolean }[]
    selectedId?: string | null
  }

  const render = async (props: GraphProps): Promise<string> => {
    const app = createSSRApp({ render: () => h(RelationGraph, props) })
    app.component('UiEmptyState', stub)
    return renderToString(app)
  }

  it('ノード・エッジラベルと操作ヒント・ズームボタンが描画される', async () => {
    const html = await render({
      nodes: [
        { id: 'c1', label: '株式会社あけぼの', kind: 'self' },
        { id: 'c2', label: 'つなぐば' },
      ],
      edges: [{ id: 'r1', from: 'c1', to: 'c2', label: '取引先', directed: true }],
      selectedId: 'c1',
    })
    expect(html).toContain('株式会社あけぼの')
    expect(html).toContain('つなぐば')
    expect(html).toContain('取引先')
    expect(html).toContain('role="application"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="拡大"')
    expect(html).toContain('aria-label="縮小"')
    expect(html).toContain('aria-label="全体表示"')
    expect(html).toContain('バブルをドラッグで移動、背景ドラッグでパン、ホイール/ピンチで拡大縮小、クリックで関係をハイライト')
  })

  it('ノード 0 件は空状態を表示する', async () => {
    const html = await render({ nodes: [], edges: [] })
    expect(html).toContain('表示するノードがありません')
    expect(html).not.toContain('role="application"')
  })
})

// 型の輸出確認（コンパイル時チェック）
const _typeCheck: SimNode = { id: 'x', x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null }
void _typeCheck
void DEFAULT_SIM_CONFIG
