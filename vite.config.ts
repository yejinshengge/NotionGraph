import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Vite + CRXJS 配置：生成 MV3 扩展包。开发模式下支持 HMR；
// 生产构建输出到 dist/，可直接在 chrome://extensions 加载
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      input: {
        options: 'src/options/index.html',
        popup: 'src/popup/index.html',
      },
    },
  },
  server: {
    // 显式绑定到 127.0.0.1（IPv4），避免 Node >= 17 在 Windows 上把
    // `localhost` 解析为 IPv6 `::1`，导致 Chrome 扩展访问 http://localhost:5173 失败
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 不自定义 HMR 端口：让 HMR 复用主端口的 HTTP 服务器，
    // 避免额外起一个监听 socket 时绑定不一致（只绑 IPv6）导致 ws 连接失败

    // Vite 5.4.12+ 因 CVE-2025-30208/31125 默认拒绝 `chrome-extension://` 源的跨域请求，
    // 会让 service worker 注册失败（Status code: 3）。这里显式放行扩展源。
    cors: {
      origin: [/^chrome-extension:\/\//],
    },
  },
});
