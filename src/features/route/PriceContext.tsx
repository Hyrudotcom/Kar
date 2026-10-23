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

interface Loaded {
  key: string;
  status: 'ready' | 'error';
  dataset: PriceDataset | null;
  /** The load failed (shown as unavailable or error): retried when the connection comes back. */
  failed: boolean;
}

export function PriceProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const { state } = useSession();
  const userId = state.kind === 'ready' ? state.user.id : null;
  const householdId = state.kind === 'ready' ? state.household.id : null;
  const engine = state.kind === 'ready' ? state.engine : null;
  const [nonce, setNonce] = useState(0);
  const key = userId && householdId ? `${userId}|${householdId}|${nonce}` : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [optIn, setOptInState] = useState<{ userId: string; value: boolean } | null>(null);
  const current = loaded && loaded.key === key ? loaded : null;
  const optInKnown = !!optIn && optIn.userId === userId;
  const status: PriceState['status'] = !key ? 'idle' : current && optInKnown ? current.status : 'loading';
  const dataset = current?.dataset ?? null;
  const seq = useRef(0);
  const failedRef = useRef(false);
  const failed = !!current?.failed;
  useLayoutEffect(() => {
    failedRef.current = failed;
  }, [failed]);

  useEffect(() => {
    if (!key || !userId || !householdId) return;
    const my = ++seq.current;
    void (async () => {
      try {
        const data = await backend.prices.loadDataset(householdId);
        if (my === seq.current) setLoaded({ key, status: 'ready', dataset: data, failed: false });
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
    if (!userId) return;
    let alive = true;
    void (async () => {
      let value: boolean;
      try {
        value = await backend.prices.getOptIn(userId);
        await backend.kv.setItem(optInKey(userId), value ? '1' : '0').catch(() => undefined);
      } catch {
        value = (await backend.kv.getItem(optInKey(userId)).catch(() => null)) === '1';
      }
      if (alive) setOptInState({ userId, value });
    })();
    return () => {
      alive = false;
    };
  }, [backend, userId, nonce]);

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
      available: dataset ? isComparisonAvailable(dataset) : false,
      optIn: optInValue,
      setOptIn,
      reload: () => setNonce((n) => n + 1),
      setOverride,
    }),
    [status, dataset, optInValue, setOptIn, setOverride],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrices(): PriceState {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePrices outside PriceProvider');
  return c;
}
