/**
 * Panel 主容器：
 *   - 处理折叠/展开；
 *   - 监听 Notion SPA 路由变化自动更新 rootId；
 *   - 拉起 background 的构图长连接。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { parseIdFromUrl } from '@/core/idUtils';
import { sendRequest } from '@/shared/messaging';
import {
  BUILD_PORT,
  type BuildClientMessage,
  type BuildServerMessage,
  type ResolvedRoot,
} from '@/shared/messaging';
import type { BuildProgress, GraphData, UserSettings } from '@/core/types';
import SidePanel from './components/SidePanel';
import CollapsedLauncher from './components/CollapsedLauncher';

type LoadState =
  | { status: 'idle' }
  | { status: 'no-token' }
  | { status: 'no-root' }
  | { status: 'resolving'; id: string }
  | { status: 'loading'; root: ResolvedRoot; progress: BuildProgress }
  /** `revalidating` 为真：表示已展示的是历史快照，后台正在做增量刷新 */
  | { status: 'ready'; root: ResolvedRoot; graph: GraphData; revalidating: boolean }
  | { status: 'error'; message: string };

export default function App(): ReactElement {
  const [open, setOpen] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(() => parseIdFromUrl(location.href));
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [maxDepth, setMaxDepth] = useState(3);
  const [includeParentChild, setIncludeParentChild] = useState(true);
  const [includeLinkToPage, setIncludeLinkToPage] = useState(true);

  const portRef = useRef<chrome.runtime.Port | null>(null);

  // 初次加载设置
  useEffect(() => {
    sendRequest<UserSettings>({ type: 'settings/get' })
      .then((s) => {
        setSettings(s);
        setMaxDepth(s.defaultMaxDepth);
      })
      .catch(() => {
        setState({ status: 'error', message: '无法读取插件设置' });
      });
  }, []);

  // SPA 路由变化时同步 currentId
  useEffect(() => {
    const handler = () => setCurrentId(parseIdFromUrl(location.href));
    window.addEventListener('notion-graph:location-changed', handler);
    return () => window.removeEventListener('notion-graph:location-changed', handler);
  }, []);

  const ensurePort = useCallback((): chrome.runtime.Port => {
    if (portRef.current) return portRef.current;
    const port = chrome.runtime.connect({ name: BUILD_PORT });
    port.onMessage.addListener((msg: BuildServerMessage) => {
      if (msg.type === 'progress') {
        setState((prev) =>
          prev.status === 'loading'
            ? { status: 'loading', root: prev.root, progress: msg.progress }
            : prev,
        );
      } else if (msg.type === 'snapshot') {
        // 快照命中：立即切到 ready，展示旧图谱；同时打上 revalidating 标记
        setState((prev) => {
          const root: ResolvedRoot =
            prev.status === 'loading' || prev.status === 'resolving' || prev.status === 'ready'
              ? ('root' in prev ? prev.root : { id: msg.graph.rootId, type: 'page', title: '', url: '' })
              : { id: msg.graph.rootId, type: 'page', title: '', url: '' };
          return { status: 'ready', root, graph: msg.graph, revalidating: true };
        });
      } else if (msg.type === 'revalidating') {
        // 冗余信号：仅用于保证 UI 上的"同步中"角标出现（即便 snapshot 消息因某种原因未触达）
        setState((prev) =>
          prev.status === 'ready' ? { ...prev, revalidating: true } : prev,
        );
      } else if (msg.type === 'done') {
        setState((prev) => {
          const root: ResolvedRoot =
            prev.status === 'loading' || prev.status === 'ready'
              ? prev.root
              : { id: msg.graph.rootId, type: 'page', title: '', url: '' };
          return { status: 'ready', root, graph: msg.graph, revalidating: false };
        });
      } else if (msg.type === 'error') {
        // 后台增量刷新失败时：若已展示快照则保留，仅清除 revalidating 状态
        setState((prev) => {
          if (prev.status === 'ready') return { ...prev, revalidating: false };
          return { status: 'error', message: msg.message };
        });
      }
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
    });
    portRef.current = port;
    return port;
  }, []);

  const loadGraph = useCallback(
    async (opts: { bypassCache?: boolean } = {}) => {
      if (!settings) return;
      if (!settings.token) {
        setState({ status: 'no-token' });
        return;
      }
      if (!currentId) {
        setState({ status: 'no-root' });
        return;
      }

      setState({ status: 'resolving', id: currentId });
      let root: ResolvedRoot;
      try {
        root = await sendRequest<ResolvedRoot>({ type: 'notion/resolve-root', id: currentId });
      } catch (e) {
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
        return;
      }

      setState({ status: 'loading', root, progress: { visited: 0, queued: 1 } });
      const port = ensurePort();
      const start: BuildClientMessage = {
        type: 'start',
        options: {
          rootId: root.id,
          rootType: root.type,
          maxDepth,
          includeParentChild,
          includeLinkToPage,
          bypassCache: opts.bypassCache,
        },
      };
      port.postMessage(start);
    },
    [settings, currentId, maxDepth, includeParentChild, includeLinkToPage, ensurePort],
  );

  // 首次展开 & 每次 rootId / 配置变化时，自动加载
  useEffect(() => {
    if (!open) return;
    if (!settings) return;
    void loadGraph();
    return () => {
      // 切换根或关闭面板时主动取消正在进行的构图
      const msg: BuildClientMessage = { type: 'cancel' };
      portRef.current?.postMessage(msg);
    };
  }, [open, settings, currentId, maxDepth, includeParentChild, includeLinkToPage, loadGraph]);

  const launcher = useMemo(
    () => <CollapsedLauncher onClick={() => setOpen(true)} />,
    [],
  );

  return (
    <>
      {!open && launcher}
      {open && (
        <SidePanel
          state={state}
          maxDepth={maxDepth}
          includeParentChild={includeParentChild}
          includeLinkToPage={includeLinkToPage}
          onMaxDepthChange={setMaxDepth}
          onIncludeParentChildChange={setIncludeParentChild}
          onIncludeLinkToPageChange={setIncludeLinkToPage}
          onClose={() => setOpen(false)}
          onReload={() => loadGraph({ bypassCache: true })}
          onOpenOptions={() => {
            void chrome.runtime.sendMessage({ type: 'open-options' }).catch(() => {});
            // 兜底：直接调用
            chrome.runtime.openOptionsPage?.();
          }}
          onChangeRoot={(id) => {
            setCurrentId(id);
          }}
        />
      )}
    </>
  );
}
