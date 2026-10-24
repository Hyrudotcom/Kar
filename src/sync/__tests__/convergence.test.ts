/**
 * Randomized convergence: three devices do random edits while going offline, losing responses,
 * getting 5xx, and being killed. After everyone reconnects and syncs, every device shows exactly
 * the server's list and every outbox is empty.
 */
import type { Unit } from '@/src/contracts';
import { FakeClock } from '../testing/fakeClock';
import { FakeServer } from '../testing/fakeServer';
import { household, makeDevice, uuid, type Device } from './harness';

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const NAMES = ['Melk', 'melk', 'Brood', 'Kaas', 'Eieren', 'Appels', 'Bananen', 'Koffie'];
const UNITS: Unit[] = ['stuk', 'stuk', 'stuk', 'kg', 'l'];

function view(dev: Device) {
  const s = dev.engine.getSnapshot();
  return [...s.open, ...s.checked]
    .map((i) => `${i.id}|${i.name}|${i.quantity}|${i.unit}|${i.note}|${i.checked}|${i.exclude_from_comparison}`)
    .sort();
}

async function scenario(seed: number) {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const server = new FakeServer();
  const users = [uuid(), uuid(), uuid()];
  const hh = household(server, ...users);
  const clock = new FakeClock();
  const devices: Device[] = [];
  // Odd seeds use tiny batches and pages to stress batching, pagination and partial acks.
  const engine = seed % 2 ? { batchSize: 1 + Math.floor(rnd() * 4), pullPageSize: 2 + Math.floor(rnd() * 4) } : undefined;
  for (const u of users) devices.push(await makeDevice(server, { userId: u, householdId: hh, clock, engine }));

  for (let step = 0; step < 160; step++) {
    const dev = pick(devices);
    const snap = dev.engine.getSnapshot();
    const all = [...snap.open, ...snap.checked];
    const any = all.length ? pick(all) : null;
    const r = rnd();
    if (r < 0.3) await dev.engine.addItem({ name: pick(NAMES), quantity: 1 + Math.floor(rnd() * 3), unit: pick(UNITS) });
    else if (r < 0.4 && any) await dev.engine.incrementQuantity(any.id, pick([1, 1, 2, -1]));
    else if (r < 0.5 && any) await dev.engine.setChecked(any.id, !any.checked);
    else if (r < 0.57 && any) await dev.engine.updateItem(any.id, pick([{ quantity: 1 + Math.floor(rnd() * 5) }, { note: pick(['', 'bio', 'groot']) }, { name: pick(NAMES) }]));
    else if (r < 0.63 && any) {
      const res = await dev.engine.deleteItem(any.id);
      if (rnd() < 0.3) await dev.engine.undo(res.undo);
    } else if (r < 0.67 && snap.checked.length) await dev.engine.clearChecked(snap.checked.map((i) => i.id));
    else if (r < 0.7) {
      const res = await dev.engine.addItem({ name: pick(NAMES), quantity: 1, unit: 'stuk' });
      await dev.engine.undo(res.undo);
    } else if (r < 0.78) {
      if (dev.connectivity.isOnline()) dev.goOffline();
      else dev.goOnline();
    } else if (r < 0.82) dev.transport.loseNextResponses(1);
    else if (r < 0.85) dev.transport.failNext(1);
    else if (r < 0.88) await dev.restart();
    else await clock.advance(Math.floor(rnd() * 3000));
    await Promise.resolve();
  }

  // Everyone comes back and settles.
  for (const d of devices) {
    d.transport.heal();
    d.goOnline();
  }
  for (let round = 0; round < 4; round++) {
    await clock.advance(61_000);
    for (const d of devices) await d.engine.syncNow();
  }

  const serverView = [...server.items.values()]
    .filter((i) => i.household_id === hh && i.deleted_at === null)
    .map((i) => `${i.id}|${i.name}|${i.quantity}|${i.unit}|${i.note}|${i.checked}|${i.exclude_from_comparison}`)
    .sort();
  for (const d of devices) {
    expect(view(d)).toEqual(serverView);
    expect(d.engine.getStatus().pendingCount).toBe(0);
    expect(await d.db.all("select id from outbox where state = 'pending'")).toEqual([]);
    for (const f of d.engine.getStatus().failed) expect(`${f.kind}:${f.reason}`).toMatch(/:deleted$|^increment_quantity:invalid$/);
  }
  // No mutation was ever applied twice: every logged result is unique per id by construction, and
  // a replayed delivery must not have bumped anything. Check the seq is consistent with the rows.
  if (process.env.GB_FUZZ_DEBUG) {
    const replays = [...server.deliveries.values()].filter((n) => n > 1).length;
    console.log(seed, { items: serverView.length, replays, failed: devices.flatMap((d) => d.engine.getStatus().failed.map((f) => `${f.kind}:${f.reason}`)), seq: server.households.get(hh)!.last_seq });
  }
  const h = server.households.get(hh)!;
  const maxRowSeq = Math.max(0, ...[...server.items.values()].filter((i) => i.household_id === hh).map((i) => i.server_seq));
  expect(maxRowSeq).toBeLessThanOrEqual(h.last_seq);
}

describe('convergence under chaos', () => {
  // GB_FUZZ_SEEDS=500 runs many more seeds locally.
  const extra = Number(process.env.GB_FUZZ_SEEDS ?? 0);
  const seeds = [1, 2, 3, 7, 42, 1234, 9999, 31337, ...Array.from({ length: extra }, (_, i) => 100_000 + i)];
  for (const seed of seeds) {
    test(`seed ${seed}`, async () => {
      await scenario(seed);
    });
  }
});
