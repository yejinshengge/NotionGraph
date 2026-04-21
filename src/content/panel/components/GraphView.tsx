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
import type { GraphData, GraphNode } from '@/core/types';

// 注册布局（多次注册会被 cytoscape 自行 dedupe，但为稳妥判重）
let fcoseRegistered = false;
function ensureLayout(): void {
  if (!fcoseRegistered) {
    cytoscape.use(fcose);
    fcoseRegistered = true;
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

  const elements = useMemo(() => toElements(props.graph), [props.graph]);

  // 初始化 cytoscape
  useEffect(() => {
    ensureLayout();
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: STYLE,
      wheelSensitivity: 0.25,
      minZoom: 0.2,
      maxZoom: 3,
    });
    cyRef.current = cy;

    cy.layout(LAYOUT_OPTIONS).run();

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

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // graph 变更：增量更新
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    cy.layout(LAYOUT_OPTIONS).run();
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

const LAYOUT_OPTIONS: cytoscape.LayoutOptions = {
  name: 'fcose',
  animate: true,
  animationDuration: 400,
  randomize: false,
  nodeRepulsion: () => 6500,
  idealEdgeLength: () => 90,
  edgeElasticity: () => 0.35,
  nodeSeparation: 60,
  padding: 24,
  fit: true,
} as cytoscape.LayoutOptions;

const STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      label: 'data(title)',
      'text-wrap': 'ellipsis',
      'text-max-width': '120px',
      'font-size': 11,
      color: '#37352f',
      'text-valign': 'bottom',
      'text-margin-y': 4,
      width: 'data(size)',
      height: 'data(size)',
      'background-color': '#2383e2',
      'border-width': 2,
      'border-color': '#ffffff',
      'overlay-opacity': 0,
    },
  },
  {
    selector: 'node.node-db',
    style: { shape: 'round-diamond', 'background-color': '#e03e3e' },
  },
  {
    selector: 'node.node-page',
    style: { shape: 'ellipse', 'background-color': '#2383e2' },
  },
  {
    selector: 'node.node-root',
    style: { 'border-width': 4, 'border-color': '#f4b400' },
  },
  {
    selector: 'node.node-unauthorized',
    style: { 'background-color': '#c7c6c0', color: '#787774' },
  },
  {
    selector: 'edge',
    style: {
      width: 1.2,
      'curve-style': 'bezier',
      'line-color': '#b8b8b4',
      'target-arrow-color': '#b8b8b4',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.9,
    },
  },
  {
    selector: 'edge.edge-parent',
    style: { 'line-color': '#787774', 'target-arrow-color': '#787774' },
  },
  {
    selector: 'edge.edge-link',
    style: { 'line-style': 'dashed', 'line-color': '#2383e2', 'target-arrow-color': '#2383e2' },
  },
  {
    selector: '.faded',
    style: { opacity: 0.15 },
  },
  {
    selector: '.focused',
    style: { opacity: 1 },
  },
  {
    selector: 'node.dimmed',
    style: { opacity: 0.25 },
  },
];
