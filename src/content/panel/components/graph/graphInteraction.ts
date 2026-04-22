/**
 * 图谱画布上的指针交互层。
 *
 * 四种手势（设计方案 §3）：
 *   - 悬停命中：pointermove 反变换到世界坐标后对节点做 O(N) 扫描，外扩 pickTolerance 容差；
 *     命中 → 主节点放大 + 一度邻居保亮 + 相关边高亮 + 其余全局暗化 dimOpacity。
 *   - 平移：pointerdown 在空白处拖拽，pointerup 留一点点惯性让滑动更「有质量」。
 *   - 缩放：wheel 事件，以鼠标指针为中心（而非画布中心）——
 *     保持指针下方世界点坐标不变，回推 tx/ty 的增量。
 *   - 节点拖拽：pointerdown 命中节点 → 设 fx/fy 钉死位置 + reheatForDrag()；
 *     pointermove 更新 fx/fy；pointerup 解除 + stopDrag()。
 *
 * 设计取舍：
 *   - 使用 Pointer Events 统一鼠标/触控/触控板；
 *   - 由于节点数量上限在 500 左右，O(N) 扫描够用，不引入 quadtree；
 *   - interaction 自己不直接画帧，只修改 state（camera、节点 target*）并 wake() 上层 rAF；
 *   - 惯性滑动在 wake 驱动的下一帧 renderer tick 里推进（通过 wake 调用本模块的 step）。
 */

import { GRAPH_CONFIG } from './graphConfig';
import { screenToWorld, type Camera, type SimLink, type SimNode } from './graphTypes';
import type { GraphSimulation } from './graphSimulation';
import { reheatForDrag, stopDrag } from './graphSimulation';

const N = GRAPH_CONFIG.node;
const I = GRAPH_CONFIG.interaction;
const L = GRAPH_CONFIG.link;

/**
 * interaction 需要的回调：修改实时状态后唤醒渲染循环重新跑 rAF。
 * GraphView 负责注入。
 */
export interface InteractionCallbacks {
  /** 唤醒 rAF（幂等；已在跑就忽略） */
  wake: () => void;
  /** 读取当前帧数据（nodes/links/camera/simulation）；每次交互事件都用最新引用 */
  getState: () => {
    nodes: SimNode[];
    links: SimLink[];
    camera: Camera;
    simulation: GraphSimulation;
    /** 搜索关键字小写（空串表示无过滤） */
    query: string;
  };
  /**
   * 节点被「激活」—— 目前的触发源是双击命中（设计方案 §3 的交互扩展）。
   * interaction 层自己不知道如何处理激活（打开新 tab / 聚焦 / 路由…），
   * 把 id 向上抛给 GraphView，由业务层决定 —— 保持表现层与业务层解耦。
   */
  onNodeActivate?: (id: string) => void;
}

/** 邻接表：nodeId → 一度邻居 id 集合 */
type Adjacency = Map<string, Set<string>>;

/**
 * 安装交互处理器。返回 detach() 用于卸载所有事件。
 *
 * 重要：我们只在 canvas 上绑定少数事件；pointermove 在 pointerdown 后也挂到 window，
 * 确保即使鼠标滑出画布也能完成拖动，松开后自动移除。
 */
export function installInteraction(
  canvas: HTMLCanvasElement,
  cb: InteractionCallbacks,
): {
  detach: () => void;
  /**
   * 每帧 rAF 中由上层调用，推进惯性滑动。
   * 返回 true 表示本帧仍有惯性动能需要下一帧继续推进。
   */
  step: () => boolean;
  /**
   * graph 变化后刷新内部邻接表 —— 悬停逻辑要靠它快速取一度邻居。
   */
  refreshAdjacency: () => void;
  /**
   * 重新把当前悬停/搜索态写入 nodes/links 的 target* 字段。
   *
   * 用场景：
   *   - 搜索关键字变化后，需要根据最新 matched 重新计算默认透明度；
   *   - graph 增量更新后，新节点的 target* 还没被交互层触达过，需要同步一次。
   */
  reapplyState: () => void;
} {
  /** 邻接表：每次 graph 变动后重建；悬停时 O(1) 查找 */
  let adjacency: Adjacency = new Map();

  /** 当前悬停的节点 id（null = 无悬停） */
  let hoveredId: string | null = null;
  /** 当前正在拖拽的节点（null = 不在拖节点） */
  let draggingNode: SimNode | null = null;
  /** 当前是否在平移画布 */
  let panning = false;
  /** 平移起点（屏幕坐标） + 起点时的相机平移量 */
  let panStart = { sx: 0, sy: 0, tx: 0, ty: 0 };
  /** 平移末速度（用于松手后的惯性滑动） */
  let panVelocity = { vx: 0, vy: 0 };
  /** 记录最近两帧的 pointermove 时间与位置，用来估算末速度 */
  let lastMove: { sx: number; sy: number; t: number } | null = null;

  // ---- 邻接表 ----

  const rebuildAdjacency = (): void => {
    const { links } = cb.getState();
    adjacency = new Map();
    for (const l of links) {
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      if (!adjacency.has(s)) adjacency.set(s, new Set());
      if (!adjacency.has(t)) adjacency.set(t, new Set());
      adjacency.get(s)!.add(t);
      adjacency.get(t)!.add(s);
    }
  };

  rebuildAdjacency();

  // ---- 悬停 / 高亮状态应用 ----

  /**
   * 把 hover 状态写入 nodes / links 的 target* 字段；
   * 由 renderer 每帧做指数平滑插值，呈现 150-200ms 过渡效果。
   */
  const applyHoverState = (hoverId: string | null): void => {
    const { nodes, links, query } = cb.getState();
    const neighbors = hoverId ? adjacency.get(hoverId) ?? new Set<string>() : null;

    if (hoverId === null) {
      // 无悬停：回到默认态（被搜索过滤掉的节点额外暗化）
      for (const n of nodes) {
        n.targetOpacity = resolveDefaultOpacity(n, query);
        n.targetScale = 1;
        n.forceLabel = false;
      }
      for (const l of links) {
        l.targetOpacity = 1;
        l.highlighted = false;
      }
      return;
    }

    // 有悬停
    for (const n of nodes) {
      const isMain = n.id === hoverId;
      const isNeighbor = neighbors!.has(n.id);
      if (isMain) {
        n.targetOpacity = 1;
        n.targetScale = N.hoverScale;
        n.forceLabel = true;
      } else if (isNeighbor) {
        n.targetOpacity = 1;
        n.targetScale = 1;
        n.forceLabel = true;
      } else {
        n.targetOpacity = I.dimOpacity;
        n.targetScale = 1;
        n.forceLabel = false;
      }
    }
    for (const l of links) {
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      const related = s === hoverId || t === hoverId;
      if (related) {
        l.targetOpacity = 1;
        l.highlighted = true;
      } else {
        l.targetOpacity = I.dimOpacity;
        l.highlighted = false;
      }
    }
  };

  /** 搜索过滤下的默认透明度：未匹配 → 更暗；未解析节点 → 半透明；其余 = 1 */
  const resolveDefaultOpacity = (n: SimNode, query: string): number => {
    if (query && !n.matched) return I.queryDimOpacity;
    if (n.unresolved) return N.unresolvedOpacity;
    return 1;
  };

  // ---- 命中测试 ----

  /** 把屏幕坐标反变换到世界坐标 */
  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const { camera } = cb.getState();
    return screenToWorld(camera, sx, sy);
  };

  /**
   * 找出鼠标下方的节点。从后往前扫 —— 高度重叠场景下优先命中最后绘制的
   * （但由于我们悬停放大后才上浮，无悬停时前后顺序无所谓；此处保持简单）。
   *
   * 命中判据：点在节点圆内（外扩 pickTolerance）；节点越小命中越难，
   * 但 pickTolerance 会把微小节点兜到至少 baseRadius+tolerance 的可命中范围。
   */
  const pickNodeAt = (wx: number, wy: number): SimNode | null => {
    const { nodes } = cb.getState();
    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (const n of nodes) {
      const dx = wx - (n.x ?? 0);
      const dy = wy - (n.y ?? 0);
      const distSq = dx * dx + dy * dy;
      const r = n.radius + N.pickTolerance;
      if (distSq <= r * r && distSq < bestDist) {
        best = n;
        bestDist = distSq;
      }
    }
    return best;
  };

  // ---- 事件处理 ----

  const onPointerDown = (e: PointerEvent): void => {
    // 只处理左键 + 触控；其他按键（如中键/右键）放给浏览器默认行为
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    canvas.setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    const hit = pickNodeAt(w.x, w.y);
    if (hit) {
      // ---- 拖拽节点 ----
      draggingNode = hit;
      hit.fx = hit.x;
      hit.fy = hit.y;
      reheatForDrag(cb.getState().simulation);
    } else {
      // ---- 平移画布 ----
      panning = true;
      const { camera } = cb.getState();
      panStart = { sx: e.clientX, sy: e.clientY, tx: camera.tx, ty: camera.ty };
      panVelocity = { vx: 0, vy: 0 };
      lastMove = { sx: e.clientX, sy: e.clientY, t: performance.now() };
    }
    cb.wake();
  };

  const onPointerMove = (e: PointerEvent): void => {
    const w = toWorld(e.clientX, e.clientY);

    if (draggingNode) {
      draggingNode.fx = w.x;
      draggingNode.fy = w.y;
      cb.wake();
      return;
    }

    if (panning) {
      const { camera } = cb.getState();
      camera.tx = panStart.tx + (e.clientX - panStart.sx);
      camera.ty = panStart.ty + (e.clientY - panStart.sy);

      // 估算瞬时速度用于惯性
      const now = performance.now();
      if (lastMove) {
        const dt = Math.max(1, now - lastMove.t);
        panVelocity.vx = (e.clientX - lastMove.sx) / dt * 16; // 转换到 px/frame（按 60fps）
        panVelocity.vy = (e.clientY - lastMove.sy) / dt * 16;
      }
      lastMove = { sx: e.clientX, sy: e.clientY, t: now };

      cb.wake();
      return;
    }

    // 悬停：重新命中测试
    const hit = pickNodeAt(w.x, w.y);
    const newId = hit ? hit.id : null;
    if (newId !== hoveredId) {
      hoveredId = newId;
      applyHoverState(hoveredId);
      // 切换鼠标样式 —— 有命中显示 pointer，其他情况显示 grab/default
      canvas.style.cursor = hit ? 'pointer' : 'default';
      cb.wake();
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    if (draggingNode) {
      // 松手：清除 fx/fy，解除钉位；alphaTarget 归零让模拟自然冷却
      draggingNode.fx = null;
      draggingNode.fy = null;
      draggingNode = null;
      stopDrag(cb.getState().simulation);
    }
    if (panning) {
      panning = false;
      // 惯性滑动交给 step() 逐帧推进；如果末速度很小就直接忽略
      if (
        Math.abs(panVelocity.vx) < I.panInertiaMinSpeed &&
        Math.abs(panVelocity.vy) < I.panInertiaMinSpeed
      ) {
        panVelocity = { vx: 0, vy: 0 };
      }
    }
    cb.wake();
  };

  /**
   * 滚轮缩放 —— 以鼠标当前指针位置为缩放中心（§3.2）。
   *
   * 原理：先记录指针下的世界坐标 before，缩放后世界坐标会变，
   * 把 camera.tx/ty 做反向补偿，使同一屏幕点对应的世界坐标仍是 before。
   */
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { camera } = cb.getState();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const before = screenToWorld(camera, sx, sy);

    const factor = Math.exp(-e.deltaY * I.zoomSpeed);
    const newZoom = clamp(camera.zoom * factor, I.zoomMin, I.zoomMax);
    camera.zoom = newZoom;

    const after = screenToWorld(camera, sx, sy);
    // 屏幕点固定 ⇒ (before - after) * zoom 就是需要补偿的平移量
    camera.tx += (after.x - before.x) * newZoom;
    camera.ty += (after.y - before.y) * newZoom;

    cb.wake();
  };

  /**
   * 双击命中节点 → 激活（当前由上层实现为打开 Notion 原页面）。
   *
   * 注意点：
   *   - 浏览器会在两次 click 之后才派发 dblclick，中间会触发两次 pointerdown/up；
   *     第一次 down 命中节点时 onPointerDown 里会进入拖拽分支设置 fx/fy —— 这没关系，
   *     up 时会立即解除，只是短暂让 simulation 重新加热一下，不会影响双击跳转；
   *   - 调用 preventDefault() 避免浏览器默认的「双击选中」在画布上意外触发。
   */
  const onDoubleClick = (e: MouseEvent): void => {
    const w = toWorld(e.clientX, e.clientY);
    const hit = pickNodeAt(w.x, w.y);
    if (!hit) return;
    e.preventDefault();
    cb.onNodeActivate?.(hit.id);
  };

  const onPointerLeave = (): void => {
    // 鼠标离开画布（未拖拽时）→ 清除悬停
    if (draggingNode || panning) return;
    if (hoveredId !== null) {
      hoveredId = null;
      applyHoverState(null);
      canvas.style.cursor = 'default';
      cb.wake();
    }
  };

  // 绑定
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDoubleClick);
  // 右键菜单禁用（避免干扰画布体验；同时对齐设计方案未提到右键行为的现状）
  const onContextMenu = (e: MouseEvent): void => e.preventDefault();
  canvas.addEventListener('contextmenu', onContextMenu);

  // 每帧 step：推进平移惯性
  const step = (): boolean => {
    if (panning || draggingNode) return true; // 交互中本身就要继续 rAF
    if (
      Math.abs(panVelocity.vx) < I.panInertiaMinSpeed &&
      Math.abs(panVelocity.vy) < I.panInertiaMinSpeed
    ) {
      if (panVelocity.vx !== 0 || panVelocity.vy !== 0) panVelocity = { vx: 0, vy: 0 };
      return false;
    }
    const { camera } = cb.getState();
    camera.tx += panVelocity.vx;
    camera.ty += panVelocity.vy;
    panVelocity.vx *= I.panInertiaDecay;
    panVelocity.vy *= I.panInertiaDecay;
    return true;
  };

  const detach = (): void => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDoubleClick);
    canvas.removeEventListener('contextmenu', onContextMenu);
  };

  // 避免未使用变量警告（高亮态写入同时也会用到 L 里的颜色 —— renderer 读取的，这里仅 refer 以显示意图）
  void L;

  const reapplyState = (): void => {
    // 若上一轮记录的悬停节点已随 graph 变化被移除 —— 悬停态直接作废，
    // 否则 applyHoverState 会把一个空邻居集套在整张图上，造成全局误暗化。
    if (hoveredId !== null) {
      const { nodes } = cb.getState();
      const stillExists = nodes.some((n) => n.id === hoveredId);
      if (!stillExists) hoveredId = null;
    }
    applyHoverState(hoveredId);
    cb.wake();
  };

  return { detach, step, refreshAdjacency: rebuildAdjacency, reapplyState };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
