/**
 * Regression tests for the round-2 review findings in the session layer and the invite sheet, on top
 * of the real sync engine (better-sqlite3 files + FakeTransport to the demo world's server) where the
 * outbox matters.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { KV_KEYS } from '@/src/lib/backend/types';

import { flush, makeBackend, renderApp, renderReady, signIn } from '../../__tests__/helpers';
import { realBackend } from '../../__tests__/realBackend';
import { HouseholdScreen } from '../../household/HouseholdScreen';
import { ListScreen } from '../../list/ListScreen';
import { RemovedScreen, UnavailableScreen } from '../GateScreens';
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
    seen.push(s.state.kind);
  });
  if (s.state.kind === 'ready') return <ListScreen />;
  if (s.state.kind === 'removed') return <RemovedScreen />;
  if (s.state.kind === 'unavailable') return <UnavailableScreen />;
  return null;
}

async function add(text: string) {
  const input = screen.getByTestId('quick-add');
  await act(async () => fireEvent.changeText(input, text));
  await act(async () => fireEvent(input, 'submitEditing'));
  await flush(20);
}

const openNames = (backend: ReturnType<typeof realBackend>['backend'], hh: string) =>
  backend.world.server
    .list(hh)
    .filter((i) => !i.checked && !i.deleted_at)
    .map((i) => i.name)
    .sort();

beforeEach(() => {
  session = null;
  seen.length = 0;
});

describe('joining a household on my other phone', () => {
  it('is not a removal: this phone follows to the new household and keeps its offline edits', async () => {
    const { backend, factory } = realBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const target = backend.world.server.createHousehold(sanne.id, 'Bij Sanne');
    backend.world.join(sanne.id, target, 'owner');
    const jan = await signIn(backend);
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    const own = backend.world.memberships.get(jan.id)!.householdId;

    // This phone (B) is offline and has queued edits.
    await act(async () => backend.connectivity.set(false));
    await add('melk');
    await add('brood');
    // Phone A accepts Sanne's invite meanwhile (Jan was alone: his household merges into hers).
    backend.world.leave(jan.id);
    backend.world.join(jan.id, target, 'member');
    backend.world.recordMerge(jan.id, own, target);
    await act(async () => backend.connectivity.set(true));

    await waitFor(() => expect(openNames(backend, target)).toEqual(['Brood', 'Melk']));
    expect(seen).not.toContain('removed');
    expect(screen.queryByText(/Je bent geen lid meer/)).toBeNull();
    await waitFor(() => expect(session!.state.kind === 'ready' && session!.state.household.id).toBe(target));
    expect(await screen.findByLabelText('Melk. Niet afgevinkt.')).toBeTruthy();
    expect(factory.exists(jan.id)).toBe(true);
    expect(openNames(backend, own)).toEqual([]);
  });

  it('a real removal (no household any more) still shows "Je bent geen lid meer" with the unsent changes', async () => {
    const { backend, factory } = realBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const hh = backend.world.server.createHousehold(sanne.id, 'Thuis');
    backend.world.join(sanne.id, hh, 'owner');
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => backend.connectivity.set(false));
    await add('wijn');
    await act(async () => {
      backend.world.leave(jan.id);
      backend.connectivity.set(true);
    });
    expect(await screen.findByText('Je bent geen lid meer van Thuis')).toBeTruthy();
    expect(screen.getByText('1 wijziging kon niet worden opgeslagen')).toBeTruthy();
    expect(factory.exists(jan.id)).toBe(false);
  });
});

describe('leave and sign-out try to send first and count failed changes too', () => {
  it('leave: a change still waiting for its push is delivered, no "Toch verlaten" prompt', async () => {
    const { backend } = realBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const hh = backend.world.server.createHousehold(sanne.id, 'Thuis');
    backend.world.join(sanne.id, hh, 'owner');
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    let result: Awaited<ReturnType<Session['leaveHousehold']>> | null = null;
    await act(async () => {
      await session!.state.kind; // keep the reference fresh
      if (session!.state.kind !== 'ready') throw new Error('not ready');
      await session!.state.engine.addItem({ name: 'Kaas', quantity: 1, unit: 'stuk' });
      result = await session!.leaveHousehold(); // within the push debounce
    });
    expect(result).toEqual({ ok: true });
    expect(openNames(backend, hh)).toEqual(['Kaas']);
  });

  it('sign-out: a change the server refused is counted (it would be deleted silently otherwise)', async () => {
    const { backend, transports } = realBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const hh = backend.world.server.createHousehold(sanne.id, 'Thuis');
    backend.world.join(sanne.id, hh, 'owner');
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await add('melk');
    const melk = backend.world.server.list(hh).find((i) => i.name === 'Melk')!;
    // Jan edits offline (requests do not get through) while Sanne deletes Melk.
    transports.get(jan.id)!.online = false;
    if (session!.state.kind !== 'ready') throw new Error('not ready');
    const engine = session!.state.engine;
    await act(async () => void (await engine.updateItem(melk.id, { note: 'halfvol' })));
    backend.world.server.applyMutations(sanne.id, {
      household_id: hh,
      mutations: [{ id: 'f3b0c1d2-0000-4000-8000-000000000001', household_id: hh, kind: 'delete_item', payload: { item_id: melk.id }, client_created_at: new Date().toISOString() }],
    });
    transports.get(jan.id)!.online = true;
    await act(async () => engine.syncNow());
    expect(engine.getStatus()).toMatchObject({ pendingCount: 0 });
    expect(engine.getStatus().failed).toHaveLength(1);
    let r: Awaited<ReturnType<Session['signOut']>> | null = null;
    await act(async () => {
      r = await session!.signOut();
    });
    expect(r).toEqual({ ok: false, error: 'pending', pending: 1 });
    expect(session!.state.kind).toBe('ready');
  });

  it('"Uitloggen" on "Je lijst kon niet worden geopend" asks before deleting unsent changes', async () => {
    const { backend } = realBackend();
    await signIn(backend);
    backend.local.openEngine = async () => {
      throw new Error('database is locked');
    };
    backend.local.countUnsent = async () => 2;
    await renderApp(<App />, backend);
    await screen.findByText('Je lijst kon niet worden geopend');
    await act(async () => fireEvent.press(screen.getByLabelText('Uitloggen')));
    await flush();
    expect(screen.getByText('Je hebt 2 wijzigingen die nog niet verstuurd zijn.')).toBeTruthy();
    expect(backend.world.currentUser).not.toBeNull();
    await act(async () => fireEvent.press(screen.getByLabelText('Toch uitloggen')));
    await flush();
    await waitFor(() => expect(backend.world.currentUser).toBeNull());
  });
});

describe('a failed sign-out wipe queued for this user', () => {
  it('is done when the same user signs in again, so the next start keeps their new offline edits', async () => {
    const { backend, factory } = realBackend();
    const jan = await signIn(backend);
    await backend.kv.setItem(KV_KEYS.pendingWipes, JSON.stringify([jan.id]));
    const first = await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    expect(JSON.parse((await backend.kv.getItem(KV_KEYS.pendingWipes))!)).toEqual([]);
    await act(async () => backend.connectivity.set(false));
    await add('melk');
    await act(async () => first.unmount());
    await flush(20);
    expect(await backend.local.countUnsent(jan.id)).toBe(1);
    // Next cold start: the boot loop must not delete the file with the unsent "Melk".
    seen.length = 0;
    await renderApp(<App />, backend);
    await waitFor(() => expect(seen).toContain('ready'));
    expect(await backend.local.countUnsent(jan.id)).toBe(1);
    expect(factory.exists(jan.id)).toBe(true);
  });
});

describe('invite link opened offline', () => {
  async function setupInvite() {
    const backend = makeBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    backend.world.users.get(sanne.id)!.displayName = 'Sanne';
    const target = backend.world.server.createHousehold(sanne.id, 'Bij Sanne');
    backend.world.join(sanne.id, target, 'owner');
    backend.world.currentUser = sanne;
    const inv = await backend.households.createInvite(target);
    if (!inv.ok) throw new Error('invite');
    backend.world.currentUser = null;
    await signIn(backend);
    return { backend, code: inv.code };
  }

  it('offers "Opnieuw proberen", keeps the code when swiped away, and loads by itself once back online', async () => {
    const { backend, code } = await setupInvite();
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => backend.connectivity.set(false));
    await act(async () => session!.setPendingInvite(code));
    await flush();
    expect(screen.getByText('Geen internet. Lid worden kan alleen online.')).toBeTruthy();
    expect(screen.getByLabelText('Opnieuw proberen')).toBeTruthy();
    // Swiping the transient error away keeps the code.
    await act(async () => fireEvent.press(screen.getByTestId('join-sheet-backdrop', { includeHiddenElements: true })));
    await flush();
    expect(screen.queryByTestId('join-error')).toBeNull();
    expect(await backend.kv.getItem(KV_KEYS.pendingInviteCode)).toBe(code);
    await act(async () => backend.connectivity.set(true));
    await flush();
    expect(await screen.findByText('Word je lid van ‘Bij Sanne’?')).toBeTruthy();
    expect(screen.getByLabelText('Lid worden')).toBeTruthy();
  });

  it('a definitive answer (unknown code) is forgotten when closed', async () => {
    const { backend } = await setupInvite();
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => session!.setPendingInvite('ZZZZZZ'));
    await flush();
    expect(screen.getByText('Deze code bestaat niet. Controleer de code en probeer het opnieuw.')).toBeTruthy();
    expect(screen.queryByLabelText('Opnieuw proberen')).toBeNull();
    await act(async () => fireEvent.press(screen.getByTestId('join-sheet-backdrop', { includeHiddenElements: true })));
    await flush();
    expect(await backend.kv.getItem(KV_KEYS.pendingInviteCode)).toBeNull();
  });
});

describe('Huishouden with an unknown member list', () => {
  it('never says the household is deleted when the members could not be loaded', async () => {
    const backend = makeBackend();
    const jan = await signIn(backend);
    const ensured = await backend.households.createHousehold();
    if (!ensured.ok) throw new Error('hh');
    const sanne = backend.world.addUser('Sanne', 'sanne@voorbeeld.nl');
    backend.world.join(sanne.id, ensured.household.id, 'member');
    // Started from the cached household; get_my_household fails (server error).
    await backend.kv.setItem(`${KV_KEYS.householdCache}_${jan.id}`, JSON.stringify({ id: ensured.household.id, name: 'Thuis', role: 'owner' }));
    backend.households.getMyHousehold = async () => ({ ok: false, error: 'server' });
    await renderReady(<HouseholdScreen />, backend);
    await flush();
    expect(screen.getByTestId('members-unknown')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Huishouden verlaten')));
    expect(screen.getByText('Je ziet deze lijst daarna niet meer.')).toBeTruthy();
    expect(screen.queryByText(/definitief verwijderd/)).toBeNull();
  });
});
