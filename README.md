# NotionGraph

在 Notion 页面右侧以侧边栏（side panel）形式显示一张类 Obsidian 的关系图谱，基于 **Notion 官方 API** 递归抓取当前页面/数据库下的子页面与页面内的双向链接。

## 功能

- 侧边悬浮按钮 → 展开 / 折叠图谱面板
- 支持以下关系：
  - 父子页面嵌套（child_page / child_database / database entry）
  - 页面正文中的 `link_to_page`、mention、指向 notion.so 的超链接
- 可调最大递归深度（1 – 6）
- 节点 / 边类型区分样式：页面 ● 数据库 ◆；父子边实线、link-to-page 虚线
- 单击节点高亮邻域 / 双击跳转原始 Notion 页面 / 右键以此为根重建
- 力导向布局（Cytoscape + fcose），搜索框快速定位节点
- 构建进度可视化，支持中途取消
- 两级缓存（内存 + chrome.storage.local，TTL 可配置）
- Shadow DOM 样式隔离，不污染 Notion 原生 UI
- 未授权页面灰显标注

## 技术栈

- Manifest V3 Chrome 扩展
- TypeScript + React 18 + Tailwind CSS
- Vite + `@crxjs/vite-plugin`
- Cytoscape.js + `cytoscape-fcose`
- `p-limit` 控制 Notion API 并发（默认 3 req/s）

## 开发

```bash
npm install
npm run dev
```

随后在 Chrome 里：

1. 访问 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目的 `dist/` 目录

代码修改会自动热更新（contents / options / popup）；对 `manifest.json` 和 service worker 的修改请手动点击扩展卡片上的刷新按钮。

### 生产构建

```bash
npm run build
```

产物位于 `dist/`，可以直接打包或分发。

## 配置 Notion Integration

1. 访问 [notion.so/my-integrations](https://www.notion.so/my-integrations)，创建一个 Internal Integration
2. 勾选至少「Read content」能力并保存
3. 复制 Internal Integration Token
4. 第一次安装插件会自动打开设置页，把 Token 粘贴进去，点击「测试连接」
5. 回到 Notion 里要使用的根页面或数据库，右上角 `··· → Connections → Add connections` 选择刚创建的 Integration
6. 打开该页面，点击右侧悬浮按钮即可看到图谱

## 项目结构

```
src/
├── background/         Service Worker：消息路由 + API 调用
├── content/            Content Script + Shadow DOM 注入的 React 面板
│   └── panel/          Panel UI（SidePanel / GraphView / Toolbar / NodeDetail）
├── options/            Options 页面（Token 配置）
├── popup/              插件图标 popup
├── core/               业务逻辑（纯函数）
│   ├── notionClient.ts   Notion API 封装（限流 / 重试 / 缓存）
│   ├── linkExtractor.ts  block -> refs
│   ├── graphBuilder.ts   BFS 构图 + 双向反链
│   ├── idUtils.ts        URL / id 互转
│   └── types.ts
└── shared/             跨端共用（messaging / storage / cache）
```

## 已知限制

- **Notion API 限流**：平均 3 req/s；工作区较大时构图较慢，可调低深度或分阶段展开
- **未授权页面**：`link_to_page` 指向的页面可能未 Share 给 Integration，将以灰色节点呈现
- **SPA 路由**：Notion 切换页面不触发原生 load 事件，插件通过劫持 `history.pushState/replaceState` 监听

## 许可

MIT
