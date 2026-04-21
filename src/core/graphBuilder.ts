/**
 * 图谱构建器：以某个 page/database 为根，按 BFS 遍历扩展，
 * 在层级深度上限内收集全部父子关系与双向链接。
 *
 * - 节点 id 以紧凑 hex 作为主键，保证去重；
 * - 边用 `${src}->${tgt}:${kind}` 作为唯一键去重；
 * - 双向反链：所有指向 N 的边会把 source 注入 N.backlinks；
 * - 支持 AbortSignal 中断；
 * - 通过 onProgress 回调上报已访问 / 剩余队列数。
 */

import {
  extractDatabaseTitle,
  extractPageTitle,
  NotionClient,
  type NotionPage,
  type NotionDatabase,
  type NotionBlock,
} from './notionClient';
import { buildNotionUrl, toCompactId } from './idUtils';
import { extractRefs } from './linkExtractor';
import type {
  BuildOptions,
  BuildProgress,
  EdgeKind,
  GraphData,
  GraphEdge,
  GraphNode,
  NotionObjectType,
} from './types';

export interface BuilderDeps {
  client: NotionClient;
  signal?: AbortSignal;
  onProgress?: (p: BuildProgress) => void;
}

/** BFS 队列单元 */
interface QueueItem {
  id: string;
  type: NotionObjectType;
  depth: number;
}

export async function buildGraph(opts: BuildOptions, deps: BuilderDeps): Promise<GraphData> {
  const { client, signal, onProgress } = deps;
  const start = performance.now();

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const visitedExpanded = new Set<string>(); // 已经展开过 children 的 id
  let truncatedCount = 0;

  const rootId = toCompactId(opts.rootId);

  // 1) 放入根节点占位
  nodes.set(rootId, createPlaceholderNode(rootId, opts.rootType, 0, true));

  const queue: QueueItem[] = [{ id: rootId, type: opts.rootType, depth: 0 }];

  while (queue.length > 0) {
    if (signal?.aborted) throw new Error('aborted');

    const cur = queue.shift()!;
    if (visitedExpanded.has(cur.id)) continue;
    visitedExpanded.add(cur.id);

    // 解析当前节点元数据（标题、url），失败即视作未授权
    await hydrateNode(client, nodes, cur);

    onProgress?.({
      visited: visitedExpanded.size,
      queued: queue.length,
      currentTitle: nodes.get(cur.id)?.title,
    });

    // 达到最大深度则不再展开（但节点已入图）
    if (cur.depth >= opts.maxDepth) continue;

    // 2) 展开当前节点的 children / refs
    const refs = await expand(client, cur, opts);
    if (refs === null) continue; // 未授权

    for (const ref of refs) {
      addEdge(edges, nodes, cur.id, ref.id, ref.kind, ref.type, cur.depth + 1);

      // 目标节点尚未入队则入队
      if (!visitedExpanded.has(ref.id) && !queue.some((q) => q.id === ref.id)) {
        queue.push({ id: ref.id, type: ref.type, depth: cur.depth + 1 });
      } else if (visitedExpanded.has(ref.id)) {
        // 已展开过：只是加边
      }
    }
  }

  // 3) 注入 backlinks（双向）
  for (const e of edges.values()) {
    const target = nodes.get(e.target);
    if (!target) continue;
    if (!target.backlinks.includes(e.source)) target.backlinks.push(e.source);
  }

  return {
    rootId,
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    buildTimeMs: Math.round(performance.now() - start),
    truncatedCount,
  };
}

// ------------------------------- 辅助 -------------------------------

function createPlaceholderNode(
  id: string,
  type: NotionObjectType,
  depth: number,
  isRoot: boolean,
): GraphNode {
  return {
    id,
    title: '',
    type,
    url: buildNotionUrl(id),
    isRoot,
    unauthorized: false,
    depth,
    backlinks: [],
  };
}

function addEdge(
  edges: Map<string, GraphEdge>,
  nodes: Map<string, GraphNode>,
  source: string,
  target: string,
  kind: EdgeKind,
  targetType: NotionObjectType,
  targetDepth: number,
): void {
  if (source === target) return; // 自环忽略
  const id = `${source}->${target}:${kind}`;
  if (edges.has(id)) return;
  edges.set(id, { id, source, target, kind });

  if (!nodes.has(target)) {
    nodes.set(target, createPlaceholderNode(target, targetType, targetDepth, false));
  }
}

async function hydrateNode(
  client: NotionClient,
  nodes: Map<string, GraphNode>,
  cur: QueueItem,
): Promise<void> {
  const node = nodes.get(cur.id);
  if (!node) return;

  try {
    if (cur.type === 'database') {
      const db = await client.getDatabase(cur.id);
      if (!db) {
        markUnauthorized(node);
        return;
      }
      applyDatabaseMeta(node, db);
    } else {
      // page
      const page = await client.getPage(cur.id);
      if (!page) {
        // 尝试作为 database 解析（link_to_page 有时拿不到 type，猜错了也能兜底）
        const db = await client.getDatabase(cur.id).catch(() => null);
        if (db) {
          node.type = 'database';
          applyDatabaseMeta(node, db);
        } else {
          markUnauthorized(node);
        }
        return;
      }
      applyPageMeta(node, page);
    }
  } catch {
    markUnauthorized(node);
  }
}

function applyPageMeta(node: GraphNode, page: NotionPage): void {
  node.type = 'page';
  node.url = page.url || node.url;
  node.title = extractPageTitle(page) || '(未命名)';
}

function applyDatabaseMeta(node: GraphNode, db: NotionDatabase): void {
  node.type = 'database';
  node.url = db.url || node.url;
  node.title = extractDatabaseTitle(db) || '(未命名数据库)';
}

function markUnauthorized(node: GraphNode): void {
  node.unauthorized = true;
  if (!node.title) node.title = '(未授权)';
}

/** 返回 null 表示无法访问（未授权） */
async function expand(
  client: NotionClient,
  cur: QueueItem,
  opts: BuildOptions,
): Promise<Array<{ id: string; type: NotionObjectType; kind: EdgeKind }> | null> {
  if (cur.type === 'database') {
    // 数据库里的 entry 作为 parent-child 子页面
    const entries = await client.queryAllDatabase(cur.id).catch(() => null);
    if (!entries) return null;

    const results: Array<{ id: string; type: NotionObjectType; kind: EdgeKind }> = [];
    if (opts.includeParentChild) {
      for (const p of entries) {
        results.push({ id: toCompactId(p.id), type: 'page', kind: 'parent-child' });
      }
    }
    return results;
  }

  // page：读 blocks，递归收集
  let blocks: NotionBlock[];
  try {
    blocks = await collectAllDescendantBlocks(client, cur.id);
  } catch {
    return null;
  }

  const refs = extractRefs(blocks, {
    includeParentChild: opts.includeParentChild,
    includeLinkToPage: opts.includeLinkToPage,
  });

  return refs.map((r) => ({ id: r.id, type: r.type, kind: r.kind }));
}

/**
 * 递归拉取一个 page 下的所有子 block（含嵌套在 toggle/callout 内的富文本），
 * 但遇到 child_page/child_database 时停止下钻——它们自身会被当作子节点展开。
 */
async function collectAllDescendantBlocks(client: NotionClient, pageId: string): Promise<NotionBlock[]> {
  const all: NotionBlock[] = [];
  const stack: string[] = [pageId];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);

    const children = await client.listAllBlockChildren(id);
    for (const child of children) {
      all.push(child);
      const t = child.type;
      // 跳过跨页下钻
      if (t === 'child_page' || t === 'child_database' || t === 'link_to_page') continue;
      if (child.has_children) stack.push(child.id);
    }
  }

  return all;
}
