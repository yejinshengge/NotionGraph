/**
 * 两级缓存：
 *   L1 —— 进程内 Map（service worker 存活期内最快）
 *   L2 —— chrome.storage.local 持久化（service worker 被回收重启后也能命中）
 *
 * 所有值包裹 `{ v, exp }`，写入时带上过期时间戳，读取时校验。
 * key 形如：`page:<id>` / `blocks:<id>` / `db:<id>`。
 */

interface Entry<T> {
  v: T;
  exp: number;
}

const STORAGE_PREFIX = 'notion-graph/cache:';
const memory = new Map<string, Entry<unknown>>();

function storageKey(key: string): string {
  return STORAGE_PREFIX + key;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const now = Date.now();

  const hit = memory.get(key) as Entry<T> | undefined;
  if (hit && hit.exp > now) return hit.v;
  if (hit && hit.exp <= now) memory.delete(key);

  const storageRes = await chrome.storage.local.get(storageKey(key));
  const persisted = storageRes[storageKey(key)] as Entry<T> | undefined;
  if (persisted && persisted.exp > now) {
    memory.set(key, persisted as Entry<unknown>);
    return persisted.v;
  }
  if (persisted && persisted.exp <= now) {
    await chrome.storage.local.remove(storageKey(key));
  }
  return undefined;
}

export async function cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const entry: Entry<T> = { v: value, exp: Date.now() + ttlMs };
  memory.set(key, entry as Entry<unknown>);
  try {
    await chrome.storage.local.set({ [storageKey(key)]: entry });
  } catch (e) {
    // 超配额 / 无权写入：降级为仅内存缓存 —— service worker 存活期内仍能命中，
    // 不影响当前构图流程；下一次 worker 重启后就需要重抓 API。
    // 同时主动清理所有已过期条目释放空间，尽量让下一次写入有机会成功。
    console.warn('[notion-graph] cacheSet storage failed, keeping in-memory only:', e);
    void evictExpiredEntries();
  }
}

/**
 * 扫描并清除所有已过期的持久化缓存条目。
 * 主要用于配额超限时的被动腾空。
 */
async function evictExpiredEntries(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const expiredKeys: string[] = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(STORAGE_PREFIX)) continue;
      const entry = v as Entry<unknown> | undefined;
      if (entry && typeof entry.exp === 'number' && entry.exp <= now) {
        expiredKeys.push(k);
      }
    }
    if (expiredKeys.length) await chrome.storage.local.remove(expiredKeys);
  } catch {
    // 清理失败也不抛；这只是尽力腾空
  }
}

/** 清空全部缓存（内存 + storage） */
export async function cacheClearAll(): Promise<void> {
  memory.clear();
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter((k) => k.startsWith(STORAGE_PREFIX));
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}
