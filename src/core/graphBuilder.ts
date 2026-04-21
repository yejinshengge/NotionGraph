/**
 * 图谱构建器：以某个 page/database 为根，按 BFS 遍历扩展，
 * 在层级深度上限内收集全部父子关系与双向链接。
 *
 * 设计要点：
 *   - 节点 id 以紧凑 hex 作为主键，保证去重；
 *   - 边用 `${src}->${tgt}:${kind}` 作为唯一键去重；
 *   - 双向反链：所有指向 N 的边会把 source 注入 N.backlinks；
 *   - 通过一个**并发 worker 池**驱动 BFS —— 将 `NotionClient` 的 p-limit(3) 真正打满，
 *     从"每刻只 1 个请求在飞"提升到"持续 3 个请求并发"，构建耗时显著下降；
 *   - 支持 AbortSignal 中断；
 *   - 通过 onProgress 回调上报已访问 / 剩余队列数；
 *   - 暴露 `revalidateGraph` 用于在历史快照基础上做**增量刷新**：
 *     只对 last_edited_time 变化的节点重抓 blocks、diff 引用，新增引用再触发局部 BFS。
 */

import {
  extractDatabaseTitle,
  extractLastEditedTime,
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

/**
 * BFS 并发度。值越大吞吐越高，但过高会触发 Notion 429 限流；
 * 对齐 `NotionClient` 内部的 p-limit(3)：取 3 即可把 API 并发位占满。
 */
const BFS_CONCURRENCY = 3;

// ======================================================================
// 入口：全量构建
// ======================================================================

export async function buildGraph(opts: BuildOptions, deps: BuilderDeps): Promise<GraphData> {
  const start = performance.now();

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const visitedExpanded = new Set<string>();

  const rootId = toCompactId(opts.rootId);
  nodes.set(rootId, createPlaceholderNode(rootId, opts.rootType, 0, true));

  const queue: QueueItem[] = [{ id: rootId, type: opts.rootType, depth: 0 }];

  await runConcurrentBFS({ queue, nodes, edges, visitedExpanded, opts, deps });

  // 注入 backlinks（双向）
  injectBacklinks(nodes, edges);

  return {
    rootId,
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    buildTimeMs: Math.round(performance.now() - start),
    truncatedCount: 0,
  };
}

// ======================================================================
// 入口：增量刷新
// ======================================================================

/**
 * 在给定 snapshot 的基础上做增量刷新：
 *   1) 并发请求所有已知节点的 meta；
 *   2) 对比 `last_edited_time`，收集脏节点；
 *   3) 对脏节点重抓 blocks + extractRefs，diff 新旧引用：
 *      - 新增的 ref → 加入 BFS 队列继续扩展（受深度约束）；
 *      - 消失的 ref → 从 edges 中移除对应边；
 *   4) 清理不再被任何边连接且非 root 的孤立节点；
 *   5) 重新计算 backlinks。
 *
 * 相比 `buildGraph` 的全量 BFS，大多数情况下请求次数 ≈ 节点数（仅 meta GET）
 * + 极少量脏节点的 blocks 请求；通常比全量快一个数量级。
 */
export async function revalidateGraph(
  snapshot: GraphData,
  opts: BuildOptions,
  deps: BuilderDeps,
): Promise<GraphData> {
  const { client, signal } = deps;
  const start = performance.now();

  // 1) 基于 snapshot 重建可变状态（清除 backlinks，稍后重算）
  const nodes = new Map<string, GraphNode>();
  for (const n of snapshot.nodes) {
    nodes.set(n.id, { ...n, backlinks: [] });
  }
  const edges = new Map<string, GraphEdge>(snapshot.edges.map((e) => [e.id, e]));
  const visitedExpanded = new Set<string>(snapshot.nodes.map((n) => n.id));

  // 2) 并发 hydrate 所有节点，收集 dirty set
  const dirtySet = new Set<string>();
  const hydrateTasks = Array.from(nodes.values()).map(async (node) => {
    if (signal?.aborted) return;
    const prev = node.lastEditedTime;
    try {
      if (node.type === 'database') {
        const db = await client.getDatabase(node.id);
        if (!db) {
          markUnauthorized(node);
          return;
        }
        applyDatabaseMeta(node, db);
        if (prev !== node.lastEditedTime) dirtySet.add(node.id);
      } else {
        const page = await client.getPage(node.id);
        if (!page) {
          // 有可能是 database（之前类型猜错），兜底一下
          const db = await client.getDatabase(node.id).catch(() => null);
          if (db) {
            applyDatabaseMeta(node, db);
            if (prev !== node.lastEditedTime) dirtySet.add(node.id);
          } else {
            markUnauthorized(node);
          }
          return;
        }
        applyPageMeta(node, page);
        if (prev !== node.lastEditedTime) dirtySet.add(node.id);
      }
    } catch {
      markUnauthorized(node);
    }
  });
  await Promise.all(hydrateTasks);
  if (signal?.aborted) throw new Error('aborted');

  // 3) 对脏节点重新 expand + diff
  const queue: QueueItem[] = [];
  for (const id of dirtySet) {
    const node = nodes.get(id);
    if (!node || node.unauthorized) continue;
    await diffAndApplyExpansion({ node, nodes, edges, queue, opts, deps });
  }

  // 4) 新增 ref 触发的局部 BFS
  await runConcurrentBFS({ queue, nodes, edges, visitedExpanded, opts, deps });

  // 5) 孤立节点 GC：非 root 且没有任何入边/出边的节点删掉
  gcOrphanNodes(nodes, edges, snapshot.rootId);

  // 6) 重新计算 backlinks
  injectBacklinks(nodes, edges);

  return {
    rootId: snapshot.rootId,
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    buildTimeMs: Math.round(performance.now() - start),
    truncatedCount: 0,
  };
}

// ======================================================================
// 核心：并发 BFS worker 池
// ======================================================================

interface BFSContext {
  queue: QueueItem[];
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  visitedExpanded: Set<string>;
  opts: BuildOptions;
  deps: BuilderDeps;
}

/**
 * 用固定数量的 worker 从共享队列并发消费，直到队列清空且所有 worker 都空闲。
 *
 * 为什么不用 `Promise.all(queue.map(...))`？因为每处理一个节点会把它的子节点
 * 再次塞进 queue；这不是一个预先已知长度的任务列表，而是动态生长的图遍历。
 */
async function runConcurrentBFS(ctx: BFSContext): Promise<void> {
  const { queue, deps } = ctx;
  const { signal, onProgress } = deps;

  // 已入队但尚未开始处理的 id，用 set 加速"是否已入队"判断；原代码里用 Array.some O(n)
  const queued = new Set<string>(queue.map((q) => q.id));

  let active = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const pump = () => {
      if (settled) return;
      if (signal?.aborted) return fail(new Error('aborted'));

      while (active < BFS_CONCURRENCY && queue.length > 0) {
        const cur = queue.shift()!;
        queued.delete(cur.id);

        if (ctx.visitedExpanded.has(cur.id)) continue;
        ctx.visitedExpanded.add(cur.id);

        active++;
        void processItem(cur, ctx, queued)
          .then(() => {
            active--;
            onProgress?.({
              visited: ctx.visitedExpanded.size,
              queued: queue.length,
              currentTitle: ctx.nodes.get(cur.id)?.title,
            });
            if (queue.length === 0 && active === 0) done();
            else pump();
          })
          .catch(fail);
      }

      if (queue.length === 0 && active === 0) done();
    };

    pump();
  });
}

/** 处理单个 BFS 队列项：hydrate meta + 展开子引用 */
async function processItem(cur: QueueItem, ctx: BFSContext, queued: Set<string>): Promise<void> {
  const { nodes, edges, deps, opts, queue } = ctx;
  const { client, signal } = deps;
  if (signal?.aborted) throw new Error('aborted');

  await hydrateNode(client, nodes, cur);

  // 达到最大深度则不再展开（节点已入图）
  if (cur.depth >= opts.maxDepth) return;

  const refs = await expand(client, cur, opts);
  if (refs === null) return; // 未授权

  for (const ref of refs) {
    addEdge(edges, nodes, cur.id, ref.id, ref.kind, ref.type, cur.depth + 1);

    if (!ctx.visitedExpanded.has(ref.id) && !queued.has(ref.id)) {
      queue.push({ id: ref.id, type: ref.type, depth: cur.depth + 1 });
      queued.add(ref.id);
    }
  }
}

// ======================================================================
// 增量刷新辅助
// ======================================================================

/**
 * 对一个脏节点：重新抓 refs，然后 diff 旧边：
 *   - 旧边里该节点是 source 且在新 refs 中不存在 → 删除
 *   - 新 refs 中存在但旧边没有 → 添加；若目标新节点不存在则创建 placeholder 并入队
 */
async function diffAndApplyExpansion(args: {
  node: GraphNode;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  queue: QueueItem[];
  opts: BuildOptions;
  deps: BuilderDeps;
}): Promise<void> {
  const { node, nodes, edges, queue, opts, deps } = args;
  const { client } = deps;

  // 深度超限时也不重 expand（否则会触发我们本不该抓的区域）
  if (node.depth >= opts.maxDepth) return;

  const refs = await expand(client, { id: node.id, type: node.type, depth: node.depth }, opts);
  if (refs === null) return;

  // 旧的从 node.id 出发的边（按 kind 区分）
  const oldEdgeIds = new Set<string>();
  for (const e of edges.values()) {
    if (e.source === node.id) oldEdgeIds.add(e.id);
  }

  const newEdgeIds = new Set<string>();
  for (const ref of refs) {
    const eid = `${node.id}->${ref.id}:${ref.kind}`;
    newEdgeIds.add(eid);

    // 新增边
    if (!edges.has(eid)) {
      addEdge(edges, nodes, node.id, ref.id, ref.kind, ref.type, node.depth + 1);
      // 新出现的目标节点 → 入队继续 BFS
      if (!nodes.has(ref.id) || (nodes.get(ref.id)?.title === '' && !nodes.get(ref.id)?.unauthorized)) {
        queue.push({ id: ref.id, type: ref.type, depth: node.depth + 1 });
      }
    }
  }

  // 消失的边
  for (const oldId of oldEdgeIds) {
    if (!newEdgeIds.has(oldId)) edges.delete(oldId);
  }
}

/** 删除非 root 且完全孤立（无出入边）的节点 */
function gcOrphanNodes(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  rootId: string,
): void {
  const connected = new Set<string>([rootId]);
  for (const e of edges.values()) {
    connected.add(e.source);
    connected.add(e.target);
  }
  for (const id of Array.from(nodes.keys())) {
    if (!connected.has(id)) nodes.delete(id);
  }
}

function injectBacklinks(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): void {
  for (const e of edges.values()) {
    const target = nodes.get(e.target);
    if (!target) continue;
    if (!target.backlinks.includes(e.source)) target.backlinks.push(e.source);
  }
}

// ======================================================================
// 节点 meta / expand（原实现，略作整理）
// ======================================================================

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
  if (source === target) return;
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
      const page = await client.getPage(cur.id);
      if (!page) {
        // 可能是 database（link_to_page 有时拿不到准确 type）
        const db = await client.getDatabase(cur.id).catch(() => null);
        if (db) {
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
  node.lastEditedTime = extractLastEditedTime(page);
  node.unauthorized = false;
}

function applyDatabaseMeta(node: GraphNode, db: NotionDatabase): void {
  node.type = 'database';
  node.url = db.url || node.url;
  node.title = extractDatabaseTitle(db) || '(未命名数据库)';
  node.lastEditedTime = extractLastEditedTime(db);
  node.unauthorized = false;
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
 * 递归拉取一个 page 下的所有子 block。
 *
 * 相比旧实现（串行栈弹出）的关键改进：**同层兄弟并发**。
 * 兄弟层用 Promise.all 同时递归下钻，全局并发由 `NotionClient` 的 p-limit 兜底。
 *
 * 遇到 child_page/child_database/link_to_page 时停止下钻 —— 它们是独立节点，
 * 会被外层 BFS 单独展开。
 */
async function collectAllDescendantBlocks(client: NotionClient, pageId: string): Promise<NotionBlock[]> {
  const all: NotionBlock[] = [];
  const seen = new Set<string>();

  async function walk(id: string): Promise<void> {
    if (seen.has(id)) return;
    seen.add(id);

    const children = await client.listAllBlockChildren(id);

    const nestedIds: string[] = [];
    for (const child of children) {
      all.push(child);
      const t = child.type;
      if (t === 'child_page' || t === 'child_database' || t === 'link_to_page') continue;
      if (child.has_children) nestedIds.push(child.id);
    }

    // 同层兄弟并发下钻
    await Promise.all(nestedIds.map(walk));
  }

  await walk(pageId);
  return all;
}
