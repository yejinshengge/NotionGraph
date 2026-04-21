/**
 * 底部节点详情抽屉：
 *   - 标题、类型、Notion URL
 *   - Backlinks 列表（支持点击切换根节点）
 *   - 打开原始页面 / 以此为根重建图谱 / 关闭
 */
import type { ReactElement } from 'react';
import type { GraphData, GraphNode } from '@/core/types';

interface Props {
  node: GraphNode;
  graph: GraphData;
  onOpen: () => void;
  onFocus: () => void;
  onClose: () => void;
}

export default function NodeDetail({ node, graph, onOpen, onFocus, onClose }: Props): ReactElement {
  const backlinkNodes = node.backlinks
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n): n is GraphNode => !!n);

  return (
    <section className="border-t border-notion-border bg-white max-h-[40%] flex flex-col">
      <div className="flex items-start justify-between p-3 gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wide text-notion-muted">
            {node.type === 'database' ? 'Database' : 'Page'}
            {node.unauthorized && <span className="ml-2 text-red-500">未授权</span>}
            {node.isRoot && <span className="ml-2 text-amber-600">根节点</span>}
          </div>
          <div className="text-sm font-medium text-notion-text truncate mt-0.5">
            {node.title || '(未命名)'}
          </div>
        </div>
        <button
          className="text-notion-muted hover:text-notion-text"
          onClick={onClose}
          title="关闭"
          type="button"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="px-3 pb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="text-xs px-2 h-7 rounded bg-notion-accent text-white hover:opacity-90"
        >
          在 Notion 打开
        </button>
        <button
          type="button"
          onClick={onFocus}
          className="text-xs px-2 h-7 rounded border border-notion-border hover:bg-notion-panel"
        >
          以此为根
        </button>
      </div>

      <div className="px-3 pb-3 overflow-y-auto">
        <div className="text-[11px] uppercase tracking-wide text-notion-muted mb-1">
          Backlinks ({backlinkNodes.length})
        </div>
        {backlinkNodes.length === 0 && (
          <div className="text-xs text-notion-muted">暂无反向链接</div>
        )}
        <ul className="space-y-0.5">
          {backlinkNodes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => window.open(n.url, '_blank')}
                className="w-full text-left text-xs text-notion-text hover:bg-notion-panel rounded px-1.5 py-1 truncate"
                title={n.title}
              >
                <span className={n.type === 'database' ? 'text-red-500' : 'text-notion-accent'}>
                  {n.type === 'database' ? '◆' : '●'}
                </span>{' '}
                {n.title || '(未命名)'}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
