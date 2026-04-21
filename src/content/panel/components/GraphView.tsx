/**
 * Cytoscape 封装：力导向布局 + 节点/边样式区分 + 单击高亮 + 双击跳转 + 右键换根。
 *
 * 性能策略（针对 200+ 节点的大图）：
 *   - 初始布局一次性收敛即停（cola `infinite:false` + `maxSimulationTime`），
 *       静止时 CPU 占用归零；
 *   - 拖拽交互**只影响被拖节点的 parent-child 下游子树**，其他未被拖的节点
 *     不会因为松手而被全图 settle cola 重新推一遍 —— 以此对齐 Obsidian 行为：
 *     拖到哪儿就停在哪儿；并同时避免"度数大的节点被大量邻居弹簧钉住、度数小的
 *     被大节点反向拽回去"这种看上去很诡异的权重不对称感；
 *   - 子节点跟随使用**非线性"橡皮筋"力**（而非简单弹簧）：
 *         F = (k_base + k_stretch · |d|² / ref²) · d
 *       小位移时几乎松弛、带柔和滞后；位移越大张力越强、把节点迅速"绷"过去；
 *       阻尼近临界 → 不会像弹簧那样反复回荡，触感更像弹力绳；
 *   - 平移/缩放时隐藏 label 并用纹理缓存，但**不**隐藏边，以免和拖拽动画
 *     持续更新节点位置冲突导致连线"闪没"；
 *   - 边统一使用 `straight`（不用 haystack）：haystack 虽快，但 focused 时若切换到
 *       straight 会导致端点渲染位置跳变，视觉上像是节点突然移动了；
 *   - 节点 label 通过 `min-zoomed-font-size` 在 zoom-out 时自动隐藏，减少文本绘制；
 *   - 搜索 query 使用 useDeferredValue 降优先级，避免键入时频繁 O(N) 遍历节点；
 *   - graph 变化时 batch 更新元素而不是整个重建；
 *   - 搜索只改 class，避免重新布局；
 *   - 节点点击回调外抛给 SidePanel。
 */

import { useDeferredValue, useEffect, useMemo, useRef, type ReactElement } from 'react';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import cola from 'cytoscape-cola';
import type { GraphData, GraphNode } from '@/core/types';

// 注册布局（多次注册会被 cytoscape 自行 dedupe，但为稳妥判重）
let fcoseRegistered = false;
let colaRegistered = false;
function ensureLayout(): void {
  if (!fcoseRegistered) {
    cytoscape.use(fcose);
    fcoseRegistered = true;
  }
  if (!colaRegistered) {
    cytoscape.use(cola);
    colaRegistered = true;
  }
}

interface Props {
  graph: GraphData;
  query: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeRoot: (id: string) => void;
}

export default function GraphView(props: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const layoutRef = useRef<cytoscape.Layouts | null>(null);
  // 当前是否处于"真实拖拽"中。仅当 cytoscape 触发过 `drag`（节点位置确实变化）后才置位；
  // 用来把"单击选中"与"拖动"彻底分开，避免单纯 mousedown/mouseup 也会扰动整个力场。
  const draggingIdRef = useRef<string | null>(null);
  // 当前被拖节点的 parent-child 下游子树快照：记录每个后代相对父节点的**静止态位移**。
  // `grabon` 时抓取一次，后续弹簧动画把每个后代朝着 父节点新位置 + 初始位移 的目标点
  // 按 `F = k·(target − pos)` 拉近，实现"带滞后、带轻微回荡"的灵动跟随，
  // 取代此前"硬刚性吸附"的做法。
  const dragSubtreeRef = useRef<{
    parentId: string;
    offsets: Array<{ node: cytoscape.NodeSingular; dx: number; dy: number }>;
  } | null>(null);
  // 用户当前是否按住节点。`dragfreeon` 置 false —— 弹簧动画循环据此判断
  // 何时可以"阻尼到接近静止后自行停止"。
  const isGrabbingRef = useRef<boolean>(false);
  // 当前弹簧动画循环的停止句柄。重新 grab 或 free 时需要强制终止。
  const dragSpringRef = useRef<{ stop: () => void } | null>(null);

  const elements = useMemo(() => toElements(props.graph), [props.graph]);
  // 搜索关键字在大图上 O(N) 过滤，降级为低优先级更新，避免输入卡顿
  const deferredQuery = useDeferredValue(props.query);

  // 初始化 cytoscape
  useEffect(() => {
    ensureLayout();
    const container = containerRef.current;
    if (!container) return;

    const cy = cytoscape({
      container,
      elements,
      style: STYLE,
      wheelSensitivity: 0.25,
      minZoom: 0.1,
      maxZoom: 4,
      // ---- 大图渲染优化 ----
      // 平移/缩放中隐藏 label，显著降低交互期间的绘制开销。
      // 注意：不启用 hideEdgesOnViewport —— cola 持续更新节点位置时，
      // cytoscape 会把每帧视为"viewport 变化"从而隐藏所有边，
      // 表现为"拖拽时连线全部消失"，体验极差。
      hideEdgesOnViewport: false,
      hideLabelsOnViewport: true,
      // 静止时把画面缓存为纹理，再次平移/缩放直接贴图
      textureOnViewport: true,
      // 动效模糊对本场景视觉收益小但有开销，关闭
      motionBlur: false,
      // 强制 1x 像素比，高 DPI 屏上渲染像素减半
      pixelRatio: 1,
    });
    cyRef.current = cy;

    // 容器刚挂载时可能还没有非零尺寸（尤其是 Shadow DOM + flex 的组合），
    // 若此时跑 fcose/cola，viewport 近似 0，随机散列会坍缩到一条线。
    // 这里等容器拥有实际尺寸、且布局帧稳定后再启动。
    runLayoutWhenReady(cy, container, LAYOUT_OPTIONS, (layout) => {
      layoutRef.current = layout;
    });

    // 事件绑定
    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id();
      props.onSelect(id);
      highlightNeighborhood(cy, id);
    });
    cy.on('dbltap', 'node', (evt) => {
      const url = evt.target.data('url') as string | undefined;
      if (url) window.open(url, '_blank');
    });
    cy.on('cxttap', 'node', (evt) => {
      evt.preventDefault();
      const id = evt.target.id();
      props.onChangeRoot(id);
    });
    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        props.onSelect(null);
        clearHighlight(cy);
      }
    });

    // 拖拽节点：子树橡皮筋跟随 —— 松手后其他节点绝不挪动。
    //
    // 设计要点：
    //   - `grabon`：
    //       · 停掉上一轮可能还在衰减的橡皮筋循环，避免并发写同一批后代；
    //       · 预计算 parent-child 下游子树，记录每个后代相对父节点的**静止态位移**
    //         —— 后续动画把"父节点位置 + 该位移"当作目标点；
    //       · 不启动任何力模拟 —— 单击也会走到这里，此时启动会浪费 CPU。
    //   - `drag`（节点位置确实发生变化时才触发）：
    //       · 首帧才启动橡皮筋循环 —— 把单纯的单击 mousedown/mouseup 与真实拖拽分开；
    //       · 循环接管所有后代位置更新，本事件回调里不再手动改位置。
    //   - `dragfreeon`（**拖动过**才松手才触发）：
    //       · 仅把 `isGrabbingRef` 置 false —— 让循环自然阻尼到静止后自行退出；
    //       · **不**启动任何全图 settle —— 对齐 Obsidian 行为：拖到哪儿就停在哪儿，
    //         未被拖的节点保持原位不动；同时也避免"小度节点拖大度节点被拽回去"
    //         这种权重不对称的诡异感。
    //   - `free`：纯单击未拖动时只清理视觉高亮，不触发任何动画。
    cy.on('grabon', 'node', (evt) => {
      const node = evt.target;

      // 强制终止上一轮可能还在阻尼衰减的橡皮筋循环，避免两个循环同时写同一批后代
      if (dragSpringRef.current) {
        dragSpringRef.current.stop();
        dragSpringRef.current = null;
      }
      // 兜底：极端情况下（组件重建、异常中断）可能遗留 lock 状态 —— 统一放行
      cy.nodes().unlock();

      node.addClass('grabbed');
      highlightConnectedEdges(cy, node.id());
      draggingIdRef.current = null; // 等 `drag` 事件确认是否为真实拖拽
      isGrabbingRef.current = true;

      // 预计算子树后代相对父节点的静止态位移，循环把它当作目标基准
      const px = node.position('x');
      const py = node.position('y');
      const descendants = collectSubtreeDescendants(node);
      dragSubtreeRef.current = {
        parentId: node.id(),
        offsets: descendants.map((d) => ({
          node: d,
          dx: d.position('x') - px,
          dy: d.position('y') - py,
        })),
      };
    });
    cy.on('drag', 'node', (evt) => {
      const node = evt.target;
      if (draggingIdRef.current === node.id()) return; // 已经启动过循环
      draggingIdRef.current = node.id();

      // 首次真实拖拽 → 启动子树橡皮筋跟随。无子树的叶子节点直接省掉这次 rAF。
      const sub = dragSubtreeRef.current;
      if (sub && sub.parentId === node.id() && sub.offsets.length > 0) {
        dragSpringRef.current = startSubtreeSpring(cy, sub, isGrabbingRef, () => {
          dragSpringRef.current = null;
        });
      }
    });
    cy.on('dragfreeon', 'node', (evt) => {
      const node = evt.target;
      node.removeClass('grabbed');
      clearConnectedEdges(cy);
      draggingIdRef.current = null;
      // 注意：**不**立即清理 dragSubtreeRef，也**不**强制 stop 橡皮筋循环
      // —— 保留一段自然阻尼尾随，子节点会柔和收紧后静止，就像真正的弹力绳。
      isGrabbingRef.current = false;
    });
    cy.on('free', 'node', (evt) => {
      // 仅处理"单击未拖动"的 free：清理视觉状态即可，不触碰布局，避免整图抖动。
      if (draggingIdRef.current !== null) return; // 真实拖拽，交给 dragfreeon 处理
      const node = evt.target;
      node.removeClass('grabbed');
      clearConnectedEdges(cy);
      isGrabbingRef.current = false;
      dragSubtreeRef.current = null;
      // 单击路径上循环并未启动，但为保险还是 stop 一次
      if (dragSpringRef.current) {
        dragSpringRef.current.stop();
        dragSpringRef.current = null;
      }
    });

    return () => {
      if (layoutRef.current) {
        layoutRef.current.stop();
      }
      if (dragSpringRef.current) {
        dragSpringRef.current.stop();
        dragSpringRef.current = null;
      }
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // graph 变更：增量更新
  useEffect(() => {
    const cy = cyRef.current;
    const container = containerRef.current;
    if (!cy || !container) return;
    
    if (layoutRef.current) {
      layoutRef.current.stop();
    }

    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    runLayoutWhenReady(cy, container, LAYOUT_OPTIONS, (layout) => {
      layoutRef.current = layout;
    });
  }, [elements]);

  // 搜索过滤：不重算布局，仅改样式。
  // 使用 deferredQuery 而非 props.query，React 会在空闲时再触发这次 O(N) 扫描，
  // 输入框自身的响应不会被阻塞。
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const q = deferredQuery.trim().toLowerCase();
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const title = ((n.data('title') as string) ?? '').toLowerCase();
        const match = q === '' || title.includes(q);
        n.toggleClass('dimmed', !match);
      });
    });
  }, [deferredQuery]);

  // 外部选中同步：高亮
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (props.selectedId) highlightNeighborhood(cy, props.selectedId);
    else clearHighlight(cy);
  }, [props.selectedId]);

  return <div ref={containerRef} className="ng-graph-canvas" />;
}

// -------------------- helpers --------------------

function toElements(graph: GraphData): ElementDefinition[] {
  const els: ElementDefinition[] = [];
  // 预计算每个节点的度，用于尺寸缩放
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  for (const n of graph.nodes) {
    els.push({
      group: 'nodes',
      data: {
        id: n.id,
        title: n.title || '(未命名)',
        url: n.url,
        type: n.type,
        isRoot: n.isRoot,
        unauthorized: n.unauthorized,
        size: Math.min(60, 22 + (degree.get(n.id) ?? 0) * 3),
      },
      classes: classListForNode(n),
    });
  }
  for (const e of graph.edges) {
    els.push({
      group: 'edges',
      data: { id: e.id, source: e.source, target: e.target, kind: e.kind },
      classes: e.kind === 'parent-child' ? 'edge-parent' : 'edge-link',
    });
  }
  return els;
}

function classListForNode(n: GraphNode): string {
  const classes: string[] = [];
  classes.push(n.type === 'database' ? 'node-db' : 'node-page');
  if (n.isRoot) classes.push('node-root');
  if (n.unauthorized) classes.push('node-unauthorized');
  return classes.join(' ');
}

/**
 * 选中节点：主节点 + 邻域从背景淡出中突出。
 *
 * 设计取舍：
 *   - 仅给**被选中的主节点**加粗描边（`focused-primary`），邻居只做保亮、不改尺寸；
 *       否则邻居 border-width 从 1 跳到 3，像素尺寸变大，视觉上会被误读为"节点挪位"。
 *   - 不切换 edge 的 curve-style（默认就是 straight），避免端点渲染位置跳变。
 */
function highlightNeighborhood(cy: Core, id: string): void {
  const target = cy.getElementById(id);
  if (target.empty()) return;
  const neighborhood = target.closedNeighborhood();
  cy.batch(() => {
    cy.elements().addClass('faded');
    neighborhood.removeClass('faded').addClass('focused');
    target.addClass('focused-primary');
  });
}

function clearHighlight(cy: Core): void {
  cy.batch(() => {
    cy.elements().removeClass('faded focused focused-primary');
  });
}

/** 拖拽期间：高亮与被拖拽节点相连的边（独立 class，不影响选中高亮） */
function highlightConnectedEdges(cy: Core, id: string): void {
  const node = cy.getElementById(id);
  if (node.empty()) return;
  cy.batch(() => {
    node.connectedEdges().addClass('drag-connected');
  });
}

function clearConnectedEdges(cy: Core): void {
  cy.batch(() => {
    cy.edges().removeClass('drag-connected');
  });
}

/**
 * 子树"橡皮筋"跟随动画参数。
 *
 * 物理模型：半隐式 Euler 积分 + 非线性刚度（刚度随拉伸距离平方增长）：
 *     k_eff = BASE_STIFFNESS + STRETCH_STIFFNESS · |d|² / STRETCH_REF_SQ
 *     v' = v · (1 − DAMPING) + k_eff · d           （d = target − pos）
 *     pos' = pos + v'
 *
 * 设计直觉：
 *   - 小位移（父节点缓慢移动或已接近目标）→ k_eff ≈ BASE，柔和松弛，带明显滞后；
 *   - 大位移（鼠标快速拖拽）→ 二次项主导，张力迅速增加，把子节点"绷紧"拉过去；
 *   - 这一非线性行为正是弹力绳和线性弹簧的本质区别。
 *
 * 阻尼参数接近临界（以 BASE 计 ζ ≈ 0.87），基本无过冲 → 不会像弹簧那样来回晃，
 * 手感更柔、更像弹力绳松开后"拉紧归位"的收尾。
 *
 * 速度每帧按 `(1 − DAMPING)` 衰减，因此即使在张力很大时也不会失稳发散。
 */
const RUBBER_BASE_STIFFNESS = 0.10;
const RUBBER_STRETCH_STIFFNESS = 0.35;
const RUBBER_STRETCH_REF_SQ = 120 * 120; // 位移平方参考值：|d| ≈ 120px 时二次项与 BASE 同阶
const RUBBER_DAMPING = 0.55;
const RUBBER_REST_SPEED_SQ = 0.04; // (0.2 px/frame)²

/**
 * 启动子树的橡皮筋跟随动画循环。
 *
 * 每一帧：
 *   1) 读取父节点当前位置（由用户鼠标或松手后的最终位置决定）；
 *   2) 对每个后代计算目标点 target = parentPos + restOffset；
 *   3) 按"非线性刚度 + 半隐式 Euler"推进速度与位置；
 *   4) `cy.batch` 合批写入，减少 cytoscape 的 dirty 传播开销。
 *
 * 退出条件：
 *   - 外部调用返回的 stop()（grab 新节点、组件卸载等）；
 *   - 父节点已被移除；
 *   - 用户已松手 (`isGrabbingRef.current === false`) 且所有后代速度平方都低于
 *     `RUBBER_REST_SPEED_SQ` —— 即阻尼衰减到视觉上已静止。
 *
 * 注意：
 *   - 对 `locked()` / `removed()` 的后代静默跳过，避免和 graph 变更或外部 lock 冲突；
 *   - 每个后代的 velocity 独立存在 Map 里，初次见到时初始化为 0；
 *   - **不依赖任何 cola 布局**，所以未被拖的节点完全不会因拖拽而移动。
 */
function startSubtreeSpring(
  cy: Core,
  subtree: {
    parentId: string;
    offsets: Array<{ node: cytoscape.NodeSingular; dx: number; dy: number }>;
  },
  isGrabbingRef: { readonly current: boolean },
  onDone: () => void,
): { stop: () => void } {
  const velocities = new Map<string, { vx: number; vy: number }>();
  let stopped = false;
  let rafId = 0;

  const tick = (): void => {
    if (stopped) return;
    const parent = cy.getElementById(subtree.parentId);
    if (parent.empty() || parent.removed()) {
      stopped = true;
      onDone();
      return;
    }
    const px = parent.position('x');
    const py = parent.position('y');
    let maxSpeedSq = 0;

    cy.batch(() => {
      for (const item of subtree.offsets) {
        if (item.node.removed() || item.node.locked()) continue;
        const pos = item.node.position();
        const dx = px + item.dx - pos.x;
        const dy = py + item.dy - pos.y;
        // 非线性刚度：k_eff = BASE + STRETCH · |d|² / REF²
        // 位移越大，二次项占比越高，张力"绷紧"；位移小则保持松弛感。
        const distSq = dx * dx + dy * dy;
        const kEff =
          RUBBER_BASE_STIFFNESS + RUBBER_STRETCH_STIFFNESS * (distSq / RUBBER_STRETCH_REF_SQ);
        let v = velocities.get(item.node.id());
        if (!v) {
          v = { vx: 0, vy: 0 };
          velocities.set(item.node.id(), v);
        }
        v.vx = v.vx * (1 - RUBBER_DAMPING) + dx * kEff;
        v.vy = v.vy * (1 - RUBBER_DAMPING) + dy * kEff;
        item.node.position({ x: pos.x + v.vx, y: pos.y + v.vy });
        const s = v.vx * v.vx + v.vy * v.vy;
        if (s > maxSpeedSq) maxSpeedSq = s;
      }
    });

    // 用户已松手 + 阻尼到接近静止 → 自然结束循环
    if (!isGrabbingRef.current && maxSpeedSq < RUBBER_REST_SPEED_SQ) {
      stopped = true;
      onDone();
      return;
    }

    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);

  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(rafId);
    },
  };
}

/**
 * 沿 parent-child 有向边向下 BFS，收集给定节点的所有后代。
 *
 * 说明：
 *   - 只跟随 `edge.edge-parent` 这一类有向边（source=父，target=子），
 *     不会顺着 link-to-page 扩散，避免把"被引用页"误当作子页搬走。
 *   - 结果不包含节点自身；如果节点是叶子或无子树，返回空数组。
 *   - Set 去重防止父子环或 DAG 场景下重复搬运同一节点。
 */
function collectSubtreeDescendants(node: cytoscape.NodeSingular): cytoscape.NodeSingular[] {
  const visited = new Set<string>([node.id()]);
  const result: cytoscape.NodeSingular[] = [];
  const queue: cytoscape.NodeSingular[] = [node];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const childEdges = cur.outgoers('edge.edge-parent');
    childEdges.forEach((edge) => {
      const child = edge.target();
      const cid = child.id();
      if (visited.has(cid)) return;
      visited.add(cid);
      result.push(child);
      queue.push(child);
    });
  }
  return result;
}

/**
 * cola 力导向布局参数。
 *
 * 关键取舍：
 *   - `infinite: false` + `maxSimulationTime`：收敛后即停，静止时 CPU 占用归零；
 *       这是 200+ 节点下避免持续卡顿的关键——原来的 infinite 模式每帧都在做 O(N²) 斥力计算。
 *   - `animate: true` + `refresh: 2`：保留动画收敛观感，但把每 N 次迭代才刷新一次，
 *       降低大图下的中间帧渲染开销；
 *   - `randomize: true`：强制随机初始化，避免稀疏树被压成一条直线；
 *   - `nodeSpacing / edgeLength` 等：兼顾展开与不飘散，视觉上更接近 Obsidian 图谱。
 */
const LAYOUT_OPTIONS = {
  name: 'cola',
  animate: true,
  refresh: 2,
  infinite: false,
  // 最长模拟 2.5s，到点强制停止；绝大多数 200~500 节点图在此时间内已经足够收敛
  maxSimulationTime: 2500,
  fit: false,
  padding: 30,
  randomize: true,
  nodeSpacing: () => 30,
  edgeLength: () => 100,
  edgeSymDiffLength: () => 50,
  edgeJaccardLength: () => 50,
  unconstrIter: 10,
  userConstIter: 10,
  allConstIter: 10,
} as unknown as cytoscape.LayoutOptions;

/**
 * 等到容器具有非零尺寸之后再跑布局，避免 fcose 在 0×0 viewport 下坍缩为一条线。
 * 使用 ResizeObserver + 一次 rAF，保证 Shadow DOM 内 flex 子项完成真实布局。
 */
function runLayoutWhenReady(
  cy: Core,
  container: HTMLElement,
  options: cytoscape.LayoutOptions,
  onLayoutReady?: (layout: cytoscape.Layouts) => void
): void {
  const start = () => {
    cy.resize();
    const layout = cy.layout(options);
    layout.run();
    if (onLayoutReady) onLayoutReady(layout);
  };

  const rect = container.getBoundingClientRect();
  if (rect.width > 2 && rect.height > 2) {
    requestAnimationFrame(start);
    return;
  }

  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width > 2 && height > 2) {
        ro.disconnect();
        requestAnimationFrame(start);
        return;
      }
    }
  });
  ro.observe(container);
  // 兜底：最多等 1s 后强制启动一次，防止 ResizeObserver 因极端场景不触发
  setTimeout(() => {
    ro.disconnect();
    start();
  }, 1000);
}

const STYLE: any = [
  {
    selector: 'node',
    style: {
      label: 'data(title)',
      'text-wrap': 'ellipsis',
      'text-max-width': '150px',
      'font-size': 12,
      color: '#d4d4d4',
      'text-valign': 'bottom',
      'text-margin-y': 6,
      width: 'data(size)',
      height: 'data(size)',
      'background-color': '#a882ff',
      'border-width': 1,
      'border-color': '#444444',
      'overlay-opacity': 0,
      'text-outline-color': '#1e1e1e',
      'text-outline-width': 2,
      // 当实际渲染字号（font-size × zoom）小于该阈值时，
      // Cytoscape 会自动跳过 label 绘制；对于大图 zoom-out 场景收益显著
      'min-zoomed-font-size': 8,
    },
  },
  {
    selector: 'node.node-db',
    style: { shape: 'round-diamond', 'background-color': '#ff6b6b' },
  },
  {
    selector: 'node.node-page',
    style: { shape: 'ellipse', 'background-color': '#a882ff' },
  },
  {
    selector: 'node.node-root',
    style: { 'border-width': 3, 'border-color': '#ffd700', 'background-color': '#ffd700' },
  },
  {
    selector: 'node.node-unauthorized',
    style: { 'background-color': '#555555', color: '#888888' },
  },
  {
    selector: 'edge',
    style: {
      width: 1.5,
      // 统一用 straight：在 200~1000 条边规模下性能足够，且避免 focused 时切换
      // curve-style 导致的端点渲染跳变（haystack → straight 视觉上会像节点挪位）。
      'curve-style': 'straight',
      'line-color': '#555555',
      opacity: 0.6,
    },
  },
  {
    selector: 'edge.edge-parent',
    style: { 'line-color': '#444444' },
  },
  {
    selector: 'edge.edge-link',
    style: { 'line-color': '#666666' },
  },
  {
    selector: '.faded',
    style: { opacity: 0.1 },
  },
  // 选中节点的邻域：仅保亮 + label 增强可读性，不改变节点尺寸/描边，
  // 避免视觉上被误读为"节点位置发生变化"
  {
    selector: '.focused',
    style: {
      opacity: 1,
      'text-outline-width': 3,
      'text-outline-color': '#000000',
      'z-index': 9999,
    },
  },
  // 只给被选中的主节点加粗描边，邻居保持原始尺寸
  {
    selector: 'node.focused-primary',
    style: {
      'border-width': 3,
      'border-color': '#ffffff',
    },
  },
  {
    selector: 'edge.focused',
    style: {
      width: 2.5,
      'line-color': '#aaaaaa',
      opacity: 1,
    },
  },
  {
    selector: 'node.dimmed',
    style: { opacity: 0.15 },
  },
  {
    selector: 'node.grabbed',
    style: {
      'border-width': 4,
      'border-color': '#ffffff',
    },
  },
  // 拖拽期间与被拖拽节点相连的边：持续亮显，便于看清拓扑关系
  {
    selector: 'edge.drag-connected',
    style: {
      width: 2.5,
      'line-color': '#ffd700',
      opacity: 1,
      'z-index': 9998,
    },
  },
];
