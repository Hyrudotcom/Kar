/** Regression tests for the round-4 review findings in the sync engine and its fake server. */
import { FakeClock } from '../testing/fakeClock';
import { FakeServer } from '../testing/fakeServer';
import { household, makeDevice, twoDevices, uuid } from './harness';

const serverNames = (server: FakeServer, hh: string) => server.list(hh).map((i) => `${i.name}:${i.quantity}`);
const serverChecked = (server: FakeServer, hh: string) => server.list(hh).map((i) => `${i.name}:${i.checked}`);

async function settle(dev: { engine: { syncNow(): Promise<void> }; clock: FakeClock }) {
  for (let i = 0; i < 4; i++) {
    await dev.clock.advance(120_000);
    await dev.engine.syncNow();
  }
}

describe('undo of an add whose response was lost, then the same item typed again', () => {
  test('offline re-add: the server keeps the re-added quantity', async () => {
    const { server, hh, anna, bram } = await twoDevices();
    anna.transport.loseNextResponses(1);
    const a1 = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await anna.engine.undo(a1.undo);
    expect(anna.names()).toEqual([]);
    anna.goOffline();
    await anna.engine.addItem({ name: 'Melk', quantity: 2, unit: 'stuk' });
    expect(anna.names()).toEqual(['Melk:2']);
    anna.goOnline();
    await settle(anna);
    await bram.engine.syncNow();
    expect(serverNames(server, hh)).toEqual(['Melk:2']);
    expect(anna.names()).toEqual(['Melk:2']);
    expect(bram.names()).toEqual(['Melk:2']);
    expect(anna.engine.getStatus()).toMatchObject({ pendingCount: 0, failed: [] });
  });

  test('online re-add while the resend fails with a 503', async () => {
    const { server, hh, anna } = await twoDevices();
    anna.transport.loseNextResponses(1);
    const a1 = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await anna.engine.undo(a1.undo);
    anna.transport.failNext(1);
    await anna.engine.addItem({ name: 'Melk', quantity: 2, unit: 'stuk' });
    await settle(anna);
    expect(serverNames(server, hh)).toEqual(['Melk:2']);
    expect(anna.names()).toEqual(['Melk:2']);
  });

  test('a lost add that restored a checked item: the re-add stays open with its quantity', async () => {
    const { server, hh, anna } = await twoDevices();
    const melk = await anna.engine.addItem({ name: 'Melk', quantity: 3, unit: 'stuk' });
    await anna.engine.setChecked(melk.itemId, true);
    await anna.engine.syncNow();
    anna.transport.loseNextResponses(1);
    const a1 = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await anna.engine.undo(a1.undo);
    await anna.engine.addItem({ name: 'Melk', quantity: 2, unit: 'stuk' });
    await settle(anna);
    expect(server.list(hh).map((i) => `${i.name}:${i.quantity}:${i.checked}`)).toEqual(['Melk:2:false']);
    expect(anna.names()).toEqual(['Melk:2']);
  });
});

describe('undo of "Wissen" while the clear is unsent or unanswered', () => {
  async function checkedMelk() {
    const t = await twoDevices();
    const melk = await t.anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await t.anna.engine.setChecked(melk.itemId, true);
    await t.anna.engine.syncNow();
    await t.bram.engine.syncNow();
    return { ...t, melk: melk.itemId };
  }

  test('offline clear + undo never brings back an item another member deleted', async () => {
    const { server, hh, anna, bram, melk } = await checkedMelk();
    anna.goOffline();
    await bram.engine.deleteItem(melk);
    await bram.engine.syncNow();
    const r = await anna.engine.clearChecked([melk]);
    await anna.engine.undo(r.flatMap((x) => x.undo));
    expect(anna.engine.getSnapshot().checked.map((i) => i.name)).toEqual(['Melk']);
    anna.goOnline();
    await settle(anna);
    expect(server.list(hh)).toEqual([]);
    expect(anna.engine.getSnapshot().checked).toEqual([]);
    expect(anna.engine.getStatus()).toMatchObject({ pendingCount: 0, failed: [] });
  });

  test('offline clear + undo without other edits: the item stays checked, nothing is deleted', async () => {
    const { server, hh, anna, melk } = await checkedMelk();
    anna.goOffline();
    const r = await anna.engine.clearChecked([melk]);
    await anna.engine.undo(r.flatMap((x) => x.undo));
    anna.goOnline();
    await settle(anna);
    expect(serverChecked(server, hh)).toEqual(['Melk:true']);
    expect(server.item(melk)?.deleted_at).toBeNull();
  });

  test('in-flight clear + undo tapped before the answer: another member\'s delete stands', async () => {
    const { server, hh, anna, bram, melk } = await checkedMelk();
    await bram.engine.deleteItem(melk);
    await bram.engine.syncNow();
    anna.transport.hold();
    const r = await anna.engine.clearChecked([melk]);
    const sync = anna.engine.syncNow();
    await new Promise((res) => setTimeout(res, 20));
    const undo = anna.engine.undo(r.flatMap((x) => x.undo));
    anna.transport.release();
    await sync;
    await undo;
    await settle(anna);
    expect(server.list(hh)).toEqual([]);
  });

  test('clear whose answer was lost + undo: restored only because this clear removed it', async () => {
    const { server, hh, anna, melk } = await checkedMelk();
    anna.transport.loseNextResponses(1);
    const r = await anna.engine.clearChecked([melk]);
    await anna.engine.syncNow();
    await anna.engine.undo(r.flatMap((x) => x.undo));
    expect(anna.engine.getSnapshot().checked.map((i) => i.name)).toEqual(['Melk']);
    await settle(anna);
    expect(serverChecked(server, hh)).toEqual(['Melk:true']);
    expect(anna.engine.getSnapshot().checked.map((i) => i.name)).toEqual(['Melk']);
  });

  test('clear whose answer was lost + undo, deleted by another member meanwhile: stays deleted', async () => {
    const { server, hh, anna, bram, melk } = await checkedMelk();
    anna.goOffline();
    await bram.engine.deleteItem(melk);
    await bram.engine.syncNow();
    anna.goOnline();
    anna.transport.loseNextResponses(1);
    const r = await anna.engine.clearChecked([melk]);
    await anna.engine.syncNow();
    await anna.engine.undo(r.flatMap((x) => x.undo));
    await settle(anna);
    expect(server.list(hh)).toEqual([]);
  });
});

describe('replay after a household switch keeps the real outcome', () => {
  test('undo of a lost merged add takes back only that quantity from the merged item', async () => {
    const server = new FakeServer();
    const a = uuid();
    const b = uuid();
    const h1 = household(server, a);
    const h2 = household(server, b);
    const clock = new FakeClock();
    const anna = await makeDevice(server, { userId: a, householdId: h1, clock });
    const bram = await makeDevice(server, { userId: b, householdId: h2, clock });
    await anna.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    await bram.engine.syncNow();
    anna.transport.loseNextResponses(1);
    const lost = await anna.engine.addItem({ name: 'Brood', quantity: 2, unit: 'stuk' });
    await anna.engine.syncNow();
    await anna.engine.undo(lost.undo); // revertOnAck
    anna.goOffline();

    // accept_invite on Anna's other phone: H1's Brood (3) merges into Bram's Brood in H2 (4).
    const x = server.list(h1).find((i) => i.name === 'Brood')!;
    const d = server.list(h2).find((i) => i.name === 'Brood')!;
    const H2 = server.households.get(h2)!;
    H2.last_seq += 1;
    d.quantity += x.quantity;
    d.server_seq = H2.last_seq;
    for (const [alias, t] of server.aliases) if (t.target_id === x.id) server.aliases.set(alias, { household_id: h2, target_id: d.id });
    server.aliases.set(x.id, { household_id: h2, target_id: d.id });
    server.items.delete(x.id);
    server.households.delete(h1);
    H2.members.add(a);
    expect(serverNames(server, h2)).toEqual(['Brood:4']);

    anna.householdId = h2;
    await anna.restart();
    anna.goOnline();
    await settle(anna);
    expect(serverNames(server, h2)).toEqual(['Brood:2']);
    expect(anna.names()).toEqual(['Brood:2']);
  });

  test('a mutation rejected in the old household is still reported as rejected', async () => {
    const server = new FakeServer();
    const a = uuid();
    const h1 = household(server, a);
    const h2 = household(server, uuid());
    server.addMember(h2, a);
    const melk = uuid();
    const del = { id: uuid(), household_id: h1, kind: 'delete_item' as const, payload: { item_id: melk }, client_created_at: new Date().toISOString() };
    expect(server.applyMutations(a, { household_id: h1, mutations: [del] })).toMatchObject({ ok: true, results: [{ status: 'rejected' }] });
    server.removeMember(h1, a);
    const again = server.applyMutations(a, { household_id: h2, mutations: [{ ...del, household_id: h2 }] });
    expect(again).toMatchObject({ ok: true, results: [{ status: 'rejected', replayed: true }] });
  });
});
