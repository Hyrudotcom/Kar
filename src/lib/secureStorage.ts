/**
 * SecureStore adapters (docs/architecture.md section 2).
 * SecureStore values are limited to ~2 KB, so the Supabase session is split into chunks:
 * `<key>.n` holds the chunk count, `<key>.0..n-1` the parts.
 */
import * as SecureStore from 'expo-secure-store';

import type { KeyValueStore } from './backend/types';

export const CHUNK_SIZE = 1800;

/** SecureStore keys may only contain alphanumerics, ".", "-" and "_". */
export function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

export interface RawSecureStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** THIS_DEVICE_ONLY: session tokens never move to another phone through an iCloud/Finder backup. */
export const systemStore: RawSecureStore = {
  getItemAsync: (k) => SecureStore.getItemAsync(k),
  setItemAsync: (k, v) => SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  deleteItemAsync: (k) => SecureStore.deleteItemAsync(k),
};

/** Chunked storage for supabase-js `auth.storage` (getItem/setItem/removeItem). */
export function createChunkedStorage(store: RawSecureStore = systemStore): KeyValueStore {
  const countKey = (key: string) => `${safeKey(key)}.n`;
  const partKey = (key: string, i: number) => `${safeKey(key)}.${i}`;

  async function readCount(key: string): Promise<number> {
    const raw = await store.getItemAsync(countKey(key));
    const n = raw === null ? 0 : Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  }

  return {
    async getItem(key) {
      const n = await readCount(key);
      if (n === 0) return null;
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const p = await store.getItemAsync(partKey(key, i));
        if (p === null) return null; // torn write: treat as no session rather than corrupt JSON
        parts.push(p);
      }
      return parts.join('');
    },
    async setItem(key, value) {
      const old = await readCount(key);
      const n = Math.max(1, Math.ceil(value.length / CHUNK_SIZE));
      for (let i = 0; i < n; i++) await store.setItemAsync(partKey(key, i), value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
      await store.setItemAsync(countKey(key), String(n));
      for (let i = n; i < old; i++) await store.deleteItemAsync(partKey(key, i));
    },
    async removeItem(key) {
      const n = await readCount(key);
      await store.deleteItemAsync(countKey(key));
      for (let i = 0; i < n; i++) await store.deleteItemAsync(partKey(key, i));
    },
  };
}

/** Small single values (pending invite code, last user id, cached household). */
export function createSecureKeyValue(store: RawSecureStore = systemStore): KeyValueStore {
  return {
    getItem: (k) => store.getItemAsync(safeKey(k)),
    setItem: (k, v) => store.setItemAsync(safeKey(k), v),
    removeItem: (k) => store.deleteItemAsync(safeKey(k)),
  };
}

/** In-memory store (demo mode, tests). */
export function createMemoryKeyValue(initial: Record<string, string> = {}): KeyValueStore & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(initial));
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v);
    },
    removeItem: async (k) => {
      m.delete(k);
    },
    dump: () => Object.fromEntries(m),
  };
}
