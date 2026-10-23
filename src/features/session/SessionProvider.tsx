/**
 * Session lifecycle (docs/architecture.md section 2, design-spec 4.2 / 4.6 / 5.9 / 5.10):
 * sign-in -> silently ensure household "Thuis" -> open the per-user database -> sync engine.
 * Also owns: account switch warning, membership loss, leave, sign out, delete account, invites.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { INVITE_CODE_REGEX, type HouseholdMember, type Uuid } from '@/src/contracts';
import { KV_KEYS, type AppEngine, type AuthUser, type Backend, type HouseholdCallError } from '@/src/lib/backend/types';
import { SyncEngineProvider } from '@/src/sync/hooks';

import { useBackend } from './BackendContext';

export interface HouseholdInfo {
  id: Uuid;
  name: string;
  role: 'owner' | 'member';
  members: HouseholdMember[];
}

export type SessionState =
  | { kind: 'booting' }
  | { kind: 'signedOut' }
  /** First start without internet and nothing cached: "Geen internet" (design-spec 4.7). */
  | { kind: 'noInternet'; user: AuthUser }
  /** A different account signed in while the previous account's file still has unsent changes (5.10). */
  | { kind: 'switchAccount'; user: AuthUser; previousUserId: Uuid; unsent: number }
  | { kind: 'ready'; user: AuthUser; household: HouseholdInfo; engine: AppEngine }
  /** "Je bent geen lid meer van Thuis" (4.6). Local data is already wiped. */
  | { kind: 'removed'; user: AuthUser; householdName: string; failedCount: number; failedText: string };

export type ActionResult = { ok: true } | { ok: false; error: HouseholdCallError | 'offline' | 'pending'; pending?: number };

export interface Session {
  state: SessionState;
  /** Code from a /j/<code> link or typed on the sign-in screen, waiting for "Lid worden". */
  pendingInvite: string | null;
  setPendingInvite(code: string | null): Promise<void>;
  /** Re-reads the household (members, roles, name). Detects removal. */
  refreshHousehold(): Promise<void>;
  /** Returns { error:'pending', pending } when unsent changes exist and force is not set. */
  signOut(force?: boolean): Promise<ActionResult>;
  leaveHousehold(force?: boolean): Promise<ActionResult>;
  deleteAccount(): Promise<ActionResult>;
  acceptInvite(code: string): Promise<ActionResult>;
  /** After "Je bent geen lid meer": make a new "Thuis" and continue. */
  continueAfterRemoval(): Promise<void>;
  confirmSwitchAccount(): Promise<void>;
  cancelSwitchAccount(): Promise<void>;
  retry(): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

interface CachedHousehold {
  id: Uuid;
  name: string;
  role: 'owner' | 'member';
}

const cacheKey = (userId: Uuid) => `${KV_KEYS.householdCache}_${userId}`;

async function readCache(backend: Backend, userId: Uuid): Promise<CachedHousehold | null> {
  try {
    const raw = await backend.kv.getItem(cacheKey(userId));
    if (!raw) return null;
    const v = JSON.parse(raw) as CachedHousehold;
    return v && typeof v.id === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function normalizeInviteCode(raw: string): string | null {
  const code = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return INVITE_CODE_REGEX.test(code) ? code : null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const [state, setStateRaw] = useState<SessionState>({ kind: 'booting' });
  const [pendingInvite, setPendingInviteState] = useState<string | null>(null);
  const stateRef = useRef<SessionState>(state);
  const generation = useRef(0);
  const engineRef = useRef<AppEngine | null>(null);

  const setState = useCallback((s: SessionState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);

  const stopEngine = useCallback(async () => {
    const e = engineRef.current;
    engineRef.current = null;
    if (e) await e.dispose().catch(() => undefined);
  }, []);

  const wipe = useCallback(
    async (userId: Uuid) => {
      const e = engineRef.current;
      engineRef.current = null;
      await backend.local.wipe(userId, e).catch(() => undefined);
      await backend.kv.removeItem(cacheKey(userId)).catch(() => undefined);
    },
    [backend],
  );

  /** Assigned after `wipe` below; refs keep `establish` stable. */
  const lostRef = useRef<(user: AuthUser, householdName: string) => Promise<void>>(async () => undefined);

  /** Loads (or silently creates) the household, opens the engine and goes to `ready`. */
  const establish = useCallback(
    async (user: AuthUser, opts: { skipAccountCheck?: boolean } = {}): Promise<void> => {
      const gen = ++generation.current;
      const stale = () => gen !== generation.current;

      if (!opts.skipAccountCheck) {
        const last = await backend.kv.getItem(KV_KEYS.lastUserId).catch(() => null);
        if (stale()) return;
        if (last && last !== user.id) {
          const unsent = await backend.local.countUnsent(last).catch(() => 0);
          if (stale()) return;
          if (unsent > 0) {
            setState({ kind: 'switchAccount', user, previousUserId: last, unsent });
            return;
          }
          await backend.local.wipe(last, null).catch(() => undefined);
          await backend.kv.removeItem(cacheKey(last)).catch(() => undefined);
        }
      }
      await backend.kv.setItem(KV_KEYS.lastUserId, user.id).catch(() => undefined);

      const cached = await readCache(backend, user.id);
      if (stale()) return;

      const fetchHousehold = async (): Promise<HouseholdInfo | 'network'> => {
        const ensured = await backend.households.createHousehold('Thuis');
        if (!ensured.ok) return 'network';
        const mine = await backend.households.getMyHousehold();
        if (!mine.ok || !mine.household || !mine.role) {
          return { id: ensured.household.id, name: ensured.household.name, role: 'owner', members: [] };
        }
        return { id: mine.household.id, name: mine.household.name, role: mine.role, members: mine.members };
      };

      let household: HouseholdInfo | null = null;
      let refreshInBackground = false;
      if (cached) {
        // Local first: the list is interactive before the network answers (design-spec 6).
        household = { ...cached, members: [] };
        refreshInBackground = true;
      } else {
        const r = await fetchHousehold();
        if (stale()) return;
        if (r === 'network') {
          setState({ kind: 'noInternet', user });
          return;
        }
        household = r;
        await backend.kv.setItem(cacheKey(user.id), JSON.stringify({ id: r.id, name: r.name, role: r.role })).catch(() => undefined);
      }

      await stopEngine();
      let engine: AppEngine;
      try {
        engine = await backend.local.openEngine(user, household.id);
      } catch {
        if (!stale()) setState({ kind: 'noInternet', user });
        return;
      }
      if (stale()) {
        await engine.dispose().catch(() => undefined);
        return;
      }
      engineRef.current = engine;
      const hhName = household.name;
      engine.onMembershipLost(() => {
        const s = stateRef.current;
        if (s.kind === 'ready' && s.engine === engine) void lostRef.current(user, s.household.name);
        else if (engineRef.current === engine) void lostRef.current(user, hhName);
      });
      setState({ kind: 'ready', user, household, engine });

      if (refreshInBackground) {
        const r = await fetchHousehold();
        if (stale() || r === 'network') return;
        if (r.id !== household.id) {
          await lostRef.current(user, household.name);
          return;
        }
        await backend.kv.setItem(cacheKey(user.id), JSON.stringify({ id: r.id, name: r.name, role: r.role })).catch(() => undefined);
        const s = stateRef.current;
        if (s.kind === 'ready' && s.engine === engine) setState({ ...s, household: r });
      }
    },
    [backend, setState, stopEngine],
  );

  const handleMembershipLost = async (user: AuthUser, householdName: string) => {
    const s = stateRef.current;
    if (s.kind === 'removed') return;
    generation.current++;
    const e = engineRef.current;
    let failedCount = 0;
    let failedText = '';
    if (e) {
      const st = e.getStatus();
      failedCount = st.failed.filter((f) => f.reason === 'not_member').length || st.pendingCount;
      failedText = failedCount > 0 ? e.failedAsText() : '';
    }
    await wipe(user.id);
    setState({ kind: 'removed', user, householdName, failedCount, failedText });
  };
  useLayoutEffect(() => {
    lostRef.current = handleMembershipLost;
  });

  // Boot + auth changes.
  useEffect(() => {
    let alive = true;
    const onUser = (user: AuthUser | null) => {
      if (!alive) return;
      const s = stateRef.current;
      if (!user) {
        if (s.kind === 'signedOut') return;
        // Session ended (sign-out or expiry). Keep the database: the outbox is only resent when the
        // same user id signs in again (5.10). Explicit sign-out wipes before calling auth.signOut().
        generation.current++;
        void stopEngine();
        setState({ kind: 'signedOut' });
        return;
      }
      if (s.kind === 'ready' && s.user.id === user.id) {
        // Same user signed in again or the token was refreshed: resend an outbox held back by needsReauth.
        s.engine.notifyReauthenticated();
        return;
      }
      if ((s.kind === 'noInternet' || s.kind === 'switchAccount' || s.kind === 'removed') && s.user.id === user.id) return;
      void establish(user);
    };
    const unsub = backend.auth.onUserChange(onUser);
    void (async () => {
      const code = await backend.kv.getItem(KV_KEYS.pendingInviteCode).catch(() => null);
      if (alive && code) setPendingInviteState(code);
      const user = await backend.auth.getUser().catch(() => null);
      if (!alive) return;
      if (user) {
        if (stateRef.current.kind === 'booting') void establish(user);
      } else if (stateRef.current.kind === 'booting') setState({ kind: 'signedOut' });
    })();
    return () => {
      alive = false;
      unsub();
    };
  }, [backend, establish, setState, stopEngine]);

  // Stop the engine on unmount.
  useEffect(() => () => void stopEngine(), [stopEngine]);

  const refreshHousehold = useCallback(async () => {
    const s = stateRef.current;
    if (s.kind !== 'ready') return;
    const mine = await backend.households.getMyHousehold();
    const now = stateRef.current;
    if (now.kind !== 'ready' || now.engine !== s.engine || !mine.ok) return;
    if (!mine.household || mine.household.id !== s.household.id || !mine.role) {
      await lostRef.current(s.user, s.household.name);
      return;
    }
    const household: HouseholdInfo = { id: mine.household.id, name: mine.household.name, role: mine.role, members: mine.members };
    await backend.kv.setItem(cacheKey(s.user.id), JSON.stringify({ id: household.id, name: household.name, role: household.role })).catch(() => undefined);
    setState({ ...now, household });
  }, [backend, setState]);

  // Membership check on every foreground (design-spec 4.6), engine foreground hint.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      const s = stateRef.current;
      if (s.kind !== 'ready') return;
      s.engine.setAppActive(st === 'active');
      if (st === 'active') void refreshHousehold();
    });
    return () => sub.remove();
  }, [refreshHousehold]);

  const setPendingInvite = useCallback(
    async (code: string | null) => {
      setPendingInviteState(code);
      if (code) await backend.kv.setItem(KV_KEYS.pendingInviteCode, code).catch(() => undefined);
      else await backend.kv.removeItem(KV_KEYS.pendingInviteCode).catch(() => undefined);
    },
    [backend],
  );

  const signOut = useCallback(
    async (force = false): Promise<ActionResult> => {
      const s = stateRef.current;
      if (s.kind === 'ready') {
        const pending = s.engine.getStatus().pendingCount;
        if (pending > 0 && !force) return { ok: false, error: 'pending', pending };
      }
      generation.current++;
      if (s.kind !== 'booting' && s.kind !== 'signedOut') {
        await wipe(s.user.id);
        await backend.kv.removeItem(KV_KEYS.lastUserId).catch(() => undefined);
      }
      setState({ kind: 'signedOut' });
      await backend.auth.signOut();
      return { ok: true };
    },
    [backend, setState, wipe],
  );

  const leaveHousehold = useCallback(
    async (force = false): Promise<ActionResult> => {
      const s = stateRef.current;
      if (s.kind !== 'ready') return { ok: false, error: 'not_member' };
      if (!backend.connectivity.isOnline()) return { ok: false, error: 'offline' };
      const pending = s.engine.getStatus().pendingCount;
      if (pending > 0 && !force) return { ok: false, error: 'pending', pending };
      const r = await backend.households.leaveHousehold(s.household.id);
      if (!r.ok && r.error !== 'not_member') return { ok: false, error: r.error };
      generation.current++;
      await wipe(s.user.id);
      await establish(s.user, { skipAccountCheck: true });
      return { ok: true };
    },
    [backend, establish, wipe],
  );

  const deleteAccount = useCallback(async (): Promise<ActionResult> => {
    const s = stateRef.current;
    if (s.kind !== 'ready' && s.kind !== 'removed' && s.kind !== 'noInternet') return { ok: false, error: 'not_authenticated' };
    if (!backend.connectivity.isOnline()) return { ok: false, error: 'offline' };
    const r = await backend.households.deleteAccount();
    if (!r.ok) return { ok: false, error: r.error };
    generation.current++;
    await wipe(s.user.id);
    await backend.kv.removeItem(KV_KEYS.lastUserId).catch(() => undefined);
    setState({ kind: 'signedOut' });
    await backend.auth.signOut();
    return { ok: true };
  }, [backend, setState, wipe]);

  const acceptInvite = useCallback(
    async (code: string): Promise<ActionResult> => {
      const s = stateRef.current;
      if (s.kind !== 'ready') return { ok: false, error: 'not_authenticated' };
      if (!backend.connectivity.isOnline()) return { ok: false, error: 'offline' };
      // Online-only flow: drain the outbox first so nothing is left behind in the old household.
      await s.engine.syncNow();
      if (s.engine.getStatus().pendingCount > 0) return { ok: false, error: 'pending' };
      const r = await backend.households.acceptInvite(code);
      if (!r.ok) return { ok: false, error: r.error };
      generation.current++;
      await wipe(s.user.id);
      await setPendingInvite(null);
      await establish(s.user, { skipAccountCheck: true });
      return { ok: true };
    },
    [backend, establish, setPendingInvite, wipe],
  );

  const continueAfterRemoval = useCallback(async () => {
    const s = stateRef.current;
    if (s.kind !== 'removed') return;
    await establish(s.user, { skipAccountCheck: true });
  }, [establish]);

  const confirmSwitchAccount = useCallback(async () => {
    const s = stateRef.current;
    if (s.kind !== 'switchAccount') return;
    await backend.local.wipe(s.previousUserId, null).catch(() => undefined);
    await backend.kv.removeItem(cacheKey(s.previousUserId)).catch(() => undefined);
    await establish(s.user, { skipAccountCheck: true });
  }, [backend, establish]);

  const cancelSwitchAccount = useCallback(async () => {
    generation.current++;
    setState({ kind: 'signedOut' });
    await backend.auth.signOut();
  }, [backend, setState]);

  const retry = useCallback(async () => {
    const s = stateRef.current;
    if (s.kind === 'noInternet') await establish(s.user, { skipAccountCheck: true });
  }, [establish]);

  const value = useMemo<Session>(
    () => ({
      state,
      pendingInvite,
      setPendingInvite,
      refreshHousehold,
      signOut,
      leaveHousehold,
      deleteAccount,
      acceptInvite,
      continueAfterRemoval,
      confirmSwitchAccount,
      cancelSwitchAccount,
      retry,
    }),
    [state, pendingInvite, setPendingInvite, refreshHousehold, signOut, leaveHousehold, deleteAccount, acceptInvite, continueAfterRemoval, confirmSwitchAccount, cancelSwitchAccount, retry],
  );

  return (
    <SessionContext.Provider value={value}>
      <SyncEngineProvider engine={state.kind === 'ready' ? state.engine : null}>{children}</SyncEngineProvider>
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** The ready session; throws when used outside the signed-in screens. */
export function useReadySession(): Extract<SessionState, { kind: 'ready' }> & { session: Session } {
  const session = useSession();
  if (session.state.kind !== 'ready') throw new Error('useReadySession: session not ready');
  return { ...session.state, session };
}
