/**
 * 面板折叠时显示的悬浮按钮：固定在页面右侧中部。
 */
import type { ReactElement } from 'react';

interface Props {
  onClick: () => void;
}

export default function CollapsedLauncher({ onClick }: Props): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title="打开 NotionGraph 关系图谱"
      className="fixed right-3 top-1/2 -translate-y-1/2 z-[2147483647]
                 flex items-center justify-center w-10 h-10 rounded-full
                 bg-notion-accent text-white shadow-lg hover:scale-105 transition-transform
                 active:scale-95"
      style={{ pointerEvents: 'auto' }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <line x1="7.5" y1="7" x2="11" y2="16" />
        <line x1="16.5" y1="7" x2="13" y2="16" />
        <line x1="8" y1="6" x2="16" y2="6" />
      </svg>
    </button>
  );
}
