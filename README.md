# NotionGraph

在 Notion 页面右侧以侧边栏（side panel）形式显示一张类 Obsidian 的关系图谱，基于 **Notion 官方 API** 递归抓取当前页面 / 数据库下的子页面与页面内的双向链接。


## 功能

- 侧边悬浮按钮 → 展开 / 折叠图谱面板
- 支持以下关系：
  - 父子页面嵌套（`child_page` / `child_database` / database entry）
  - 页面正文中的 `link_to_page`、mention、指向 `notion.so` 的超链接
- 可调最大递归深度（1 – 6）、可单独开关「父子」与「link-to-page」两类边
- 节点视觉按度数动态变大，未授权 / 未命名节点灰显
- **悬停高亮**：主节点放大、一度邻居保亮、相关边加粗，其余全局暗化
- **双击节点**：在新标签页打开对应 Notion 页面
- **拖拽节点**：长按拖动会钉住节点（fx/fy），松手后自然回到物理模拟
- 画布自身支持平移（含松手惯性滑动）、以指针为中心的滚轮缩放
- 搜索框快速过滤节点（未命中者额外暗化）
- 构图进度可视化，支持中途取消
- **秒开快照**：首次构建完成的整张图会写入 `chrome.storage.local`（默认 7 天 TTL），下次打开先渲染快照、后台再做增量刷新（stale-while-revalidate）
- 两级缓存：API 响应级缓存（内存 + storage）+ 整图级快照
- Shadow DOM 样式隔离，不污染 Notion 原生 UI

## 技术栈

- Manifest V3 Chrome 扩展
- TypeScript + React 18 + Tailwind CSS
- Vite + `@crxjs/vite-plugin`
- **d3-force** 物理引擎（多体斥力 / 弹簧 / 向心 / 碰撞）
- **Canvas 2D 自绘渲染器**（视锥体剔除、分桶批量 stroke、zoom 逆补偿、指数平滑过渡）
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

代码修改会自动热更新（content / options / popup）；对 `manifest.json` 和 service worker 的修改请手动点击扩展卡片上的刷新按钮。

### 生产构建

```bash
npm run build
```

产物位于 `dist/`，可以直接打包或分发。

### 类型检查

```bash
npm run typecheck
```

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
├── background/               Service Worker
│   └── index.ts                一次性请求 (onMessage) + 构图长连接 (onConnect/Port)
├── content/                  Content Script
│   ├── index.ts                Shadow DOM 注入 + SPA 路由监听 (history.pushState 劫持)
│   └── panel/                  面板 UI（React，挂载在 Shadow DOM 里）
│       ├── App.tsx / inject.ts / styles.css
│       └── components/
│           ├── CollapsedLauncher.tsx   折叠态悬浮按钮
│           ├── SidePanel.tsx           主面板（标题栏 / Toolbar / Graph / Detail）
│           ├── Toolbar.tsx             深度 / 过滤 / 搜索控件
│           ├── NodeDetail.tsx          选中节点详情
│           ├── GraphView.tsx           React 壳子：装配 simulation + 事件层 + rAF 循环
│           └── graph/                  图谱表现层（无 React 依赖的纯模块）
│               ├── graphConfig.ts        所有视觉 / 物理 / 交互魔法数字（集中管理）
│               ├── graphTypes.ts         SimNode / SimLink / Camera 及世界↔屏幕变换
│               ├── graphSimulation.ts    d3-force 力场装配、增量同步、拖拽 reheat
│               ├── graphRenderer.ts      Canvas 2D 批量绘制（边 / 节点 / 标签）
│               └── graphInteraction.ts   Pointer Events（悬停 / 平移 / 缩放 / 拖节点 / 双击）
├── core/                     业务逻辑（纯函数 / 无 DOM 依赖）
│   ├── notionClient.ts         Notion API 封装（限流 / 重试 / 缓存）
│   ├── linkExtractor.ts        block → refs
│   ├── graphBuilder.ts         BFS 构图 + revalidate 增量刷新
│   ├── graphSnapshot.ts        整图快照持久化（storage.local，默认 7 天 TTL）
│   ├── idUtils.ts              URL / id 互转（含 dash 规整）
│   └── types.ts
├── options/                  Options 页面（Token / 缓存配置）
├── popup/                    插件图标 popup
└── shared/                   跨端共用
    ├── messaging.ts            Request / Response / Port 协议类型
    ├── storage.ts              chrome.storage 封装（settings）
    └── cache.ts                API 响应级缓存（内存 + storage.local，短 TTL）
```

## 构图数据流

1. Content Script 解析当前页面 URL → 向 background 发 `notion/resolve-root`
2. Content Script 打开 `BUILD_PORT` 长连接，发 `start` 消息
3. Background：
   - 命中快照 → 立即 `snapshot` 回推 + 异步 `revalidateGraph` 增量刷新
   - 未命中 → `buildGraph` BFS，期间持续 `progress` 上报
   - 最终 `done` 或 `error`
4. 前端用 `GraphView` 渲染；`query` / `graph` prop 变化时走 `applyIncremental` 保留位置 / 速度

## 已知限制

- **Notion API 限流**：平均 3 req/s；工作区较大时首次构图较慢（此时快照机制会让后续打开保持秒开）
- **未授权页面**：`link_to_page` 指向的页面可能未 Share 给 Integration，将以灰色节点呈现，节点 title 可能为空
- **SPA 路由**：Notion 切换页面不触发原生 load 事件，插件通过劫持 `history.pushState / replaceState` 监听
- **快照存储上限**：`chrome.storage.local` 有配额；写入失败时会先驱逐其他 rootId 的快照再重试，仍失败则仅告警（不影响当次渲染）

## 许可

MIT
