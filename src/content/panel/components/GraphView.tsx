/**
 * Cytoscape 封装：力导向布局 + 节点/边样式区分 + 单击高亮 + 双击跳转 + 右键换根。
 *
 * 性能策略（针对 200+ 节点的大图）：
 *   - 布局一次性收敛即停（cola `infinite:false` + `maxSimulationTime`），
 *       静止时 CPU 占用归零；拖拽节点不触发 relayout，拖到哪就放在哪；
 *   - 开启 Cytoscape 的 viewport 级隐藏：平移/缩放时不画边和 label，使用纹理缓存；
 *   - 边默认使用 `haystack`（最快的曲线类型），仅在 focused 时切回 `straight` 以保证高亮清晰；
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
      // 平移/缩放中隐藏边和 label，只画节点，显著降低交互期间的绘制开销
      hideEdgesOnViewport: true,
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

    // 拖拽节点：仅加样式，不重启布局。
    // 设计取舍：
    //   - 初次收敛后布局已停止（infinite:false），此时拖拽邻居不会跟随，符合 Obsidian 风格的"定位"交互；
    //   - 若需要"弹性"效果，可在 grabon 里启动短时 relayout，但会带来 200+ 节点下的一次抖动，权衡后选择不做。
    cy.on('grabon', 'node', (evt) => {
      evt.target.addClass('grabbed');
    });
    cy.on('free', 'node', (evt) => {
      evt.target.removeClass('grabbed');
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

function highlightNeighborhood(cy: Core, id: string): void {
  const target = cy.getElementById(id);
  if (target.empty()) return;
  const neighborhood = target.closedNeighborhood();
  cy.batch(() => {
    cy.elements().addClass('faded');
    neighborhood.removeClass('faded').addClass('focused');
  });
}

function clearHighlight(cy: Core): void {
  cy.batch(() => {
    cy.elements().removeClass('faded focused');
  });
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
      // haystack 是 cytoscape 里最快的曲线类型：用预绘制的线束批量渲染，
      // 不支持箭头和弯曲，但本项目本来就是无箭头直线，完美契合。
      'curve-style': 'haystack',
      'haystack-radius': 0,
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
  {
    selector: '.focused',
    style: { 
      opacity: 1,
      'text-outline-width': 3,
      'text-outline-color': '#000000',
      'z-index': 9999,
    },
  },
  {
    selector: 'node.focused',
    style: {
      'border-width': 3,
      'border-color': '#ffffff',
    },
  },
  {
    selector: 'edge.focused',
    style: {
      // focused 时切回 straight，保证高亮边的走线更清晰；
      // 此时只有少量边进入该分支，不影响整体性能。
      'curve-style': 'straight',
      width: 2.5,
      'line-color': '#aaaaaa',
      opacity: 1,
    }
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
    }
  }
];
