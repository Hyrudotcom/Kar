/**
 * (a) Two users in one household edit at the same time and converge to identical state.
 * (b) A client offline for many edits reconnects: nothing lost, no duplicates.
 * Real GoTrue users, real RPCs/RLS, real Realtime nudges, real sync engine on SQLite files.
 */
import type { Uuid } from '@/src/contracts';

import {
  closeAll,
  db,
  ensureHousehold,
  inviteAndJoin,
  openDevice,
  serverRows,
  settle,
  signInUser,
  sleep,
  waitFor,
  type Device,
} from './stack';

jest.setTimeout(120_000);

let devices: Device[] = [];
afterEach(async () => {
  for (const d of devices) await d.dispose();
  devices = [];
});
afterAll(closeAll);

async function sharedHousehold(): Promise<{ hh: Uuid; anna: Device; bram: Device }> {
  const a = await signInUser('anna');
  const b = await signInUser('bram');
  const hh = await ensureHousehold(a.client);
  await inviteAndJoin(a, b, hh);
  const anna = await openDevice(a, hh);
  const bram = await openDevice(b, hh);
  devices.push(anna, bram);
  await settle([anna, bram]);
  return { hh, anna, bram };
}

async function expectConverged(hh: Uuid, ...ds: Device[]) {
  await settle(ds);
  const truth = await serverRows(hh);
  for (const d of ds) expect(d.view()).toEqual(truth);
  return truth;
}

const byName = (d: Device, name: string) => {
  const s = d.engine.getSnapshot();
  const it = [...s.open, ...s.checked].find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (!it) throw new Error(`no ${name} on ${d.user.email}`);
  return it;
};

describe('(a) two users editing simultaneously', () => {
  test('different items in parallel, while both online: identical lists, realtime delivers the other side', async () => {
    const { hh, anna, bram } = await sharedHousehold();
    const annaItems = ['Melk', 'Brood', 'Eieren', 'Kaas', 'Appels', 'Rijst', 'Pasta', 'Tomaten', 'Uien', 'Koffie'];
    const bramItems = ['Bananen', 'Yoghurt', 'Boter', 'Thee', 'Wc-papier', 'Afwasmiddel', 'Paprika', 'Kipfilet', 'Sla', 'Hagelslag'];
    await Promise.all([
      (async () => {
        for (const n of annaItems) await anna.engine.addItem({ name: n, quantity: 1, unit: 'stuk' });
      })(),
      (async () => {
        for (const n of bramItems) await bram.engine.addItem({ name: n, quantity: 2, unit: 'stuk' });
      })(),
    ]);
    // Without any explicit pull, Anna sees Bram's items through the Realtime nudge.
    await waitFor(() => anna.engine.getSnapshot().open.length === 20 && bram.engine.getSnapshot().open.length === 20, 15_000, 'realtime fan-out');
    const truth = await expectConverged(hh, anna, bram);
    expect(truth).toHaveLength(20);
  });

  test('same item: concurrent +1s are deltas (no lost increments), exact quantity is last-writer-wins by server order', async () => {
    const { hh, anna, bram } = await sharedHousehold();
    await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await expectConverged(hh, anna, bram);
    const melk = byName(bram, 'Melk').id;
    await Promise.all([
      (async () => {
        for (let i = 0; i < 15; i++) await anna.engine.incrementQuantity(melk, 1);
      })(),
      (async () => {
        for (let i = 0; i < 10; i++) await bram.engine.incrementQuantity(melk, 1);
      })(),
    ]);
    await expectConverged(hh, anna, bram);
    expect(byName(anna, 'Melk').quantity).toBe(26);

    // Exact set from both sides: whichever the server applied last wins, everywhere.
    await anna.engine.updateItem(melk, { quantity: 3 });
    await anna.engine.syncNow();
    await bram.engine.updateItem(melk, { quantity: 7 });
    await expectConverged(hh, anna, bram);
    expect(byName(anna, 'Melk').quantity).toBe(7);
  });

  test('both add "melk" while offline: one row with the summed quantity', async () => {
    const { hh, anna, bram } = await sharedHousehold();
    anna.offline();
    bram.offline();
    await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await bram.engine.addItem({ name: 'melk ', quantity: 2, unit: 'stuk' });
    anna.online();
    bram.online();
    const truth = await expectConverged(hh, anna, bram);
    expect(truth).toHaveLength(1);
    expect(byName(anna, 'Melk').quantity).toBe(3);
  });

  test('check / uncheck races converge to the state the server applied last', async () => {
    const { hh, anna, bram } = await sharedHousehold();
    for (const n of ['Melk', 'Brood', 'Kaas']) await anna.engine.addItem({ name: n, quantity: 1, unit: 'stuk' });
    await expectConverged(hh, anna, bram);
    const ids = ['Melk', 'Brood', 'Kaas'].map((n) => byName(bram, n).id);
    // Interleaved toggles from both users, online, no waiting.
    await Promise.all([
      (async () => {
        for (let i = 0; i < 6; i++) await anna.engine.setChecked(ids[i % 3]!, i % 2 === 0);
      })(),
      (async () => {
        for (let i = 0; i < 6; i++) await bram.engine.setChecked(ids[(i + 1) % 3]!, i % 2 === 1);
      })(),
    ]);
    await expectConverged(hh, anna, bram);
    // And a deterministic race on an unchecked row: Bram checks it while offline; Anna checks and
    // unchecks it online afterwards. Bram's change reaches the server last, so checked wins everywhere.
    await anna.engine.setChecked(ids[0]!, false);
    await expectConverged(hh, anna, bram);
    bram.offline();
    await bram.engine.setChecked(ids[0]!, true);
    await anna.engine.setChecked(ids[0]!, true);
    await anna.engine.setChecked(ids[0]!, false);
    await anna.engine.syncNow();
    expect(byName(anna, 'Melk').checked).toBe(false);
    bram.online();
    await expectConverged(hh, anna, bram);
    expect(byName(anna, 'Melk').checked).toBe(true);
  });

  test('delete vs edit: delete wins, the edit is reported as failed, both lists identical', async () => {
    const { hh, anna, bram } = await sharedHousehold();
    await anna.engine.addItem({ name: 'Chips', quantity: 1, unit: 'stuk' });
    await expectConverged(hh, anna, bram);
    const chips = byName(bram, 'Chips').id;
    bram.offline();
    await bram.engine.updateItem(chips, { name: 'Paprikachips', note: 'grote zak' });
    await bram.engine.incrementQuantity(chips, 1);
    await anna.engine.deleteItem(chips);
    await anna.engine.syncNow();
    bram.online();
    const truth = await expectConverged(hh, anna, bram);
    expect(truth).toEqual([]);
    const failed = bram.engine.getStatus().failed;
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed.every((f) => f.reason === 'deleted')).toBe(true);
    expect(bram.engine.getStatus().icon).toBe('error');
    const { rows } = await db().query('select deleted_at is not null as deleted, name from public.list_items where id = $1', [chips]);
    expect(rows[0]).toEqual({ deleted: true, name: 'Chips' });
  });

  test('"Wissen" vs uncheck by the other user: only rows still checked on the server are removed', async () => {
    const { hh, anna, bram } = await sharedHousehold();
    for (const n of ['Melk', 'Brood']) await anna.engine.addItem({ name: n, quantity: 1, unit: 'stuk' });
    await expectConverged(hh, anna, bram);
    for (const n of ['Melk', 'Brood']) await anna.engine.setChecked(byName(anna, n).id, true);
    await expectConverged(hh, anna, bram);
    const onScreen = anna.engine.getSnapshot().checked.map((i) => i.id);
    bram.offline();
    await bram.engine.setChecked(byName(bram, 'Brood').id, false);
    bram.online();
    await bram.engine.syncNow();
    await anna.engine.clearChecked(onScreen);
    const truth = await expectConverged(hh, anna, bram);
    expect(truth.map((r) => r.split('|')[1])).toEqual(['Brood']);
  });
});

describe('realtime after an engine restart', () => {
  test('an engine reopened right away on the same Supabase client still gets realtime nudges', async () => {
    const a = await signInUser('rt-anna');
    const b = await signInUser('rt-bram');
    const hh = await ensureHousehold(a.client);
    await inviteAndJoin(a, b, hh);
    const anna = await openDevice(a, hh);
    const bram = await openDevice(b, hh, { periodicPullMs: 10 * 60_000 });
    devices.push(anna, bram);
    await settle([anna, bram]);
    // The app restarts the engine for the same household (e.g. re-establishing the session):
    // dispose, then immediately a new engine that subscribes to the same channel topics.
    await bram.engine.dispose();
    bram.engine = (await openDevice(b, hh, { dir: bram.dir, periodicPullMs: 10 * 60_000 })).engine;
    await settle([bram]);
    await sleep(1_000);
    await anna.engine.addItem({ name: 'Na herstart', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    // Bram does nothing: only a realtime nudge can bring the item in.
    await waitFor(() => bram.engine.getSnapshot().open.some((i) => i.name === 'Na herstart'), 10_000, 'nudge after restart');
  });
});

describe('(b) long offline session', () => {
  test('150 mixed edits offline (with an app restart in between) are all applied once after reconnecting', async () => {
    const { hh, anna, bram } = await sharedHousehold();
    // Some shared state first.
    for (const n of ['Melk', 'Brood', 'Kaas', 'Eieren']) await anna.engine.addItem({ name: n, quantity: 1, unit: 'stuk' });
    await expectConverged(hh, anna, bram);

    bram.offline();
    let ops = 0;
    for (let i = 0; i < 60; i++) {
      await bram.engine.addItem({ name: `Product ${i}`, quantity: (i % 3) + 1, unit: i % 4 === 0 ? 'kg' : 'stuk' });
      ops++;
    }
    for (let i = 0; i < 10; i++) {
      await bram.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' }); // merges into the shared row
      ops++;
    }
    const melk = byName(bram, 'Melk').id;
    for (let i = 0; i < 20; i++) {
      await bram.engine.incrementQuantity(melk, 1);
      ops++;
    }
    // App killed and reopened while offline: the outbox survives.
    const before = bram.view();
    await bram.restart();
    expect(bram.view()).toEqual(before);
    for (let i = 0; i < 30; i += 2) {
      await bram.engine.setChecked(byName(bram, `Product ${i}`).id, true);
      ops++;
    }
    for (let i = 1; i < 30; i += 3) {
      await bram.engine.deleteItem(byName(bram, `Product ${i}`).id);
      ops++;
    }
    for (let i = 30; i < 60; i += 2) {
      await bram.engine.updateItem(byName(bram, `Product ${i}`).id, { note: `notitie ${i}` });
      ops++;
    }
    while (ops < 150) {
      await bram.engine.incrementQuantity(byName(bram, 'Kaas').id, 1);
      ops++;
    }
    expect(bram.engine.getStatus().pendingCount).toBe(150);
    const expected = bram.view();

    bram.online();
    const truth = await expectConverged(hh, anna, bram);
    // Exactly what Bram saw offline is now the server state and Anna's state.
    expect(truth).toEqual(expected);
    expect(bram.engine.getStatus().failed).toEqual([]);
    expect(byName(anna, 'Melk').quantity).toBe(1 + 10 + 20);
    // No duplicates: one open row per (normalized_name, unit), and every mutation stored once.
    const dup = await db().query(
      `select normalized_name, unit, count(*) from public.list_items
        where household_id = $1 and deleted_at is null and not checked group by 1, 2 having count(*) > 1`,
      [hh],
    );
    expect(dup.rows).toEqual([]);
    const applied = bram.transport.results.flatMap((r) => (r.ok ? r.results : []));
    expect(applied.filter((r) => r.status !== 'applied' && r.status !== 'merged' && r.status !== 'restored')).toEqual([]);
    expect(new Set(applied.map((r) => r.id)).size).toBe(150);
    // Batches respect the 100-mutation limit.
    expect(bram.transport.results.length).toBeGreaterThanOrEqual(2);
  });
});
