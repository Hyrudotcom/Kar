/** Regression tests for the round-3 review findings in the sync engine and its fake server. */
import { FakeClock } from '../testing/fakeClock';
import { FakeServer } from '../testing/fakeServer';
import { household, makeDevice, twoDevices, uuid } from './harness';

const serverNames = (server: FakeServer, hh: string) => server.list(hh).map((i) => `${i.name}:${i.quantity}`);

describe('household switch: a lost add is never answered with the old household result', () => {
  test('no ghost row, and deleting what is shown never deletes the merged item', async () => {
    const server = new FakeServer();
    const a = uuid();
    const b = uuid();
    const h1 = household(server, a);
    const h2 = household(server, b);
    const clock = new FakeClock();
    const anna = await makeDevice(server, { userId: a, householdId: h1, clock });
    const bram = await makeDevice(server, { userId: b, householdId: h2, clock });
    // Anna's solo list has some history, so its seq is far ahead of Bram's household.
    const eieren = await anna.engine.addItem({ name: 'Eieren', quantity: 1, unit: 'stuk' });
    for (let i = 0; i < 30; i++) await anna.engine.incrementQuantity(eieren.itemId, 1);
    await anna.engine.syncNow();
    await bram.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    await bram.engine.syncNow();
    anna.transport.loseNextResponses(1);
    await anna.engine.addItem({ name: 'Brood', quantity: 2, unit: 'stuk' });
    await anna.engine.syncNow();
    anna.goOffline();

    // accept_invite on Anna's other phone: H1's open items move into H2, Brood merges into Bram's Brood.
    const x = [...server.items.values()].find((i) => i.household_id === h1 && i.name === 'Brood')!;
    const d = [...server.items.values()].find((i) => i.household_id === h2 && i.name === 'Brood')!;
    const H2 = server.households.get(h2)!;
    H2.last_seq += 1;
    d.quantity += x.quantity;
    d.server_seq = H2.last_seq;
    server.aliases.set(x.id, { household_id: h2, target_id: d.id });
    const e = [...server.items.values()].find((i) => i.household_id === h1 && i.name === 'Eieren')!;
    H2.last_seq += 1;
    e.household_id = h2;
    e.position = H2.last_seq;
    e.server_seq = H2.last_seq;
    server.items.delete(x.id);
    server.households.delete(h1);
    H2.members.add(a);

    anna.householdId = h2;
    await anna.restart();
    anna.goOnline();
    await anna.engine.syncNow();
    await anna.engine.syncNow();
    expect(serverNames(server, h2).sort()).toEqual(['Brood:3', 'Eieren:31']);
    expect(anna.names().sort()).toEqual(['Brood:3', 'Eieren:31']);
    expect(anna.engine.getStatus()).toMatchObject({ pendingCount: 0, failed: [] });
    await anna.restart();
    await anna.engine.syncNow();
    expect(anna.names().sort()).toEqual(['Brood:3', 'Eieren:31']);
  });
});

describe('undo of "Wissen" decides only from that clear', () => {
  test('an older clear of the same item does not bring back an item another member deleted', async () => {
    const { server, hh, anna, bram } = await twoDevices();
    const melk = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.setChecked(melk.itemId, true);
    await anna.engine.syncNow();
    const r1 = await anna.engine.clearChecked([melk.itemId]);
    await anna.engine.syncNow();
    await anna.engine.undo(r1.flatMap((r) => r.undo));
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    expect(server.list(hh).map((i) => `${i.name}:${i.checked}`)).toEqual(['Melk:true']);

    anna.goOffline();
    await bram.engine.deleteItem(melk.itemId);
    await bram.engine.syncNow();
    const r2 = await anna.engine.clearChecked([melk.itemId]);
    anna.goOnline();
    await anna.engine.syncNow();
    expect(server.list(hh)).toEqual([]);
    await anna.engine.undo(r2.flatMap((r) => r.undo));
    await anna.engine.syncNow();
    expect(server.list(hh)).toEqual([]); // Bram's delete stands
    expect(anna.engine.getStatus().failed).toEqual([]);
  });

  test('the undo still restores what this clear removed', async () => {
    const { server, hh, anna } = await twoDevices();
    const melk = await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await anna.engine.setChecked(melk.itemId, true);
    await anna.engine.syncNow();
    const r = await anna.engine.clearChecked([melk.itemId]);
    await anna.engine.syncNow();
    await anna.engine.undo(r.flatMap((x) => x.undo));
    await anna.engine.syncNow();
    expect(server.list(hh).map((i) => `${i.name}:${i.checked}`)).toEqual(['Melk:true']);
  });
});

describe('not_member: commands are still stored, never silently dropped', () => {
  test('an edit after not_member goes into the outbox and is listed by unsent()', async () => {
    const { server, hh, bram } = await twoDevices();
    server.removeMember(hh, bram.userId);
    await bram.engine.addItem({ name: 'Kaas', quantity: 1, unit: 'stuk' });
    await bram.engine.syncNow();
    const r = await bram.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    expect(r.outcome).toBe('added');
    expect(bram.names().sort()).toEqual(['Brood:1', 'Kaas:1']);
    expect(bram.engine.unsent().count).toBe(2);
  });
});
