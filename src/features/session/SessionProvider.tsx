/**
 * Session lifecycle (docs/architecture.md section 2, design-spec 4.2 / 4.6 / 5.9 / 5.10):
 * sign-in -> silently ensure household "Thuis" -> open the per-user database -> sync engine.
 * Also owns: account switch warning, membership loss, leave, sign out, delete account, invites.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { INVITE_CODE_REGEX, type HouseholdMember, type Uuid } from '@/src/contracts';
import { KV_KEYS, type AppEngine, type AuthUser, type Backend, type HouseholdApi, type HouseholdCallError } from '@/src/lib/backend/types';
import { SyncEngineProvider } from '@/src/sync/hooks';

import { useBackend } from './BackendContext';

export interface HouseholdInfo {
  id: Uuid;
  name: string;
  /** 'member' is also used while the role is unknown (owner controls stay hidden until confirmed). */
  role: 'owner' | 'member';
  members: HouseholdMember[];
}

/** Why the signed-in user has no list on screen: no network, the server failed, or the local file did. */
export type UnavailableReason = 'network' | 'server' | 'local';

export type SessionState =
  | { kind: 'booting' }
  | { kind: 'signedOut' }
  /**
   * No list to show: first start without internet and nothing cached ("Geen internet", design-spec
   * 4.7), a server error while creating/loading the household, or the local database failed to open.
   */
  | { kind: 'unavailable'; user: AuthUser; reason: UnavailableReason }
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
  /** Returns { error:'pending', pending } when changes could not be sent and force is not set. */
  acceptInvite(code: string, force?: boolean): Promise<ActionResult>;
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
/** "Je bent geen lid meer" survives a restart: the file is wiped, the notice and lost edits are not. */
const removedKey = (userId: Uuid) => `removed_notice_${userId}`;

type MembershipAnswer = Awaited<ReturnType<HouseholdApi['getMyHousehold']>>;

interface RemovedNotice {
  householdName: string;
  failedCount: number;
  failedText: string;
}

async function readRemovedNotice(backend: Backend, userId: Uuid): Promise<RemovedNotice | null> {
  try {
    const raw = await backend.kv.getItem(removedKey(userId));
    const v = raw ? (JSON.parse(raw) as RemovedNotice) : null;
    return v && typeof v.householdName === 'string' ? v : null;
  } catch {
    return null;
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

async function readPendingWipes(backend: Backend): Promise<Uuid[]> {
  try {
    const raw = await backend.kv.getItem(KV_KEYS.pendingWipes);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is Uuid => typeof x === 'string') : [];
  } catch {
    return [];
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

  /** Set while leave / accept / delete account run: the engine's not_member answers are expected then. */
  const transitioning = useRef(false);
  /** Single flight for the membership check (engine listener, foreground check and establish can all start it). */
  const losing = useRef(false);
  /** A check requested while one ran: it runs again afterwards with a fresh answer, never dropped. */
  const recheck = useRef<{ user: AuthUser; householdName: string } | null>(null);
  const lastReopen = useRef(0);
  /** Engines that got a not_member answer: they keep queueing edits but no longer sync. */
  const lostEngines = useRef(new WeakSet<AppEngine>());
  /** Retry of a membership check whose answer was unknown (timer with backoff, or back online). */
  const memberRetry = useRef<{ timer: ReturnType<typeof setTimeout> | null; unsub: (() => void) | null; attempt: number }>({ timer: null, unsub: null, attempt: 0 });
  const signingOut = useRef(false);

  const clearRetry = useCallback(() => {
    const r = memberRetry.current;
    if (r.timer) clearTimeout(r.timer);
    r.unsub?.();
    r.timer = null;
    r.unsub = null;
  }, []);

  const stopEngine = useCallback(async () => {
    const e = engineRef.current;
    engineRef.current = null;
    if (e) await e.dispose().catch(() => undefined);
  }, []);

  /**
   * Deletes a user's local file. A failed delete is never swallowed silently: the user id is kept in
   * `pending_wipes` and the delete is retried on every start until it succeeds (user data must not
   * stay on the phone after sign-out, account deletion or removal).
   */
  const wipeUser = useCallback(
    async (userId: Uuid, engine: AppEngine | null) => {
      try {
        await backend.local.wipe(userId, engine);
      } catch (err) {
        console.warn('Goedboodschap: local data could not be deleted, retrying at next start', err);
        const list = await readPendingWipes(backend);
        if (!list.includes(userId)) await backend.kv.setItem(KV_KEYS.pendingWipes, JSON.stringify([...list, userId])).catch(() => undefined);
      }
      await backend.kv.removeItem(cacheKey(userId)).catch(() => undefined);
      await backend.kv.removeItem(removedKey(userId)).catch(() => undefined);
    },
    [backend],
  );

  const wipe = useCallback(
    async (userId: Uuid) => {
      const e = engineRef.current;
      engineRef.current = null;
      await wipeUser(userId, e);
    },
    [wipeUser],
  );

  /** Assigned after `wipe` below; refs keep `establish` stable. */
  const lostRef = useRef<(user: AuthUser, householdName: string, known?: MembershipAnswer) => Promise<void>>(async () => undefined);

  /** Loads (or silently creates) the household, opens the engine and goes to `ready`. */
  const establish = useCallback(
    async (user: AuthUser, opts: { skipAccountCheck?: boolean } = {}): Promise<void> => {
      const gen = ++generation.current;
      const stale = () => gen !== generation.current;
      clearRetry();

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
          await wipeUser(last, null);
        }
      }
      await backend.kv.setItem(KV_KEYS.lastUserId, user.id).catch(() => undefined);

      // A delete of this user's file that failed at sign-out is done now, before the file is used
      // again; afterwards the id leaves the queue, so a later start never deletes new offline edits.
      const queued = await readPendingWipes(backend);
      if (queued.includes(user.id)) {
        await backend.local.wipe(user.id, null).catch((err: unknown) => console.warn('Goedboodschap: local data could not be deleted', err));
        const rest = (await readPendingWipes(backend)).filter((x) => x !== user.id);
        await backend.kv.setItem(KV_KEYS.pendingWipes, JSON.stringify(rest)).catch(() => undefined);
        if (stale()) return;
      }

      // Removed while the app was closed after the notice was shown: show it again (4.6).
      const notice = await readRemovedNotice(backend, user.id);
      if (stale()) return;
      if (notice) {
        await stopEngine();
        setState({ kind: 'removed', user, ...notice });
        return;
      }

      const cached = await readCache(backend, user.id);
      if (stale()) return;

      /**
       * Only without a cached household (first start, after removal, leave or a switch): ensure one.
       * `confirmed` = role and members come from get_my_household (only then is the role cached).
       */
      const fetchHousehold = async (): Promise<(HouseholdInfo & { confirmed: boolean }) | 'network' | 'server'> => {
        const ensured = await backend.households.createHousehold('Thuis');
        if (!ensured.ok) return ensured.error === 'network' ? 'network' : 'server';
        const mine = await backend.households.getMyHousehold();
        if (!mine.ok || !mine.household || !mine.role) {
          // Only a household this call created is certainly ours to own; never guess "owner".
          return { id: ensured.household.id, name: ensured.household.name, role: ensured.created ? 'owner' : 'member', members: [], confirmed: ensured.created };
        }
        return { id: mine.household.id, name: mine.household.name, role: mine.role, members: mine.members, confirmed: true };
      };
      const cache = (h: HouseholdInfo & { confirmed: boolean }) =>
        h.confirmed ? backend.kv.setItem(cacheKey(user.id), JSON.stringify({ id: h.id, name: h.name, role: h.role })).catch(() => undefined) : undefined;

      let household: HouseholdInfo | null = null;
      let refreshInBackground = false;
      if (cached) {
        // Local first: the list is interactive before the network answers (design-spec 6).
        household = { ...cached, members: [] };
        refreshInBackground = true;
      } else {
        const r = await fetchHousehold();
        if (stale()) return;
        if (r === 'network' || r === 'server') {
          setState({ kind: 'unavailable', user, reason: r });
          return;
        }
        const { confirmed: _confirmed, ...info } = r;
        household = info;
        await cache(r);
      }

      await stopEngine();
      let engine: AppEngine;
      try {
        engine = await backend.local.openEngine(user, household.id);
      } catch (err) {
        // Locked, corrupt or full database: not a network problem, so not "Geen internet" (D-01).
        console.warn('Goedboodschap: local database could not be opened', err);
        if (!stale()) setState({ kind: 'unavailable', user, reason: 'local' });
        return;
      }
      if (stale()) {
        await engine.dispose().catch(() => undefined);
        return;
      }
      engineRef.current = engine;
      const hhName = household.name;
      engine.onMembershipLost(() => {
        lostEngines.current.add(engine);
        if (transitioning.current) return;
        const s = stateRef.current;
        if (s.kind === 'ready' && s.engine === engine) void lostRef.current(user, s.household.name);
        else if (engineRef.current === engine) void lostRef.current(user, hhName);
      });
      setState({ kind: 'ready', user, household, engine });

      if (refreshInBackground) {
        // Membership check on every open (4.6). Never creates a household: a user removed while the
        // app was closed must see the removal, not a fresh "Thuis" that swallows the offline edits.
        const mine = await backend.households.getMyHousehold();
        if (stale() || !mine.ok) return;
        await lostRef.current(user, household.name, mine);
      }
    },
    [backend, setState, stopEngine, wipeUser, clearRetry],
  );

  /**
   * Decides what a membership answer means: still a member (refresh the info; reopen an engine that
   * got not_member), switched household on another phone (reopen on the new one; start() re-addresses
   * the outbox), or removed (stop, collect unsent edits, wipe, show the notice). An unknown answer is
   * retried on a timer with backoff and at once when the connection comes back; meanwhile edits keep
   * going into the outbox.
   */
  const checkMembership = async (user: AuthUser, householdName: string, known?: MembershipAnswer) => {
    if (transitioning.current || stateRef.current.kind === 'removed') return;
    if (losing.current) {
      recheck.current = { user, householdName };
      return;
    }
    losing.current = true;
    const gen = generation.current;
    let retryIn: number | null = null;
    try {
      const mine = known ?? (await backend.households.getMyHousehold());
      if (transitioning.current || gen !== generation.current) return;
      if (!mine.ok) {
        retryIn = Math.min(60_000, 2_000 * 2 ** memberRetry.current.attempt++);
        return;
      }
      memberRetry.current.attempt = 0;
      if (mine.household && mine.role) {
        const s = stateRef.current;
        if (s.kind === 'ready' && s.household.id === mine.household.id) {
          if (!lostEngines.current.has(s.engine)) {
            const household: HouseholdInfo = { id: mine.household.id, name: mine.household.name, role: mine.role, members: mine.members };
            await backend.kv.setItem(cacheKey(user.id), JSON.stringify({ id: household.id, name: household.name, role: household.role })).catch(() => undefined);
            const now = stateRef.current;
            if (now.kind === 'ready' && now.engine === s.engine) setState({ ...now, household });
            return;
          }
          // Still a member of this very household (a not_member raced a re-join): reopen, but never in a loop.
          const wait = lastReopen.current + 60_000 - Date.now();
          if (wait > 0) {
            retryIn = wait;
            return;
          }
          lastReopen.current = Date.now();
        }
        await backend.kv
          .setItem(cacheKey(user.id), JSON.stringify({ id: mine.household.id, name: mine.household.name, role: mine.role }))
          .catch(() => undefined);
        await establish(user, { skipAccountCheck: true });
        return;
      }
      generation.current++;
      clearRetry();
      const e = engineRef.current;
      engineRef.current = null;
      let unsent = { count: 0, text: '' };
      if (e) {
        // Stop first (drains an in-flight request), then collect failed AND still pending changes:
        // the file that holds them is deleted next.
        await e.stop().catch(() => undefined);
        unsent = e.unsent();
      }
      await wipeUser(user.id, e);
      const notice: RemovedNotice = { householdName, failedCount: unsent.count, failedText: unsent.text };
      await backend.kv.setItem(removedKey(user.id), JSON.stringify(notice)).catch(() => undefined);
      setState({ kind: 'removed', user, ...notice });
    } finally {
      losing.current = false;
      if (retryIn !== null && gen === generation.current) {
        clearRetry();
        const again = () => {
          if (gen !== generation.current) return;
          clearRetry();
          void lostRef.current(user, householdName);
        };
        memberRetry.current.timer = setTimeout(again, retryIn);
        memberRetry.current.unsub = backend.connectivity.subscribe((online) => {
          if (online) queueMicrotask(again);
        });
      }
      const next = recheck.current;
      recheck.current = null;
      if (next) void lostRef.current(next.user, next.householdName);
    }
  };
  useLayoutEffect(() => {
    lostRef.current = checkMembership;
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
      if ((s.kind === 'unavailable' || s.kind === 'switchAccount' || s.kind === 'removed') && s.user.id === user.id) return;
      void establish(user);
    };
    const unsub = backend.auth.onUserChange(onUser);
    void (async () => {
      // Files whose delete failed earlier (sign-out, removal, account deletion) go first.
      for (const id of await readPendingWipes(backend)) {
        try {
          await backend.local.wipe(id, null);
          const rest = (await readPendingWipes(backend)).filter((x) => x !== id);
          await backend.kv.setItem(KV_KEYS.pendingWipes, JSON.stringify(rest)).catch(() => undefined);
        } catch (err) {
          console.warn('Goedboodschap: local data could not be deleted', err);
        }
      }
      if (!alive) return;
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

  // Stop the engine and any membership retry on unmount.
  useEffect(
    () => () => {
      generation.current++;
      clearRetry();
      void stopEngine();
    },
    [stopEngine, clearRetry],
  );

  const refreshHousehold = useCallback(async () => {
    const s = stateRef.current;
    if (s.kind !== 'ready') return;
    const mine = await backend.households.getMyHousehold();
    const now = stateRef.current;
    if (now.kind !== 'ready' || now.engine !== s.engine) return;
    if (!mine.ok && !lostEngines.current.has(s.engine)) return; // unknown, nothing lost: next foreground
    await lostRef.current(s.user, s.household.name, mine);
  }, [backend]);

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
      if (signingOut.current) return { ok: false, error: 'pending', pending: 0 };
      if (!force && s.kind === 'ready' && s.engine.unsent().count > 0) {
        // Something is unsent: one short, bounded attempt to deliver it (never a blocking pull when
        // nothing is pending), then ask about what is still unsent or failed (both are deleted).
        signingOut.current = true;
        try {
          if (backend.connectivity.isOnline()) await Promise.race([s.engine.syncNow(), delay(3_000)]);
        } finally {
          signingOut.current = false;
        }
        const pending = s.engine.unsent().count;
        if (pending > 0) return { ok: false, error: 'pending', pending };
      }
      if (!force && s.kind === 'unavailable') {
        // E.g. the file could not be opened: it can still hold offline edits.
        const pending = await backend.local.countUnsent(s.user.id).catch(() => 0);
        if (pending > 0) return { ok: false, error: 'pending', pending };
      }
      generation.current++;
      if (s.kind !== 'booting' && s.kind !== 'signedOut') {
        await wipe(s.user.id);
        await backend.kv.removeItem(KV_KEYS.lastUserId).catch(() => undefined);
      }
      await setPendingInvite(null); // a code saved by this user is not offered to the next account
      setState({ kind: 'signedOut' });
      await backend.auth.signOut();
      return { ok: true };
    },
    [backend, setState, wipe, setPendingInvite],
  );

  const leaveHousehold = useCallback(
    async (force = false): Promise<ActionResult> => {
      const s = stateRef.current;
      if (s.kind !== 'ready') return { ok: false, error: 'not_member' };
      if (!backend.connectivity.isOnline()) return { ok: false, error: 'offline' };
      if (!force) {
        await s.engine.syncNow();
        const pending = s.engine.unsent().count;
        if (pending > 0) return { ok: false, error: 'pending', pending };
      }
      transitioning.current = true;
      try {
        const r = await backend.households.leaveHousehold(s.household.id);
        if (!r.ok && r.error !== 'not_member') return { ok: false, error: r.error };
        generation.current++;
        await wipe(s.user.id);
      } finally {
        transitioning.current = false;
      }
      await establish(s.user, { skipAccountCheck: true });
      return { ok: true };
    },
    [backend, establish, wipe],
  );

  const deleteAccount = useCallback(async (): Promise<ActionResult> => {
    const s = stateRef.current;
    if (s.kind !== 'ready' && s.kind !== 'removed' && s.kind !== 'unavailable') return { ok: false, error: 'not_authenticated' };
    if (!backend.connectivity.isOnline()) return { ok: false, error: 'offline' };
    transitioning.current = true;
    try {
      const r = await backend.households.deleteAccount();
      if (!r.ok) return { ok: false, error: r.error };
      generation.current++;
      await wipe(s.user.id);
    } finally {
      transitioning.current = false;
    }
    await backend.kv.removeItem(KV_KEYS.lastUserId).catch(() => undefined);
    await setPendingInvite(null);
    setState({ kind: 'signedOut' });
    await backend.auth.signOut();
    return { ok: true };
  }, [backend, setState, wipe, setPendingInvite]);

  const acceptInvite = useCallback(
    async (code: string, force = false): Promise<ActionResult> => {
      const s = stateRef.current;
      if (s.kind !== 'ready') return { ok: false, error: 'not_authenticated' };
      if (!backend.connectivity.isOnline()) return { ok: false, error: 'offline' };
      // Online-only flow: drain the outbox first (syncNow also retries rows that wait for a backoff),
      // so nothing is left behind in the old household. What still cannot be sent needs a confirmation.
      await s.engine.syncNow();
      const pending = s.engine.unsent().count;
      if (pending > 0 && !force) return { ok: false, error: 'pending', pending };
      transitioning.current = true;
      try {
        const r = await backend.households.acceptInvite(code);
        if (!r.ok) return { ok: false, error: r.error };
        generation.current++;
        await wipe(s.user.id);
      } finally {
        transitioning.current = false;
      }
      await setPendingInvite(null);
      await establish(s.user, { skipAccountCheck: true });
      return { ok: true };
    },
    [backend, establish, setPendingInvite, wipe],
  );

  const continueAfterRemoval = useCallback(async () => {
    const s = stateRef.current;
    if (s.kind !== 'removed') return;
    await backend.kv.removeItem(removedKey(s.user.id)).catch(() => undefined);
    await establish(s.user, { skipAccountCheck: true });
  }, [backend, establish]);

  const confirmSwitchAccount = useCallback(async () => {
    const s = stateRef.current;
    if (s.kind !== 'switchAccount') return;
    await wipeUser(s.previousUserId, null);
    await establish(s.user, { skipAccountCheck: true });
  }, [establish, wipeUser]);

  const cancelSwitchAccount = useCallback(async () => {
    generation.current++;
    // The invite code stays: it was opened by the person at this phone, who now signs in again.
    setState({ kind: 'signedOut' });
    await backend.auth.signOut();
  }, [backend, setState]);

  const retry = useCallback(async () => {
    const s = stateRef.current;
    if (s.kind === 'unavailable') await establish(s.user, { skipAccountCheck: true });
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
