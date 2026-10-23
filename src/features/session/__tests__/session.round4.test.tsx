/**
 * Regression tests for the round-4 review findings in the session layer.
 */
import { createClient } from '@supabase/supabase-js';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { createAuth } from '@/src/lib/backend/supabaseApis';
import type { Backend } from '@/src/lib/backend/types';

import { flush, renderApp, signIn } from '../../__tests__/helpers';
import { realBackend } from '../../__tests__/realBackend';
import { ListScreen } from '../../list/ListScreen';
import { RemovedScreen } from '../GateScreens';
import { useSession, type Session } from '../SessionProvider';

jest.mock('react-native-safe-area-context', () => require('../../__tests__/mocks').safeAreaMock());
jest.mock('expo-router', () => ({ useRouter: () => require('../../__tests__/helpers').mockRouter }));
jest.mock('expo-clipboard', () => require('../../__tests__/mocks').clipboardMock());

let session: Session | null = null;
const seen: string[] = [];
function App() {
  const s = useSession();
  useEffect(() => {
    session = s;
    seen.push(s.state.kind === 'ready' ? `ready:${s.state.household.name}` : s.state.kind);
  });
  if (s.state.kind === 'ready') return <ListScreen />;
  if (s.state.kind === 'removed') return <RemovedScreen />;
  if (s.state.kind === 'signedOut') return null;
  return null;
}

async function add(text: string) {
  const input = screen.getByTestId('quick-add');
  await act(async () => fireEvent.changeText(input, text));
  await act(async () => fireEvent(input, 'submitEditing'));
  await flush(20);
}

beforeEach(() => {
  session = null;
  seen.length = 0;
});

/** A real supabase-js client whose stored session expired 10 minutes ago, with no network at all. */
function offlineSupabaseWithExpiredSession(user: { id: string; email: string | null }) {
  const store = new Map<string, string>();
  const storageKey = 'sb-test-auth-token';
  const now = Math.floor(Date.now() / 1000);
  store.set(
    storageKey,
    JSON.stringify({
      access_token: 'expired.jwt.token',
      refresh_token: 'refresh-123',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: now - 600,
      user: { id: user.id, email: user.email, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
    }),
  );
  const sb = createClient('http://127.0.0.1:1', 'anon-key', {
    auth: {
      storageKey,
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: {
      fetch: () => Promise.reject(new TypeError('Network request failed')),
    },
  });
  return { sb, store, storageKey };
}

describe('cold start offline with an expired access token', () => {
  it('opens the cached list (not "Inloggen") and keeps the stored session', async () => {
    const { backend } = realBackend();
    const jan = await signIn(backend);
    const first = await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await add('melk');
    await act(async () => backend.connectivity.set(false));
    await add('brood');
    await act(async () => first.unmount());
    await flush(20);

    const { sb, store, storageKey } = offlineSupabaseWithExpiredSession(jan);
    const offline: Backend = { ...backend, auth: createAuth(sb) };
    seen.length = 0;
    await renderApp(<App />, offline as typeof backend);
    await waitFor(() => expect(session?.state.kind).toBe('ready'));
    expect(screen.getByTestId('row-Melk')).toBeTruthy();
    expect(screen.getByTestId('row-Brood')).toBeTruthy();
    await flush(50);
    expect(seen).not.toContain('signedOut');
    expect(session?.state.kind).toBe('ready');
    expect(store.has(storageKey)).toBe(true);
  });

  it('INITIAL_SESSION after an offline refresh failure reports the stored user, not a sign-out', async () => {
    jest.useFakeTimers();
    try {
      const { sb } = offlineSupabaseWithExpiredSession({ id: 'u1', email: 'a@b.nl' });
      const got: (string | null)[] = [];
      const unsub = createAuth(sb).onUserChange((u) => got.push(u?.id ?? null));
      await jest.advanceTimersByTimeAsync(60_000);
      expect(got).toEqual(['u1']);
      unsub();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a session rejected by the server (no session left in storage) still signs out', async () => {
    const { sb, store, storageKey } = offlineSupabaseWithExpiredSession({ id: 'u1', email: 'a@b.nl' });
    store.delete(storageKey);
    const auth = createAuth(sb);
    expect(await auth.getUser()).toBeNull();
  });
});

describe('removed on another phone, then a new household there', () => {
  it('shows "Je bent geen lid meer" and never posts the offline edits into the new household', async () => {
    const { backend } = realBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const shared = backend.world.server.createHousehold(sanne.id, 'Familie');
    backend.world.join(sanne.id, shared, 'owner');
    const jan = await signIn(backend);
    backend.world.join(jan.id, shared, 'member');

    const first = await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => backend.connectivity.set(false));
    await add('zwangerschapstest');
    await act(async () => first.unmount());
    await flush(20);

    // Sanne removes Jan; on his other phone Jan taps "Doorgaan" and gets a new private household.
    backend.world.leave(jan.id);
    const thuis = backend.world.server.createHousehold(jan.id, 'Thuis');
    backend.world.join(jan.id, thuis, 'owner');

    await act(async () => backend.connectivity.set(true));
    seen.length = 0;
    await renderApp(<App />, backend);
    expect(await screen.findByText('Je bent geen lid meer van Familie')).toBeTruthy();
    expect(screen.getByText('1 wijziging kon niet worden opgeslagen')).toBeTruthy();
    const names = [...backend.world.server.items.values()].filter((i) => !i.deleted_at).map((i) => i.name);
    expect(names).not.toContain('Zwangerschapstest');
    await act(async () => {
      await session!.continueAfterRemoval();
    });
    await waitFor(() => expect(session?.state.kind).toBe('ready'));
    expect(session?.state.kind === 'ready' && session.state.household.id).toBe(thuis);
  });
});

describe('left or removed from a shared household that stays alive, then joined another one', () => {
  it('the offline edits never reach the new household\'s members', async () => {
    const { backend } = realBackend();
    const piet = backend.world.userByEmail('piet@voorbeeld.nl');
    const studenten = backend.world.server.createHousehold(piet.id, 'Studentenhuis');
    backend.world.join(piet.id, studenten, 'owner');
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const bijSanne = backend.world.server.createHousehold(sanne.id, 'Bij Sanne');
    backend.world.join(sanne.id, bijSanne, 'owner');
    const jan = await signIn(backend);
    backend.world.join(jan.id, studenten, 'member');

    const first = await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => backend.connectivity.set(false));
    await add('zwangerschapstest');
    await act(async () => first.unmount());
    await flush(20);

    backend.world.leave(jan.id);
    backend.world.join(jan.id, bijSanne, 'member');
    await act(async () => backend.connectivity.set(true));
    seen.length = 0;
    await renderApp(<App />, backend);
    expect(await screen.findByText('Je bent geen lid meer van Studentenhuis')).toBeTruthy();
    await flush(50);
    expect(backend.world.server.list(bijSanne).map((i) => i.name)).toEqual([]);
    expect(backend.world.server.list(studenten).map((i) => i.name)).toEqual([]);
    expect(seen).not.toContain('ready:Bij Sanne');
  });
});

describe('session ended without our sign-out (e.g. account deleted on another phone)', () => {
  it('deletes the local list when nothing is unsent', async () => {
    const { backend, factory } = realBackend();
    const jan = await signIn(backend);
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await add('melk');
    await waitFor(() => expect(session?.state.kind === 'ready' && session.state.engine.unsent().count).toBe(0));
    expect(factory.exists(jan.id)).toBe(true);
    await act(async () => backend.auth.signOut()); // refresh token rejected: auth reports no user
    await flush(50);
    expect(session?.state.kind).toBe('signedOut');
    expect(factory.exists(jan.id)).toBe(false);
    expect(await backend.kv.getItem('last_user_id')).toBeNull();
  });

  it('keeps the file while it holds unsent changes (resent when the same user signs in again)', async () => {
    const { backend, factory } = realBackend();
    const jan = await signIn(backend);
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => backend.connectivity.set(false));
    await add('melk');
    await act(async () => backend.auth.signOut());
    await flush(50);
    expect(session?.state.kind).toBe('signedOut');
    expect(factory.exists(jan.id)).toBe(true);
  });
});

describe('"Lid worden" whose answer was lost', () => {
  it('ends in the new household with "Je bent lid van …", not on "Geen internet" or "Je bent al lid van <old>"', async () => {
    const { backend } = realBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const target = backend.world.server.createHousehold(sanne.id, 'Familie');
    backend.world.join(sanne.id, target, 'owner');
    backend.world.currentUser = sanne;
    const inv = await backend.households.createInvite(target);
    if (!inv.ok) throw new Error('invite');
    backend.world.currentUser = null;
    await signIn(backend);
    const accept = backend.households.acceptInvite;
    backend.households.acceptInvite = async (code) => {
      await accept(code); // committed on the server, the answer never arrives
      return { ok: false, error: 'network' };
    };
    const jan = backend.world.currentUser!;
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    // Jan's household is shared: joining Familie leaves it (no merge the other paths could follow).
    const piet = backend.world.userByEmail('piet@voorbeeld.nl');
    backend.world.join(piet.id, backend.world.memberships.get(jan.id)!.householdId, 'member');
    await act(async () => session!.setPendingInvite(inv.code));
    await flush();
    await act(async () => fireEvent.press(await screen.findByLabelText('Lid worden')));
    await flush(50);
    await waitFor(() => expect(session?.state.kind === 'ready' && session.state.household.name).toBe('Familie'));
    expect(screen.getByText('Je bent lid van Familie')).toBeTruthy();
    expect(screen.queryByText(/Geen internet/)).toBeNull();
    expect(session?.pendingInvite).toBeNull();
  });
});
