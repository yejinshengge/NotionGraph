/**
 * Canvas 绘制器。
 *
 * 每帧流程（与设计方案 §5 性能优化一一对应）：
 *   1) 清屏 + 坐标变换（DPR × zoom × 平移 一次性合并到 ctx 的 transform）；
 *   2) 插值悬停/搜索过渡的 opacity、scale —— 用指数平滑实现 CSS transition 观感；
 *   3) 视锥体剔除：根据相机反推可见世界矩形，屏外节点直接跳过；
 *   4) 边：分 3 桶（dim / normal / hover），每桶一次 beginPath + 一次 stroke
 *      —— 对应 §5.3 批量绘制，避免在循环里频繁切换颜色；
 *   5) 节点：dim 桶先画、hover 桶后画，保证悬停节点永远在上层；
 *   6) 标签：§3.1 悬停强制可见、§3.2 zoom 阈值三段式淡入、字号逆补偿保证视觉恒定；
 *   7) 循环停止：物理静止 + 所有过渡收敛 + 无外部活动时，交回上层决定是否暂停 rAF。
 */

import { GRAPH_CONFIG } from './graphConfig';
import { resolveEndpoint, type Camera, type SimLink, type SimNode } from './graphTypes';

const N = GRAPH_CONFIG.node;
const L = GRAPH_CONFIG.link;
const LB = GRAPH_CONFIG.label;
const I = GRAPH_CONFIG.interaction;
const BG = GRAPH_CONFIG.background;

/** 过渡完成的阈值：视觉差低于此就认为到位 */
const EPS_OPACITY = 1e-3;
const EPS_SCALE = 1e-3;

export interface RenderState {
  nodes: SimNode[];
  links: SimLink[];
  camera: Camera;
  /** 设备像素比 */
  dpr: number;
  /** 距上一帧的时间（ms），用于过渡插值 */
  dt: number;
}

/** 绘制一帧。返回值表示「是否还有未收敛的视觉过渡」——外层据此决定是否继续 rAF。 */
export function render(ctx: CanvasRenderingContext2D, state: RenderState): boolean {
  const { nodes, links, camera, dpr, dt } = state;

  // ---- 1) 清屏（用 identity transform 先清一次物理像素） ----
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, camera.width * dpr, camera.height * dpr);

  // ---- 2) 合并所有变换到 ctx ----
  // 世界原点 → 屏幕中心 + 相机平移；世界单位 → 屏幕单位乘以 zoom；屏幕单位 → 物理像素乘以 dpr
  const k = camera.zoom * dpr;
  const ox = (camera.width / 2 + camera.tx) * dpr;
  const oy = (camera.height / 2 + camera.ty) * dpr;
  ctx.setTransform(k, 0, 0, k, ox, oy);

  // ---- 3) 过渡插值 + 是否还有未收敛的过渡 ----
  const alpha = transitionAlpha(dt);
  let transitionsPending = false;

  for (const n of nodes) {
    if (Math.abs(n.opacity - n.targetOpacity) > EPS_OPACITY) {
      n.opacity += (n.targetOpacity - n.opacity) * alpha;
      transitionsPending = true;
    } else {
      n.opacity = n.targetOpacity;
    }
    if (Math.abs(n.scale - n.targetScale) > EPS_SCALE) {
      n.scale += (n.targetScale - n.scale) * alpha;
      transitionsPending = true;
    } else {
      n.scale = n.targetScale;
    }
  }
  for (const l of links) {
    if (Math.abs(l.opacity - l.targetOpacity) > EPS_OPACITY) {
      l.opacity += (l.targetOpacity - l.opacity) * alpha;
      transitionsPending = true;
    } else {
      l.opacity = l.targetOpacity;
    }
  }

  // ---- 4) 视锥体剔除：反推可见世界矩形（加一点 padding 兜住节点半径） ----
  const visibleWorld = computeVisibleWorldRect(camera, 32);

  // ---- 5) 批量绘边 ----
  drawLinks(ctx, links, camera.zoom);

  // ---- 6) 绘节点（dim → 普通 → hover 三层，保证高亮始终在上） ----
  drawNodes(ctx, nodes, visibleWorld);

  // ---- 7) 绘标签 ----
  drawLabels(ctx, nodes, camera, visibleWorld);

  return transitionsPending;
}

// -------------------- 过渡插值 --------------------

/**
 * 把 `dt`(ms) 转换为本帧应插值的比例 α。
 *
 * 指数平滑：pos' = pos + (target - pos) * α，其中 α = 1 - exp(-dt / τ)，
 * τ 取 hoverTransitionMs / 3.0 可让「几乎到位」所需时间约等于 hoverTransitionMs
 * （3τ 规则，对应 exp(-3) ≈ 0.05 残差）。
 */
function transitionAlpha(dt: number): number {
  const tau = I.hoverTransitionMs / 3.0;
  return 1 - Math.exp(-dt / Math.max(1, tau));
}

// -------------------- 视锥体 --------------------

function computeVisibleWorldRect(
  cam: Camera,
  paddingPx: number,
): { x0: number; y0: number; x1: number; y1: number } {
  // 屏幕 (0, 0) 和 (w, h) 反推到世界
  const pad = paddingPx / cam.zoom;
  return {
    x0: (-cam.width / 2 - cam.tx) / cam.zoom - pad,
    y0: (-cam.height / 2 - cam.ty) / cam.zoom - pad,
    x1: (cam.width / 2 - cam.tx) / cam.zoom + pad,
    y1: (cam.height / 2 - cam.ty) / cam.zoom + pad,
  };
}

function nodeInRect(
  n: SimNode,
  r: { x0: number; y0: number; x1: number; y1: number },
): boolean {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

// -------------------- 连线绘制 --------------------

/**
 * 批量绘线：按颜色/粗细桶分组，每桶一次 beginPath + 一次 stroke。
 *
 * 设计方案 §5.3：切忌在循环中频繁改色。我们把边分成两桶：
 *   - normal：默认色 + 默认粗细
 *   - hover ：高亮色 + 高亮粗细
 *
 * 暗化（dim）态实际上是 normal 的一个低 opacity 版本，为了避免再开一桶，
 * 我们让 normal 桶按 opacity 直接降到 dimOpacity * baseOpacity 即可
 * —— 但 Canvas 的 globalAlpha 无法逐边设置；折中做法：
 *     每条边单独 stroke 是 O(E) 的 stroke 调用，在 1k 条边规模下依然可接受。
 *     为保留批量绘制的优势，我们**先把 normal 桶按分位量化到 3 档 alpha**，
 *     每档一次 stroke。
 *
 * 线宽 = widthCss / zoom：视觉粗细恒定为 widthCss 个 CSS 像素，不随缩放变粗细。
 */
function drawLinks(ctx: CanvasRenderingContext2D, links: SimLink[], zoom: number): void {
  if (links.length === 0) return;

  // 量化 alpha 的桶数；桶越多越接近连续，越少越省 stroke 次数
  const BUCKETS = 4;
  const buckets: Array<{ opacity: number; paths: SimLink[] }> = [];
  const hoverBucket: SimLink[] = [];

  for (const l of links) {
    if (l.highlighted && l.opacity > 0.01) {
      hoverBucket.push(l);
      continue;
    }
    // 量化到 [1/BUCKETS, 2/BUCKETS, ..., 1]
    const q = Math.max(1, Math.ceil(l.opacity * BUCKETS));
    const op = q / BUCKETS;
    let b = buckets[q - 1];
    if (!b) {
      b = { opacity: op, paths: [] };
      buckets[q - 1] = b;
    }
    b.paths.push(l);
  }

  // 普通边
  ctx.lineWidth = L.widthCss / zoom;
  for (const b of buckets) {
    if (!b || b.paths.length === 0) continue;
    // rgba() 的 alpha 用颜色字符串里的即可，额外用 globalAlpha 乘一次
    ctx.globalAlpha = b.opacity;
    ctx.strokeStyle = L.color;
    ctx.beginPath();
    for (const l of b.paths) {
      const s = resolveEndpoint(l.source);
      const t = resolveEndpoint(l.target);
      if (!s || !t) continue;
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(t.x ?? 0, t.y ?? 0);
    }
    ctx.stroke();
  }

  // 高亮边（永远在上）
  if (hoverBucket.length > 0) {
    ctx.globalAlpha = 1;
    ctx.lineWidth = L.hoverWidthCss / zoom;
    ctx.strokeStyle = L.hoverColor;
    ctx.beginPath();
    for (const l of hoverBucket) {
      const s = resolveEndpoint(l.source);
      const t = resolveEndpoint(l.target);
      if (!s || !t) continue;
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(t.x ?? 0, t.y ?? 0);
    }
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

// -------------------- 节点绘制 --------------------

function drawNodes(
  ctx: CanvasRenderingContext2D,
  nodes: SimNode[],
  rect: { x0: number; y0: number; x1: number; y1: number },
): void {
  // 先画非高亮节点（opacity < 1 视为 dim 或普通），再画高亮节点（scale > 1）
  // —— 用 targetScale 区分，避免动画尾巴里的短暂压盖问题
  for (const n of nodes) {
    if (n.targetScale > 1) continue; // 高亮放大的节点留到第二轮
    if (!nodeInRect(n, rect)) continue;
    drawOneNode(ctx, n);
  }
  for (const n of nodes) {
    if (n.targetScale <= 1) continue;
    if (!nodeInRect(n, rect)) continue;
    drawOneNode(ctx, n);
  }
}

function drawOneNode(ctx: CanvasRenderingContext2D, n: SimNode): void {
  const r = n.radius * n.scale;
  ctx.globalAlpha = n.opacity;
  ctx.fillStyle = n.unresolved ? N.unresolvedColor : N.color;
  ctx.beginPath();
  ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// -------------------- 标签绘制 --------------------

/**
 * §3.2 文本显示阈值（三段式）：
 *   zoom < minZoomHideAll          → 只画 forceLabel（悬停/邻居）
 *   minZoomHideAll ≤ zoom < minZoomShowTopDegree
 *                                  → 额外画 degreeRank ≤ topDegreeRatio 的节点
 *   minZoomShowTopDegree ≤ zoom < minZoomShowAll
 *                                  → 线性阈值：degreeRank 小于 (zoom 归一化值) 的节点
 *   zoom ≥ minZoomShowAll          → 全部显示
 *
 * 同时 §5.2 要求：文字是 Canvas 中最贵的操作，在满足可读性的前提下尽量少画。
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  nodes: SimNode[],
  cam: Camera,
  rect: { x0: number; y0: number; x1: number; y1: number },
): void {
  const zoom = cam.zoom;

  // 字号/描边宽度做 zoom 逆补偿，保证视觉恒定
  const fontPx = LB.sizeCss / zoom;
  ctx.font = `${fontPx}px ${stripLeadingSize(LB.font)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = LB.strokeWidth / zoom;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  // 预计算当前 zoom 对应的 degreeRank 阈值
  const rankThreshold = computeRankThreshold(zoom);

  for (const n of nodes) {
    if (!shouldDrawLabel(n, rankThreshold, zoom)) continue;
    if (!nodeInRect(n, rect)) continue;
    if (!n.title) continue;

    const x = n.x ?? 0;
    const y = (n.y ?? 0) + n.radius * n.scale + LB.offsetY / zoom;

    ctx.globalAlpha = n.opacity;
    // 先描边、再填充 —— 保证在连线/其他节点之上依然可读
    ctx.strokeStyle = LB.strokeColor;
    ctx.strokeText(n.title, x, y);
    ctx.fillStyle = n.forceLabel ? LB.hoverColor : LB.color;
    ctx.fillText(n.title, x, y);
  }
  ctx.globalAlpha = 1;
}

/** 去掉 `"12px sans-serif"` 里的 `"12px "` 前缀，便于与动态字号拼接 */
function stripLeadingSize(font: string): string {
  return font.replace(/^\s*\d+(?:\.\d+)?px\s*/, '');
}

/**
 * 计算当前 zoom 下「degreeRank 小于多少」的节点可见。
 * 返回值 ∈ [0, 1]，度数排名分位低于此值的节点显示。
 */
function computeRankThreshold(zoom: number): number {
  if (zoom < LB.minZoomHideAll) return -1; // 没有节点自动显示
  if (zoom >= LB.minZoomShowAll) return 1; // 全部显示

  if (zoom < LB.minZoomShowTopDegree) {
    // 在 [hideAll, showTopDegree) 之间：固定只显示 top 比例
    return LB.topDegreeRatio;
  }
  // 在 [showTopDegree, showAll) 之间：从 topDegreeRatio 线性过渡到 1
  const t =
    (zoom - LB.minZoomShowTopDegree) /
    Math.max(1e-6, LB.minZoomShowAll - LB.minZoomShowTopDegree);
  return LB.topDegreeRatio + (1 - LB.topDegreeRatio) * t;
}

function shouldDrawLabel(n: SimNode, rankThreshold: number, _zoom: number): boolean {
  if (n.forceLabel) return true; // 悬停/邻居强制显示
  return n.degreeRank <= rankThreshold;
}
