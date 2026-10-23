import { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import type { ListSnapshot, SyncStatus } from '@/src/contracts';
import { SyncEngineProvider, useHistory, useItem, useList, useSyncStatus } from '../hooks';
import { FakeServer } from '../testing/fakeServer';
import { household, makeDevice, uuid } from './harness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function setup() {
  const server = new FakeServer();
  const user = uuid();
  const hh = household(server, user);
  return makeDevice(server, { userId: user, householdId: hh });
}

describe('React hooks', () => {
  test('useList / useSyncStatus with no engine return empty defaults', async () => {
    let list: ListSnapshot | undefined;
    let status: SyncStatus | undefined;
    function Probe() {
      list = useList(null);
      status = useSyncStatus(null);
      return null;
    }
    const root = createRoot();
    await act(async () => root.render(createElement(Probe)));
    expect(list).toMatchObject({ loaded: false, open: [], checked: [] });
    expect(status).toMatchObject({ icon: 'idle', pendingCount: 0, needsReauth: false });
    await act(async () => root.unmount());
  });

  test('re-render on list and status changes via the provider', async () => {
    const dev = await setup();
    const renders: { open: string[]; icon: string; pending: number }[] = [];
    function Probe() {
      const l = useList();
      const s = useSyncStatus();
      renders.push({ open: l.open.map((i) => i.name), icon: s.icon, pending: s.pendingCount });
      return null;
    }
    const root = createRoot();
    await act(async () => root.render(createElement(SyncEngineProvider, { engine: dev.engine }, createElement(Probe))));
    expect(renders.at(-1)).toEqual({ open: [], icon: 'idle', pending: 0 });
    dev.goOffline();
    await act(async () => {
      await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    });
    expect(renders.at(-1)).toEqual({ open: ['Melk'], icon: 'offline', pending: 1 });
    await act(async () => {
      dev.goOnline();
      await dev.engine.whenIdle();
      await dev.engine.syncNow();
    });
    expect(renders.at(-1)).toEqual({ open: ['Melk'], icon: 'idle', pending: 0 });
    const count = renders.length;
    await act(async () => {
      await dev.engine.syncNow(); // nothing changes -> no re-render
    });
    expect(renders.length).toBe(count);
    await act(async () => root.unmount());
  });

  test('useItem follows one row and becomes undefined when it is deleted (F12)', async () => {
    const dev = await setup();
    const { itemId } = await dev.engine.addItem({ name: 'Kaas', quantity: 1, unit: 'stuk' });
    let seen: unknown = 'unset';
    function Probe() {
      seen = useItem(itemId, dev.engine)?.name;
      return null;
    }
    const root = createRoot();
    await act(async () => root.render(createElement(Probe)));
    expect(seen).toBe('Kaas');
    await act(async () => {
      await dev.engine.deleteItem(itemId);
    });
    expect(seen).toBeUndefined();
    await act(async () => root.unmount());
  });

  test('useHistory refreshes after adds', async () => {
    const dev = await setup();
    let names: string[] = [];
    function Probe() {
      names = useHistory(dev.engine).map((h) => h.display_name);
      return null;
    }
    const root = createRoot();
    await act(async () => root.render(createElement(Probe)));
    expect(names).toEqual([]);
    await act(async () => {
      await dev.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    });
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
    expect(names).toEqual(['Brood']);
    await act(async () => root.unmount());
  });
});
