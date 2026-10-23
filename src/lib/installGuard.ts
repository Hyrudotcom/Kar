/**
 * iOS keeps Keychain items after the app is deleted: without this guard a reinstall would sign the
 * previous user straight back in (session chunks, last user id, invite code, household cache).
 * A marker in the app sandbox (removed by an uninstall) tells a fresh install apart; then every
 * SecureStore key of the app is deleted once, before the first read.
 */
import { KV_KEYS } from './backend/types';
import { createChunkedStorage, safeKey, type RawSecureStore } from './secureStorage';

export interface InstallMarker {
  isSet(): Promise<boolean>;
  set(): Promise<void>;
}

/** Keys kept per user / household elsewhere (SessionProvider, PriceContext). */
const perUser = (uid: string) => [`${KV_KEYS.householdCache}_${uid}`, `removed_notice_${uid}`, `price_opt_in_${uid}`];

async function clearAppKeys(store: RawSecureStore, sessionKey: string): Promise<void> {
  const get = (k: string) => store.getItemAsync(safeKey(k)).catch(() => null);
  const del = (k: string) => store.deleteItemAsync(safeKey(k)).catch(() => undefined);
  const last = await get(KV_KEYS.lastUserId);
  if (last) {
    const cached = await get(`${KV_KEYS.householdCache}_${last}`);
    try {
      const hh = cached ? (JSON.parse(cached) as { id?: unknown }).id : null;
      if (typeof hh === 'string') await del(`price_available_${hh}`);
    } catch {
      /* unreadable cache: nothing more to find */
    }
    for (const k of perUser(last)) await del(k);
  }
  for (const k of Object.values(KV_KEYS)) await del(k);
  await createChunkedStorage(store).removeItem(sessionKey).catch(() => undefined);
}

/** Wraps SecureStore so the first access of any kind waits for the fresh-install check. */
export function guardFreshInstall(store: RawSecureStore, marker: InstallMarker, sessionKey: string): RawSecureStore {
  let ready: Promise<void> | null = null;
  const once = () =>
    (ready ??= (async () => {
      try {
        if (await marker.isSet()) return;
        await clearAppKeys(store, sessionKey);
        await marker.set();
      } catch (e) {
        console.warn('Goedboodschap: install check failed', e);
      }
    })());
  return {
    getItemAsync: async (k) => (await once(), store.getItemAsync(k)),
    setItemAsync: async (k, v) => (await once(), store.setItemAsync(k, v)),
    deleteItemAsync: async (k) => (await once(), store.deleteItemAsync(k)),
  };
}
