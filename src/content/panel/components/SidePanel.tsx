/**
 * 右侧主面板：
 *   - 顶部标题栏（关闭、刷新、设置）；
 *   - Toolbar（深度、过滤、搜索）；
 *   - 中部 GraphView（Cytoscape）；
 *   - 底部 NodeDetail。
 */

import { useMemo, useState, type ReactElement } from 'react';
import type { BuildProgress, GraphData, GraphNode } from '@/core/types';
import type { ResolvedRoot } from '@/shared/messaging';
import GraphView from './GraphView';
import Toolbar from './Toolbar';
import NodeDetail from './NodeDetail';

type LoadState =
  | { status: 'idle' }
  | { status: 'no-token' }
  | { status: 'no-root' }
  | { status: 'resolving'; id: string }
  | { status: 'loading'; root: ResolvedRoot; progress: BuildProgress }
  | { status: 'ready'; root: ResolvedRoot; graph: GraphData; revalidating: boolean }
  | { status: 'error'; message: string };

interface Props {
  state: LoadState;
  maxDepth: number;
  includeParentChild: boolean;
  includeLinkToPage: boolean;
  onMaxDepthChange: (v: number) => void;
  onIncludeParentChildChange: (v: boolean) => void;
  onIncludeLinkToPageChange: (v: boolean) => void;
  onClose: () => void;
  onReload: () => void;
  onOpenOptions: () => void;
  onChangeRoot: (id: string) => void;
}

export default function SidePanel(props: Props): ReactElement {
  const { state } = props;
  // 注：表现层已按设计方案改为「悬停高亮」，不再向外派发点击选中事件；
  // 但底部 NodeDetail 仍保留 selectedId 框架，留给将来可能回归的「pin 选中」功能。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const graph = state.status === 'ready' ? state.graph : null;

  const selectedNode: GraphNode | null = useMemo(() => {
    if (!graph || !selectedId) return null;
    return graph.nodes.find((n) => n.id === selectedId) ?? null;
  }, [graph, selectedId]);

  return (
    <aside
      className="fixed top-0 right-0 h-screen flex flex-col
                 bg-notion-panel border-l border-notion-border shadow-2xl
                 z-[2147483646]"
      style={{ width: 'clamp(360px, 30vw, 560px)', pointerEvents: 'auto' }}
    >
      {/* 标题栏 */}
      <header className="flex items-center justify-between px-3 h-11 border-b border-notion-border bg-notion-panel">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded bg-notion-accent text-white flex items-center justify-center text-xs">
            NG
          </div>
          <div className="truncate">
            <div className="text-sm font-medium text-notion-text truncate">
              {state.status === 'ready' ? state.root.title || '(未命名)' : 'NotionGraph'}
            </div>
            <div className="text-[11px] text-notion-muted truncate flex items-center gap-1.5">
              {state.status === 'ready' ? (
                <>
                  <span>
                    {state.graph.nodes.length} 节点 · {state.graph.edges.length} 连接 · {state.graph.buildTimeMs}ms
                  </span>
                  {state.revalidating && (
                    <span
                      className="inline-flex items-center gap-1 text-notion-accent"
                      title="正在基于历史快照做增量同步"
                    >
                      <span className="inline-block w-2 h-2 rounded-full bg-notion-accent animate-pulse" />
                      同步中
                    </span>
                  )}
                </>
              ) : (
                '关系图谱'
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <IconButton title="刷新" onClick={props.onReload}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </IconButton>
          <IconButton title="设置" onClick={props.onOpenOptions}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </IconButton>
          <IconButton title="关闭" onClick={props.onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </IconButton>
        </div>
      </header>

      {/* Toolbar */}
      <Toolbar
        maxDepth={props.maxDepth}
        includeParentChild={props.includeParentChild}
        includeLinkToPage={props.includeLinkToPage}
        query={query}
        onMaxDepthChange={props.onMaxDepthChange}
        onIncludeParentChildChange={props.onIncludeParentChildChange}
        onIncludeLinkToPageChange={props.onIncludeLinkToPageChange}
        onQueryChange={setQuery}
      />

      {/* 图谱区 */}
      <main className="flex-1 min-h-0 relative">
        {renderBody(state, graph, query)}
      </main>

      {/* 底部详情 */}
      {selectedNode && graph && (
        <NodeDetail
          node={selectedNode}
          graph={graph}
          onOpen={() => window.open(selectedNode.url, '_blank')}
          onFocus={() => props.onChangeRoot(selectedNode.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </aside>
  );
}

function renderBody(
  state: LoadState,
  graph: GraphData | null,
  query: string,
): ReactElement {
  if (state.status === 'no-token') {
    return (
      <EmptyState
        title="尚未配置 Notion Integration Token"
        description="点击右上角齿轮图标打开设置页，按引导完成配置即可开始使用。"
      />
    );
  }
  if (state.status === 'no-root') {
    return (
      <EmptyState
        title="无法从当前 URL 识别页面"
        description="请先打开一个具体的 Notion 页面或数据库，然后刷新面板。"
      />
    );
  }
  if (state.status === 'error') {
    return <EmptyState title="加载失败" description={state.message} />;
  }
  if (state.status === 'resolving') {
    return <LoadingState label="解析当前页面..." />;
  }
  if (state.status === 'loading') {
    return (
      <LoadingState
        label={`构建图谱中... 已访问 ${state.progress.visited} / 待处理 ${state.progress.queued}`}
        hint={state.progress.currentTitle}
      />
    );
  }
  if (state.status === 'ready' && graph) {
    return <GraphView graph={graph} query={query} />;
  }
  return <LoadingState label="等待中..." />;
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactElement }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="w-7 h-7 rounded hover:bg-notion-border/60 text-notion-muted hover:text-notion-text flex items-center justify-center"
    >
      {children}
    </button>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
      <div>
        <div className="text-sm font-medium text-notion-text mb-1">{title}</div>
        <div className="text-xs text-notion-muted leading-relaxed">{description}</div>
      </div>
    </div>
  );
}

function LoadingState({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="text-center">
        <div className="inline-block w-6 h-6 border-2 border-notion-accent border-t-transparent rounded-full animate-spin mb-3" />
        <div className="text-xs text-notion-muted">{label}</div>
        {hint && <div className="text-[11px] text-notion-muted/70 mt-1 max-w-[260px] truncate mx-auto">{hint}</div>}
      </div>
    </div>
  );
}
