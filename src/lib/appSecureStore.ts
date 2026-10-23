/** The app's SecureStore, behind the fresh-install guard (src/lib/installGuard.ts). */
import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';

import { env } from './env';
import { guardFreshInstall, type InstallMarker } from './installGuard';
import { systemStore, type RawSecureStore } from './secureStorage';

/** supabase-js's own default key, set explicitly so the install guard knows it. */
export function sessionStorageKey(url = env.supabaseUrl ?? ''): string {
  try {
    return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
  } catch {
    return 'sb-auth-token';
  }
}

/** A row in a small SQLite file in the app sandbox: an uninstall deletes it, the Keychain stays. */
const sandboxMarker: InstallMarker = {
  async isSet() {
    const db = await SQLite.openDatabaseAsync('gb-install.db');
    try {
      await db.execAsync('create table if not exists install (at text not null)');
      return !!(await db.getFirstAsync('select at from install limit 1'));
    } finally {
      await db.closeAsync();
    }
  },
  async set() {
    const db = await SQLite.openDatabaseAsync('gb-install.db');
    try {
      await db.runAsync('insert into install (at) values (?)', [new Date().toISOString()]);
    } finally {
      await db.closeAsync();
    }
  },
};

export const appSecureStore: RawSecureStore = Platform.OS === 'web' ? systemStore : guardFreshInstall(systemStore, sandboxMarker, sessionStorageKey());
