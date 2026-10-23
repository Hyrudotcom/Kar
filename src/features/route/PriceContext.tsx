/**
 * Price data for "Goedkoopste route" and the settings toggle: the licensed dataset (read-only),
 * whether a comparison is possible at all (>= 2 verified chains), and the per-user opt-in.
 * Loaded once per household session; "Opnieuw proberen" reloads.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { PriceDataset } from '@/src/contracts';
import { compareBaskets } from '@/src/price';

import { useBackend } from '../session/BackendContext';
import { useSession } from '../session/SessionProvider';

export interface PriceState {
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

export function PriceProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const { state } = useSession();
  const userId = state.kind === 'ready' ? state.user.id : null;
  const householdId = state.kind === 'ready' ? state.household.id : null;
  const [nonce, setNonce] = useState(0);
  const key = userId && householdId ? `${userId}|${householdId}|${nonce}` : null;
  const [loaded, setLoaded] = useState<{ key: string; status: 'ready' | 'error'; dataset: PriceDataset | null; optIn: boolean } | null>(null);
  const current = loaded && loaded.key === key ? loaded : null;
  const status: PriceState['status'] = !key ? 'idle' : current ? current.status : 'loading';
  const dataset = current?.dataset ?? null;
  const optIn = current?.optIn ?? false;
  const seq = useRef(0);

  useEffect(() => {
    if (!key || !userId || !householdId) return;
    const my = ++seq.current;
    void (async () => {
      try {
        const [data, opted] = await Promise.all([backend.prices.loadDataset(householdId), backend.prices.getOptIn(userId).catch(() => false)]);
        if (my === seq.current) setLoaded({ key, status: 'ready', dataset: data, optIn: opted });
      } catch {
        if (my === seq.current) setLoaded({ key, status: 'error', dataset: null, optIn: false });
      }
    })();
  }, [backend, key, userId, householdId]);

  const patch = useCallback((fn: (l: NonNullable<typeof loaded>) => NonNullable<typeof loaded>) => setLoaded((l) => (l ? fn(l) : l)), []);

  const setOptIn = useCallback(
    async (enabled: boolean) => {
      if (!userId) return;
      patch((l) => ({ ...l, optIn: enabled }));
      try {
        await backend.prices.setOptIn(userId, enabled);
      } catch {
        patch((l) => ({ ...l, optIn: !enabled }));
      }
    },
    [backend, userId, patch],
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

  const value = useMemo<PriceState>(
    () => ({
      status,
      dataset,
      available: dataset ? isComparisonAvailable(dataset) : false,
      optIn,
      setOptIn,
      reload: () => setNonce((n) => n + 1),
      setOverride,
    }),
    [status, dataset, optIn, setOptIn, setOverride],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrices(): PriceState {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePrices outside PriceProvider');
  return c;
}
