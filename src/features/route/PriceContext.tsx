/**
 * Price data for "Goedkoopste route" and the settings toggle: the licensed dataset (read-only),
 * whether a comparison is possible at all (>= 2 verified chains), and the per-user opt-in.
 * Loaded once per household session, and again when the connection comes back after a failed load.
 *
 * A failed load is only an error ("Prijzen tijdelijk niet beschikbaar") when a comparison was shown
 * before (a cached comparison exists). Otherwise nothing proves prices exist at all (v1: none), so
 * the screen stays "Geen geverifieerde prijzen beschikbaar" without a button.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { PriceDataset } from '@/src/contracts';
import { compareBaskets } from '@/src/price';

import { useBackend } from '../session/BackendContext';
import { useSession } from '../session/SessionProvider';

export interface PriceState {
  /** 'error' only when a comparison was available before; a failed first load is 'ready' + no dataset. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  dataset: PriceDataset | null;
  /** At least two chains have verified licensed prices (otherwise state "unavailable"). */
  available: boolean;
  optIn: boolean;
  setOptIn(enabled: boolean): Promise<void>;
  reload(): void;
  /** "Verkeerd product" / "Toch gebruiken" (household-wide). */
  setOverride(catalogItemId: string, chainId: string, wrong: boolean): Promise<void>;
}

const Ctx = createContext<PriceState | null>(null);

export function isComparisonAvailable(data: PriceDataset, now = Date.now()): boolean {
  return compareBaskets({ items: [], data, now, list_fingerprint: '' }).state !== 'unavailable';
}

/** The opt-in is also kept on the device, so it is known offline (cached comparison, rule 9). */
const optInKey = (userId: string) => `price_opt_in_${userId}`;
/** Whether the last load for this household found a comparison possible ('1') or not ('0'). */
const availableKey = (householdId: string) => `price_available_${householdId}`;

/** Price reads never hold the tab hostage: a stalled connection counts as a failed load. */
export const PRICE_LOAD_TIMEOUT_MS = 8_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

interface Loaded {
  key: string;
  status: 'ready' | 'error';
  dataset: PriceDataset | null;
  /** The load failed (shown as unavailable or error): retried when the connection comes back. */
  failed: boolean;
}

/**
 * The tab never waits on the network to say "Geen geverifieerde prijzen beschikbaar": unless the last
 * load on this device found verified prices for this household, that state shows at once while the
 * dataset loads in the background. The opt-in is only fetched once a comparison is possible.
 */
export function PriceProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const { state } = useSession();
  const userId = state.kind === 'ready' ? state.user.id : null;
  const householdId = state.kind === 'ready' ? state.household.id : null;
  const engine = state.kind === 'ready' ? state.engine : null;
  const [nonce, setNonce] = useState(0);
  const key = userId && householdId ? `${userId}|${householdId}|${nonce}` : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [hint, setHint] = useState<{ householdId: string; available: boolean } | null>(null);
  const [optIn, setOptInState] = useState<{ userId: string; value: boolean } | null>(null);
  const current = loaded && loaded.key === key ? loaded : null;
  const dataset = current?.dataset ?? null;
  const available = useMemo(() => (dataset ? isComparisonAvailable(dataset) : false), [dataset]);
  const optInKnown = !!optIn && optIn.userId === userId;
  // Opt-in matters only once a comparison is possible (or a cached one may be shown offline).
  const needOptIn = available || current?.status === 'error';
  const hintKnown = !!hint && hint.householdId === householdId;
  const status: PriceState['status'] = !key
    ? 'idle'
    : current
      ? needOptIn && !optInKnown
        ? 'loading'
        : current.status
      : hintKnown && !hint!.available
        ? 'ready'
        : 'loading';
  const seq = useRef(0);
  const failedRef = useRef(false);
  const failed = !!current?.failed;
  useLayoutEffect(() => {
    failedRef.current = failed;
  }, [failed]);

  useEffect(() => {
    if (!householdId) return;
    let alive = true;
    void withTimeout(backend.kv.getItem(availableKey(householdId)), 1_000)
      .catch(() => null)
      .then((v) => {
        if (alive) setHint({ householdId, available: v === '1' });
      });
    return () => {
      alive = false;
    };
  }, [backend, householdId]);

  useEffect(() => {
    if (!key || !userId || !householdId) return;
    const my = ++seq.current;
    void (async () => {
      try {
        const data = await withTimeout(backend.prices.loadDataset(householdId), PRICE_LOAD_TIMEOUT_MS);
        if (my !== seq.current) return;
        setLoaded({ key, status: 'ready', dataset: data, failed: false });
        const ok = isComparisonAvailable(data);
        setHint({ householdId, available: ok });
        await backend.kv.setItem(availableKey(householdId), ok ? '1' : '0').catch(() => undefined);
      } catch {
        // Only a comparison shown before (cached) proves that prices exist and are now missing.
        const cache = await engine?.readPriceCache().catch(() => null);
        if (my === seq.current) setLoaded({ key, status: cache ? 'error' : 'ready', dataset: null, failed: true });
      }
    })();
  }, [backend, key, userId, householdId, engine]);

  // Opt-in: server value when reachable, else the last value seen on this device. Never reset by a
  // failed dataset load.
  useEffect(() => {
    if (!userId || !needOptIn) return;
    let alive = true;
    void (async () => {
      let value: boolean;
      try {
        value = await withTimeout(backend.prices.getOptIn(userId), PRICE_LOAD_TIMEOUT_MS);
        await backend.kv.setItem(optInKey(userId), value ? '1' : '0').catch(() => undefined);
      } catch {
        value = (await backend.kv.getItem(optInKey(userId)).catch(() => null)) === '1';
      }
      if (alive) setOptInState({ userId, value });
    })();
    return () => {
      alive = false;
    };
  }, [backend, userId, nonce, needOptIn]);

  // Back online after a failed load: load again by itself (no "Opnieuw proberen" needed).
  useEffect(
    () =>
      backend.connectivity.subscribe((online) => {
        if (online && failedRef.current) setNonce((n) => n + 1);
      }),
    [backend],
  );

  const patch = useCallback((fn: (l: Loaded) => Loaded) => setLoaded((l) => (l ? fn(l) : l)), []);

  const setOptIn = useCallback(
    async (enabled: boolean) => {
      if (!userId) return;
      setOptInState({ userId, value: enabled });
      try {
        await backend.prices.setOptIn(userId, enabled);
        await backend.kv.setItem(optInKey(userId), enabled ? '1' : '0').catch(() => undefined);
      } catch {
        setOptInState({ userId, value: !enabled });
      }
    },
    [backend, userId],
  );

  const setOverride = useCallback(
    async (catalogItemId: string, chainId: string, wrong: boolean) => {
      if (!householdId) return;
      if (wrong) await backend.prices.addOverride(householdId, catalogItemId, chainId);
      else await backend.prices.removeOverride(householdId, catalogItemId, chainId);
      patch((l) => {
        const d = l.dataset;
        if (!d) return l;
        const rest = d.overrides.filter((o) => !(o.catalog_item_id === catalogItemId && o.chain_id === chainId && o.household_id === householdId));
        return {
          ...l,
          dataset: {
            ...d,
            overrides: wrong ? [...rest, { household_id: householdId, catalog_item_id: catalogItemId, chain_id: chainId, created_by: userId, created_at: new Date().toISOString() }] : rest,
          },
        };
      });
    },
    [backend, householdId, userId, patch],
  );

  const optInValue = optInKnown && optIn!.value;
  const value = useMemo<PriceState>(
    () => ({
      status,
      dataset,
      available,
      optIn: optInValue,
      setOptIn,
      reload: () => setNonce((n) => n + 1),
      setOverride,
    }),
    [status, dataset, available, optInValue, setOptIn, setOverride],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrices(): PriceState {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePrices outside PriceProvider');
  return c;
}
