/**
 * 图谱相关的核心类型定义。
 * 同时服务于 background、content script 与 panel UI 三端，避免重复声明。
 */

/** Notion 资源类型 */
export type NotionObjectType = 'page' | 'database';

/** 图谱中的节点 */
export interface GraphNode {
  /** 不带连字符的 32 位 hex id，全局唯一 */
  id: string;
  /** 节点标题；未授权或尚未解析时为空串 */
  title: string;
  /** Notion 对象类型 */
  type: NotionObjectType;
  /** 在原始 Notion 站点上的 URL（用于双击跳转） */
  url: string;
  /** 是否为根节点（决定视觉样式） */
  isRoot: boolean;
  /** 是否未授权访问：link_to_page 指向了 Integration 没权限的页面 */
  unauthorized: boolean;
  /** 节点在 BFS 中的层级深度（root 为 0） */
  depth: number;
  /** 反向链接 —— 指向本节点的其他节点 id 列表（去重） */
  backlinks: string[];
  /**
   * Notion 对象的最后编辑时间（ISO 字符串）。
   * 用于增量刷新时的脏检测：若该值未变，则不必重抓 blocks。
   * 对未授权或尚未 hydrate 的节点为 undefined。
   */
  lastEditedTime?: string;
}

/** 边的类型：父子嵌套 or 正文中的超链接/提及 */
export type EdgeKind = 'parent-child' | 'link-to-page';

/** 图谱中的边 */
export interface GraphEdge {
  /** 稳定 id: `${source}->${target}:${kind}` */
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
}

/** 完整的图谱数据 */
export interface GraphData {
  rootId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 构建耗时，毫秒 */
  buildTimeMs: number;
  /** 被截断的边（因达到深度上限未继续展开）条数 */
  truncatedCount: number;
}

/** 构建选项 */
export interface BuildOptions {
  rootId: string;
  rootType: NotionObjectType;
  /** 最大递归深度，root 记为 0 */
  maxDepth: number;
  /** 是否包含父子嵌套关系 */
  includeParentChild: boolean;
  /** 是否包含正文里的 link-to-page / mention */
  includeLinkToPage: boolean;
  /** 强制绕过缓存 */
  bypassCache?: boolean;
}

/** 构建进度事件（通过 runtime port 回传给前端） */
export interface BuildProgress {
  visited: number;
  queued: number;
  currentTitle?: string;
}

/** 插件设置 */
export interface UserSettings {
  /** Notion Integration Token (secret_xxx) */
  token: string;
  /** 默认最大深度 */
  defaultMaxDepth: number;
  /** 缓存 TTL（毫秒） */
  cacheTtlMs: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  token: '',
  defaultMaxDepth: 3,
  cacheTtlMs: 10 * 60 * 1000,
};
