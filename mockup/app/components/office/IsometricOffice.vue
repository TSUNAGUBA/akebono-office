<script setup lang="ts">
/**
 * 2.5D アイソメトリックオフィス（F-08-1）
 * インライン SVG のみで描画（画像アセット不使用）。菱形グリッドの床 4×3 に
 * AI 社員のデスクとアバターを deskPosition で配置し、状態をアニメーション表現する。
 *   working = 緑パルス / waiting_approval = 橙バッジ / idle = グレー
 * クリック（Enter/Space 可）で select イベントを emit する。
 */
import type { AiEmployee } from '~/types/domain'
import { AI_EMPLOYEE_STATUS_LABELS } from '~/utils/labels'

const props = defineProps<{
  employees: AiEmployee[]
  /** AI 社員 ID → ロール名（ラベル表示用） */
  roleNames: Record<string, string>
  selectedId?: string | null
}>()

const emit = defineEmits<{ select: [aiEmployeeId: string] }>()

// ---------- アイソメ座標系 ----------
const TILE_W = 150
const TILE_H = 75
const GRID_X = 4
const GRID_Y = 3
const OX = 320 // 原点（タイル 0,0 の中心 x）
const OY = 116
const DESK_Z = 26 // デスク天板の高さ
const DESK_S = 0.62 // デスクのタイル占有率

function center(x: number, y: number): { cx: number; cy: number } {
  return {
    cx: OX + (x - y) * (TILE_W / 2),
    cy: OY + (x + y) * (TILE_H / 2),
  }
}

/** 菱形の points 文字列（中心 cx,cy、半幅 w2、半高 h2、上方向オフセット dz） */
function diamond(cx: number, cy: number, w2: number, h2: number, dz = 0): string {
  const yy = cy - dz
  return `${cx},${yy - h2} ${cx + w2},${yy} ${cx},${yy + h2} ${cx - w2},${yy}`
}

/** 箱の側面（右面 / 左面）ポリゴン */
function boxRight(cx: number, cy: number, w2: number, h2: number, dz: number): string {
  return `${cx + w2},${cy} ${cx},${cy + h2} ${cx},${cy + h2 - dz} ${cx + w2},${cy - dz}`
}
function boxLeft(cx: number, cy: number, w2: number, h2: number, dz: number): string {
  return `${cx - w2},${cy} ${cx},${cy + h2} ${cx},${cy + h2 - dz} ${cx - w2},${cy - dz}`
}

const floorTiles = computed(() => {
  const tiles: { key: string; points: string; alt: boolean }[] = []
  for (let y = 0; y < GRID_Y; y++) {
    for (let x = 0; x < GRID_X; x++) {
      const { cx, cy } = center(x, y)
      tiles.push({ key: `${x}-${y}`, points: diamond(cx, cy, TILE_W / 2, TILE_H / 2), alt: (x + y) % 2 === 1 })
    }
  }
  return tiles
})

interface DeskItem {
  emp: AiEmployee
  roleName: string
  cx: number
  cy: number
  depth: number
}

const desks = computed<DeskItem[]>(() =>
  props.employees
    .map((emp) => {
      const { cx, cy } = center(emp.deskPosition.x, emp.deskPosition.y)
      return { emp, roleName: props.roleNames[emp.id] ?? '', cx, cy, depth: emp.deskPosition.x + emp.deskPosition.y }
    })
    .sort((a, b) => a.depth - b.depth))

/** 観葉植物（空きマスに配置。全て SVG シェイプ） */
const plants = computed(() =>
  [{ x: 0, y: 0 }, { x: 3, y: 2 }].map(({ x, y }) => ({ key: `plant-${x}-${y}`, ...center(x, y) })))

/** ミーティングラグ（装飾） */
const rug = computed(() => center(0, 2))

const DW2 = (TILE_W / 2) * DESK_S
const DH2 = (TILE_H / 2) * DESK_S

const STATUS_COLOR: Record<AiEmployee['status'], string> = {
  working: 'var(--c-ok)',
  waiting_approval: 'var(--c-warn)',
  idle: 'var(--c-muted)',
}

function onKey(e: KeyboardEvent, id: string): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    emit('select', id)
  }
}
</script>

<template>
  <!-- モバイルは横スクロール可（ページ全体は横スクロールさせない） -->
  <div class="overflow-x-auto scroll-slim">
    <svg
      viewBox="0 0 640 400"
      class="block h-auto w-full min-w-[560px]"
      role="group"
      aria-label="AIオフィス空間（AI 社員をクリックすると詳細を表示）"
    >
      <!-- 床（菱形グリッド 4×3） -->
      <g>
        <polygon
          v-for="t in floorTiles"
          :key="t.key"
          :points="t.points"
          :fill="t.alt ? 'var(--c-page)' : 'var(--c-surface-soft)'"
          stroke="var(--c-line)"
          stroke-width="1"
        />
      </g>

      <!-- ラグ（装飾） -->
      <ellipse :cx="rug.cx" :cy="rug.cy" :rx="TILE_W / 2 * 0.55" :ry="TILE_H / 2 * 0.55" fill="var(--c-brand-soft)" opacity="0.8" />
      <ellipse :cx="rug.cx" :cy="rug.cy" :rx="TILE_W / 2 * 0.36" :ry="TILE_H / 2 * 0.36" fill="none" stroke="var(--c-brand)" stroke-width="1" opacity="0.25" />

      <!-- 観葉植物（装飾） -->
      <g v-for="p in plants" :key="p.key" aria-hidden="true">
        <ellipse :cx="p.cx" :cy="p.cy + 6" rx="16" ry="7" fill="var(--c-line)" />
        <polygon :points="`${p.cx - 10},${p.cy} ${p.cx + 10},${p.cy} ${p.cx + 6},${p.cy - 16} ${p.cx - 6},${p.cy - 16}`" fill="#c98d5f" />
        <ellipse :cx="p.cx - 8" :cy="p.cy - 26" rx="7" ry="12" fill="var(--c-ok)" opacity="0.75" transform-origin="center" :transform="`rotate(-24 ${p.cx - 8} ${p.cy - 26})`" />
        <ellipse :cx="p.cx + 8" :cy="p.cy - 26" rx="7" ry="12" fill="var(--c-ok)" opacity="0.75" :transform="`rotate(24 ${p.cx + 8} ${p.cy - 26})`" />
        <ellipse :cx="p.cx" :cy="p.cy - 32" rx="7" ry="14" fill="var(--c-ok)" />
      </g>

      <!-- デスク + AI 社員（奥から手前へ描画） -->
      <g
        v-for="d in desks"
        :key="d.emp.id"
        role="button"
        tabindex="0"
        class="desk-group cursor-pointer outline-none"
        :aria-label="`${d.emp.name}（${d.roleName} / ${AI_EMPLOYEE_STATUS_LABELS[d.emp.status]}）の詳細を開く`"
        @click="emit('select', d.emp.id)"
        @keydown="onKey($event, d.emp.id)"
      >
        <!-- 選択中タイルの強調 -->
        <polygon
          v-if="selectedId === d.emp.id"
          :points="diamond(d.cx, d.cy, TILE_W / 2, TILE_H / 2)"
          fill="var(--c-brand-soft)"
          stroke="var(--c-brand)"
          stroke-width="1.5"
        />

        <!-- デスク（アイソメの箱） -->
        <polygon :points="boxLeft(d.cx, d.cy, DW2, DH2, DESK_Z)" fill="#b9c0c9" />
        <polygon :points="boxRight(d.cx, d.cy, DW2, DH2, DESK_Z)" fill="#cdd3da" />
        <polygon :points="diamond(d.cx, d.cy, DW2, DH2, DESK_Z)" fill="var(--c-line)" stroke="var(--c-line-strong)" stroke-width="0.5" />
        <!-- モニター -->
        <polygon
          :points="`${d.cx + 6},${d.cy - DESK_Z - 2} ${d.cx + 26},${d.cy - DESK_Z - 12} ${d.cx + 26},${d.cy - DESK_Z - 28} ${d.cx + 6},${d.cy - DESK_Z - 18}`"
          fill="var(--c-sub)"
        />
        <polygon
          :points="`${d.cx + 8},${d.cy - DESK_Z - 5} ${d.cx + 24},${d.cy - DESK_Z - 13} ${d.cx + 24},${d.cy - DESK_Z - 25} ${d.cx + 8},${d.cy - DESK_Z - 17}`"
          fill="var(--c-brand-soft)"
        />

        <!-- アバター（円 + イニシャル） -->
        <g>
          <!-- working: 緑パルス -->
          <circle
            v-if="d.emp.status === 'working'"
            class="pulse-ring"
            :cx="d.cx - 14"
            :cy="d.cy - DESK_Z - 34"
            r="19"
            fill="none"
            :stroke="STATUS_COLOR.working"
            stroke-width="2"
          />
          <circle
            :cx="d.cx - 14"
            :cy="d.cy - DESK_Z - 34"
            r="16"
            fill="var(--c-surface)"
            :stroke="STATUS_COLOR[d.emp.status]"
            stroke-width="2.5"
          />
          <text
            :x="d.cx - 14"
            :y="d.cy - DESK_Z - 29"
            text-anchor="middle"
            class="select-none"
            :fill="'var(--c-ink)'"
            font-size="13"
            font-weight="700"
          >{{ d.emp.name.slice(0, 1) }}</text>
          <!-- waiting_approval: 橙バッジ -->
          <g v-if="d.emp.status === 'waiting_approval'">
            <circle :cx="d.cx" :cy="d.cy - DESK_Z - 46" r="7" :fill="STATUS_COLOR.waiting_approval" />
            <text :x="d.cx" :y="d.cy - DESK_Z - 42.5" text-anchor="middle" fill="#fff" font-size="10" font-weight="700">!</text>
          </g>
        </g>

        <!-- 名札 -->
        <text :x="d.cx" :y="d.cy + DH2 + 16" text-anchor="middle" fill="var(--c-ink)" font-size="12" font-weight="700">{{ d.emp.name }}</text>
        <text :x="d.cx" :y="d.cy + DH2 + 29" text-anchor="middle" fill="var(--c-muted)" font-size="10">{{ d.roleName }}</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.desk-group:focus-visible polygon:first-of-type {
  stroke: var(--c-brand);
  stroke-width: 2;
}
.pulse-ring {
  transform-box: fill-box;
  transform-origin: center;
  animation: office-pulse 2s ease-out infinite;
}
@keyframes office-pulse {
  0% { transform: scale(0.85); opacity: 0.9; }
  70% { transform: scale(1.35); opacity: 0; }
  100% { transform: scale(1.35); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .pulse-ring { animation: none; opacity: 0.5; }
}
</style>
