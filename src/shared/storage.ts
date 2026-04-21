/**
 * chrome.storage 的 Promise 化封装，统一所有持久化操作。
 *
 * - 用户设置（token 等）走 storage.local —— 不跨设备同步，降低 token 外泄风险；
 * - 缓存数据也走 storage.local，避免占用 sync 的配额。
 */

import { DEFAULT_SETTINGS, type UserSettings } from '@/core/types';

const SETTINGS_KEY = 'notion-graph/settings';

/** 读取用户设置；若不存在则返回默认值。 */
export async function loadSettings(): Promise<UserSettings> {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = res[SETTINGS_KEY] as Partial<UserSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

/** 保存用户设置（浅合并） */
export async function saveSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const current = await loadSettings();
  const merged: UserSettings = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

/** 监听设置变更 */
export function onSettingsChanged(handler: (s: UserSettings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
    const next = changes[SETTINGS_KEY].newValue as UserSettings | undefined;
    handler({ ...DEFAULT_SETTINGS, ...(next ?? {}) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
