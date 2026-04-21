/**
 * 图谱工具条：深度滑块、边类型过滤、关键词搜索。
 */
import type { ReactElement } from 'react';

interface Props {
  maxDepth: number;
  includeParentChild: boolean;
  includeLinkToPage: boolean;
  query: string;
  onMaxDepthChange: (v: number) => void;
  onIncludeParentChildChange: (v: boolean) => void;
  onIncludeLinkToPageChange: (v: boolean) => void;
  onQueryChange: (v: string) => void;
}

export default function Toolbar(props: Props): ReactElement {
  return (
    <div className="flex flex-col gap-2 px-3 py-2 border-b border-notion-border bg-notion-panel/80 backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-notion-muted whitespace-nowrap">深度</label>
        <input
          type="range"
          min={1}
          max={6}
          value={props.maxDepth}
          onChange={(e) => props.onMaxDepthChange(Number(e.target.value))}
          className="flex-1 accent-notion-accent"
        />
        <span className="text-xs text-notion-text w-5 text-center">{props.maxDepth}</span>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <Checkbox
          checked={props.includeParentChild}
          onChange={props.onIncludeParentChildChange}
          label="父子嵌套"
        />
        <Checkbox
          checked={props.includeLinkToPage}
          onChange={props.onIncludeLinkToPageChange}
          label="正文链接"
        />
      </div>

      <input
        type="search"
        value={props.query}
        onChange={(e) => props.onQueryChange(e.target.value)}
        placeholder="搜索节点标题..."
        className="w-full h-8 px-2 text-xs rounded border border-notion-border bg-notion-bg text-notion-text
                   focus:outline-none focus:ring-2 focus:ring-notion-accent/40"
      />
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-notion-accent"
      />
      <span className="text-notion-text">{label}</span>
    </label>
  );
}
