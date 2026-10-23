/**
 * Regression tests for the round-3 review findings in the session layer, on top of the real sync
 * engine (better-sqlite3 files + FakeTransport to the demo world's server).
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { KV_KEYS } from '@/src/lib/backend/types';

import { flush, renderApp, signIn } from '../../__tests__/helpers';
import { realBackend } from '../../__tests__/realBackend';
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
    seen.push(s.state.kind === 'ready' ? `ready:${s.state.household.name}` : s.state.kind);
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

function setupShared() {
  const { backend, factory } = realBackend();
  const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
  const hh = backend.world.server.createHousehold(sanne.id, 'Bij Sanne');
  backend.world.join(sanne.id, hh, 'owner');
  return { backend, factory, hh };
}

const allNames = (backend: ReturnType<typeof realBackend>['backend']) =>
  [...backend.world.server.items.values()].filter((i) => !i.deleted_at).map((i) => `${i.household_id}:${i.name}`);

beforeEach(() => {
  session = null;
  seen.length = 0;
});

describe('removed while the app was closed', () => {
  it('shows "Je bent geen lid meer" on the next start; offline edits never go into a new household', async () => {
    const { backend, factory, hh } = setupShared();
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    const first = await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => backend.connectivity.set(false));
    await add('melk');
    await act(async () => first.unmount());
    await flush(20);

    backend.world.leave(jan.id); // Sanne removes Jan
    await act(async () => backend.connectivity.set(true));
    seen.length = 0;
    const second = await renderApp(<App />, backend);
    expect(await screen.findByText('Je bent geen lid meer van Bij Sanne')).toBeTruthy();
    expect(screen.getByText('1 wijziging kon niet worden opgeslagen')).toBeTruthy();
    expect(seen).not.toContain('ready:Thuis');
    expect(backend.world.memberships.get(jan.id)).toBeUndefined(); // no household was created
    expect(allNames(backend).filter((n) => n.endsWith(':Melk'))).toEqual([]);
    expect(factory.exists(jan.id)).toBe(false);

    // The notice survives the app being closed before "Kopieer als tekst" / "Doorgaan".
    await act(async () => second.unmount());
    await renderApp(<App />, backend);
    expect(await screen.findByText('Je bent geen lid meer van Bij Sanne')).toBeTruthy();
    expect(screen.getByText('1 wijziging kon niet worden opgeslagen')).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByLabelText('Doorgaan')));
    await screen.findByTestId('quick-add');
    expect(session!.state.kind === 'ready' && session!.state.household.name).toBe('Thuis');
    expect(backend.world.server.list(backend.world.memberships.get(jan.id)!.householdId)).toEqual([]);
  });
});

describe('membership check fails while online', () => {
  it('keeps every edit in the outbox and retries the check on a timer', async () => {
    const { backend, hh } = setupShared();
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    const realGet = backend.households.getMyHousehold;
    let failures = 1;
    backend.households.getMyHousehold = async () => (failures-- > 0 ? { ok: false, error: 'server' } : realGet());

    backend.world.leave(jan.id);
    await add('melk'); // not_member -> the check fails once
    await flush(50);
    expect(session!.state.kind).toBe('ready');
    await add('kaas');
    await add('brood');
    // Not thrown away: on the list and in the outbox, the input is cleared because they were stored.
    expect(screen.getByLabelText('Kaas. Niet afgevinkt.')).toBeTruthy();
    expect(screen.getByLabelText('Brood. Niet afgevinkt.')).toBeTruthy();
    if (session!.state.kind !== 'ready') throw new Error('not ready');
    expect(session!.state.engine.unsent().count).toBe(3);

    // No connectivity change happens: the timer retries the check by itself.
    expect(await screen.findByText('Je bent geen lid meer van Bij Sanne', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText('3 wijzigingen konden niet worden opgeslagen')).toBeTruthy();
  });

  it('a still-member answer reopens an engine that got not_member (refresh on foreground)', async () => {
    const { backend, hh } = setupShared();
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    if (session!.state.kind !== 'ready') throw new Error('not ready');
    const first = session!.state.engine;
    // A not_member that raced a re-join: removed and added back before the check runs.
    backend.world.leave(jan.id);
    const realGet = backend.households.getMyHousehold;
    backend.households.getMyHousehold = async () => {
      if (!backend.world.memberships.get(jan.id)) backend.world.join(jan.id, hh, 'member');
      return realGet();
    };
    await add('melk');
    await waitFor(() => expect(session!.state.kind === 'ready' && session!.state.engine).not.toBe(first));
    await waitFor(() => expect(backend.world.server.list(hh).map((i) => i.name)).toEqual(['Melk']));
  });
});

describe('sign-out', () => {
  it('signs out at once when nothing is pending (no blocking sync)', async () => {
    const { backend } = realBackend();
    await signIn(backend);
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    if (session!.state.kind !== 'ready') throw new Error('not ready');
    const sync = jest.spyOn(session!.state.engine, 'syncNow');
    let r: Awaited<ReturnType<Session['signOut']>> | null = null;
    await act(async () => {
      r = await session!.signOut();
    });
    expect(r).toEqual({ ok: true });
    expect(sync).not.toHaveBeenCalled();
  });

  it('an undo snackbar of the previous account does not survive sign-out', async () => {
    const { backend } = realBackend();
    await signIn(backend);
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await add('melk');
    await add('melk');
    expect(screen.getByText('Melk +1')).toBeTruthy();
    await act(async () => void (await session!.signOut()));
    await flush();
    expect(screen.queryByText('Melk +1')).toBeNull();
  });
});

describe('account-switch warning', () => {
  it('"Terug naar inloggen" keeps the invite code the person just opened', async () => {
    const { backend } = realBackend();
    const jan = await signIn(backend);
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => backend.connectivity.set(false));
    await add('melk');
    await act(async () => void (await backend.auth.signOut()));
    await flush();
    await act(async () => session!.setPendingInvite('K7QM4Z'));
    await act(async () => backend.connectivity.set(true));
    await act(async () => void (await backend.auth.verifyEmailCode('sanne@voorbeeld.nl', '123456')));
    await waitFor(() => expect(session!.state.kind).toBe('switchAccount'));
    await act(async () => session!.cancelSwitchAccount());
    expect(session!.pendingInvite).toBe('K7QM4Z');
    expect(await backend.kv.getItem(KV_KEYS.pendingInviteCode)).toBe('K7QM4Z');
    void jan;
  });
});
