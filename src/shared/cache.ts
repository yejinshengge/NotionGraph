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
  await chrome.storage.local.set({ [storageKey(key)]: entry });
}

/** 清空全部缓存（内存 + storage） */
export async function cacheClearAll(): Promise<void> {
  memory.clear();
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter((k) => k.startsWith(STORAGE_PREFIX));
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}
