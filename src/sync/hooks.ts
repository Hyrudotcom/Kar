/**
 * React bindings. Mobile wraps the signed-in tree in <SyncEngineProvider engine={engine}> and reads
 * with useList() / useSyncStatus(). Both are useSyncExternalStore-based: re-render only on change,
 * tear-free, and safe before sign-in (engine null -> empty, loaded=false snapshot).
 */
import { createContext, createElement, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { HistoryEntry, ListSnapshot, SyncEngine, SyncStatus, VisibleItem } from '@/src/contracts';

const EMPTY_SNAPSHOT: ListSnapshot = Object.freeze({
  householdId: '',
  open: [] as VisibleItem[],
  checked: [] as VisibleItem[],
  revision: 0,
  loaded: false,
}) as ListSnapshot;

const EMPTY_STATUS: SyncStatus = Object.freeze({
  icon: 'idle',
  pendingCount: 0,
  failed: [],
  needsReauth: false,
  lastPulledSeq: 0,
}) as SyncStatus;

const EMPTY_HISTORY: HistoryEntry[] = [];

const noopUnsubscribe = () => undefined;

export const SyncEngineContext = createContext<SyncEngine | null>(null);

export function SyncEngineProvider(props: { engine: SyncEngine | null; children?: ReactNode }) {
  return createElement(SyncEngineContext.Provider, { value: props.engine }, props.children);
}

/** The engine from context (or null before sign-in / household). */
export function useSyncEngine(): SyncEngine | null {
  return useContext(SyncEngineContext);
}

/** Live list snapshot. Pass an engine explicitly or rely on SyncEngineProvider. */
export function useList(engine?: SyncEngine | null): ListSnapshot {
  const ctx = useContext(SyncEngineContext);
  const e = engine === undefined ? ctx : engine;
  const subscribe = useCallback((cb: () => void) => (e ? e.subscribe(cb) : noopUnsubscribe), [e]);
  const get = useCallback(() => (e ? e.getSnapshot() : EMPTY_SNAPSHOT), [e]);
  return useSyncExternalStore(subscribe, get, get);
}

/** Live sync status (icon, pending count, failed mutations, needsReauth). */
export function useSyncStatus(engine?: SyncEngine | null): SyncStatus {
  const ctx = useContext(SyncEngineContext);
  const e = engine === undefined ? ctx : engine;
  const subscribe = useCallback((cb: () => void) => (e ? e.subscribeStatus(cb) : noopUnsubscribe), [e]);
  const get = useCallback(() => (e ? e.getStatus() : EMPTY_STATUS), [e]);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * One visible item by id (open or checked), or undefined once it is gone (deleted elsewhere: F12).
 * Follows aliases: an add the server merged into another row is found under that row's id.
 */
export function useItem(itemId: string | null | undefined, engine?: SyncEngine | null): VisibleItem | undefined {
  const ctx = useContext(SyncEngineContext);
  const e = engine === undefined ? ctx : engine;
  const snap = useList(e);
  if (!itemId) return undefined;
  const id = e ? e.resolveId(itemId) : itemId;
  return snap.open.find((i) => i.id === id) ?? snap.checked.find((i) => i.id === id);
}

/** Suggestion history; refreshed whenever the list revision changes. */
export function useHistory(engine?: SyncEngine | null): HistoryEntry[] {
  const ctx = useContext(SyncEngineContext);
  const e = engine === undefined ? ctx : engine;
  const revision = useList(e).revision;
  const [state, setState] = useState<{ engine: SyncEngine | null; history: HistoryEntry[] }>({ engine: null, history: EMPTY_HISTORY });
  useEffect(() => {
    if (!e) return;
    let alive = true;
    e.getHistory().then(
      (history) => {
        if (alive) setState({ engine: e, history });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [e, revision]);
  return e && state.engine === e ? state.history : EMPTY_HISTORY;
}

/** Fires `listener` once when the server reports not_member for this engine. */
export function useMembershipLost(listener: () => void, engine?: SyncEngine | null): void {
  const ctx = useContext(SyncEngineContext);
  const e = engine === undefined ? ctx : engine;
  useEffect(() => (e ? e.onMembershipLost(listener) : undefined), [e, listener]);
}
