/**
 * The screens on top of the real sync engine (src/sync): better-sqlite3 per-user files and a
 * FakeTransport to the same in-memory server the demo household RPCs use.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { Backend } from '@/src/lib/backend/types';
import { countUnsentChanges, createSyncEngine, wipeLocalData } from '@/src/sync';
import { BetterSqliteFactory } from '@/src/sync/node/betterSqlite';
import { FakeTransport } from '@/src/sync/testing';

import { ListScreen } from '../list/ListScreen';
import { RemovedScreen, SwitchAccountScreen } from '../session/GateScreens';
import { useSession } from '../session/SessionProvider';
import { flush, makeBackend, renderApp, signIn } from './helpers';

jest.mock('react-native-safe-area-context', () => require('./mocks').safeAreaMock());
jest.mock('expo-router', () => ({ useRouter: () => require('./helpers').mockRouter }));

function realBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-mobile-'));
  const factory = new BetterSqliteFactory(dir);
  const transports = new Map<string, FakeTransport>();
  const demo = makeBackend();
  const backend: Backend & { world: typeof demo.world; connectivity: typeof demo.connectivity } = {
    ...demo,
    local: {
      async openEngine(user, householdId) {
        const transport = new FakeTransport(demo.world.server, user.id, { online: demo.connectivity.isOnline() });
        demo.connectivity.subscribe((on) => (transport.online = on));
        transports.set(user.id, transport);
        const engine = createSyncEngine(
          { db: await factory.open(user.id), transport, connectivity: demo.connectivity, userId: user.id, householdId, uuid: randomUUID },
          { pushDebounceMs: 5, nudgeDebounceMs: 5 },
        );
        await engine.start();
        return engine;
      },
      wipe: (userId, engine) => wipeLocalData({ engine, factory, userId }),
      countUnsent: (userId) => countUnsentChanges(factory, userId),
    },
  };
  return { backend, factory, transports };
}

function App() {
  const { state } = useSession();
  if (state.kind === 'ready') return <ListScreen />;
  if (state.kind === 'removed') return <RemovedScreen />;
  if (state.kind === 'switchAccount') return <SwitchAccountScreen />;
  return null;
}

async function add(text: string) {
  const input = screen.getByTestId('quick-add');
  await act(async () => fireEvent.changeText(input, text));
  await act(async () => fireEvent(input, 'submitEditing'));
  await flush(20);
}

describe('with the real sync engine', () => {
  it('keeps offline edits in the persistent outbox and sends them when back online', async () => {
    const { backend, factory } = realBackend();
    const jan = await signIn(backend);
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => backend.connectivity.set(false));
    await add('2 melk');
    expect(screen.getByLabelText('Melk, 2. Niet afgevinkt.')).toBeTruthy();
    expect(await screen.findByLabelText('Offline')).toBeTruthy();
    const hh = backend.world.memberships.get(jan.id)!.householdId;
    expect(backend.world.server.list(hh)).toHaveLength(0);
    await act(async () => backend.connectivity.set(true));
    await waitFor(() => expect(backend.world.server.list(hh).map((i) => [i.name, i.quantity])).toEqual([['Melk', 2]]));
    await waitFor(() => expect(screen.queryByLabelText('Offline')).toBeNull());
    void factory;
  });

  it('removal with unsent changes: "Je bent geen lid meer", count + copy, then a fresh Thuis', async () => {
    const { backend, factory } = realBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const hh = backend.world.server.createHousehold(sanne.id, 'Thuis');
    backend.world.join(sanne.id, hh, 'owner');
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => backend.connectivity.set(false));
    await add('melk');
    await add('brood');
    await act(async () => {
      backend.world.leave(jan.id);
      backend.connectivity.set(true);
    });
    expect(await screen.findByText('Je bent geen lid meer van Thuis')).toBeTruthy();
    expect(screen.getByText('2 wijzigingen konden niet worden opgeslagen')).toBeTruthy();
    expect(screen.getByLabelText('Kopieer als tekst')).toBeTruthy();
    // Local data of that household is wiped.
    expect(factory.exists(jan.id)).toBe(false);
    await act(async () => fireEvent.press(screen.getByLabelText('Doorgaan')));
    await screen.findByText('Je lijst is leeg');
    expect(backend.world.memberships.get(jan.id)!.householdId).not.toBe(hh);
  });

  it('warns before discarding another account\'s unsent changes', async () => {
    const { backend, factory } = realBackend();
    const jan = await signIn(backend);
    const first = await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => backend.connectivity.set(false));
    await add('melk');
    // Session expires offline: the file and its outbox stay on disk.
    await act(async () => backend.auth.signOut());
    first.unmount();
    expect(await countUnsentChanges(factory, jan.id)).toBe(1);
    await act(async () => backend.connectivity.set(true));
    await signIn(backend, 'tim@voorbeeld.nl');
    await renderApp(<App />, backend);
    expect(await screen.findByText('Op deze telefoon staan nog 1 wijziging van een ander account die nog niet verstuurd is. Als je doorgaat, worden ze weggegooid.')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Doorgaan en weggooien')));
    await screen.findByText('Je lijst is leeg');
    expect(factory.exists(jan.id)).toBe(false);
  });
});
