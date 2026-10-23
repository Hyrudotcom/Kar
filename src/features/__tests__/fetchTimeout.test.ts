import { fetchWithTimeout } from '@/src/lib/fetchWithTimeout';

describe('fetchWithTimeout (round 3: household calls never wait forever)', () => {
  it('aborts a request that never answers', async () => {
    jest.useFakeTimers();
    try {
      const stalled: typeof fetch = (_i, init) =>
        new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('Network request failed: aborted'))));
      const p = fetchWithTimeout(1_000, stalled)('https://x.test/rpc');
      jest.advanceTimersByTime(1_001);
      await expect(p).rejects.toThrow(/aborted/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('passes answers through and honours the caller abort signal', async () => {
    const ok: typeof fetch = async () => ({ status: 200 }) as Response;
    await expect(fetchWithTimeout(1_000, ok)('https://x.test')).resolves.toEqual({ status: 200 });
    const seen: AbortSignal[] = [];
    const spy: typeof fetch = async (_i, init) => {
      seen.push(init!.signal!);
      return { status: 200 } as Response;
    };
    const c = new AbortController();
    c.abort();
    await fetchWithTimeout(1_000, spy)('https://x.test', { signal: c.signal });
    expect(seen[0]!.aborted).toBe(true);
  });
});
