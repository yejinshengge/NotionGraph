/**
 * Notion id 与 URL 工具。
 *
 * Notion 的 id 有两种写法：
 *   - 紧凑式：32 位十六进制，例如 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
 *   - UUID 式：8-4-4-4-12，例如 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d
 *
 * 本模块：
 *   - 提供双向互转；
 *   - 从完整 notion.so URL 中解析出 id；
 *   - 提供由 id 反推回访问 URL 的能力。
 */

const HEX32 = /^[0-9a-f]{32}$/i;
const UUID_36 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 去连字符，小写化 */
export function toCompactId(raw: string): string {
  return raw.replace(/-/g, '').toLowerCase();
}

/** 转为标准 8-4-4-4-12 UUID */
export function toUuid(raw: string): string {
  const compact = toCompactId(raw);
  if (!HEX32.test(compact)) {
    throw new Error(`Invalid Notion id: ${raw}`);
  }
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

/** 判断是否为合法 id（两种形式均可） */
export function isNotionId(s: string | undefined | null): boolean {
  if (!s) return false;
  return HEX32.test(s) || UUID_36.test(s);
}

/**
 * 从 notion URL 中解析 page/database id。
 *
 * 兼容以下形式：
 *   - https://www.notion.so/Workspace/Page-Title-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
 *   - https://www.notion.so/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
 *   - https://username.notion.site/Page-1a2b3c4d...
 *   - https://www.notion.so/Workspace/Page?p=1a2b3c4d... (popup page)
 *   - 带查询参数 v=xxx (database view id) 的也会返回主体 id
 *
 * 无法解析时返回 null。
 */
export function parseIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    // 优先 ?p= 参数（Notion 打开 page popup 时会带）
    const pParam = u.searchParams.get('p');
    if (pParam && isNotionId(pParam)) {
      return toCompactId(pParam);
    }

    // 从 pathname 取最后一段；slug 里 id 在末尾
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    // slug 可能形如 "My-Page-Title-1a2b3c4d..."
    const match = last.match(/([0-9a-f]{32})(?:[^0-9a-f]|$)/i);
    if (match) return match[1].toLowerCase();

    // 再尝试 UUID 形式
    const uuidMatch = last.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    if (uuidMatch) return toCompactId(uuidMatch[1]);

    return null;
  } catch {
    return null;
  }
}

/** 由 id 生成一个可点击跳转的公开 URL（工作区路径由浏览器自动重定向） */
export function buildNotionUrl(id: string): string {
  const compact = toCompactId(id);
  return `https://www.notion.so/${compact}`;
}
