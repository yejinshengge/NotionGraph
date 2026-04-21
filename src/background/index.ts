/**
 * Background Service Worker：
 *   - 一次性请求（token 测试 / 设置读写 / 解析根节点 / 清缓存）走 runtime.onMessage；
 *   - 长连接（构图进度 + 结果）走 runtime.onConnect + Port。
 */

import { NotionClient, extractDatabaseTitle, extractPageTitle } from '@/core/notionClient';
import { buildGraph, revalidateGraph } from '@/core/graphBuilder';
import { loadSnapshot, saveSnapshot, clearAllSnapshots } from '@/core/graphSnapshot';
import { toCompactId } from '@/core/idUtils';
import { loadSettings, saveSettings } from '@/shared/storage';
import { cacheClearAll } from '@/shared/cache';
import {
  BUILD_PORT,
  handleRequest,
  type BuildClientMessage,
  type BuildServerMessage,
  type Request,
  type Response,
  type ResolvedRoot,
} from '@/shared/messaging';
import type { NotionObjectType } from '@/core/types';

// ------------------------------- 一次性请求 -------------------------------

chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
  (async () => {
    const res = await dispatchRequest(message);
    sendResponse(res);
  })();
  return true; // 异步响应
});

async function dispatchRequest(req: Request): Promise<Response> {
  switch (req.type) {
    case 'settings/get':
      return handleRequest(async () => await loadSettings());

    case 'settings/save':
      return handleRequest(async () => await saveSettings(req.patch));

    case 'notion/test-token':
      return handleRequest(async () => {
        const client = new NotionClient({ token: req.token, cacheTtlMs: 0 });
        return await client.me();
      });

    case 'notion/resolve-root':
      return handleRequest<ResolvedRoot>(async () => {
        const settings = await loadSettings();
        if (!settings.token) throw new Error('未配置 Notion Integration Token');
        const client = new NotionClient({ token: settings.token, cacheTtlMs: settings.cacheTtlMs });

        const id = toCompactId(req.id);
        // 先试 page，再试 database
        const page = await client.getPage(id).catch(() => null);
        if (page) {
          return {
            id,
            type: 'page' satisfies NotionObjectType,
            title: extractPageTitle(page) || '(未命名)',
            url: page.url || `https://www.notion.so/${id}`,
          };
        }
        const db = await client.getDatabase(id).catch(() => null);
        if (db) {
          return {
            id,
            type: 'database' satisfies NotionObjectType,
            title: extractDatabaseTitle(db) || '(未命名数据库)',
            url: db.url || `https://www.notion.so/${id}`,
          };
        }
        throw new Error('无法访问该页面/数据库，请确认 Integration 已被 Share');
      });

    case 'cache/clear':
      return handleRequest(async () => {
        // API 级缓存和图谱快照都要清：否则 UI 点"清缓存"后仍会秒开旧快照
        await Promise.all([cacheClearAll(), clearAllSnapshots()]);
        return { cleared: true };
      });

    default:
      return { type: 'error', message: `未知请求类型` };
  }
}

// ------------------------------- 构图 Port -------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BUILD_PORT) return;

  let controller: AbortController | null = null;

  const post = (msg: BuildServerMessage) => {
    try {
      port.postMessage(msg);
    } catch {
      // port 已断开
    }
  };

  port.onMessage.addListener((msg: BuildClientMessage) => {
    if (msg.type === 'cancel') {
      controller?.abort();
      return;
    }

    if (msg.type === 'start') {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;

      (async () => {
        try {
          const settings = await loadSettings();
          if (!settings.token) {
            post({ type: 'error', message: '未配置 Notion Integration Token' });
            return;
          }

          const client = new NotionClient({
            token: settings.token,
            cacheTtlMs: msg.options.bypassCache ? 0 : settings.cacheTtlMs,
            signal,
          });

          const snapKey = {
            rootId: msg.options.rootId,
            maxDepth: msg.options.maxDepth,
            includeParentChild: msg.options.includeParentChild,
            includeLinkToPage: msg.options.includeLinkToPage,
          };

          // bypassCache（即用户手动"刷新"）时强制全量重建，忽略快照
          const snapshot = msg.options.bypassCache ? null : await loadSnapshot(snapKey);

          if (snapshot) {
            // 快照命中：立即推给前端，后台增量刷新
            post({ type: 'snapshot', graph: snapshot.graph });
            post({ type: 'revalidating' });

            try {
              const refreshed = await revalidateGraph(snapshot.graph, msg.options, {
                client,
                signal,
              });
              await saveSnapshot(snapKey, refreshed);
              post({ type: 'done', graph: refreshed, incremental: true });
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              if (message === 'aborted' || (e as Error)?.name === 'AbortError') return;
              // 增量刷新失败不影响已渲染的快照：前端仍能正常使用缓存图谱
              post({ type: 'error', message: `增量刷新失败：${message}` });
            }
            return;
          }

          // 无快照：走全量 BFS，上报进度
          const graph = await buildGraph(msg.options, {
            client,
            signal,
            onProgress: (progress) => post({ type: 'progress', progress }),
          });
          await saveSnapshot(snapKey, graph);
          post({ type: 'done', graph, incremental: false });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (message === 'aborted' || (e as Error)?.name === 'AbortError') return;
          post({ type: 'error', message });
        }
      })();
    }
  });

  port.onDisconnect.addListener(() => {
    controller?.abort();
  });
});

// 安装后自动打开 Options 页面，引导用户配置 token
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
});
