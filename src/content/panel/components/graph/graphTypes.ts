/**
 * 图谱表现层的内部数据类型。
 *
 * 之所以单独抽文件：
 *   - simulation / renderer / interaction / GraphView 四个模块都要共享同一份节点/边模型，
 *     避免三次重复声明；
 *   - 内部结构与上游 `GraphData`（Notion 业务语义）解耦 —— 上游给的是不可变的快照，
 *     表现层自己维护可变的「活」对象（位置、速度、实时透明度、目标透明度…）。
 */

import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';

/**
 * 力模拟 + 渲染共用的节点结构。
 *
 * 继承 `SimulationNodeDatum` 后 d3 会自动在其上附加 `x/y/vx/vy/fx/fy` 字段，
 * 不需要我们手动声明。
 */
export interface SimNode extends SimulationNodeDatum {
  /** 稳定 id（与上游 GraphNode.id 一致） */
  id: string;
  /** 展示标题；空串表示未命名 */
  title: string;
  /** 是否为「未创建 / 无权访问」节点 —— 决定视觉降级（§2.1） */
  unresolved: boolean;

  // ---- 派生视觉属性（构造时算好，graph 不变就不动） ----
  /** 度数（入边+出边总数） */
  degree: number;
  /** 视觉半径：baseRadius + sqrt(degree) * scaleFactor */
  radius: number;
  /**
   * 度数排名分位：0 表示度数最高，1 表示度数最低。
   * 用于 §3.2 的标签缩放阈值分级淡入判定。
   */
  degreeRank: number;

  // ---- 实时交互/动画状态（每帧在渲染/交互循环中更新） ----
  /** 当前帧的实际透明度（指数平滑向 targetOpacity 逼近，实现 CSS transition 感觉的过渡） */
  opacity: number;
  /** 目标透明度（悬停逻辑设置） */
  targetOpacity: number;
  /** 当前帧的实际尺寸倍率（悬停时平滑放大到 hoverScale） */
  scale: number;
  /** 目标尺寸倍率 */
  targetScale: number;
  /** 为 true 时 label 无视 zoom 阈值强制显示（§3.1） */
  forceLabel: boolean;
  /** 搜索匹配标志；搜索关键字为空时恒为 true */
  matched: boolean;
}

/**
 * 力模拟 + 渲染共用的边结构。
 *
 * d3 在首次 tick 之前会把 source/target 的字符串 id 原地替换为对应 SimNode 引用，
 * 所以这里用联合类型 —— 业务代码请通过 resolveEndpoint() 统一读取。
 */
export interface SimLink extends SimulationLinkDatum<SimNode> {
  /** 稳定 id（与上游 GraphEdge.id 一致） */
  id: string;
  source: SimNode | string;
  target: SimNode | string;
  /** 当前帧的实际透明度 */
  opacity: number;
  /** 目标透明度 */
  targetOpacity: number;
  /** 是否处于悬停相关高亮：true 使用 hoverColor + hoverWidth，false 使用 color + widthCss */
  highlighted: boolean;
}

/**
 * 读取边端点（统一处理 string | SimNode 两种阶段）。
 * 初始化期间 d3 还没替换，返回 null；调用方需容错。
 */
export function resolveEndpoint(endpoint: SimNode | string): SimNode | null {
  return typeof endpoint === 'string' ? null : endpoint;
}

/** 视口 / 相机参数。屏幕坐标与世界坐标的桥梁。 */
export interface Camera {
  /** 画布 CSS 宽度 */
  width: number;
  /** 画布 CSS 高度 */
  height: number;
  /** 缩放倍率 */
  zoom: number;
  /** 世界坐标原点相对画布中心的平移量（CSS 像素） */
  tx: number;
  ty: number;
}

/**
 * 屏幕坐标 → 世界坐标。
 *
 * 世界坐标系原点位于画布中心（对应 d3 的 forceCenter(0,0)），
 * 再叠加相机平移 tx/ty 和 zoom。
 */
export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - cam.width / 2 - cam.tx) / cam.zoom,
    y: (sy - cam.height / 2 - cam.ty) / cam.zoom,
  };
}

/** 世界坐标 → 屏幕坐标（rarely 需要，仅为对称完整） */
export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return {
    x: wx * cam.zoom + cam.width / 2 + cam.tx,
    y: wy * cam.zoom + cam.height / 2 + cam.ty,
  };
}
