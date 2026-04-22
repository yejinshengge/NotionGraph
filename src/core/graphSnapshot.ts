/**
 * 图谱快照持久化层。
 *
 * 与 `shared/cache.ts` 的 API 级缓存职责区分：
 *   - cache.ts 缓存的是**单次 Notion API 响应**（page / blocks / database query），粒度小、TTL 短；
 *   - graphSnapshot 缓存的是**整张构建完成的 GraphData**，粒度大、TTL 长（默认 7 天）。
 *
 * 典型使用路径：
 *   1) 用户打开面板 → Background 先尝试 `loadSnapshot` 立即推送给前端（秒开）；
 *   2) Background 再启动 `revalidateGraph` 做增量刷新；
 *   3) 刷新完成后 `saveSnapshot` 回写最新结果。
 *
 * 存储介质：`chrome.storage.local`。key 由 root id + build options 派生，
 * 保证不同 options 各自独立（避免 depth=3 的结果污染 depth=5 的视图）。
 */

import type { GraphData } from './types';

/** 独立前缀，避免与 cache.ts 的 `notion-graph/cache:` 命名冲突 */
export const SNAPSHOT_STORE_PREFIX = 'notion-graph/snapshot:';

/** 默认快照 TTL：7 天。过期的快照会被忽略并删除 */
const DEFAULT_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 快照 key 由这些字段决定；字段不同则快照相互隔离 */
export interface SnapshotKeyInput {
  rootId: string;
  maxDepth: number;
  includeParentChild: boolean;
  includeLinkToPage: boolean;
}

export interface StoredSnapshot {
  graph: GraphData;
  /** 写入时间戳（毫秒） */
  savedAt: number;
  /** 版本号，便于将来结构变更时兼容 */
  version: number;
}

/** 当前快照结构版本；若解析出的 version 不一致则视为失效 */
const SNAPSHOT_VERSION = 1;

function buildKey(input: SnapshotKeyInput): string {
  const pc = input.includeParentChild ? 1 : 0;
  const lp = input.includeLinkToPage ? 1 : 0;
  return `${SNAPSHOT_STORE_PREFIX}${input.rootId}:d${input.maxDepth}:pc${pc}:lp${lp}`;
}

/**
 * 读取快照；若不存在、版本不符或已过期则返回 null。
 * 过期快照会在读取时顺带清理。
 */
export async function loadSnapshot(
  input: SnapshotKeyInput,
  ttlMs: number = DEFAULT_SNAPSHOT_TTL_MS,
): Promise<StoredSnapshot | null> {
  const key = buildKey(input);
  const res = await chrome.storage.local.get(key);
  const snap = res[key] as StoredSnapshot | undefined;
  if (!snap) return null;

  if (snap.version !== SNAPSHOT_VERSION) {
    await chrome.storage.local.remove(key);
    return null;
  }

  if (Date.now() - snap.savedAt > ttlMs) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return snap;
}

/**
 * 写入/覆盖快照。
 *
 * 容错策略：
 *   - 遇到 `chrome.storage.local` 配额错误（大图 + 多 rootId 累积常见）时，
 *     先尝试清理所有**其他** snapshot（保留当前 key）释放空间，再重试一次；
 *   - 仍失败则仅 `console.warn`，**不向上抛出** —— 快照只是秒开优化，
 *     即便写失败，当前这次构图的结果依然要交付给前端（否则用户会看到
 *     "加载失败"但实际上图谱已经构建完毕）。
 */
export async function saveSnapshot(input: SnapshotKeyInput, graph: GraphData): Promise<void> {
  const key = buildKey(input);
  const snap: StoredSnapshot = {
    graph,
    savedAt: Date.now(),
    version: SNAPSHOT_VERSION,
  };
  try {
    await chrome.storage.local.set({ [key]: snap });
    return;
  } catch (e) {
    console.warn('[notion-graph] saveSnapshot failed, attempting eviction and retry:', e);
  }

  // 首次写失败：清理其他 snapshot（保留当前 key），再重试一次
  try {
    await evictOtherSnapshots(key);
    await chrome.storage.local.set({ [key]: snap });
  } catch (e2) {
    console.warn('[notion-graph] saveSnapshot retry still failing, skipping persistence:', e2);
  }
}

/** 除给定 key 外，清理所有 snapshot.* 条目；尽力释放空间 */
async function evictOtherSnapshots(keepKey: string): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter(
    (k) => k.startsWith(SNAPSHOT_STORE_PREFIX) && k !== keepKey,
  );
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}

/** 清空全部快照（与 cacheClearAll 配合使用） */
export async function clearAllSnapshots(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter((k) => k.startsWith(SNAPSHOT_STORE_PREFIX));
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}
