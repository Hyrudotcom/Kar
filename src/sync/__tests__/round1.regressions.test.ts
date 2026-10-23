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

  test('round 2: the server merged the add into another member\'s item -> undo only takes my quantity back', async () => {
    const { server, hh, anna, bram } = await twoDevices();
    await bram.engine.addItem({ name: 'Melk', quantity: 2, unit: 'stuk' });
    await bram.engine.syncNow();
    // Anna has not pulled Bram's Melk: locally her add is a new item, the server merges it.
    anna.transport.loseNextResponses(1);
    const r = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual(['Melk:3']);
    await anna.engine.undo(r.undo);
    await anna.engine.syncNow();
    await anna.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual(['Melk:2']); // Bram's Melk survives
    expect(anna.names()).toEqual(['Melk:2']);
    await bram.engine.syncNow();
    expect(bram.names()).toEqual(['Melk:2']);
    expect(anna.engine.getStatus()).toMatchObject({ pendingCount: 0, failed: [] });
  });

  test('round 2: locally merged, but the server applied it as new (target deleted remotely) -> undo deletes the new item', async () => {
    const { server, hh, anna, bram } = await twoDevices();
    const melk = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    await bram.engine.deleteItem(melk.itemId);
    await bram.engine.syncNow();
    anna.transport.loseNextResponses(1);
    const r = await anna.engine.addItem({ name: 'Melk', quantity: 2, unit: 'stuk' });
    expect(r.outcome).toBe('merged'); // the local guess
    await anna.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual(['Melk:2']);
    await anna.engine.undo(r.undo);
    await anna.engine.syncNow();
    await anna.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual([]);
    expect(anna.names()).toEqual([]);
    expect(anna.engine.getStatus()).toMatchObject({ pendingCount: 0, failed: [] });
  });

  test('round 2: undo while still offline survives a restart and resolves once the answer arrives', async () => {
    const { server, hh, anna, bram } = await twoDevices();
    await bram.engine.addItem({ name: 'Melk', quantity: 2, unit: 'stuk' });
    await bram.engine.syncNow();
    anna.transport.loseNextResponses(1);
    const r = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    anna.goOffline();
    await anna.engine.undo(r.undo);
    expect(anna.names()).toEqual([]); // hidden at once (Bram's Melk was never pulled here)
    await anna.restart();
    anna.goOnline();
    await anna.engine.syncNow();
    await anna.engine.syncNow();
    expect(openOnServer(server, hh)).toEqual(['Melk:2']);
    expect(anna.names()).toEqual(['Melk:2']);
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

describe('round 2: acked edits are not replayed onto a pulled row that already contains them', () => {
  async function cutPull(anna: Awaited<ReturnType<typeof twoDevices>>['anna'], between: () => Promise<void>) {
    const pull = anna.transport.pullChanges.bind(anna.transport);
    let calls = 0;
    anna.transport.pullChanges = async (...args) => {
      calls++;
      if (calls === 1) await between();
      if (calls === 2) throw new TransientSyncError('page 2 lost');
      return pull(...args);
    };
    await anna.engine.syncNow();
    expect(calls).toBe(2);
    return pull;
  }

  test('increment: page 1 already has my +1 -> 2, not 3 (also after a restart)', async () => {
    const { server, hh, anna, bram } = await twoDevices({ pullPageSize: 2 });
    const melk = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    await anna.engine.incrementQuantity(melk.itemId, 1);
    await cutPull(anna, async () => {
      await bram.engine.updateItem(melk.itemId, { note: 'halfvol' });
      await bram.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
      await bram.engine.addItem({ name: 'Kaas', quantity: 1, unit: 'stuk' });
      await bram.engine.syncNow();
    });
    expect(server.list(hh).find((i) => i.name === 'Melk')!.quantity).toBe(2);
    expect(anna.engine.getSnapshot().open.find((i) => i.id === melk.itemId)!.quantity).toBe(2);
    await anna.restart();
    expect(anna.engine.getSnapshot().open.find((i) => i.id === melk.itemId)!.quantity).toBe(2);
  });

  test('rename: a newer rename by someone else wins over my acked older rename', async () => {
    const { anna, bram } = await twoDevices({ pullPageSize: 2 });
    const melk = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    await anna.engine.updateItem(melk.itemId, { name: 'Halfvolle melk' });
    await cutPull(anna, async () => {
      await bram.engine.updateItem(melk.itemId, { name: 'Volle melk' });
      await bram.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
      await bram.engine.addItem({ name: 'Kaas', quantity: 1, unit: 'stuk' });
      await bram.engine.syncNow();
    });
    expect(anna.engine.getSnapshot().open.find((i) => i.id === melk.itemId)!.name).toBe('Volle melk');
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
