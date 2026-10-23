import { createSyncEngine } from '../engine';
import { FakeClock } from '../testing/fakeClock';
import { FakeServer } from '../testing/fakeServer';
import { household, makeDevice, outboxRows, tempDir, twoDevices, uuid } from './harness';

describe('two devices, one household', () => {
  test('changes of one device reach the other on sync and via realtime nudge', async () => {
    const { anna, bram, clock } = await twoDevices();
    await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    // Bram got a nudge (debounced 100 ms) -> pull
    await clock.advance(150);
    await bram.engine.whenIdle();
    expect(bram.names()).toEqual(['Melk:1']);
  });

  test('both add "melk" offline -> one row with the summed quantity on both devices', async () => {
    const { anna, bram, server, hh } = await twoDevices();
    anna.goOffline();
    bram.goOffline();
    await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await bram.engine.addItem({ name: 'melk ', quantity: 2, unit: 'stuk' });
    anna.goOnline();
    await anna.engine.syncNow();
    bram.goOnline();
    const r = await bram.engine.syncNow();
    void r;
    await anna.engine.syncNow();
    expect(server.list(hh).map((i) => [i.name, i.quantity])).toEqual([['Melk', 3]]);
    expect(anna.names()).toEqual(['Melk:3']);
    expect(bram.names()).toEqual(['Melk:3']);
    expect(await outboxRows(bram)).toEqual([]);
  });

  test('concurrent +1 and +1 from both devices -> +2', async () => {
    const { anna, bram, server } = await twoDevices();
    const { itemId } = await anna.engine.addItem({ name: 'Bananen', quantity: 6, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    anna.goOffline();
    bram.goOffline();
    await anna.engine.incrementQuantity(itemId, 1);
    await bram.engine.incrementQuantity(itemId, 1);
    expect(anna.names()).toEqual(['Bananen:7']);
    expect(bram.names()).toEqual(['Bananen:7']);
    anna.goOnline();
    bram.goOnline();
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    await anna.engine.syncNow();
    expect(server.item(itemId)!.quantity).toBe(8);
    expect(anna.names()).toEqual(['Bananen:8']);
    expect(bram.names()).toEqual(['Bananen:8']);
  });

  test('exact quantity is last-writer-wins in server receive order (not client clock)', async () => {
    const { anna, bram, server, clock } = await twoDevices();
    const { itemId } = await anna.engine.addItem({ name: 'Eieren', quantity: 6, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    anna.goOffline();
    bram.goOffline();
    await bram.engine.updateItem(itemId, { quantity: 10 }); // earlier on the client clock
    await clock.advance(60_000);
    await anna.engine.updateItem(itemId, { quantity: 12 }); // later on the client clock, but arrives first
    anna.goOnline();
    await anna.engine.syncNow();
    bram.goOnline();
    await bram.engine.syncNow();
    await anna.engine.syncNow();
    expect(server.item(itemId)!.quantity).toBe(10);
    expect(anna.names()).toEqual(['Eieren:10']);
    expect(bram.names()).toEqual(['Eieren:10']);
  });

  test('per-field LWW: concurrent name and note edits both survive', async () => {
    const { anna, bram, server } = await twoDevices();
    const { itemId } = await anna.engine.addItem({ name: 'Kaas', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    anna.goOffline();
    bram.goOffline();
    await anna.engine.updateItem(itemId, { name: 'Kaas jong belegen' });
    await bram.engine.updateItem(itemId, { note: '48+' });
    anna.goOnline();
    bram.goOnline();
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    await anna.engine.syncNow();
    expect(server.item(itemId)).toMatchObject({ name: 'Kaas jong belegen', note: '48+' });
    expect(bram.engine.getSnapshot().open[0]).toMatchObject({ name: 'Kaas jong belegen', note: '48+' });
  });

  test('delete vs edit: delete wins, the edit is rejected as deleted and shown as failed', async () => {
    const { anna, bram, server } = await twoDevices();
    const { itemId } = await anna.engine.addItem({ name: 'Yoghurt', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    bram.goOffline();
    await bram.engine.updateItem(itemId, { quantity: 2 });
    await bram.engine.setChecked(itemId, true);
    await anna.engine.deleteItem(itemId);
    await anna.engine.syncNow();
    const other = await bram.engine.addItem({ name: 'Kwark', quantity: 1, unit: 'stuk' });
    bram.goOnline();
    await bram.engine.syncNow();
    expect(server.item(itemId)!.deleted_at).not.toBeNull();
    expect(server.item(itemId)!.quantity).toBe(1);
    const st = bram.engine.getStatus();
    expect(st.icon).toBe('error');
    expect(st.failed.map((f) => [f.kind, f.reason, f.itemName])).toEqual([
      ['update_item', 'deleted', 'Yoghurt'],
      ['set_checked', 'deleted', 'Yoghurt'],
    ]);
    // the rest of the queue went through
    expect(server.item(other.itemId)).toBeDefined();
    expect(bram.names()).toEqual(['Kwark:1']);
    expect(bram.engine.failedAsText()).toContain('2 wijzigingen konden niet worden opgeslagen: Yoghurt.');
    expect(bram.engine.failedAsText()).toContain('- Yoghurt: wijzigen (het item was al verwijderd)');
    await bram.engine.discardFailed(st.failed.map((f) => f.mutationId));
    expect(bram.engine.getStatus()).toMatchObject({ icon: 'idle', failed: [] });
  });

  test('edit then delete on the other device (edit first at the server): delete still wins', async () => {
    const { anna, bram, server } = await twoDevices();
    const { itemId } = await anna.engine.addItem({ name: 'Sla', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    await bram.engine.updateItem(itemId, { note: 'ijsberg' });
    await bram.engine.syncNow();
    await anna.engine.deleteItem(itemId);
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    expect(server.item(itemId)).toMatchObject({ note: 'ijsberg' });
    expect(server.item(itemId)!.deleted_at).not.toBeNull();
    expect(bram.names()).toEqual([]);
  });

  test('"Wissen" removes only the on-screen ids still checked; undo does not resurrect others\' deletes', async () => {
    const { anna, bram, server } = await twoDevices();
    const a = await anna.engine.addItem({ name: 'A', quantity: 1, unit: 'stuk' });
    const b = await anna.engine.addItem({ name: 'B', quantity: 1, unit: 'stuk' });
    const c = await anna.engine.addItem({ name: 'C', quantity: 1, unit: 'stuk' });
    for (const x of [a, b, c]) await anna.engine.setChecked(x.itemId, true);
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    // Bram, offline, sees A, B, C checked and taps "Wissen".
    bram.goOffline();
    // Meanwhile Anna unchecks B (she still needs it) and deletes C.
    await anna.engine.setChecked(b.itemId, false);
    await anna.engine.deleteItem(c.itemId);
    await anna.engine.syncNow();
    const results = await bram.engine.clearChecked(bram.engine.getSnapshot().checked.map((i) => i.id));
    expect(results).toHaveLength(3);
    bram.goOnline();
    await bram.engine.syncNow();
    expect(server.item(a.itemId)!.deleted_at).not.toBeNull();
    expect(server.item(b.itemId)).toMatchObject({ deleted_at: null, checked: false });
    expect(bram.names()).toEqual(['B:1']);
    // Undo "Wissen": only A comes back; C stays deleted (Anna deleted it, not this clear).
    await bram.engine.undo(results.flatMap((r) => r.undo));
    await bram.engine.syncNow();
    expect(server.item(a.itemId)!.deleted_at).toBeNull();
    expect(server.item(c.itemId)!.deleted_at).not.toBeNull();
  });

  test('add on one device while the item is checked on the other -> restored, not duplicated', async () => {
    const { anna, bram, server, hh } = await twoDevices();
    const { itemId } = await anna.engine.addItem({ name: 'Koffie', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    bram.goOffline();
    await anna.engine.setChecked(itemId, true);
    await anna.engine.syncNow();
    // Bram still sees it open; locally that is a merge, the server restores the checked row.
    const r = await bram.engine.addItem({ name: 'koffie', quantity: 2, unit: 'stuk' });
    expect(r.outcome).toBe('merged');
    bram.goOnline();
    await bram.engine.syncNow();
    expect(server.list(hh)).toHaveLength(1);
    expect(server.item(itemId)).toMatchObject({ checked: false, quantity: 2 });
    expect(bram.names()).toEqual(['Koffie:2']);
  });

  test('add merged server-side into a row this device never saw: no flicker between ack and pull', async () => {
    const { anna, bram } = await twoDevices();
    anna.goOffline();
    await bram.engine.addItem({ name: 'Rijst', quantity: 1, unit: 'kg' });
    await bram.engine.syncNow();
    const r = await anna.engine.addItem({ name: 'Rijst', quantity: 1, unit: 'kg' });
    expect(r.outcome).toBe('added'); // anna has not seen bram's row
    const edit = await anna.engine.updateItem(r.itemId, { note: 'basmati' });
    expect(edit.outcome).toBe('updated');
    // Record what is on screen at the moment the pull starts, i.e. after the ack was processed.
    const atPull: string[][] = [];
    const pull = anna.transport.pullChanges.bind(anna.transport);
    anna.transport.pullChanges = async (...args) => {
      atPull.push(anna.engine.getSnapshot().open.map((i) => `${i.id === r.itemId ? 'local' : 'target'}:${i.note}:${i.pending}`));
      return pull(...args);
    };
    const shown: number[] = [];
    anna.engine.subscribe((s) => shown.push(s.open.length));
    anna.goOnline();
    await anna.engine.whenIdle();
    await anna.engine.syncNow();
    expect(atPull[0]).toEqual(['target:basmati:false']); // ack replayed onto the server's target id
    expect(shown.every((n) => n === 1)).toBe(true);
    expect(anna.engine.getSnapshot().open).toHaveLength(1);
    expect(anna.engine.getSnapshot().open[0]).toMatchObject({ name: 'Rijst', quantity: 2, note: 'basmati', pending: false });
  });
});

describe('durability and delivery', () => {
  test('app killed with a pending outbox: reopened engine shows and sends it', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh, online: false });
    await dev.engine.addItem({ name: 'Pindakaas', quantity: 1, unit: 'stuk' });
    await dev.engine.addItem({ name: 'Hagelslag', quantity: 1, unit: 'stuk' });
    await dev.restart();
    expect(dev.names()).toEqual(['Hagelslag:1', 'Pindakaas:1']);
    expect(dev.engine.getStatus().pendingCount).toBe(2);
    dev.goOnline();
    await dev.engine.whenIdle();
    await dev.engine.syncNow();
    expect(server.list(hh).map((i) => i.name).sort()).toEqual(['Hagelslag', 'Pindakaas']);
    expect(dev.engine.getStatus().pendingCount).toBe(0);
  });

  test('app killed mid-push (server applied, response lost): resend after restart is idempotent', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    const { itemId } = await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    await dev.engine.incrementQuantity(itemId, 1);
    await dev.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    dev.transport.loseNextResponses(1);
    await dev.engine.syncNow(); // server applied both; client never heard back
    expect(server.item(itemId)!.quantity).toBe(3);
    expect((await outboxRows(dev)).map((r) => r.state)).toEqual(['pending', 'pending']);
    await dev.restart();
    await dev.engine.syncNow();
    expect(server.item(itemId)!.quantity).toBe(3); // not 5
    expect(dev.names()).toEqual(['Melk:3']);
    expect(await outboxRows(dev)).toEqual([]);
    const ids = [...server.deliveries.entries()].filter(([, n]) => n === 2);
    expect(ids).toHaveLength(2);
  });

  test('kill while the outbox write transaction is open: nothing half-written', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh, online: false });
    await dev.engine.addItem({ name: 'Thee', quantity: 1, unit: 'stuk' });
    // Open a transaction like a command would, write, and die before commit.
    await dev.db.exec('begin immediate');
    await dev.db.run("insert into outbox (id, household_id, kind, payload, client_created_at) values ('x', ?, 'add_item', '{}', '')", [hh]);
    await dev.restart();
    expect((await outboxRows(dev)).map((r) => r.id)).not.toContain('x');
    expect(dev.names()).toEqual(['Thee:1']);
  });

  test('duplicate realtime nudges and repeated pulls are harmless', async () => {
    const { anna, bram, server, clock } = await twoDevices();
    await anna.engine.addItem({ name: 'Boter', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    for (let i = 0; i < 5; i++) server.rename(anna.householdId, 'Thuis');
    await clock.advance(150);
    await bram.engine.whenIdle();
    await bram.engine.syncNow();
    await bram.engine.syncNow();
    expect(bram.names()).toEqual(['Boter:1']);
    expect(bram.engine.getHousehold()).toMatchObject({ name: 'Thuis' });
  });

  test('the same batch delivered twice: second delivery replays stored results', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    await dev.engine.addItem({ name: 'Wortel', quantity: 1, unit: 'kg' });
    dev.transport.loseNextResponses(2);
    await dev.engine.syncNow();
    await dev.clock.advance(5_000);
    await dev.engine.whenIdle();
    await dev.engine.syncNow();
    expect(server.list(hh)).toHaveLength(1);
    expect(server.list(hh)[0]!.quantity).toBe(1);
    expect(dev.names()).toEqual(['Wortel:1kg']);
  });

  test('offline for days with 250 edits, others changing things and tombstones purged meanwhile', async () => {
    const { anna, bram, server, hh, clock } = await twoDevices();
    const base = await anna.engine.addItem({ name: 'Basis', quantity: 1, unit: 'stuk' });
    const gone = await anna.engine.addItem({ name: 'Weg', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    bram.goOffline();
    for (let i = 0; i < 200; i++) await bram.engine.addItem({ name: `Item ${i % 120}`, quantity: 1, unit: 'stuk' });
    for (let i = 0; i < 50; i++) await bram.engine.incrementQuantity(base.itemId, 1);
    await clock.advance(3 * 86_400_000);
    await anna.engine.deleteItem(gone.itemId);
    await anna.engine.addItem({ name: 'Item 5', quantity: 4, unit: 'stuk' });
    await anna.engine.syncNow();
    server.purgeTombstones(hh);
    expect(bram.engine.getStatus().pendingCount).toBe(250);
    bram.goOnline();
    await bram.engine.whenIdle();
    await bram.engine.syncNow();
    await anna.engine.syncNow();
    expect(bram.engine.getStatus()).toMatchObject({ pendingCount: 0, failed: [] });
    const serverOpen = server.list(hh).map((i) => `${i.name}:${i.quantity}`).sort();
    expect(serverOpen).toHaveLength(121); // Basis + Item 0..119
    expect(server.item(base.itemId)!.quantity).toBe(51);
    expect(server.list(hh).find((i) => i.name === 'Item 5')!.quantity).toBe(4 + 2);
    expect(bram.names().sort()).toEqual(serverOpen);
    expect(anna.names().sort()).toEqual(serverOpen);
    // pushed in batches of at most 100
    const applies = bram.transport.calls.filter((c) => c.fn === 'apply') as { req: { mutations: unknown[] } }[];
    expect(Math.max(...applies.map((c) => c.req.mutations.length))).toBeLessThanOrEqual(100);
  });

  test('reset_required: wipes server_items, keeps the outbox, pulls from 0', async () => {
    const { anna, bram, server, hh } = await twoDevices();
    const x = await anna.engine.addItem({ name: 'X', quantity: 1, unit: 'stuk' });
    const y = await anna.engine.addItem({ name: 'Y', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    bram.goOffline();
    await bram.engine.addItem({ name: 'Z', quantity: 1, unit: 'stuk' });
    await anna.engine.deleteItem(x.itemId);
    await anna.engine.syncNow();
    server.purgeTombstones(hh);
    void y;
    bram.goOnline();
    const pulls = bram.transport.calls.length;
    await bram.engine.syncNow();
    const sinceValues = bram.transport.calls.slice(pulls).filter((c) => c.fn === 'pull').map((c) => (c.req as { sinceSeq: number }).sinceSeq);
    expect(sinceValues).toContain(0);
    expect(bram.names().sort()).toEqual(['Y:1', 'Z:1']);
  });

  test('pull pagination follows has_more', async () => {
    const server = new FakeServer();
    const a = uuid();
    const hh = household(server, a);
    const clock = new FakeClock();
    const anna = await makeDevice(server, { userId: a, householdId: hh, clock });
    for (let i = 0; i < 23; i++) await anna.engine.addItem({ name: `P${i}`, quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    const b = uuid();
    server.addMember(hh, b);
    const bram = await makeDevice(server, { userId: b, householdId: hh, clock, engine: { pullPageSize: 5 } });
    await bram.engine.syncNow();
    expect(bram.names()).toHaveLength(23);
    expect(bram.transport.calls.filter((c) => c.fn === 'pull').length).toBeGreaterThanOrEqual(5);
  });
});

describe('errors and retries', () => {
  test('network failure: everything stays pending, exponential backoff 1 s, 2 s, 4 s', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    await dev.engine.whenIdle();
    await dev.engine.addItem({ name: 'Peper', quantity: 1, unit: 'stuk' });
    dev.transport.failNext(3);
    await dev.clock.advance(150);
    await dev.engine.whenIdle();
    expect(dev.transport.applyCount()).toBe(1);
    await dev.clock.advance(800); // 1 s * (0.75 + 0.25*0.5) = 875 ms
    expect(dev.transport.applyCount()).toBe(1);
    await dev.clock.advance(100);
    await dev.engine.whenIdle();
    expect(dev.transport.applyCount()).toBe(2);
    await dev.clock.advance(1750);
    await dev.engine.whenIdle();
    expect(dev.transport.applyCount()).toBe(3);
    await dev.clock.advance(3500);
    await dev.engine.whenIdle();
    expect(dev.transport.applyCount()).toBe(4);
    expect(server.list(hh)).toHaveLength(1);
    expect(dev.engine.getStatus().pendingCount).toBe(0);
  });

  test('coming back online retries immediately (no waiting for backoff)', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    dev.goOffline();
    await dev.engine.addItem({ name: 'Zout', quantity: 1, unit: 'stuk' });
    await dev.clock.advance(10_000);
    expect(dev.transport.applyCount()).toBe(0); // offline -> not even tried
    dev.goOnline();
    await dev.engine.whenIdle();
    expect(server.list(hh)).toHaveLength(1);
  });

  test('per-mutation retry: that row backs off, the rest continues, then it succeeds', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    const a = await dev.engine.addItem({ name: 'Ananas', quantity: 1, unit: 'stuk' });
    await dev.engine.addItem({ name: 'Bloem', quantity: 1, unit: 'kg' });
    const outbox = await outboxRows(dev);
    server.retryIds.add(outbox[0]!.id);
    await dev.engine.syncNow();
    // The server applies nothing after a 'retry' in the same batch (order is preserved).
    expect(server.list(hh)).toEqual([]);
    expect(dev.names().sort()).toEqual(['Ananas:1', 'Bloem:1kg']); // still shown (pending)
    expect((await outboxRows(dev))[0]).toMatchObject({ state: 'pending', attempts: 1 });
    // Next round: the failing row goes alone, so the unrelated row behind it gets through.
    await dev.clock.advance(1000);
    await dev.engine.whenIdle();
    expect(server.list(hh).map((i) => i.name)).toEqual(['Bloem']);
    server.retryIds.clear();
    await dev.clock.advance(5000);
    await dev.engine.whenIdle();
    expect(server.item(a.itemId)).toBeDefined();
  });

  test('edits of an item whose add got "retry" are re-queued, not lost as not_found', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    const a = await dev.engine.addItem({ name: 'Ananas', quantity: 1, unit: 'stuk' });
    await dev.engine.updateItem(a.itemId, { note: 'rijp' });
    await dev.engine.setChecked(a.itemId, true);
    const [add] = await outboxRows(dev);
    server.retryIds.add(add!.id);
    await dev.engine.syncNow();
    expect(dev.engine.getStatus().failed).toEqual([]);
    expect(dev.engine.getStatus().pendingCount).toBe(3);
    server.retryIds.clear();
    await dev.clock.advance(2000);
    await dev.engine.whenIdle();
    await dev.engine.syncNow();
    expect(server.item(a.itemId)).toMatchObject({ note: 'rijp', checked: true });
    expect(dev.engine.getStatus()).toMatchObject({ pendingCount: 0, failed: [] });
  });

  test('later edits of an item stay behind its backed-off edit (per-item order kept)', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    const a = await dev.engine.addItem({ name: 'Wijn', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    await dev.engine.setChecked(a.itemId, true);
    const rows = await outboxRows(dev);
    server.retryIds.add(rows[0]!.id);
    await dev.engine.syncNow();
    await dev.engine.setChecked(a.itemId, false); // must not overtake the pending check
    await dev.engine.syncNow();
    expect(server.item(a.itemId)!.checked).toBe(false);
    // syncNow retries the backed-off check right away (alone); the uncheck stays behind it.
    expect(dev.transport.calls.filter((c) => c.fn === 'apply').map((c) => (c.req as { mutations: unknown[] }).mutations.length)).toEqual([1, 1, 1]);
    server.retryIds.clear();
    await dev.clock.advance(1000);
    await dev.engine.whenIdle();
    await dev.engine.syncNow();
    expect(server.item(a.itemId)!.checked).toBe(false); // check then uncheck, in order
  });

  test('one rejected mutation does not block the rest', async () => {
    const { anna, bram, server } = await twoDevices();
    const x = await anna.engine.addItem({ name: 'X', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    bram.goOffline();
    await anna.engine.deleteItem(x.itemId);
    await anna.engine.syncNow();
    await bram.engine.incrementQuantity(x.itemId, 1);
    const ok = [];
    for (let i = 0; i < 3; i++) ok.push(await bram.engine.addItem({ name: `Ok${i}`, quantity: 1, unit: 'stuk' }));
    bram.goOnline();
    await bram.engine.syncNow();
    for (const o of ok) expect(server.item(o.itemId)).toBeDefined();
    expect(bram.engine.getStatus().failed).toHaveLength(1);
  });

  test('invalid_batch: mutations are isolated one by one, only the bad one fails', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    await dev.engine.addItem({ name: 'Goed', quantity: 1, unit: 'stuk' });
    await dev.engine.addItem({ name: 'Ook goed', quantity: 1, unit: 'stuk' });
    // Corrupt the second row's kind so the server rejects the whole batch.
    const rows = await outboxRows(dev);
    const realApply = server.applyMutations.bind(server);
    server.applyMutations = (uid, req) => {
      if (req.mutations.some((m) => m.id === rows[1]!.id)) return { ok: false, error: 'invalid_batch' };
      return realApply(uid, req);
    };
    await dev.engine.syncNow();
    expect(server.list(hh).map((i) => i.name)).toEqual(['Goed']);
    expect(dev.engine.getStatus().failed.map((f) => [f.itemName, f.reason])).toEqual([['Ook goed', 'invalid']]);
  });

  test('session expired offline: outbox kept, needsReauth, sent after the same user signs in again', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    dev.transport.sessionExpired = true;
    await dev.engine.addItem({ name: 'Honing', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    expect(dev.engine.getStatus()).toMatchObject({ needsReauth: true, pendingCount: 1 });
    await dev.clock.advance(120_000); // no automatic retries while the session is gone
    expect(dev.transport.applyCount()).toBe(1);
    dev.transport.sessionExpired = false;
    dev.engine.notifyReauthenticated();
    await dev.engine.whenIdle();
    expect(dev.engine.getStatus()).toMatchObject({ needsReauth: false, pendingCount: 0 });
    expect(server.list(hh)).toHaveLength(1);
  });

  test('not_member: stops, keeps the pending outbox (unsent() lists it), fires onMembershipLost once', async () => {
    const { anna, bram, server, hh } = await twoDevices();
    const lost = jest.fn();
    bram.engine.onMembershipLost(lost);
    const ack = await bram.engine.addItem({ name: 'Al verstuurd', quantity: 1, unit: 'stuk' });
    await bram.engine.syncNow();
    bram.goOffline();
    await bram.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    await bram.engine.addItem({ name: 'Kaas', quantity: 1, unit: 'stuk' });
    await bram.engine.setChecked(ack.itemId, true);
    server.removeMember(hh, bram.userId);
    bram.goOnline();
    await bram.engine.whenIdle();
    await bram.engine.syncNow();
    expect(lost).toHaveBeenCalledTimes(1);
    // Kept, not moved to failed: the session decides between removal (wipe, with this list) and a
    // household switch on another device (re-addressed by the next engine on this file).
    expect((await outboxRows(bram)).map((r) => r.kind)).toEqual(['add_item', 'add_item', 'set_checked']);
    const u = bram.engine.unsent();
    expect(u.count).toBe(3);
    expect(u.text).toContain('3 wijzigingen konden niet worden opgeslagen');
    for (const n of ['Brood', 'Kaas', 'Al verstuurd']) expect(u.text).toContain(n);
    const before = bram.transport.calls.length;
    await bram.engine.syncNow();
    await bram.engine.addItem({ name: 'Na verwijdering', quantity: 1, unit: 'stuk' });
    await bram.clock.advance(120_000);
    expect(bram.transport.calls.length).toBe(before); // never retried
    expect(server.list(hh).map((i) => i.name)).toEqual(['Al verstuurd']);
    void anna;
  });

  test('not_member on pull (removed while idle, realtime broadcast)', async () => {
    const { bram, server, hh, clock } = await twoDevices();
    const lost = jest.fn();
    bram.engine.onMembershipLost(lost);
    server.removeMember(hh, bram.userId);
    await clock.advance(150);
    await bram.engine.whenIdle();
    expect(lost).toHaveBeenCalledTimes(1);
  });
});

describe('undo of adds (revert_add)', () => {
  test('undo of a pending add drops it before it is ever sent', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    const r = await dev.engine.addItem({ name: 'Oeps', quantity: 1, unit: 'stuk' });
    await dev.engine.updateItem(r.itemId, { note: 'x' });
    await dev.engine.undo(r.undo);
    expect(dev.names()).toEqual([]);
    expect(await outboxRows(dev)).toEqual([]);
    await dev.engine.syncNow();
    expect(dev.transport.applyCount()).toBe(0);
    expect(dev.engine.getStatus().failed).toEqual([]);
  });

  test('undo of a merged add after sync decrements on the server (other device\'s +1 kept)', async () => {
    const { anna, bram, server } = await twoDevices();
    const { itemId } = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    const r = await anna.engine.addItem({ name: 'melk', quantity: 2, unit: 'stuk' });
    expect(r.outcome).toBe('merged');
    await anna.engine.syncNow();
    await bram.engine.incrementQuantity(itemId, 1);
    await bram.engine.syncNow();
    expect(server.item(itemId)!.quantity).toBe(4);
    await anna.engine.undo(r.undo);
    await anna.engine.syncNow();
    expect(server.item(itemId)!.quantity).toBe(2);
    expect(anna.names()).toEqual(['Melk:2']);
  });

  test('undo of a restored add re-checks the row and restores the previous quantity', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    const a = await dev.engine.addItem({ name: 'Eieren', quantity: 10, unit: 'stuk' });
    await dev.engine.setChecked(a.itemId, true);
    await dev.engine.syncNow();
    const r = await dev.engine.addItem({ name: 'eieren', quantity: 6, unit: 'stuk' });
    expect(r.outcome).toBe('restored');
    await dev.engine.syncNow();
    await dev.engine.undo(r.undo);
    await dev.engine.syncNow();
    expect(server.item(a.itemId)).toMatchObject({ checked: true, quantity: 10 });
  });

  test('undo of an applied add after the pull already removed the outbox row (acked_log)', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    const r = await dev.engine.addItem({ name: 'Snoep', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    expect(await outboxRows(dev)).toEqual([]);
    await dev.restart(); // even across a restart
    await dev.engine.undo(r.undo);
    await dev.engine.syncNow();
    expect(server.item(r.itemId)!.deleted_at).not.toBeNull();
  });

  test('undo while the add is in flight waits for the server result', async () => {
    const { anna, bram, server, hh } = await twoDevices();
    await bram.engine.addItem({ name: 'Peer', quantity: 1, unit: 'stuk' });
    await bram.engine.syncNow();
    const r = await anna.engine.addItem({ name: 'Peer', quantity: 3, unit: 'stuk' }); // server merges into bram's row
    anna.transport.hold();
    const sync = anna.engine.syncNow();
    await new Promise((res) => setImmediate(res));
    expect(anna.transport.applyCount()).toBe(1); // the add is on the wire
    const undo = anna.engine.undo(r.undo);
    await new Promise((res) => setImmediate(res));
    expect(anna.transport.applyCount()).toBe(1); // undo waited, nothing else sent yet
    anna.transport.release();
    await sync;
    await undo;
    await anna.engine.syncNow();
    expect(server.list(hh).map((i) => [i.name, i.quantity])).toEqual([['Peer', 1]]);
  });
});

describe('local data lifecycle', () => {
  test('switching household re-addresses pending mutations and drops the old list', async () => {
    const server = new FakeServer();
    const user = uuid();
    const old = household(server, user);
    const dir = tempDir();
    const dev = await makeDevice(server, { userId: user, householdId: old, dir });
    await dev.engine.addItem({ name: 'Oud', quantity: 1, unit: 'stuk' });
    await dev.engine.syncNow();
    dev.goOffline();
    await dev.engine.addItem({ name: 'Nieuw', quantity: 1, unit: 'stuk' });
    await dev.engine.dispose();
    const owner = uuid();
    const next = household(server, owner, user);
    const dev2 = await makeDevice(server, { userId: user, householdId: next, dir });
    expect(dev2.names()).toEqual(['Nieuw:1']);
    await dev2.engine.syncNow();
    expect(server.list(next).map((i) => i.name)).toEqual(['Nieuw']);
  });

  test('a database file of another user is refused', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    await dev.engine.dispose();
    const db = await dev.factory.open(user);
    const other = createSyncEngine({ db, transport: dev.transport, connectivity: dev.connectivity, userId: uuid(), householdId: hh, uuid });
    await expect(other.start()).rejects.toThrow(/another user/);
  });
});
