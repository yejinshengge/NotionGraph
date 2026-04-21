/**
 * 类型安全的消息协议：
 *   - 短连接（request/response）用 chrome.runtime.sendMessage
 *   - 长连接（构图进度流）用 chrome.runtime.connect + Port
 *
 * 所有消息通过 `type` 字段判别，TS 通过联合类型 + 辅助函数保证收发两端匹配。
 */

import type {
  BuildOptions,
  BuildProgress,
  GraphData,
  NotionObjectType,
  UserSettings,
} from '@/core/types';

// -------------------------- 一次性请求 --------------------------

export type Request =
  | { type: 'settings/get' }
  | { type: 'settings/save'; patch: Partial<UserSettings> }
  | { type: 'notion/test-token'; token: string }
  | { type: 'notion/resolve-root'; id: string } /** 根据 id 推断是 page 还是 database 并取 meta */
  | { type: 'cache/clear' };

export type Response =
  | { type: 'ok'; data: unknown }
  | { type: 'error'; message: string };

export async function sendRequest<T = unknown>(req: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Response;
  if (res?.type === 'error') throw new Error(res.message);
  return (res as Extract<Response, { type: 'ok' }>).data as T;
}

/** background 端用的 helper：把一个处理函数包成标准 Response */
export async function handleRequest<T>(fn: () => Promise<T>): Promise<Response> {
  try {
    const data = await fn();
    return { type: 'ok', data };
  } catch (e) {
    return { type: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

// -------------------------- 长连接（构图流） --------------------------

/** Port 名称 */
export const BUILD_PORT = 'notion-graph/build';

/** content/panel -> background */
export type BuildClientMessage =
  | { type: 'start'; options: BuildOptions }
  | { type: 'cancel' };

/** background -> content/panel */
export type BuildServerMessage =
  /** 全量构建进度（仅无快照的首次构建才会发） */
  | { type: 'progress'; progress: BuildProgress }
  /** 命中历史快照：前端可立即渲染，随后会收到 `revalidating` 然后 `done` */
  | { type: 'snapshot'; graph: GraphData }
  /** 快照命中后开始后台增量刷新的提示信号；前端展示"同步中"角标 */
  | { type: 'revalidating' }
  /** 构建/刷新完成，`graph` 为最终结果；`incremental` 标识是否来自增量刷新 */
  | { type: 'done'; graph: GraphData; incremental: boolean }
  | { type: 'error'; message: string };

// -------------------------- 辅助 --------------------------

export interface ResolvedRoot {
  id: string;
  type: NotionObjectType;
  title: string;
  url: string;
}
