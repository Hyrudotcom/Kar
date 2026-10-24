import { guardFreshInstall, type InstallMarker } from '@/src/lib/installGuard';
import { createChunkedStorage, createSecureKeyValue, type RawSecureStore } from '@/src/lib/secureStorage';

function keychain(): RawSecureStore & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    getItemAsync: async (k) => m.get(k) ?? null,
    setItemAsync: async (k, v) => void m.set(k, v),
    deleteItemAsync: async (k) => void m.delete(k),
  };
}

function marker(initial: boolean): InstallMarker & { value: boolean } {
  const mk = { value: initial, isSet: async () => mk.value, set: async () => void (mk.value = true) };
  return mk;
}

const SESSION = 'sb-abc-auth-token';

async function previousInstall(store: RawSecureStore) {
  await createChunkedStorage(store).setItem(SESSION, JSON.stringify({ refresh_token: 'r', user: { id: 'u1' } }));
  const kv = createSecureKeyValue(store);
  await kv.setItem('last_user_id', 'u1');
  await kv.setItem('pending_invite_code', 'ABC234');
  await kv.setItem('household_cache_u1', JSON.stringify({ id: 'h1', name: 'Thuis', role: 'owner' }));
  await kv.setItem('price_available_h1', '1');
  await kv.setItem('removed_notice_u1', '{}');
}

describe('fresh install after an uninstall (round 4: iOS keeps the Keychain)', () => {
  it('deletes the old session and app keys before the first read', async () => {
    const store = keychain();
    await previousInstall(store);
    const guarded = guardFreshInstall(store, marker(false), SESSION);
    expect(await createChunkedStorage(guarded).getItem(SESSION)).toBeNull();
    expect(await createSecureKeyValue(guarded).getItem('last_user_id')).toBeNull();
    expect([...store.m.keys()]).toEqual([]);
  });

  it('keeps everything on a normal start (marker present) and checks only once', async () => {
    const store = keychain();
    await previousInstall(store);
    const mk = marker(true);
    const guarded = guardFreshInstall(store, mk, SESSION);
    expect(await createSecureKeyValue(guarded).getItem('last_user_id')).toBe('u1');
    expect(await createChunkedStorage(guarded).getItem(SESSION)).toContain('refresh_token');

    const fresh = marker(false);
    const g2 = guardFreshInstall(keychain(), fresh, SESSION);
    await createSecureKeyValue(g2).setItem('last_user_id', 'u2');
    expect(fresh.value).toBe(true);
    expect(await createSecureKeyValue(g2).getItem('last_user_id')).toBe('u2'); // not wiped again
  });
});
