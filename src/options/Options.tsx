/**
 * Options 页面：Notion Integration Token 配置、深度默认值、缓存 TTL、测试连接、清空缓存。
 */
import { useEffect, useState, type ReactElement } from 'react';
import { sendRequest } from '@/shared/messaging';
import { DEFAULT_SETTINGS, type UserSettings } from '@/core/types';

type TestResult = { kind: 'idle' } | { kind: 'ok'; name: string } | { kind: 'error'; message: string };

export default function Options(): ReactElement {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<TestResult>({ kind: 'idle' });
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    sendRequest<UserSettings>({ type: 'settings/get' })
      .then(setSettings)
      .catch(() => {});
  }, []);

  const update = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const next = await sendRequest<UserSettings>({ type: 'settings/save', patch: settings });
      setSettings(next);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!settings.token) {
      setTestResult({ kind: 'error', message: '请先填入 Token' });
      return;
    }
    setTesting(true);
    setTestResult({ kind: 'idle' });
    try {
      const me = await sendRequest<{ name?: string; id: string }>({
        type: 'notion/test-token',
        token: settings.token,
      });
      setTestResult({ kind: 'ok', name: me.name || me.id });
    } catch (e) {
      setTestResult({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleClearCache = async () => {
    await sendRequest({ type: 'cache/clear' });
    alert('缓存已清空');
  };

  return (
    <div className="min-h-screen px-8 py-10 max-w-2xl mx-auto">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-notion-text">NotionGraph 设置</h1>
        <p className="text-sm text-notion-muted mt-1">
          将 Notion 工作区与插件连接，并调整图谱构建默认参数。
        </p>
      </header>

      <Section title="1. Notion Integration Token" subtitle="从 notion.so/my-integrations 创建 Internal Integration，并复制 Token。">
        <input
          type="password"
          value={settings.token}
          onChange={(e) => update('token', e.target.value)}
          placeholder="secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          className="w-full h-10 px-3 rounded border border-notion-border bg-white font-mono text-sm
                     focus:outline-none focus:ring-2 focus:ring-notion-accent/40"
        />

        <div className="flex items-center gap-3 mt-3">
          <button
            type="button"
            disabled={testing}
            onClick={handleTest}
            className="h-9 px-3 rounded border border-notion-border bg-white hover:bg-notion-panel text-sm disabled:opacity-50"
          >
            {testing ? '测试中...' : '测试连接'}
          </button>
          {testResult.kind === 'ok' && (
            <span className="text-sm text-green-600">连接成功：{testResult.name}</span>
          )}
          {testResult.kind === 'error' && (
            <span className="text-sm text-red-600">连接失败：{testResult.message}</span>
          )}
        </div>

        <details className="mt-4 text-xs text-notion-muted">
          <summary className="cursor-pointer">如何创建 Integration 与授权页面？</summary>
          <ol className="list-decimal list-inside space-y-1 mt-2 leading-relaxed">
            <li>访问 <a className="text-notion-accent underline" href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">notion.so/my-integrations</a>，点击 "New integration" 创建 Internal 集成。</li>
            <li>在 "Capabilities" 中至少勾选 Read content，保存。</li>
            <li>复制 Internal Integration Token 粘贴到上方输入框。</li>
            <li>回到 Notion 中要使用的页面或数据库，点击右上角 "··· → Connections → Add connections"，选择刚刚创建的 Integration。</li>
            <li>该页面及其子页面即可被插件访问。</li>
          </ol>
        </details>
      </Section>

      <Section title="2. 默认构建参数">
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-xs text-notion-muted">默认最大深度</span>
            <input
              type="number"
              min={1}
              max={10}
              value={settings.defaultMaxDepth}
              onChange={(e) => update('defaultMaxDepth', Math.max(1, Math.min(10, Number(e.target.value))))}
              className="w-full h-9 px-2 mt-1 rounded border border-notion-border bg-white text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-notion-muted">缓存 TTL（分钟）</span>
            <input
              type="number"
              min={1}
              max={120}
              value={Math.round(settings.cacheTtlMs / 60000)}
              onChange={(e) =>
                update('cacheTtlMs', Math.max(1, Math.min(120, Number(e.target.value))) * 60000)
              }
              className="w-full h-9 px-2 mt-1 rounded border border-notion-border bg-white text-sm"
            />
          </label>
        </div>
      </Section>

      <Section title="3. 缓存管理">
        <button
          type="button"
          onClick={handleClearCache}
          className="h-9 px-3 rounded border border-notion-border bg-white hover:bg-notion-panel text-sm"
        >
          清空全部缓存
        </button>
      </Section>

      <div className="flex items-center gap-3 mt-8">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="h-10 px-5 rounded bg-notion-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存设置'}
        </button>
        {savedAt && <span className="text-xs text-notion-muted">已保存 ✓</span>}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-notion-text mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-notion-muted mb-3">{subtitle}</p>}
      {children}
    </section>
  );
}
