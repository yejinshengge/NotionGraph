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

const API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const limit = pLimit(3);

/** 简化的 block/page/database 返回结构，只保留我们要用的字段 */
export interface NotionPage {
  object: 'page';
  id: string;
  url: string;
  parent: { type: string; page_id?: string; database_id?: string; workspace?: boolean };
  properties: Record<string, unknown>;
  in_trash?: boolean;
  archived?: boolean;
}

export interface NotionDatabase {
  object: 'database';
  id: string;
  url: string;
  title: Array<{ plain_text: string }>;
  parent: { type: string; page_id?: string; workspace?: boolean };
  in_trash?: boolean;
  archived?: boolean;
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

  /** 获取 block 的所有子块（自动翻页直到 has_more = false） */
  async listAllBlockChildren(id: string): Promise<NotionBlock[]> {
    const cacheKey = `blocks:${id}`;
    const cached = await cacheGet<NotionBlock[]>(cacheKey);
    if (cached) return cached;

    const all: NotionBlock[] = [];
    let cursor: string | null = null;
    while (true) {
      const qs = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : '?page_size=100';
      const page = (await this.rawFetch(`/blocks/${toUuid(id)}/children${qs}`)) as unknown as ListResult<NotionBlock>;
      all.push(...page.results);
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
      if (e instanceof NotionClientError && (e.status === 403 || e.status === 404)) {
        return null;
      }
      throw e;
    }
  }

  /** 所有 fetch 统一经过这里：限流 + 重试 + 鉴权 */
  private async rawFetch(pathWithQuery: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    return limit(() => this.doFetchWithRetry(pathWithQuery, init));
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
