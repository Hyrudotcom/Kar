import { CHUNK_SIZE, createChunkedStorage, safeKey, type RawSecureStore } from '@/src/lib/secureStorage';

function fakeStore(): RawSecureStore & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    getItemAsync: async (k) => m.get(k) ?? null,
    setItemAsync: async (k, v) => {
      if (v.length > 2048) throw new Error('value too large for SecureStore');
      if (!/^[A-Za-z0-9._-]+$/.test(k)) throw new Error('invalid key');
      m.set(k, v);
    },
    deleteItemAsync: async (k) => {
      m.delete(k);
    },
  };
}

describe('chunked SecureStore session storage', () => {
  it('round-trips a large session in chunks below the 2 KB limit', async () => {
    const raw = fakeStore();
    const s = createChunkedStorage(raw);
    const session = JSON.stringify({ access_token: 'x'.repeat(5000), refresh_token: 'é'.repeat(10) });
    await s.setItem('sb-local-auth-token', session);
    expect(await s.getItem('sb-local-auth-token')).toBe(session);
    expect(raw.m.get('sb-local-auth-token.n')).toBe(String(Math.ceil(session.length / CHUNK_SIZE)));
  });

  it('removes stale chunks when the value shrinks and on removeItem', async () => {
    const raw = fakeStore();
    const s = createChunkedStorage(raw);
    await s.setItem('k', 'a'.repeat(CHUNK_SIZE * 3));
    await s.setItem('k', 'short');
    expect([...raw.m.keys()].sort()).toEqual(['k.0', 'k.n']);
    expect(await s.getItem('k')).toBe('short');
    await s.removeItem('k');
    expect(raw.m.size).toBe(0);
    expect(await s.getItem('k')).toBeNull();
  });

  it('treats a torn write as no session', async () => {
    const raw = fakeStore();
    const s = createChunkedStorage(raw);
    await s.setItem('k', 'a'.repeat(CHUNK_SIZE * 2));
    raw.m.delete('k.1');
    expect(await s.getItem('k')).toBeNull();
  });

  it('sanitises keys', () => {
    expect(safeKey('sb:abc/auth token')).toBe('sb_abc_auth_token');
  });
});

describe('round 3: keychain class', () => {
  it('stores secrets for this device only (not in backups)', async () => {
    const SecureStore = require('expo-secure-store');
    const spy = jest.spyOn(SecureStore, 'setItemAsync').mockResolvedValue(undefined);
    try {
      await createChunkedStorage().setItem('k', 'v');
      for (const call of spy.mock.calls) expect(call[2]).toEqual({ keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
