/**
 * fetch with a deadline for the Supabase client: a stalled connection (captive portal, dead Wi-Fi
 * that NetInfo still calls online) must end as a network error, never as an endless spinner on
 * first sign-in, joining, leaving or the blank boot screen. React Native's OkHttp has no read
 * timeout by default.
 */
export const FETCH_TIMEOUT_MS = 15_000;

export function fetchWithTimeout(timeoutMs = FETCH_TIMEOUT_MS, base: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const outer = init?.signal;
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener?.('abort', () => controller.abort(), { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return base(input, { ...init, signal: controller.signal }).then(
      (r) => {
        clearTimeout(timer);
        return r;
      },
      (e: unknown) => {
        clearTimeout(timer);
        // supabase-js maps a failed fetch to a network error (AuthRetryableFetchError / 'network').
        throw e instanceof Error ? e : new Error(String(e));
      },
    );
  };
}
