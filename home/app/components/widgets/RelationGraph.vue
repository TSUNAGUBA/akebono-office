<script lang="ts">
/** マーカー ID の重複回避用カウンタ（同一ページに複数グラフを置けるように。決定的採番） */
let graphSeq = 0
</script>

<script setup lang="ts">
/**
 * 関係グラフ（F-10-6）: Obsidian 風 force-directed グラフ
 * - 物理レイアウト: 反発 + ばね + 中心重力（純ロジック = ~/utils/force-graph。初期配置は id シードで決定的・乱数不使用）
 * - 操作: ノードドラッグ = 物理追従で移動 / 背景ドラッグ = パン / ホイール・ピンチ = ズーム / クリック = 選択（select を emit）
 * - 選択中: 接続エッジをブランド色でハイライト・無関係エッジ/ノードは減光（ラベルは読める濃度を維持）
 * - prefers-reduced-motion: reduce では同期整定して静的描画（アニメーションなし）
 * - エッジ: 矢印マーカー + 中点ラベル（縮小時は非表示）。directed=false は両矢印。平行エッジは法線オフセット
 */
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ALPHA_MIN, clampScale, computeDegrees, DEFAULT_SIM_CONFIG, fitToBounds, initialPositions,
  nodeRadius, parallelEdgeOffsets, settle, type SimNode, simulateStep, type ViewTransform, zoomAtPoint,
} from '~/utils/force-graph'

export interface RelationGraphNode {
  id: string
  label: string
  kind?: string // 'self' は塗りつぶし表示
}

export interface RelationGraphEdge {
  id: string
  from: string
  to: string
  label: string
  directed: boolean
}

const props = withDefaults(defineProps<{
  nodes: RelationGraphNode[]
  edges: RelationGraphEdge[]
  /** 選択中ノード（ハイライト表示） */
  selectedId?: string | null
}>(), { selectedId: null })

const emit = defineEmits<{ select: [id: string] }>()

const gid = `rg-${++graphSeq}`

/** クリックとドラッグを区別する移動しきい値（画面 px） */
const CLICK_THRESHOLD = 5
/** エッジラベルを表示する最小ズーム倍率 */
const EDGE_LABEL_MIN_SCALE = 0.6

// ---- シミュレーション状態（非リアクティブ。tick の増分で描画を駆動） ----
let sim: SimNode[] = initialPositions(props.nodes)
let alpha = 1
let rafId: number | null = null
let reducedMotion = false
const tick = ref(0)

// ---- ビュー（ズーム/パン） ----
const containerRef = ref<HTMLDivElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const viewW = ref(800)
const viewH = ref(420)
const view = ref<ViewTransform>(fitToBounds(sim, viewW.value, viewH.value))
/** ユーザーがズーム/パン/ドラッグしたら整定までの自動フィットを止める */
let userAdjusted = false
let resizeObserver: ResizeObserver | null = null

function measure(): void {
  const el = containerRef.value
  if (!el) return
  viewW.value = el.clientWidth || viewW.value
  viewH.value = el.clientHeight || viewH.value
}

function fitView(): void {
  if (sim.length === 0) return
  view.value = fitToBounds(sim, viewW.value, viewH.value)
}

// ---- シミュレーションループ ----
function startLoop(): void {
  if (typeof window === 'undefined' || rafId != null) return
  const step = (): void => {
    rafId = null
    alpha = simulateStep(sim, props.edges, alpha)
    tick.value++
    if (!userAdjusted) fitView()
    if (alpha >= ALPHA_MIN || dragNodeId != null) rafId = window.requestAnimationFrame(step)
  }
  rafId = window.requestAnimationFrame(step)
}

/** alpha を持ち上げて再加熱。reduced-motion 時は同期整定して静的更新 */
function reheat(a: number): void {
  alpha = Math.max(alpha, a)
  if (reducedMotion) {
    alpha = settle(sim, props.edges, DEFAULT_SIM_CONFIG, alpha)
    tick.value++
    if (!userAdjusted) fitView()
  }
  else {
    startLoop()
  }
}

/** props 変化時の再構築: 既存ノードの位置は保持し、新ノードのみシード配置（進捗を巻き戻さない） */
function rebuild(): void {
  const prev = new Map(sim.map(n => [n.id, n]))
  sim = initialPositions(props.nodes).map((fresh) => {
    const old = prev.get(fresh.id)
    return old ? { ...old, fx: null, fy: null } : fresh
  })
  alpha = 1
  reheat(1)
  tick.value++
}

watch([() => props.nodes, () => props.edges], rebuild)

onMounted(() => {
  reducedMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      measure()
      if (!userAdjusted) fitView()
    })
    if (containerRef.value) resizeObserver.observe(containerRef.value)
  }
  if (reducedMotion) {
    alpha = settle(sim, props.edges)
    tick.value++
    fitView()
  }
  else {
    fitView()
    startLoop()
  }
})

// 空 → 非空でコンテナが後から現れるケース（v-else 切替）に追随
watch(containerRef, (el, old) => {
  if (resizeObserver && old) resizeObserver.unobserve(old)
  if (resizeObserver && el) resizeObserver.observe(el)
  if (el) {
    measure()
    if (!userAdjusted) fitView()
  }
})

onBeforeUnmount(() => {
  if (rafId != null && typeof window !== 'undefined') window.cancelAnimationFrame(rafId)
  rafId = null
  resizeObserver?.disconnect()
  resizeObserver = null
})

// ---- 座標変換ヘルパー ----
function localPoint(e: { clientX: number, clientY: number }): { x: number, y: number } {
  const rect = svgRef.value?.getBoundingClientRect()
  return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 }
}

function toWorld(p: { x: number, y: number }): { x: number, y: number } {
  const t = view.value
  return { x: (p.x - t.x) / t.k, y: (p.y - t.y) / t.k }
}

// ---- ポインタ操作（ノードドラッグ / パン / ピンチ） ----
type PointerMode = 'none' | 'maybe-node' | 'node-drag' | 'pan' | 'pinch'
let mode: PointerMode = 'none'
const activePointers = new Map<number, { x: number, y: number }>()
let dragNodeId: string | null = null
let pressPoint = { x: 0, y: 0 }
let pinchStart: { d: number, k: number, wx: number, wy: number } | null = null

function registerPointer(e: PointerEvent): void {
  activePointers.set(e.pointerId, localPoint(e))
  svgRef.value?.setPointerCapture(e.pointerId)
}

function beginPinch(): void {
  if (dragNodeId) {
    freeDragNode()
    dragNodeId = null
  }
  const pts = [...activePointers.values()]
  const p1 = pts[0]
  const p2 = pts[1]
  if (!p1 || !p2) return
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
  const w = toWorld(mid)
  pinchStart = { d: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)), k: view.value.k, wx: w.x, wy: w.y }
  mode = 'pinch'
  userAdjusted = true
}

function onNodePointerDown(e: PointerEvent, id: string): void {
  e.stopPropagation()
  e.preventDefault()
  registerPointer(e)
  if (activePointers.size >= 2) {
    beginPinch()
    return
  }
  mode = 'maybe-node'
  dragNodeId = id
  pressPoint = localPoint(e)
}

function onSvgPointerDown(e: PointerEvent): void {
  e.preventDefault()
  registerPointer(e)
  if (activePointers.size >= 2) {
    beginPinch()
    return
  }
  mode = 'pan'
}

function pinDragNode(p: { x: number, y: number }): void {
  const node = sim.find(n => n.id === dragNodeId)
  if (!node) return
  const w = toWorld(p)
  node.fx = w.x
  node.fy = w.y
}

function freeDragNode(): void {
  const node = sim.find(n => n.id === dragNodeId)
  if (node) {
    node.fx = null
    node.fy = null
  }
}

function onSvgPointerMove(e: PointerEvent): void {
  const prev = activePointers.get(e.pointerId)
  if (!prev) return
  const cur = localPoint(e)
  activePointers.set(e.pointerId, cur)

  if (mode === 'maybe-node' && dragNodeId) {
    if (Math.hypot(cur.x - pressPoint.x, cur.y - pressPoint.y) > CLICK_THRESHOLD) {
      mode = 'node-drag'
      userAdjusted = true
      pinDragNode(cur)
      reheat(0.5)
    }
    return
  }
  if (mode === 'node-drag' && dragNodeId) {
    pinDragNode(cur)
    reheat(0.3)
    return
  }
  if (mode === 'pan') {
    userAdjusted = true
    view.value = { ...view.value, x: view.value.x + (cur.x - prev.x), y: view.value.y + (cur.y - prev.y) }
    return
  }
  if (mode === 'pinch' && pinchStart) {
    const pts = [...activePointers.values()]
    const p1 = pts[0]
    const p2 = pts[1]
    if (!p1 || !p2) return
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
    const d = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y))
    const k = clampScale(pinchStart.k * (d / pinchStart.d))
    view.value = { k, x: mid.x - pinchStart.wx * k, y: mid.y - pinchStart.wy * k }
  }
}

function releasePointer(e: PointerEvent): void {
  activePointers.delete(e.pointerId)
  const svg = svgRef.value
  if (svg && svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId)
}

function onSvgPointerUp(e: PointerEvent): void {
  if (!activePointers.has(e.pointerId)) return
  releasePointer(e)
  if (mode === 'maybe-node' && dragNodeId) {
    // 移動しきい値未満 = クリック → 選択トグル（トグル自体はページ側の責務）
    const id = dragNodeId
    dragNodeId = null
    mode = 'none'
    emit('select', id)
    return
  }
  if (mode === 'node-drag') {
    freeDragNode()
    dragNodeId = null
    mode = 'none'
    reheat(0.3)
    return
  }
  if (mode === 'pinch') {
    pinchStart = null
    mode = activePointers.size === 1 ? 'pan' : 'none'
    return
  }
  if (activePointers.size === 0) mode = 'none'
}

function onSvgPointerCancel(e: PointerEvent): void {
  if (!activePointers.has(e.pointerId)) return
  releasePointer(e)
  if (dragNodeId) {
    freeDragNode()
    dragNodeId = null
    reheat(0.3)
  }
  pinchStart = null
  mode = activePointers.size === 1 ? 'pan' : 'none'
}

// ---- ズーム操作 ----
function onWheel(e: WheelEvent): void {
  userAdjusted = true
  const pt = localPoint(e)
  view.value = zoomAtPoint(view.value, pt.x, pt.y, Math.exp(-e.deltaY * 0.0015))
}

function zoomBy(factor: number): void {
  userAdjusted = true
  view.value = zoomAtPoint(view.value, viewW.value / 2, viewH.value / 2, factor)
}

function onFit(): void {
  // 全体表示 = 自動フィットへ復帰（整定中でも画角内に収まり続ける）
  userAdjusted = false
  measure()
  fitView()
}

// ---- 描画用データ ----
const degrees = computed(() => computeDegrees(props.nodes.map(n => n.id), props.edges))

/** 選択ノード + 隣接ノードの集合（null = 選択なし） */
const neighborIds = computed<Set<string> | null>(() => {
  if (!props.selectedId) return null
  const s = new Set<string>([props.selectedId])
  for (const e of props.edges) {
    if (e.from === props.selectedId) s.add(e.to)
    if (e.to === props.selectedId) s.add(e.from)
  }
  return s
})

interface RenderNode {
  id: string
  label: string
  kind?: string
  x: number
  y: number
  r: number
  dim: boolean
}

const renderNodes = computed<RenderNode[]>(() => {
  void tick.value
  const nb = neighborIds.value
  const meta = new Map(props.nodes.map(n => [n.id, n]))
  return sim.map((s) => {
    const m = meta.get(s.id)
    return {
      id: s.id,
      label: m?.label ?? s.id,
      kind: m?.kind,
      x: s.x,
      y: s.y,
      r: nodeRadius(degrees.value.get(s.id) ?? 0),
      dim: nb != null && !nb.has(s.id),
    }
  })
})

type EdgeState = 'active' | 'dim' | 'normal'

interface RenderEdge extends RelationGraphEdge {
  x1: number
  y1: number
  x2: number
  y2: number
  lx: number
  ly: number
  state: EdgeState
}

const edgeOffsets = computed(() => parallelEdgeOffsets(props.edges))

const renderEdges = computed<RenderEdge[]>(() => {
  void tick.value
  const pos = new Map(sim.map(n => [n.id, n]))
  const out: RenderEdge[] = []
  for (const e of props.edges) {
    if (e.from === e.to) continue // 自己ループは描画しない
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    const off = edgeOffsets.value.get(e.id) ?? 0
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const nx = -uy * off
    const ny = ux * off
    const ra = nodeRadius(degrees.value.get(e.from) ?? 0)
    const rb = nodeRadius(degrees.value.get(e.to) ?? 0)
    const x1 = a.x + ux * (ra + 4) + nx
    const y1 = a.y + uy * (ra + 4) + ny
    const x2 = b.x - ux * (rb + 9) + nx
    const y2 = b.y - uy * (rb + 9) + ny
    const state: EdgeState = props.selectedId == null
      ? 'normal'
      : (e.from === props.selectedId || e.to === props.selectedId) ? 'active' : 'dim'
    out.push({ ...e, x1, y1, x2, y2, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2, state })
  }
  return out
})

/** 縮小時はエッジラベルを隠してごちゃつきを抑える */
const showEdgeLabels = computed(() => view.value.k >= EDGE_LABEL_MIN_SCALE)

const MARKER_STATES = ['normal', 'active', 'dim'] as const

const EDGE_STROKE: Record<EdgeState, string> = {
  active: 'var(--c-brand)',
  dim: 'var(--c-line)',
  normal: 'var(--c-muted)',
}

function markerUrl(state: EdgeState): string {
  return `url(#${gid}-arrow-${state})`
}
</script>

<template>
  <UiEmptyState v-if="nodes.length === 0" icon="Waypoints" title="表示するノードがありません" />
  <div v-else>
    <div
      ref="containerRef"
      class="relative h-[420px] w-full select-none overflow-hidden rounded-lg border border-line bg-surface md:h-[560px]"
      role="application"
      :aria-label="`関係グラフ（ノード ${nodes.length} 件・関係 ${edges.length} 件）`"
    >
      <svg
        ref="svgRef"
        class="graph-svg block h-full w-full"
        @pointerdown="onSvgPointerDown"
        @pointermove="onSvgPointerMove"
        @pointerup="onSvgPointerUp"
        @pointercancel="onSvgPointerCancel"
        @wheel.prevent="onWheel"
      >
        <defs>
          <marker
            v-for="state in MARKER_STATES"
            :id="`${gid}-arrow-${state}`"
            :key="state"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" :fill="EDGE_STROKE[state]" />
          </marker>
        </defs>

        <g :transform="`translate(${view.x} ${view.y}) scale(${view.k})`">
          <!-- エッジ -->
          <g>
            <template v-for="e in renderEdges" :key="e.id">
              <line
                :x1="e.x1"
                :y1="e.y1"
                :x2="e.x2"
                :y2="e.y2"
                :stroke="EDGE_STROKE[e.state]"
                stroke-width="1.5"
                :marker-end="markerUrl(e.state)"
                :marker-start="e.directed ? undefined : markerUrl(e.state)"
              />
              <text
                v-if="showEdgeLabels"
                :x="e.lx"
                :y="e.ly - 5"
                text-anchor="middle"
                class="edge-label"
                :class="{ 'is-active': e.state === 'active', 'is-dim': e.state === 'dim' }"
              >{{ e.label }}</text>
            </template>
          </g>

          <!-- ノード（バブル） -->
          <g>
            <g
              v-for="p in renderNodes"
              :key="p.id"
              role="button"
              tabindex="0"
              class="node-hit"
              :class="{ 'is-dim': p.dim }"
              :aria-label="`${p.label} を選択`"
              :aria-pressed="selectedId === p.id"
              @pointerdown="onNodePointerDown($event, p.id)"
              @keydown.enter.prevent="emit('select', p.id)"
              @keydown.space.prevent="emit('select', p.id)"
            >
              <!-- タッチターゲット拡大用の透明ヒットエリア -->
              <circle :cx="p.x" :cy="p.y" :r="Math.max(22, p.r + 8)" fill="transparent" />
              <circle
                :cx="p.x"
                :cy="p.y"
                :r="p.r"
                class="node-bubble"
                :fill="p.kind === 'self' ? 'var(--c-brand)' : 'var(--c-surface)'"
                :stroke="selectedId === p.id ? 'var(--c-brand)' : 'var(--c-line-strong)'"
                :stroke-width="selectedId === p.id ? 3 : 1.5"
              />
              <text
                :x="p.x"
                :y="p.y + p.r + 14"
                text-anchor="middle"
                class="node-label"
                :class="{ 'is-active': selectedId === p.id }"
              >{{ p.label }}</text>
            </g>
          </g>
        </g>
      </svg>

      <!-- ズーム操作（44px タッチターゲット） -->
      <div class="absolute right-2 top-2 flex flex-col gap-1">
        <button type="button" class="btn graph-ctl" aria-label="拡大" @click="zoomBy(1.4)">
          <ZoomIn class="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" class="btn graph-ctl" aria-label="縮小" @click="zoomBy(1 / 1.4)">
          <ZoomOut class="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" class="btn graph-ctl" aria-label="全体表示" @click="onFit">
          <Maximize2 class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
    <p class="mt-1.5 text-[11px] text-muted">
      バブルをドラッグで移動、背景ドラッグでパン、ホイール/ピンチで拡大縮小、クリックで関係をハイライト
    </p>
  </div>
</template>

<style scoped>
.graph-svg {
  touch-action: none;
  cursor: grab;
}
.graph-ctl {
  width: 44px;
  height: 44px;
  padding: 0;
}
.node-hit {
  cursor: pointer;
  outline: none;
}
.node-hit:focus-visible .node-bubble {
  stroke: var(--c-brand);
}
.node-hit.is-dim .node-bubble {
  opacity: 0.35;
}
.node-hit.is-dim .node-label {
  opacity: 0.6;
}
.node-label {
  font-size: 11px;
  font-weight: 600;
  fill: var(--c-ink);
  paint-order: stroke;
  stroke: var(--c-surface);
  stroke-width: 3px;
  stroke-linejoin: round;
}
.node-label.is-active {
  fill: var(--c-brand);
}
.edge-label {
  font-size: 10px;
  fill: var(--c-sub);
  paint-order: stroke;
  stroke: var(--c-surface);
  stroke-width: 3px;
  stroke-linejoin: round;
}
.edge-label.is-active {
  fill: var(--c-brand);
  font-weight: 700;
}
.edge-label.is-dim {
  fill: var(--c-muted);
  opacity: 0.6;
}
</style>
