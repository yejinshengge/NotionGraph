/**
 * d3-force 力场装配 + 节点/边增量同步 + alpha 生命周期管理。
 *
 * 对应设计方案 §4 物理引擎：
 *   1) 多体排斥力 —— 强度与节点大小成正比
 *   2) 弹簧引力  —— 相连节点以 linkDistance 为默认距离
 *   3) 向心力    —— 极微弱，防飘散
 *   4) 碰撞体积  —— 半径 = R + padding，保证节点不重叠
 *
 * 模拟生命周期：
 *   - 初次装载：alpha = 1，节点迅速散开
 *   - 自然冷却：由 d3 的 alphaDecay 驱动，alpha < alphaMin 时自动停
 *   - 拖拽唤醒：调用 reheatForDrag()，设 alphaTarget 让模拟持续跑
 *   - 拖拽结束：调用 stopDrag()，回到自然冷却
 *
 * 注：我们手动在 rAF 里 `simulation.tick()` 驱动，而不是用 d3 内置 timer，
 * 这样可以和 Canvas 渲染循环合并为同一帧，避免物理/渲染频率错配。
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from 'd3-force';
import type { GraphData, GraphEdge, GraphNode } from '@/core/types';
import { GRAPH_CONFIG } from './graphConfig';
import type { SimLink, SimNode } from './graphTypes';

const P = GRAPH_CONFIG.physics;
const N = GRAPH_CONFIG.node;

/** 独立出 simulation 类型别名，便于下游 helper 复用 */
export type GraphSimulation = Simulation<SimNode, SimLink>;

/**
 * 把上游 GraphData 构造为渲染层使用的 SimNode[] / SimLink[]。
 *
 * 增量语义：
 *   - 新建/重建图谱时传 prevNodes = undefined，所有节点从围绕原点的随机散布开始；
 *   - graph 重新拉取、或 root 切换但有节点重叠时，把 prevNodes 传进来 —— 旧节点的
 *     `x/y/vx/vy/opacity/scale` 等实时状态会被保留，让视觉上没有「跳变」。
 */
export function buildSimData(
  graph: GraphData,
  prevNodes?: SimNode[] | null,
): { nodes: SimNode[]; links: SimLink[] } {
  // 度数统计
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  // 度数排名分位：按度数降序排，i / (len-1) 作为 degreeRank（0 = 最高，1 = 最低）
  const sortedIds = [...graph.nodes]
    .map((n) => n.id)
    .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0));
  const rankMap = new Map<string, number>();
  const total = Math.max(1, sortedIds.length - 1);
  sortedIds.forEach((id, i) => rankMap.set(id, i / total));

  // 旧节点索引：用于保留位置 & 速度
  const prevById = new Map<string, SimNode>();
  if (prevNodes) for (const n of prevNodes) prevById.set(n.id, n);

  const nodes: SimNode[] = graph.nodes.map((g) => {
    const prev = prevById.get(g.id);
    const deg = degree.get(g.id) ?? 0;
    const radius = N.baseRadius + Math.sqrt(deg) * N.scaleFactor;
    return makeSimNode(g, deg, radius, rankMap.get(g.id) ?? 1, prev);
  });

  // 构造 id → node 的索引，d3 forceLink 会自动从字符串 id 解析成 node 引用，
  // 但我们这里直接传引用也没问题。
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links: SimLink[] = [];
  for (const e of graph.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue; // 容错：引用了不存在的节点则静默丢弃
    links.push(makeSimLink(e, s, t));
  }

  return { nodes, links };
}

/** 构造单个 SimNode，保留前一帧的可变状态（若存在） */
function makeSimNode(
  g: GraphNode,
  degree: number,
  radius: number,
  degreeRank: number,
  prev?: SimNode,
): SimNode {
  const unresolved = g.unauthorized || !g.title;
  // 初始位置：围绕原点小范围随机散布，避免所有节点堆在 (0,0) 导致首 tick 的力数值发散
  const initX = prev?.x ?? (Math.random() - 0.5) * 80;
  const initY = prev?.y ?? (Math.random() - 0.5) * 80;

  return {
    id: g.id,
    title: g.title || '(未命名)',
    unresolved,

    degree,
    radius,
    degreeRank,

    x: initX,
    y: initY,
    vx: prev?.vx ?? 0,
    vy: prev?.vy ?? 0,

    // 透明度/尺寸初始值：无悬停时的「默认态」
    opacity: prev?.opacity ?? (unresolved ? N.unresolvedOpacity : 1),
    targetOpacity: unresolved ? N.unresolvedOpacity : 1,
    scale: prev?.scale ?? 1,
    targetScale: 1,

    forceLabel: false,
    matched: true,
  };
}

/** 构造单个 SimLink */
function makeSimLink(e: GraphEdge, s: SimNode, t: SimNode): SimLink {
  return {
    id: e.id,
    source: s,
    target: t,
    opacity: 1,
    targetOpacity: 1,
    highlighted: false,
  };
}

/**
 * 创建 d3 力模拟。
 *
 * 注意：
 *   - 立刻 `.stop()`，由外层 rAF 逐帧 `.tick()` 驱动；
 *   - linkDistance / chargeStrength 都做了常量化，方便调手感；
 *   - charge strength 按节点 radius 做了线性加成 —— 大节点排斥更强（设计方案 §4.1）。
 */
export function createSimulation(nodes: SimNode[], links: SimLink[]): GraphSimulation {
  const sim = forceSimulation<SimNode, SimLink>(nodes)
    .velocityDecay(P.velocityDecay)
    .alphaDecay(P.alphaDecay)
    .alphaMin(P.alphaMin)
    .alpha(P.alphaInit)
    .force(
      'charge',
      forceManyBody<SimNode>().strength(
        (n) => P.chargeStrength * (1 + n.radius * P.chargeRadiusBoost),
      ),
    )
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((n) => n.id)
        .distance(P.linkDistance)
        .strength(P.linkStrength),
    )
    .force('center', forceCenter<SimNode>(0, 0).strength(P.centerStrength))
    .force(
      'collide',
      forceCollide<SimNode>().radius((n) => n.radius + P.collisionPadding),
    );

  // 自己驱动 tick —— 立即停掉 d3 的内置 timer
  sim.stop();
  return sim;
}

/**
 * 增量刷新 simulation 的节点/边（对应 graph prop 变化场景）。
 *
 * 做法：
 *   1) 用 `.nodes(newNodes)` 整个替换；d3 会重新索引，保留已有对象上的 x/y/vx/vy；
 *   2) forceLink 需要重绑 links 数组（否则 d3 仍引用旧 links）；
 *   3) 重置 alpha 到 1，让布局重新快速收敛到新拓扑。
 */
export function applyIncremental(
  sim: GraphSimulation,
  nodes: SimNode[],
  links: SimLink[],
): void {
  sim.nodes(nodes);
  const link = sim.force<ReturnType<typeof forceLink<SimNode, SimLink>>>('link');
  if (link) link.links(links);
  sim.alpha(P.alphaInit).restart();
  // 再次停掉内置 timer —— restart() 会重启它
  sim.stop();
}

/** 拖拽开始：让 alpha 持续维持在 reheat 水平，整图保持活跃 */
export function reheatForDrag(sim: GraphSimulation): void {
  sim.alphaTarget(P.alphaReheatOnDrag);
}

/** 拖拽结束：alphaTarget 归零，模拟自然冷却到 alphaMin 后停止 */
export function stopDrag(sim: GraphSimulation): void {
  sim.alphaTarget(0);
}

/**
 * 模拟是否仍有活动能量。
 * 渲染循环据此判断是否可以暂停 rAF（同时还要结合 UI 过渡、拖拽等其他条件）。
 */
export function isSimulationActive(sim: GraphSimulation): boolean {
  return sim.alpha() > P.alphaMin;
}
