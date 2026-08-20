/**
 * 関係グラフ（F-10-6）の force-directed レイアウト純ロジック（SoT）。
 * - 決定的: 初期配置は ~/utils/rng（FNV-1a）で node id からシード。Math.random 不使用（規約4）
 * - simulateStep: 反発（クーロン型）+ ばね（エッジ）+ 中心重力 + 速度減衰の 1 tick
 * - ビュー変換（ズーム/パン/フィット）・次数・平行エッジのオフセットもここで計算し、
 *   コンポーネント（RelationGraph.vue）は描画とポインタ操作に専念する
 */
import { unit } from '~/utils/rng'

/** シミュレーションに必要な最小のエッジ形（from/to のみ） */
export interface ForceEdge {
  from: string
  to: string
}

/** シミュレーション上のノード状態（座標は原点中心のワールド座標） */
export interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  /** ドラッグ中の固定 x 座標（null = 物理に委ねる） */
  fx: number | null
  /** ドラッグ中の固定 y 座標（null = 物理に委ねる） */
  fy: number | null
}

export interface SimConfig {
  /** ノード間反発の強さ（クーロン型: F = repulsion / d^2） */
  repulsion: number
  /** ばね（エッジ）の自然長 */
  springLength: number
  /** ばね定数 */
  springK: number
  /** 中心（原点）への重力係数 */
  gravity: number
  /** 速度減衰（1 tick ごとに v *= damping） */
  damping: number
  /** alpha の減衰率（1 tick ごとに alpha *= 1 - alphaDecay） */
  alphaDecay: number
  /** 1 tick の最大移動速度（発散防止） */
  maxVelocity: number
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  repulsion: 8000,
  springLength: 110,
  springK: 0.1,
  gravity: 0.004,
  damping: 0.6,
  alphaDecay: 0.028,
  maxVelocity: 30,
}

/** これ未満で整定（静止）とみなす alpha */
export const ALPHA_MIN = 0.02

/** ズーム倍率の下限・上限 */
export const SCALE_MIN = 0.25
export const SCALE_MAX = 4

/**
 * 決定的な初期配置。id ごとの FNV-1a ハッシュから角度・半径を導くため、
 * 同じノード集合は常に同じ初期位置（リロードしても世界が変わらない）。
 */
export function initialPositions(nodes: readonly { id: string }[], spread?: number): SimNode[] {
  const r0 = spread ?? Math.max(120, Math.sqrt(nodes.length) * 80)
  return nodes.map((n) => {
    const angle = unit(`${n.id}:angle`) * Math.PI * 2
    const radius = r0 * Math.sqrt(unit(`${n.id}:radius`))
    return { id: n.id, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0, fx: null, fy: null }
  })
}

/**
 * 物理シミュレーション 1 tick。nodes を破壊的に更新し、減衰後の alpha を返す。
 * - 反発: 全ペア（マスタ規模なので O(n^2) で十分）。完全重なりは id ハッシュの決定的角度で分離
 * - ばね: エッジごと。自己ループ・欠損端点はスキップ
 * - 重力: 原点への引力。ピン留め（fx/fy 非 null）ノードは指定座標へ固定
 */
export function simulateStep(
  nodes: SimNode[],
  edges: readonly ForceEdge[],
  alpha: number,
  config: SimConfig = DEFAULT_SIM_CONFIG,
): number {
  const n = nodes.length
  if (n === 0) return 0
  const idx = new Map<string, number>()
  nodes.forEach((node, i) => idx.set(node.id, i))
  const fx = new Array<number>(n).fill(0)
  const fy = new Array<number>(n).fill(0)

  // 反発（クーロン型）
  for (let i = 0; i < n; i++) {
    const a = nodes[i]!
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j]!
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1e-6) {
        // 完全重なりは決定的な角度で分離（乱数不使用）
        const ang = unit(`${a.id}|${b.id}`) * Math.PI * 2
        dx = Math.cos(ang) * 0.1
        dy = Math.sin(ang) * 0.1
        d2 = 0.01
      }
      const d = Math.sqrt(d2)
      const f = config.repulsion / Math.max(d2, 100) // 近接時の爆発防止（d >= 10 相当でクランプ）
      const ux = dx / d
      const uy = dy / d
      fx[i]! -= ux * f
      fy[i]! -= uy * f
      fx[j]! += ux * f
      fy[j]! += uy * f
    }
  }

  // ばね（エッジ）
  for (const e of edges) {
    if (e.from === e.to) continue
    const i = idx.get(e.from)
    const j = idx.get(e.to)
    if (i === undefined || j === undefined) continue
    const a = nodes[i]!
    const b = nodes[j]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.hypot(dx, dy) || 1
    const f = config.springK * (d - config.springLength)
    const ux = dx / d
    const uy = dy / d
    fx[i]! += ux * f
    fy[i]! += uy * f
    fx[j]! -= ux * f
    fy[j]! -= uy * f
  }

  // 中心重力 + 速度積分
  for (let i = 0; i < n; i++) {
    const node = nodes[i]!
    if (node.fx != null && node.fy != null) {
      node.x = node.fx
      node.y = node.fy
      node.vx = 0
      node.vy = 0
      continue
    }
    const gx = -node.x * config.gravity
    const gy = -node.y * config.gravity
    node.vx = (node.vx + (fx[i]! + gx) * alpha) * config.damping
    node.vy = (node.vy + (fy[i]! + gy) * alpha) * config.damping
    const speed = Math.hypot(node.vx, node.vy)
    if (speed > config.maxVelocity) {
      node.vx = (node.vx / speed) * config.maxVelocity
      node.vy = (node.vy / speed) * config.maxVelocity
    }
    node.x += node.vx
    node.y += node.vy
  }

  return alpha * (1 - config.alphaDecay)
}

/**
 * 同期整定: alpha が ALPHA_MIN を下回るか maxSteps に達するまで simulateStep を回す。
 * prefers-reduced-motion 時の静的描画・テストで使用。最終 alpha を返す。
 */
export function settle(
  nodes: SimNode[],
  edges: readonly ForceEdge[],
  config: SimConfig = DEFAULT_SIM_CONFIG,
  alpha = 1,
  maxSteps = 600,
): number {
  let a = alpha
  for (let s = 0; s < maxSteps && a >= ALPHA_MIN; s++) a = simulateStep(nodes, edges, a, config)
  return a
}

/** ノード次数（自己ループは数えない。端点が欠けたエッジは描画されないため次数にも数えない） */
export function computeDegrees(nodeIds: readonly string[], edges: readonly ForceEdge[]): Map<string, number> {
  const deg = new Map<string, number>()
  for (const id of nodeIds) deg.set(id, 0)
  for (const e of edges) {
    if (e.from === e.to) continue
    const df = deg.get(e.from)
    const dt = deg.get(e.to)
    if (df === undefined || dt === undefined) continue
    deg.set(e.from, df + 1)
    deg.set(e.to, dt + 1)
  }
  return deg
}

/** 次数に応じたバブル半径（Obsidian 風: 接続が多いほど大きい） */
export function nodeRadius(degree: number): number {
  return 8 + Math.min(10, degree * 1.5)
}

/** ビュー変換（screen = world * k + (x, y)） */
export interface ViewTransform {
  x: number
  y: number
  k: number
}

export function clampScale(k: number, min = SCALE_MIN, max = SCALE_MAX): number {
  return Math.min(max, Math.max(min, k))
}

/** 画面座標 (px, py) を不動点としてスケールを factor 倍する（カーソル中心ズーム） */
export function zoomAtPoint(
  t: ViewTransform,
  px: number,
  py: number,
  factor: number,
  min = SCALE_MIN,
  max = SCALE_MAX,
): ViewTransform {
  const k = clampScale(t.k * factor, min, max)
  const wx = (px - t.x) / t.k
  const wy = (py - t.y) / t.k
  return { k, x: px - wx * k, y: py - wy * k }
}

/**
 * ノード群のバウンディングボックスが (width, height) に収まる変換（中央寄せ + padding）。
 * 単一ノード等の退化ケースは拡大しすぎないよう k を 1.5 で頭打ちにする。
 */
export function fitToBounds(
  points: readonly { x: number, y: number }[],
  width: number,
  height: number,
  padding = 48,
  min = SCALE_MIN,
  max = SCALE_MAX,
): ViewTransform {
  if (points.length === 0 || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, k: 1 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const bw = Math.max(maxX - minX, 1)
  const bh = Math.max(maxY - minY, 1)
  const kRaw = Math.min((width - padding * 2) / bw, (height - padding * 2) / bh)
  const k = clampScale(Math.min(kRaw, 1.5), min, max)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { k, x: width / 2 - cx * k, y: height / 2 - cy * k }
}

/** 平行エッジオフセットの入力（id はオフセット表のキー） */
export interface OffsetEdge {
  id: string
  from: string
  to: string
}

/**
 * 同一ペア間の平行エッジを法線方向にずらすオフセット（ワールド px）。
 * 返り値は「そのエッジ自身の from→to 方向の左法線」に掛ける値で、
 * 向きが逆のエッジ同士でも重ならないようソート済みペア基準で符号を正規化する。
 * 自己ループは対象外（表に含めない）。
 */
export function parallelEdgeOffsets(edges: readonly OffsetEdge[], gap = 14): Map<string, number> {
  const pairKey = (e: OffsetEdge): string => [e.from, e.to].sort().join('|')
  const pairCount = new Map<string, number>()
  for (const e of edges) {
    if (e.from === e.to) continue
    const k = pairKey(e)
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const out = new Map<string, number>()
  for (const e of edges) {
    if (e.from === e.to) continue
    const k = pairKey(e)
    const i = seen.get(k) ?? 0
    seen.set(k, i + 1)
    const m = pairCount.get(k) ?? 1
    const sign = e.from < e.to ? 1 : -1
    out.set(e.id, (i - (m - 1) / 2) * gap * sign)
  }
  return out
}
