/**
 * 知识图谱表现层入口。
 *
 * 架构：
 *   - 本组件是极薄的 React 壳子，职责仅限于：
 *       · 挂载 `<canvas>` 并处理 DPR、容器尺寸变化；
 *       · 装配 d3-force simulation / 事件层 / 渲染循环，并衔接它们的数据流；
 *       · 响应 `graph` / `query` prop 的变化做增量同步。
 *   - 所有物理、视觉、交互细节都在 `graph/` 子目录里实现，严格按 [设计方案.md](设计方案.md)
 *     1:1 复刻 Obsidian 知识图谱（§2 视觉 / §3 交互 / §4 物理 / §5 性能）。
 *
 * rAF 策略：
 *   - 帧循环本身由 `simulation.tick()` + `render()` 合并驱动；
 *   - 静止条件：物理已冷却 + 所有 UI 过渡已收敛 + 交互层无惯性动能
 *     → 主动 `cancelAnimationFrame` 释放 CPU；
 *   - 任意事件（悬停、拖拽、平移、缩放、graph/query 变化）都会调用 `wake()`
 *     幂等地重新启动帧循环。
 */

import { useEffect, useRef, type ReactElement } from 'react';
import type { GraphData } from '@/core/types';
import { GRAPH_CONFIG } from './graph/graphConfig';
import { render, type RenderState } from './graph/graphRenderer';
import {
  applyIncremental,
  buildSimData,
  createSimulation,
  isSimulationActive,
  type GraphSimulation,
} from './graph/graphSimulation';
import { installInteraction } from './graph/graphInteraction';
import type { Camera, SimLink, SimNode } from './graph/graphTypes';

interface Props {
  graph: GraphData;
  query: string;
}

export default function GraphView(props: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /**
   * 所有「活」数据放在 ref 里，避免每次 React re-render 重建导致动画断点。
   * 使用对象包一层，方便整体替换 + 事件层闭包读取到最新值。
   */
  const stateRef = useRef<{
    nodes: SimNode[];
    links: SimLink[];
    simulation: GraphSimulation | null;
    camera: Camera;
    query: string;
  }>({
    nodes: [],
    links: [],
    simulation: null,
    camera: { width: 0, height: 0, zoom: 1, tx: 0, ty: 0 },
    query: '',
  });

  const rafRef = useRef<number>(0);
  const lastFrameTsRef = useRef<number>(0);
  const interactionRef = useRef<ReturnType<typeof installInteraction> | null>(null);

  /**
   * 最新 graph 的 ref 快照。
   *
   * 作用：
   *   interaction 的 onNodeActivate 回调只在初始化时注入一次，之后的 graph 变化
   *   不能通过 props 闭包捕获到。用 ref 让回调始终读到最新的 graph.nodes，
   *   避免因 React re-render 的闭包陈旧而跳错页面。
   */
  const graphRef = useRef<GraphData>(props.graph);

  // -------------------- 初始化：一次性装配 --------------------
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    // ------------------------------------------------------------------
    // ⚠️ 声明顺序说明：
    //   下面几个闭包（resize / tick / wake / interaction 的 wake 回调）互相引用，
    //   并且 installInteraction 内部的 reapplyState() 会**同步触发** `cb.wake()`，
    //   所以 `wake` 必须在调用 installInteraction 之前就可用 —— 这里统一用
    //   `function` 声明利用函数提升，彻底避开 `const` 的 TDZ（暂时性死区）。
    // ------------------------------------------------------------------

    function wake(): void {
      if (rafRef.current !== 0) return; // 已排队
      lastFrameTsRef.current = 0;
      rafRef.current = requestAnimationFrame(tick);
    }

    function tick(ts: number): void {
      rafRef.current = 0;
      const dt = lastFrameTsRef.current === 0 ? 16 : ts - lastFrameTsRef.current;
      lastFrameTsRef.current = ts;

      const sim = stateRef.current.simulation;
      const simActive = sim ? isSimulationActive(sim) : false;

      if (sim && sim.alpha() > 0) {
        sim.tick();
      }

      const interactionActive = interactionRef.current?.step() ?? false;

      const rs: RenderState = {
        nodes: stateRef.current.nodes,
        links: stateRef.current.links,
        camera: stateRef.current.camera,
        dpr,
        dt: Math.min(64, dt), // 截断极端长帧，避免过渡一次性跳过
      };
      const transitionsPending = render(ctx!, rs);

      if (simActive || interactionActive || transitionsPending) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        lastFrameTsRef.current = 0;
      }
    }

    function resize(): void {
      const rect = container!.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      stateRef.current.camera.width = w;
      stateRef.current.camera.height = h;
      wake();
    }

    resize();

    // 初始化 simulation + 数据
    const { nodes, links } = buildSimData(props.graph, null);
    stateRef.current.nodes = nodes;
    stateRef.current.links = links;
    stateRef.current.simulation = createSimulation(nodes, links);
    stateRef.current.query = props.query.trim().toLowerCase();
    applyQueryFilter(nodes, stateRef.current.query);

    // 装配交互层 —— wake 已经在上方通过函数声明提升可用
    const interaction = installInteraction(canvas, {
      wake,
      getState: () => ({
        nodes: stateRef.current.nodes,
        links: stateRef.current.links,
        camera: stateRef.current.camera,
        simulation: stateRef.current.simulation!,
        query: stateRef.current.query,
      }),
      onNodeActivate: (id) => {
        // 双击节点 → 打开对应 Notion 原页面；未授权/无效 URL 直接忽略
        const node = graphRef.current.nodes.find((n) => n.id === id);
        if (!node || !node.url) return;
        window.open(node.url, '_blank', 'noopener,noreferrer');
      },
    });
    interactionRef.current = interaction;
    interaction.reapplyState(); // 让搜索过滤的默认态先生效

    // 容器尺寸变化
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    wake();

    return () => {
      ro.disconnect();
      interaction.detach();
      interactionRef.current = null;
      if (rafRef.current !== 0) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (stateRef.current.simulation) {
        stateRef.current.simulation.stop();
        stateRef.current.simulation = null;
      }
    };
    // 只初始化一次；后续 graph/query 变化由下面的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------- graph 变化：增量同步 --------------------
  useEffect(() => {
    graphRef.current = props.graph; // 先同步到最新快照，供交互回调闭包读取
    const sim = stateRef.current.simulation;
    const interaction = interactionRef.current;
    if (!sim || !interaction) return;

    // 保留旧节点的 x/y/vx/vy/opacity/scale —— 让拓扑变化不会出现视觉跳变
    const { nodes, links } = buildSimData(props.graph, stateRef.current.nodes);
    stateRef.current.nodes = nodes;
    stateRef.current.links = links;
    applyIncremental(sim, nodes, links);
    applyQueryFilter(nodes, stateRef.current.query);
    interaction.refreshAdjacency();
    interaction.reapplyState();
  }, [props.graph]);

  // -------------------- query 变化：仅重算 matched 与默认透明度，不重跑物理 --------------------
  useEffect(() => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const q = props.query.trim().toLowerCase();
    stateRef.current.query = q;
    applyQueryFilter(stateRef.current.nodes, q);
    interaction.reapplyState();
  }, [props.query]);

  return (
    <div
      ref={containerRef}
      className="ng-graph-canvas"
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: GRAPH_CONFIG.background,
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
}

// -------------------- helpers --------------------

/**
 * 遍历节点更新 `matched` 标志：空 query 时恒为 true。
 *
 * 注意只改 matched，不动 targetOpacity —— target 的计算在
 * `applyHoverState`（interaction 内部）里完成，调用 `reapplyState()` 会触发。
 */
function applyQueryFilter(nodes: SimNode[], query: string): void {
  if (!query) {
    for (const n of nodes) n.matched = true;
    return;
  }
  for (const n of nodes) {
    n.matched = n.title.toLowerCase().includes(query);
  }
}
