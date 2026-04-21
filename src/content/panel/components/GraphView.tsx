/**
 * Cytoscape 封装：力导向布局 + 节点/边样式区分 + 单击高亮 + 双击跳转 + 右键换根。
 *
 * 性能策略（针对 200+ 节点的大图）：
 *   - 初始布局一次性收敛即停（cola `infinite:false` + `maxSimulationTime`），
 *       静止时 CPU 占用归零；
 *   - 拖拽节点时启动 infinite cola（保留坐标、不 fit），邻居按弹簧力联动；
 *       松手后切换为 finite cola（有 maxSimulationTime）让力场自然衰减到平衡再停，
 *       不是硬 stop —— Obsidian 风格的弹性手感 + 低稳态功耗 + 平滑缓动；
 *   - 平移/缩放时隐藏 label 并用纹理缓存，但**不**隐藏边，以免和拖拽时 cola 持续
 *       更新节点位置冲突导致连线"闪没"；
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

    // 拖拽节点：弹性联动（Obsidian 风格）。
    // 设计：
    //   - grab 时启动 infinite cola：被拖拽节点被 cytoscape 自动视作固定点，
    //       邻居在弹簧/斥力下自然跟随。同时给相连边加 `drag-connected` 高亮，
    //       让用户一眼看到当前节点连接了哪些其他节点。
    //   - free 时不硬 stop，而是切换到 **finite cola**（有 maxSimulationTime），
    //       让力场自然衰减到接近平衡再停 —— 这样整张图的"缓动"曲线是衰减的，
    //       不会在最后一刻出现突兀的静止帧。
    //   - 若用户接连拖拽多个节点，再次 grab 会 cancel 掉正在运行的 settle 布局。
    cy.on('grabon', 'node', (evt) => {
      const node = evt.target;
      // 安全兜底：上一次 settle 可能还没来得及 unlock（例如 graph 重建、组件卸载等
      // 异常路径），这里在新一次拖拽开始前统一放行所有节点，避免出现"某个节点再也拖不动"。
      cy.nodes().unlock();
      node.addClass('grabbed');
      highlightConnectedEdges(cy, node.id());
      startDragLayout(cy, layoutRef);
    });
    cy.on('free', 'node', (evt) => {
      const node = evt.target;
      node.removeClass('grabbed');
      clearConnectedEdges(cy);
      // 关键：锁定松手节点，避免 settle 布局把它拉回原力场平衡位置（否则"弹回原地"）；
      // settle 结束（layoutstop）时 unlock，恢复用户拖拽能力。
      node.lock();
      startSettleLayout(cy, layoutRef, () => {
        node.unlock();
      });
    });

    return () => {
      if (layoutRef.current) {
        layoutRef.current.stop();
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
 * 拖拽期间使用的 cola 布局：
 *   - `randomize: false`：保留现有节点坐标，仅施加力；否则会把整张图重随机散布。
 *   - `infinite: true`：持续模拟，直到 free 后切换成 settle 布局。
 *   - `fit: false`：不重置 viewport（用户当前的缩放/平移保持不变）。
 *
 * cytoscape 把被 `grab` 的节点视为"固定点"（grabbed 属性为 true），cola 在每一步
 * 计算时不会改变它的位置，周围节点通过弹簧/斥力被自然带动——这就是 Obsidian 风格的
 * 弹性拖拽手感。
 */
function startDragLayout(cy: Core, layoutRef: { current: cytoscape.Layouts | null }): void {
  if (layoutRef.current) {
    layoutRef.current.stop();
  }
  const dragOptions = {
    ...(LAYOUT_OPTIONS as unknown as Record<string, unknown>),
    randomize: false,
    infinite: true,
    fit: false,
    animate: true,
    maxSimulationTime: Number.POSITIVE_INFINITY,
  } as unknown as cytoscape.LayoutOptions;
  const layout = cy.layout(dragOptions);
  layout.run();
  layoutRef.current = layout;
}

/**
 * 松手后的 "settle"（缓动收敛）布局：
 *   - 从 infinite 切回 finite，`maxSimulationTime: 1800` 让 cola 在一个略长的时间窗口内
 *       自然衰减到力学平衡；由于弹簧已经接近稳定，最后几帧的位移本来就很小，
 *       看起来是平滑渐停而不是"突然定住"。
 *   - 保留 `animate/refresh` 和默认的 `convergenceThreshold`，让 cola 若早已稳定可提前结束。
 *   - 不 randomize、不 fit，保持用户视角不变。
 *
 * @param onStop  当 settle 布局停止（自然到期或被后续 grab 打断）时回调一次。
 *                通常用于 unlock 之前被 free 锁定的节点。
 */
function startSettleLayout(
  cy: Core,
  layoutRef: { current: cytoscape.Layouts | null },
  onStop?: () => void
): void {
  if (layoutRef.current) {
    layoutRef.current.stop();
  }
  const settleOptions = {
    ...(LAYOUT_OPTIONS as unknown as Record<string, unknown>),
    randomize: false,
    infinite: false,
    fit: false,
    animate: true,
    // 缓动时长：足够长以掩盖 stop 边界，但也不会让 CPU 空转太久
    maxSimulationTime: 1800,
  } as unknown as cytoscape.LayoutOptions;
  const layout = cy.layout(settleOptions);
  if (onStop) {
    // `one` 保证无论是自然到期、convergenceThreshold 提前结束，还是被后续 grab
    // 主动 stop，都只会回调一次，避免重复 unlock。
    layout.one('layoutstop', onStop);
  }
  layout.run();
  layoutRef.current = layout;
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
