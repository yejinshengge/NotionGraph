/**
 * Popup：简短状态 + 跳转到设置 / 仓库。
 */
import { useEffect, useState, type ReactElement } from 'react';
import { sendRequest } from '@/shared/messaging';
import type { UserSettings } from '@/core/types';

export default function Popup(): ReactElement {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [status, setStatus] = useState<'loading' | 'connected' | 'invalid' | 'no-token'>('loading');
  const [name, setName] = useState<string>('');

  useEffect(() => {
    (async () => {
      try {
        const s = await sendRequest<UserSettings>({ type: 'settings/get' });
        setSettings(s);
        if (!s.token) {
          setStatus('no-token');
          return;
        }
        const me = await sendRequest<{ name?: string; id: string }>({
          type: 'notion/test-token',
          token: s.token,
        });
        setName(me.name || me.id);
        setStatus('connected');
      } catch {
        setStatus('invalid');
      }
    })();
  }, []);

  const openOptions = () => chrome.runtime.openOptionsPage();

  return (
    <div className="p-4 w-[300px]">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded bg-notion-accent text-white flex items-center justify-center text-sm font-semibold">
          NG
        </div>
        <div>
          <div className="text-sm font-medium">NotionGraph</div>
          <div className="text-[11px] text-notion-muted">在 Notion 中可视化关系图谱</div>
        </div>
      </div>

      <div className="p-2 rounded bg-notion-panel text-xs mb-3">
        {status === 'loading' && <span className="text-notion-muted">检查连接状态...</span>}
        {status === 'no-token' && <span className="text-amber-600">尚未配置 Integration Token</span>}
        {status === 'invalid' && <span className="text-red-600">Token 无效，请在设置页更新</span>}
        {status === 'connected' && (
          <span className="text-green-600">已连接 · {name}</span>
        )}
      </div>

      <div className="text-xs text-notion-muted leading-relaxed mb-3">
        打开任意 Notion 页面后，点击页面右侧的悬浮按钮即可展开图谱面板。
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={openOptions}
          className="flex-1 h-9 rounded bg-notion-accent text-white text-xs hover:opacity-90"
        >
          打开设置
        </button>
        {settings && (
          <a
            className="h-9 px-3 rounded border border-notion-border text-xs flex items-center hover:bg-notion-panel"
            href="https://www.notion.so/my-integrations"
            target="_blank"
            rel="noreferrer"
          >
            管理 Integration
          </a>
        )}
      </div>
    </div>
  );
}
