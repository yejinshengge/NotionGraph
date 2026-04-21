/**
 * 将 Panel React 应用挂载到 Notion 页面的 Shadow DOM 中。
 *
 * 为什么用 Shadow DOM？
 *   - Tailwind 的 Preflight 会重置全局样式，不能污染 Notion 原始 UI；
 *   - Notion 自身大量 class 名过于通用，也容易反过来影响我们。
 */

import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import App from './App';
// 以 `?inline` 把 CSS 源串导入，注入到 Shadow DOM 内
import styleText from './styles.css?inline';

const HOST_ID = 'notion-graph-root';

function boot(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // 让宿主节点自身不参与布局，避免对 Notion 页面的意外挤压
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = styleText as string;
  shadow.appendChild(styleEl);

  const mount = document.createElement('div');
  // 真正的交互区域恢复 pointer-events
  mount.style.cssText = 'all: initial; pointer-events: auto; color-scheme: light;';
  mount.className = 'ng-shadow-root';
  shadow.appendChild(mount);

  const root = createRoot(mount);
  root.render(createElement(App));

  installLocationWatcher();
}

/**
 * Notion 使用 SPA 路由：history.pushState / replaceState 不会触发 popstate 或 load。
 * 这里做一次性 monkey-patch，触发自定义事件，由 Panel 订阅。
 */
function installLocationWatcher(): void {
  const patch = (method: 'pushState' | 'replaceState') => {
    const orig = history[method];
    history[method] = function patched(this: History, ...args: Parameters<typeof orig>) {
      const ret = orig.apply(this, args);
      window.dispatchEvent(new Event('notion-graph:location-changed'));
      return ret;
    } as typeof orig;
  };
  patch('pushState');
  patch('replaceState');
  window.addEventListener('popstate', () => {
    window.dispatchEvent(new Event('notion-graph:location-changed'));
  });
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  boot();
} else {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
}
