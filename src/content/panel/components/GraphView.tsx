/**
 * Cytoscape 封装：力导向布局 + 节点/边样式区分 + 单击高亮 + 双击跳转 + 右键换根。
 *
 * 性能策略：
 *   - graph 变化时 batch 更新元素而不是整个重建；
 *   - 搜索只改 class，避免重新布局；
 *   - 节点点击回调外抛给 SidePanel。
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react';
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

    // 拖拽节点时，cola 会自动处理，但为了更好的交互，可以在拖拽时增加一些样式
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

  // 搜索过滤：不重算布局，仅改样式
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const q = props.query.trim().toLowerCase();
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const title = ((n.data('title') as string) ?? '').toLowerCase();
        const match = q === '' || title.includes(q);
        n.toggleClass('dimmed', !match);
      });
    });
  }, [props.query]);

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
 * fcose 力导向布局参数。
 *
 * 关键取舍：
 *   - `randomize: true`：强制随机初始化，避免稀疏树被压成一条直线；
 *   - `quality: 'proof'`：多跑几轮迭代，对树/链状结构尤其有必要，否则容易卡在局部极值；
 *   - `nodeRepulsion` 拉大 + `gravity` 轻度收拢：兼顾展开与不飘散；
 *   - `packComponents: true`：把多个连通分量平面化拼接，避免再次串成一串；
 *   - `tilingPaddingVertical/Horizontal`：给孤立/小团块留出空间，视觉上更接近 Obsidian 图谱。
 */
const LAYOUT_OPTIONS = {
  name: 'cola',
  animate: true,
  refresh: 1,
  infinite: true,
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
      'curve-style': 'bezier',
      'line-color': '#555555',
      'target-arrow-color': '#555555',
      'target-arrow-shape': 'none',
      'arrow-scale': 0.8,
      opacity: 0.6,
    },
  },
  {
    selector: 'edge.edge-parent',
    style: { 'line-color': '#444444', 'target-arrow-color': '#444444' },
  },
  {
    selector: 'edge.edge-link',
    style: { 'line-style': 'solid', 'line-color': '#666666', 'target-arrow-color': '#666666' },
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
