/**
 * Regression tests for the round-1 review findings in the session layer, on top of the real sync
 * engine (better-sqlite3 files + FakeTransport to the demo world's server).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { KV_KEYS } from '@/src/lib/backend/types';
import { BetterSqliteFactory } from '@/src/sync/node/betterSqlite';

import { clipboard } from '../../__tests__/mocks';
import { flush, makeBackend, renderApp, signIn } from '../../__tests__/helpers';
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

beforeEach(() => {
  session = null;
  seen.length = 0;
  clipboard.text = null;
});

describe('removal found by the session layer (foreground check), not by the engine', () => {
  it('counts AND copies the unsent changes before the file is wiped', async () => {
    const { backend, factory, transports } = realBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const hh = backend.world.server.createHousehold(sanne.id, 'Thuis');
    backend.world.join(sanne.id, hh, 'owner');
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    // The phone thinks it is online, but requests do not get through (e.g. a captive portal).
    transports.get(jan.id)!.online = false;
    await add('melk');
    await add('brood');
    backend.world.leave(jan.id);
    await act(async () => session!.refreshHousehold());
    expect(await screen.findByText('Je bent geen lid meer van Thuis')).toBeTruthy();
    expect(screen.getByText('2 wijzigingen konden niet worden opgeslagen')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Kopieer als tekst')));
    expect(clipboard.text).toContain('Melk');
    expect(clipboard.text).toContain('Brood');
    expect(factory.exists(jan.id)).toBe(false);
  });
});

describe('leaving while a request is in flight', () => {
  it('a not_member answer during leave does not show "Je bent geen lid meer"', async () => {
    const { backend, transports } = realBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const hh = backend.world.server.createHousehold(sanne.id, 'Thuis');
    backend.world.join(sanne.id, hh, 'owner');
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    // A slow network after the leave: the new household takes a moment to set up.
    const create = backend.households.createHousehold;
    backend.households.createHousehold = async (name) => {
      await new Promise((r) => setTimeout(r, 50));
      return create(name);
    };
    const t = transports.get(jan.id)!;
    t.hold(); // the next request (a periodic pull) stays on the wire during the leave
    const engine = session!.state.kind === 'ready' ? session!.state.engine : null;
    void engine!.syncNow();
    await flush(5);
    // Not one big act(): every intermediate session state must get a chance to render.
    const leave = session!.leaveHousehold(true);
    await flush(5);
    t.release();
    for (let i = 0; i < 10; i++) await flush(20);
    await act(async () => {
      await leave;
    });
    await flush(100);
    expect(session!.state.kind).toBe('ready');
    expect(seen).not.toContain('removed'); // not even for a moment
    expect(screen.queryByText('Je bent geen lid meer van Thuis')).toBeNull();
    expect(backend.world.memberships.get(jan.id)!.householdId).not.toBe(hh);
  });
});

describe('sign-out when the local file cannot be deleted', () => {
  it('still signs out, remembers the file and deletes it at the next start', async () => {
    const factory = new BetterSqliteFactory(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-session-')));
    const { backend } = realBackend({ factory });
    const jan = await signIn(backend);
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await add('melk');
    const destroy = factory.destroy.bind(factory);
    factory.destroy = async () => {
      throw new Error('EBUSY: file is locked');
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => {
      await session!.signOut(true);
    });
    expect(session!.state.kind).toBe('signedOut');
    expect(factory.exists(jan.id)).toBe(true);
    expect(JSON.parse((await backend.kv.getItem(KV_KEYS.pendingWipes))!)).toEqual([jan.id]);

    factory.destroy = destroy; // next start: the delete works again
    await renderApp(<App />, backend);
    await waitFor(() => expect(factory.exists(jan.id)).toBe(false));
    await waitFor(async () => expect(JSON.parse((await backend.kv.getItem(KV_KEYS.pendingWipes)) ?? '[]')).toEqual([]));
    warn.mockRestore();
  });
});

describe('pending invite code and sign-out', () => {
  it('a saved code is not offered to the next account', async () => {
    const backend = makeBackend();
    await signIn(backend);
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => session!.setPendingInvite('K7QM4Z'));
    await act(async () => {
      await session!.signOut(true);
    });
    expect(session!.pendingInvite).toBeNull();
    expect(await backend.kv.getItem(KV_KEYS.pendingInviteCode)).toBeNull();
  });
});

describe('household role while get_my_household fails', () => {
  it('a member is never shown as owner and the guess is not cached', async () => {
    const backend = makeBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const hh = backend.world.server.createHousehold(sanne.id, 'Thuis');
    backend.world.join(sanne.id, hh, 'owner');
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    backend.households.getMyHousehold = async () => ({ ok: false, error: 'network' });
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    expect(session!.state.kind === 'ready' && session!.state.household.role).toBe('member');
    expect(await backend.kv.getItem(`${KV_KEYS.householdCache}_${jan.id}`)).toBeNull();
  });
});

describe('why there is no list (D-01 and "every error is Geen internet")', () => {
  it('a database that cannot be opened is not "Geen internet"', async () => {
    const backend = makeBackend();
    backend.local.openEngine = async () => {
      throw new Error('cannot create file');
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await signIn(backend);
    await renderApp(<App />, backend);
    expect(await screen.findByText('Je lijst kon niet worden geopend')).toBeTruthy();
    expect(screen.queryByText('Geen internet')).toBeNull();
    warn.mockRestore();
  });

  it('a server error while creating the household is not "Geen internet"', async () => {
    const backend = makeBackend();
    backend.households.createHousehold = async () => ({ ok: false, error: 'server' });
    await signIn(backend);
    await renderApp(<App />, backend);
    expect(await screen.findByText('Er ging iets mis')).toBeTruthy();
    expect(screen.queryByText('Geen internet')).toBeNull();
  });

  it('a real network failure still says "Geen internet"', async () => {
    const backend = makeBackend();
    await signIn(backend);
    backend.connectivity.set(false);
    await renderApp(<App />, backend);
    expect(await screen.findByText('Geen internet')).toBeTruthy();
  });
});
