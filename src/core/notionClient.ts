/**
 * Notion REST API 客户端。
 *
 * 设计要点：
 *   1. 仅在 background service worker 中使用（避免 content script 的 CORS 限制）；
 *   2. 全局 p-limit 并发 = 3，贴近 Notion 官方 3 req/s 的软限制；
 *   3. 429 响应 + Retry-After 指数退避；其它 5xx 也重试几次；
 *   4. 404 / 403 不抛异常，返回 `null` 让上层把节点标记为 unauthorized/missing；
 *   5. 支持 AbortSignal，上层取消构图时立即中断未发出的请求。
 */

import pLimit from 'p-limit';
import { cacheGet, cacheSet } from '@/shared/cache';
import { toUuid } from './idUtils';
import { slimBlockForRefs } from './linkExtractor';

const API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/**
 * 全局并发上限。贴近 Notion 官方 3 req/s 的软限制；
 * 真正决定吞吐的是 `buildGraph` 中的 worker 池能否把这 3 个并发位长期占满。
 */
const limit = pLimit(3);

/**
 * 飞行中的 GET 请求去重表：同一 URL 在返回前再次被请求，直接复用同一个 Promise。
 *
 * 典型场景：
 *   - 新 BFS worker 抓某 page 的 meta 时，另一 worker 因 link-to-page 同时触达该 page；
 *   - 增量刷新并发 hydrate 大量 page 时。
 * 去重只对 GET 生效；POST（如 database query）不安全，略过。
 */
const inFlight = new Map<string, Promise<Record<string, unknown>>>();

/** 简化的 block/page/database 返回结构，只保留我们要用的字段 */
export interface NotionPage {
  object: 'page';
  id: string;
  url: string;
  parent: { type: string; page_id?: string; database_id?: string; workspace?: boolean };
  properties: Record<string, unknown>;
  in_trash?: boolean;
  archived?: boolean;
  /** ISO 时间字符串；用于增量刷新脏检测 */
  last_edited_time?: string;
}

export interface NotionDatabase {
  object: 'database';
  id: string;
  url: string;
  title: Array<{ plain_text: string }>;
  parent: { type: string; page_id?: string; workspace?: boolean };
  in_trash?: boolean;
  archived?: boolean;
  /** ISO 时间字符串；用于增量刷新脏检测 */
  last_edited_time?: string;
}

/** Notion block 我们按 type 做 narrow，用 unknown 承载未识别字段 */
export interface NotionBlock {
  object: 'block';
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

export interface ListResult<T> {
  object: 'list';
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export class NotionClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface NotionClientOptions {
  token: string;
  cacheTtlMs: number;
  /** 全局取消信号 */
  signal?: AbortSignal;
}

export class NotionClient {
  private token: string;
  private cacheTtlMs: number;
  private signal?: AbortSignal;

  constructor(opts: NotionClientOptions) {
    this.token = opts.token;
    this.cacheTtlMs = opts.cacheTtlMs;
    this.signal = opts.signal;
  }

  /** 验证 token 是否可用（同时可以用来拿到 bot user） */
  async me(): Promise<{ id: string; name?: string }> {
    const json = await this.rawFetch('/users/me');
    return { id: json.id as string, name: (json.name as string | undefined) ?? undefined };
  }

  async getPage(id: string): Promise<NotionPage | null> {
    return this.cachedGet(`page:${id}`, () => this.rawFetch(`/pages/${toUuid(id)}`));
  }

  async getDatabase(id: string): Promise<NotionDatabase | null> {
    return this.cachedGet(`db:${id}`, () => this.rawFetch(`/databases/${toUuid(id)}`));
  }

  /**
   * 获取 block 的所有子块（自动翻页直到 has_more = false）。
   *
   * 性能/存储优化：返回前统一用 `slimBlockForRefs` 把每个 block 瘦身到
   * 下游（extractRefs + 递归下钻）真正需要的字段，典型体积下降 5~10 倍；
   * 这对大型页面能显著减轻 `chrome.storage.local` 的配额压力。
   */
  async listAllBlockChildren(id: string): Promise<NotionBlock[]> {
    const cacheKey = `blocks:${id}`;
    const cached = await cacheGet<NotionBlock[]>(cacheKey);
    if (cached) return cached;

    const all: NotionBlock[] = [];
    let cursor: string | null = null;
    while (true) {
      const qs = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : '?page_size=100';
      const page = (await this.rawFetch(`/blocks/${toUuid(id)}/children${qs}`)) as unknown as ListResult<NotionBlock>;
      for (const b of page.results) all.push(slimBlockForRefs(b));
      if (!page.has_more) break;
      cursor = page.next_cursor;
      if (!cursor) break;
    }

    await cacheSet(cacheKey, all, this.cacheTtlMs);
    return all;
  }

  /** 查询 database 中的条目（翻页聚合） */
  async queryAllDatabase(id: string): Promise<NotionPage[]> {
    const cacheKey = `dbq:${id}`;
    const cached = await cacheGet<NotionPage[]>(cacheKey);
    if (cached) return cached;

    const all: NotionPage[] = [];
    let cursor: string | null = null;
    while (true) {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const page = (await this.rawFetch(`/databases/${toUuid(id)}/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      })) as unknown as ListResult<NotionPage>;
      all.push(...page.results);
      if (!page.has_more) break;
      cursor = page.next_cursor;
      if (!cursor) break;
    }

    await cacheSet(cacheKey, all, this.cacheTtlMs);
    return all;
  }

  // -------------------- 私有 --------------------

  private async cachedGet<T>(key: string, fetcher: () => Promise<unknown>): Promise<T | null> {
    const cached = await cacheGet<T>(key);
    if (cached !== undefined) return cached;
    try {
      const v = (await fetcher()) as T;
      await cacheSet(key, v, this.cacheTtlMs);
      return v;
    } catch (e) {
      if (e instanceof NotionClientError && isRecoverableResourceError(e)) {
        return null;
      }
      throw e;
    }
  }

  /** 所有 fetch 统一经过这里：限流 + 重试 + 鉴权 + 飞行中 GET 去重 */
  private async rawFetch(pathWithQuery: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      return limit(() => this.doFetchWithRetry(pathWithQuery, init));
    }

    // GET：同一 URL 复用飞行中的 Promise，避免短时间重复发起
    const key = `GET ${pathWithQuery}`;
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = limit(() => this.doFetchWithRetry(pathWithQuery, init));
    inFlight.set(key, promise);
    // 无论成功失败都要清掉 in-flight 记录，否则后续请求拿到旧的失败 Promise。
    //
    // 注意：这里**必须同时注册 fulfilled & rejected handler**（即 `.then(cb, cb)`）
    // 而不是 `.finally(cb)`。`.finally` 返回的新 Promise 在原 promise reject 时
    // 会把同一个 rejection 继续透传，若没人 .catch 就会产生 Unhandled Promise
    // Rejection —— 即使调用方已经对 `promise` 自身 await + try/catch 了。
    // 用 `.then(cb, cb)` 能把原 rejection 在这条清理链上「消化」掉，
    // 同时 return 的仍是原 promise，调用方依然能感知到错误。
    const cleanup = (): void => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  private async doFetchWithRetry(
    pathWithQuery: string,
    init: RequestInit,
    attempt = 0,
  ): Promise<Record<string, unknown>> {
    if (this.signal?.aborted) throw new Error('aborted');

    const url = API_BASE + pathWithQuery;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: this.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      // 网络错误：最多重试 3 次
      if (attempt < 3) {
        await sleep(500 * Math.pow(2, attempt));
        return this.doFetchWithRetry(pathWithQuery, init, attempt + 1);
      }
      throw e;
    }

    if (res.status === 429) {
      const ra = Number(res.headers.get('Retry-After') ?? '1');
      await sleep(Math.max(1000, ra * 1000));
      if (attempt < 5) return this.doFetchWithRetry(pathWithQuery, init, attempt + 1);
    }

    if (res.status >= 500 && res.status < 600 && attempt < 3) {
      await sleep(500 * Math.pow(2, attempt));
      return this.doFetchWithRetry(pathWithQuery, init, attempt + 1);
    }

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new NotionClientError(res.status, `Notion API ${res.status}: ${text}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 判断一个 NotionClientError 是否「本质上 = 此 endpoint 访问不到该资源」，
 * 可以静默返回 null 让上层走类型回退（例如把 page 当 database 再试一次）。
 *
 * 覆盖场景：
 *   - 403 Forbidden：Integration 没被 Share 到此页面；
 *   - 404 Not Found：id 不存在或已被删除；
 *   - 400 validation_error 但消息提示「类型错了 / 无可访问 data source」：
 *       · `Provided ID ... is a database, not a page` —— 我们用 /pages 查了 database；
 *       · `Provided ID ... is a page, not a database` —— 反向情况；
 *       · `does not contain any data sources accessible by this API bot`
 *         —— Notion 新版 multi-source database 特性下，
 *            旧的 /databases/{id}/query endpoint 访问不到任何 data source。
 *     这些都不是"代码错误"，应当与 404 同等对待：节点标记为 unauthorized。
 */
function isRecoverableResourceError(e: NotionClientError): boolean {
  if (e.status === 403 || e.status === 404) return true;
  if (e.status !== 400) return false;
  const msg = e.message;
  return (
    msg.includes('is a database, not a page') ||
    msg.includes('is a page, not a database') ||
    msg.includes('does not contain any data sources') ||
    msg.includes('is a data_source, not a')
  );
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}

/** 从 page.properties 里提取标题（兼容多种 property type） */
export function extractPageTitle(page: NotionPage): string {
  const props = page.properties as Record<string, { type?: string; title?: Array<{ plain_text: string }> }>;
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p?.type === 'title' && Array.isArray(p.title)) {
      return p.title.map((t) => t.plain_text).join('').trim();
    }
  }
  return '';
}

/** 从 database 中提取标题 */
export function extractDatabaseTitle(db: NotionDatabase): string {
  return (db.title ?? []).map((t) => t.plain_text).join('').trim();
}

/** 从 page/database 对象中安全取 last_edited_time */
export function extractLastEditedTime(obj: NotionPage | NotionDatabase | null | undefined): string | undefined {
  if (!obj) return undefined;
  return typeof obj.last_edited_time === 'string' ? obj.last_edited_time : undefined;
}
