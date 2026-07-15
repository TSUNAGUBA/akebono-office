<script lang="ts">
/** マーカー ID の重複回避用カウンタ（同一ページに複数グラフを置けるように。決定的採番） */
let graphSeq = 0
</script>

<script setup lang="ts">
/**
 * 関係グラフ（F-10-6）: SVG 円環レイアウトの有向グラフ
 * - 決定的配置: ノードを id 順にソートし角度を均等配置（乱数不使用）
 * - エッジ: 直線 + 矢印マーカー + 中点ラベル。directed=false は両矢印
 * - ノードクリックで select を emit（選択中ノードと接続エッジをハイライト）
 * - モバイル: 横スクロール可能なコンテナに収める
 */

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

const NODE_R = 9
/** ラベル（日本語社名）がはみ出さないよう外周に余白を確保 */
const PAD = 120

/** id 順ソート = 決定的な角度割当 */
const sortedNodes = computed(() => [...props.nodes].sort((a, b) => a.id.localeCompare(b.id)))
const ringR = computed(() => Math.max(120, sortedNodes.value.length * 24))
const size = computed(() => (ringR.value + PAD) * 2)
const center = computed(() => ringR.value + PAD)

interface PlacedNode extends RelationGraphNode {
  x: number
  y: number
  cos: number
  sin: number
}

const placedNodes = computed<PlacedNode[]>(() => {
  const n = Math.max(1, sortedNodes.value.length)
  return sortedNodes.value.map((node, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    return { ...node, cos, sin, x: center.value + ringR.value * cos, y: center.value + ringR.value * sin }
  })
})

const posMap = computed(() => new Map(placedNodes.value.map(p => [p.id, p] as [string, PlacedNode])))

type EdgeState = 'active' | 'dim' | 'normal'

interface PlacedEdge extends RelationGraphEdge {
  x1: number
  y1: number
  x2: number
  y2: number
  lx: number
  ly: number
  state: EdgeState
}

const placedEdges = computed<PlacedEdge[]>(() => {
  // 同一ペア間の平行エッジは法線方向にずらして重なりを避ける
  const pairCount = new Map<string, number>()
  for (const e of props.edges) {
    const k = [e.from, e.to].sort().join('|')
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1)
  }
  const pairSeen = new Map<string, number>()
  const out: PlacedEdge[] = []
  for (const e of props.edges) {
    const a = posMap.value.get(e.from)
    const b = posMap.value.get(e.to)
    if (!a || !b || e.from === e.to) continue
    const k = [e.from, e.to].sort().join('|')
    const idx = pairSeen.get(k) ?? 0
    pairSeen.set(k, idx + 1)
    const m = pairCount.get(k) ?? 1
    const off = (idx - (m - 1) / 2) * 14

    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const nx = -uy * off
    const ny = ux * off

    const x1 = a.x + ux * (NODE_R + 4) + nx
    const y1 = a.y + uy * (NODE_R + 4) + ny
    const x2 = b.x - ux * (NODE_R + 9) + nx
    const y2 = b.y - uy * (NODE_R + 9) + ny

    const state: EdgeState = props.selectedId == null
      ? 'normal'
      : (e.from === props.selectedId || e.to === props.selectedId) ? 'active' : 'dim'

    out.push({ ...e, x1, y1, x2, y2, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2, state })
  }
  return out
})

const MARKER_STATES = ['normal', 'active', 'dim'] as const

const EDGE_STROKE: Record<EdgeState, string> = {
  active: 'var(--c-brand)',
  dim: 'var(--c-line)',
  normal: 'var(--c-muted)',
}

function markerUrl(state: EdgeState): string {
  return `url(#${gid}-arrow-${state})`
}

function labelAnchor(p: PlacedNode): string {
  if (p.cos > 0.35) return 'start'
  if (p.cos < -0.35) return 'end'
  return 'middle'
}

function labelX(p: PlacedNode): number {
  return p.x + p.cos * (NODE_R + 12)
}

function labelY(p: PlacedNode): number {
  return p.y + p.sin * (NODE_R + 16) + 4
}
</script>

<template>
  <UiEmptyState v-if="nodes.length === 0" icon="Waypoints" title="表示するノードがありません" />
  <div v-else class="overflow-x-auto scroll-slim">
    <svg
      :width="size"
      :height="size"
      :viewBox="`0 0 ${size} ${size}`"
      class="mx-auto block"
      role="img"
      :aria-label="`関係グラフ（ノード ${nodes.length} 件・関係 ${edges.length} 件）`"
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

      <!-- エッジ -->
      <g>
        <template v-for="e in placedEdges" :key="e.id">
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
            :x="e.lx"
            :y="e.ly - 5"
            text-anchor="middle"
            class="edge-label"
            :class="{ 'is-active': e.state === 'active', 'is-dim': e.state === 'dim' }"
          >{{ e.label }}</text>
        </template>
      </g>

      <!-- ノード -->
      <g>
        <g
          v-for="p in placedNodes"
          :key="p.id"
          role="button"
          tabindex="0"
          class="node-hit"
          :aria-label="`${p.label} を選択`"
          :aria-pressed="selectedId === p.id"
          @click="emit('select', p.id)"
          @keydown.enter.prevent="emit('select', p.id)"
          @keydown.space.prevent="emit('select', p.id)"
        >
          <!-- タッチターゲット拡大用の透明ヒットエリア -->
          <circle :cx="p.x" :cy="p.y" r="22" fill="transparent" />
          <circle
            :cx="p.x"
            :cy="p.y"
            :r="NODE_R"
            :fill="p.kind === 'self' ? 'var(--c-brand)' : 'var(--c-surface)'"
            :stroke="selectedId === p.id ? 'var(--c-brand)' : 'var(--c-line-strong)'"
            :stroke-width="selectedId === p.id ? 3 : 1.5"
          />
          <text
            :x="labelX(p)"
            :y="labelY(p)"
            :text-anchor="labelAnchor(p)"
            class="node-label"
            :class="{ 'is-active': selectedId === p.id }"
          >{{ p.label }}</text>
        </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.node-hit {
  cursor: pointer;
  outline: none;
}
.node-hit:focus-visible circle:last-of-type {
  stroke: var(--c-brand);
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
