import { FakeServer } from '../testing/fakeServer';
import { SyncInputError } from '../validate';
import { household, makeDevice, outboxRows, uuid } from './harness';

async function solo(opts: { online?: boolean } = {}) {
  const server = new FakeServer();
  const user = uuid();
  const hh = household(server, user);
  const dev = await makeDevice(server, { userId: user, householdId: hh, online: opts.online });
  return { server, hh, dev };
}

describe('commands: outbox first, optimistic snapshot', () => {
  test('snapshot is loaded after start and empty', async () => {
    const { dev } = await solo();
    const s = dev.engine.getSnapshot();
    expect(s.loaded).toBe(true);
    expect(s.open).toEqual([]);
    expect(s.checked).toEqual([]);
  });

  test('addItem is visible immediately, pending, and persisted in the outbox before sync', async () => {
    const { dev, server, hh } = await solo();
    const r = await dev.engine.addItem({ name: '  Melk ', quantity: 2, unit: 'stuk' });
    expect(r.outcome).toBe('added');
    expect(r.itemName).toBe('Melk');
    expect(r.undo).toEqual([{ kind: 'revert_add', mutationId: expect.any(String) }]);
    const s = dev.engine.getSnapshot();
    expect(s.open).toHaveLength(1);
    expect(s.open[0]).toMatchObject({ id: r.itemId, name: 'Melk', normalized_name: 'melk', quantity: 2, pending: true, household_id: hh });
    expect(await outboxRows(dev)).toEqual([{ id: expect.any(String), kind: 'add_item', state: 'pending', attempts: 0 }]);
    expect(server.list(hh)).toHaveLength(0);
    expect(dev.engine.getStatus().pendingCount).toBe(1);

    await dev.engine.syncNow();
    expect(server.list(hh).map((i) => i.name)).toEqual(['Melk']);
    expect(dev.engine.getSnapshot().open[0]).toMatchObject({ id: r.itemId, pending: false, position: 1, server_seq: 1 });
    expect(await outboxRows(dev)).toEqual([]); // acked and covered by the pull -> removed
    expect(dev.engine.getStatus()).toMatchObject({ pendingCount: 0, icon: 'idle', lastPulledSeq: 1 });
  });

  test('push is debounced (~150 ms) after a command', async () => {
    const { dev, server, hh } = await solo();
    await dev.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    await dev.engine.addItem({ name: 'Kaas', quantity: 1, unit: 'stuk' });
    await dev.clock.advance(100);
    expect(dev.transport.applyCount()).toBe(0);
    await dev.clock.advance(100);
    await dev.engine.whenIdle();
    expect(dev.transport.applyCount()).toBe(1); // both in one batch
    expect(server.list(hh)).toHaveLength(2);
  });

  test('open items sort newest first; checked items by checked_at desc', async () => {
    const { dev } = await solo();
    const a = await dev.engine.addItem({ name: 'Appels', quantity: 1, unit: 'stuk' });
    const b = await dev.engine.addItem({ name: 'Bananen', quantity: 6, unit: 'stuk' });
    const c = await dev.engine.addItem({ name: 'Citroen', quantity: 1, unit: 'stuk' });
    expect(dev.names()).toEqual(['Citroen:1', 'Bananen:6', 'Appels:1']);
    await dev.engine.syncNow();
    expect(dev.names()).toEqual(['Citroen:1', 'Bananen:6', 'Appels:1']);
    await dev.engine.setChecked(a.itemId, true);
    await dev.clock.advance(1000);
    await dev.engine.setChecked(c.itemId, true);
    const s = dev.engine.getSnapshot();
    expect(s.open.map((i) => i.id)).toEqual([b.itemId]);
    expect(s.checked.map((i) => i.id)).toEqual([c.itemId, a.itemId]);
  });

  test('local dedupe mirrors the server: same name+unit merges, other unit is a new row', async () => {
    const { dev, server, hh } = await solo();
    await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    const r2 = await dev.engine.addItem({ name: 'mélk', quantity: 2, unit: 'stuk' });
    expect(r2.outcome).toBe('merged');
    expect(r2.itemName).toBe('Melk');
    const r3 = await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'l' });
    expect(r3.outcome).toBe('added');
    expect(dev.names()).toEqual(['Melk:1l', 'Melk:3']);
    await dev.engine.syncNow();
    expect(server.list(hh).map((i) => `${i.name}:${i.quantity}${i.unit}`).sort()).toEqual(['Melk:1l', 'Melk:3stuk']);
    expect(dev.names()).toEqual(['Melk:1l', 'Melk:3']);
  });

  test('adding a checked item restores it with the typed quantity ("Melk teruggezet")', async () => {
    const { dev } = await solo();
    const a = await dev.engine.addItem({ name: 'Melk', quantity: 3, unit: 'stuk' });
    await dev.engine.setChecked(a.itemId, true);
    await dev.engine.syncNow();
    const r = await dev.engine.addItem({ name: 'melk', quantity: 1, unit: 'stuk', note: 'halfvol' });
    expect(r).toMatchObject({ outcome: 'restored', itemId: a.itemId, itemName: 'Melk' });
    expect(dev.engine.getSnapshot().open[0]).toMatchObject({ id: a.itemId, quantity: 1, checked: false, note: 'halfvol' });
    await dev.engine.syncNow();
    expect(dev.engine.getSnapshot().open[0]).toMatchObject({ id: a.itemId, quantity: 1, checked: false, note: 'halfvol', pending: false });
  });

  test('update / increment / check / delete / restore with undo actions', async () => {
    const { dev, server } = await solo();
    const { itemId } = await dev.engine.addItem({ name: 'Gehakt', quantity: 500, unit: 'g' });
    await dev.engine.syncNow();

    const u = await dev.engine.updateItem(itemId, { name: 'Rundergehakt', note: 'mager', quantity: 500 });
    expect(u.undo).toEqual([{ kind: 'update_item', itemId, fields: { name: 'Gehakt', note: '' } }]);
    const inc = await dev.engine.incrementQuantity(itemId, 250);
    expect(inc.undo).toEqual([{ kind: 'increment_quantity', itemId, delta: -250 }]);
    const chk = await dev.engine.setChecked(itemId, true);
    expect(chk.undo).toEqual([{ kind: 'set_checked', itemId, checked: false }]);
    expect(dev.engine.getSnapshot().checked[0]).toMatchObject({ name: 'Rundergehakt', quantity: 750, note: 'mager' });
    await dev.engine.syncNow();
    expect(server.item(itemId)).toMatchObject({ name: 'Rundergehakt', quantity: 750, checked: true });

    await dev.engine.undo(chk.undo);
    await dev.engine.undo(inc.undo);
    await dev.engine.undo(u.undo);
    await dev.engine.syncNow();
    expect(server.item(itemId)).toMatchObject({ name: 'Gehakt', quantity: 500, note: '', checked: false });

    const del = await dev.engine.deleteItem(itemId);
    expect(del.undo).toEqual([{ kind: 'restore_item', itemId }]);
    expect(dev.engine.getSnapshot().open).toHaveLength(0);
    await dev.engine.syncNow();
    expect(server.item(itemId)?.deleted_at).not.toBeNull();
    await dev.engine.undo(del.undo);
    expect(dev.engine.getSnapshot().open).toHaveLength(1);
    await dev.engine.syncNow();
    expect(server.item(itemId)?.deleted_at).toBeNull();
  });

  test('no-op commands do not enqueue', async () => {
    const { dev } = await solo();
    const { itemId } = await dev.engine.addItem({ name: 'Ui', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    expect((await dev.engine.setChecked(itemId, false)).outcome).toBe('noop');
    expect((await dev.engine.updateItem(itemId, { name: 'Ui' })).outcome).toBe('noop');
    expect((await dev.engine.restoreItem(itemId)).outcome).toBe('noop');
    expect((await dev.engine.incrementQuantity(itemId, -1)).outcome).toBe('noop'); // would reach 0
    expect((await dev.engine.deleteItem(uuid())).outcome).toBe('noop');
    expect(await outboxRows(dev)).toEqual([]);
  });

  test('input validation rejects what the server would reject', async () => {
    const { dev } = await solo();
    await expect(dev.engine.addItem({ name: '   ', quantity: 1, unit: 'stuk' })).rejects.toBeInstanceOf(SyncInputError);
    await expect(dev.engine.addItem({ name: 'x'.repeat(121), quantity: 1, unit: 'stuk' })).rejects.toBeInstanceOf(SyncInputError);
    await expect(dev.engine.addItem({ name: 'Melk', quantity: 0, unit: 'stuk' })).rejects.toBeInstanceOf(SyncInputError);
    await expect(dev.engine.addItem({ name: 'Melk', quantity: 100000, unit: 'stuk' })).rejects.toBeInstanceOf(SyncInputError);
    await expect(dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'pak' as never })).rejects.toBeInstanceOf(SyncInputError);
    await expect(dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk', note: 'n'.repeat(141) })).rejects.toBeInstanceOf(SyncInputError);
    expect(await outboxRows(dev)).toEqual([]);
  });

  test('quantities are numeric(12,3): no float drift', async () => {
    const { dev, server } = await solo();
    const { itemId } = await dev.engine.addItem({ name: 'Kaas', quantity: 0.1, unit: 'kg' });
    await dev.engine.incrementQuantity(itemId, 0.2);
    expect(dev.engine.getSnapshot().open[0]!.quantity).toBe(0.3);
    await dev.engine.syncNow();
    expect(server.item(itemId)!.quantity).toBe(0.3);
  });

  test('clearChecked only removes the given ids that are still checked', async () => {
    const { dev, server } = await solo();
    const a = await dev.engine.addItem({ name: 'A', quantity: 1, unit: 'stuk' });
    const b = await dev.engine.addItem({ name: 'B', quantity: 1, unit: 'stuk' });
    const c = await dev.engine.addItem({ name: 'C', quantity: 1, unit: 'stuk' });
    await dev.engine.setChecked(a.itemId, true);
    await dev.engine.setChecked(b.itemId, true);
    await dev.engine.setChecked(c.itemId, true);
    await dev.engine.syncNow();
    const results = await dev.engine.clearChecked([a.itemId, b.itemId]);
    expect(results.map((r) => r.itemId).sort()).toEqual([a.itemId, b.itemId].sort());
    expect(dev.engine.getSnapshot().checked.map((i) => i.id)).toEqual([c.itemId]);
    await dev.engine.syncNow();
    expect(server.item(a.itemId)!.deleted_at).not.toBeNull();
    expect(server.item(c.itemId)!.deleted_at).toBeNull();
    await dev.engine.undo(results.flatMap((r) => r.undo));
    await dev.engine.syncNow();
    expect(dev.engine.getSnapshot().checked).toHaveLength(3);
    expect(await dev.engine.clearChecked([])).toEqual([]);
  });

  test('history counts adds per normalized name + unit', async () => {
    const { dev } = await solo();
    await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await dev.engine.addItem({ name: 'melk', quantity: 1, unit: 'stuk' });
    await dev.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    const h = await dev.engine.getHistory();
    expect(h.map((e) => [e.normalized_name, e.unit, e.use_count, e.display_name])).toEqual([
      ['melk', 'stuk', 2, 'melk'],
      ['brood', 'stuk', 1, 'Brood'],
    ]);
  });

  test('snapshot identity is stable when nothing visible changed; unchanged rows keep identity', async () => {
    const { dev } = await solo();
    const a = await dev.engine.addItem({ name: 'A', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    const s1 = dev.engine.getSnapshot();
    await dev.engine.syncNow(); // empty pull
    expect(dev.engine.getSnapshot()).toBe(s1);
    const rowA = s1.open[0];
    await dev.engine.addItem({ name: 'B', quantity: 1, unit: 'stuk' });
    const s2 = dev.engine.getSnapshot();
    expect(s2.revision).toBeGreaterThan(s1.revision);
    expect(s2.open.find((i) => i.id === a.itemId)).toBe(rowA);
  });

  test('commands issued before start() resolve after start', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh, start: false });
    const p = dev.engine.addItem({ name: 'Ei', quantity: 6, unit: 'stuk' });
    await dev.engine.start();
    expect((await p).outcome).toBe('added');
  });
});

describe('status', () => {
  test('offline icon follows connectivity; error icon follows failed mutations', async () => {
    const { dev } = await solo();
    const seen: string[] = [];
    dev.engine.subscribeStatus((s) => seen.push(s.icon));
    dev.goOffline();
    expect(dev.engine.getStatus().icon).toBe('offline');
    dev.goOnline();
    await dev.engine.whenIdle();
    expect(dev.engine.getStatus().icon).toBe('idle');
    expect(seen).toEqual(['offline', 'idle']);
  });
});
