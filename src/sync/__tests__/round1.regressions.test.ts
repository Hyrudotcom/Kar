/**
 * Regression tests for the round-1 review findings in the sync engine (one test per defect).
 */
import { TransientSyncError } from '@/src/contracts';

import { FakeServer } from '../testing/fakeServer';
import { household, makeDevice, outboxRows, twoDevices, uuid } from './harness';

async function soloDevice() {
  const server = new FakeServer();
  const user = uuid();
  const hh = household(server, user);
  const dev = await makeDevice(server, { userId: user, householdId: hh });
  return { server, hh, dev };
}

const openOnServer = (server: FakeServer, hh: string) =>
  server
    .list(hh)
    .filter((i) => !i.checked)
    .map((i) => `${i.name}:${i.quantity}`)
    .sort();

describe('undo of an add whose response was lost', () => {
  test('the server keeps nothing and the item does not come back', async () => {
    const { server, hh, dev } = await soloDevice();
    dev.transport.loseNextResponses(1);
    const r = await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual(['Melk:1']); // committed, but the device never heard back
    expect((await outboxRows(dev))[0]).toMatchObject({ kind: 'add_item', state: 'pending', attempts: 1 });

    await dev.engine.undo(r.undo);
    expect(dev.names()).toEqual([]);
    await dev.engine.syncNow();
    await dev.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual([]);
    expect(dev.names()).toEqual([]);
    expect(dev.engine.getStatus()).toMatchObject({ pendingCount: 0, failed: [] });
  });

  test('an add that was never sent is still just dropped locally', async () => {
    const { dev } = await soloDevice();
    dev.goOffline();
    const r = await dev.engine.addItem({ name: 'Kaas', quantity: 1, unit: 'stuk' });
    await dev.engine.undo(r.undo);
    expect(await outboxRows(dev)).toEqual([]);
  });
});

describe('a later add of the same name never overtakes a held-back delete or rename', () => {
  test('delete in backoff, then add "Melk 3": the new Melk survives', async () => {
    const { server, hh, dev } = await soloDevice();
    const melk = await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    await dev.engine.deleteItem(melk.itemId);
    server.retryIds.add((await outboxRows(dev))[0]!.id);
    await dev.engine.syncNow(); // delete answered 'retry' -> per-row backoff
    await dev.engine.addItem({ name: 'Melk', quantity: 3, unit: 'stuk' });
    await dev.clock.advance(200); // debounced push: the add must wait for the delete
    await dev.engine.whenIdle();
    expect(openOnServer(server, hh)).toEqual(['Melk:1']);
    server.retryIds.clear();
    await dev.clock.advance(70_000);
    await dev.engine.whenIdle();
    await dev.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual(['Melk:3']);
    expect(dev.names()).toEqual(['Melk:3']);
  });

  test('rename in backoff, then add the old name: the quantity lands on the new item', async () => {
    const { server, hh, dev } = await soloDevice();
    const melk = await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    await dev.engine.updateItem(melk.itemId, { name: 'Kaas' });
    server.retryIds.add((await outboxRows(dev))[0]!.id);
    await dev.engine.syncNow();
    await dev.engine.addItem({ name: 'Melk', quantity: 3, unit: 'stuk' });
    await dev.clock.advance(200);
    await dev.engine.whenIdle();
    server.retryIds.clear();
    await dev.clock.advance(70_000);
    await dev.engine.whenIdle();
    await dev.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual(['Kaas:1', 'Melk:3']);
    expect(dev.names().sort()).toEqual(['Kaas:1', 'Melk:3']);
  });

  test('in one batch: the server applies nothing after a retry', async () => {
    const { server, hh, dev } = await soloDevice();
    const melk = await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    dev.goOffline();
    await dev.engine.deleteItem(melk.itemId);
    await dev.engine.addItem({ name: 'Melk', quantity: 3, unit: 'stuk' });
    server.retryIds.add((await outboxRows(dev))[0]!.id);
    dev.goOnline();
    await dev.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual(['Melk:1']);
    server.retryIds.clear();
    await dev.clock.advance(70_000);
    await dev.engine.whenIdle();
    await dev.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual(['Melk:3']);
  });
});

describe('paged pull keeps acked edits until the last page', () => {
  test('a failed second page does not revert my acked note', async () => {
    const { anna, bram } = await twoDevices({ pullPageSize: 2 });
    const melk = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    await anna.engine.updateItem(melk.itemId, { note: 'halfvol' });

    const pull = anna.transport.pullChanges.bind(anna.transport);
    let calls = 0;
    anna.transport.pullChanges = async (...args) => {
      calls++;
      if (calls === 1) {
        // Between anna's push and her pull, bram adds two items and edits Melk again.
        await bram.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
        await bram.engine.addItem({ name: 'Kaas', quantity: 1, unit: 'stuk' });
        await bram.engine.incrementQuantity(melk.itemId, 1);
        await bram.engine.syncNow();
      }
      if (calls === 2) throw new TransientSyncError('page 2 lost');
      return pull(...args);
    };
    const notes: string[] = [];
    anna.engine.subscribe((s) => notes.push(s.open.find((i) => i.id === melk.itemId)?.note ?? '?'));
    await anna.engine.syncNow();
    expect(calls).toBe(2);
    expect(anna.engine.getSnapshot().open.find((i) => i.id === melk.itemId)?.note).toBe('halfvol');
    expect(notes.every((n) => n === 'halfvol')).toBe(true);
    anna.transport.pullChanges = pull;
    await anna.engine.syncNow();
    expect(anna.engine.getSnapshot().open.find((i) => i.id === melk.itemId)).toMatchObject({ note: 'halfvol', quantity: 2 });
  });
});

describe('wall clock set back after a transport failure', () => {
  test('sync resumes within the maximum backoff instead of after the jump', async () => {
    const { server, hh, dev } = await soloDevice();
    dev.transport.failNext(1);
    await dev.engine.addItem({ name: 'Zout', quantity: 1, unit: 'stuk' });
    await dev.clock.advance(200); // push fails -> global backoff
    await dev.engine.whenIdle();
    expect(server.list(hh)).toHaveLength(0);
    dev.clock.shiftWall(-3_600_000); // user sets the phone back one hour
    await dev.clock.advance(120_000);
    await dev.engine.whenIdle();
    expect(openOnServer(server, hh)).toEqual(['Zout:1']);
    expect(dev.engine.getStatus().pendingCount).toBe(0);
  });
});

describe('membership loss while stopping', () => {
  test('a not_member answer of a request in flight during stop() does not start the removal flow', async () => {
    const { server, hh, dev } = await soloDevice();
    const other = uuid();
    server.addMember(hh, other);
    const lost = jest.fn();
    dev.engine.onMembershipLost(lost);
    await dev.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    dev.transport.hold();
    const sync = dev.engine.syncNow();
    await new Promise((r) => setImmediate(r));
    server.removeMember(hh, dev.userId); // e.g. accept_invite / leave already went through
    const stopped = dev.engine.stop();
    dev.transport.release();
    await stopped;
    await sync;
    expect(lost).not.toHaveBeenCalled();
  });
});

describe('unsent() and resolveId()', () => {
  test('unsent() lists pending rows too, not only failed ones', async () => {
    const { dev } = await soloDevice();
    dev.goOffline();
    await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await dev.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    expect(dev.engine.failedAsText()).toBe('');
    const u = dev.engine.unsent();
    expect(u.count).toBe(2);
    expect(u.text).toContain('Melk');
    expect(u.text).toContain('Brood');
  });

  test('resolveId follows the server alias of a merged add', async () => {
    const { anna, bram } = await twoDevices();
    anna.goOffline();
    const b = await bram.engine.addItem({ name: 'Rijst', quantity: 1, unit: 'kg' });
    await bram.engine.syncNow();
    const a = await anna.engine.addItem({ name: 'Rijst', quantity: 1, unit: 'kg' });
    expect(anna.engine.resolveId(a.itemId)).toBe(a.itemId);
    anna.goOnline();
    await anna.engine.syncNow();
    expect(anna.engine.resolveId(a.itemId)).toBe(b.itemId);
  });
});
