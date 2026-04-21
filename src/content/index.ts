/**
 * Content Script：
 *   1. 在 Notion 页面挂一个顶层容器，内部使用 Shadow DOM 隔离样式；
 *   2. 在 Shadow DOM 里挂载 Panel 的 React 应用；
 *   3. 劫持 history.pushState/replaceState + 监听 popstate，通知 panel 当前页面 id 变化。
 */

import './panel/inject';
