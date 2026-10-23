/**
 * Engine against the real Postgres RPCs (apply_mutations / pull_changes, RLS) of the local stack.
 * Opt-in: GB_SYNC_PG=1 npx jest --selectProjects sync pg.integration  (requires `npm run db:start`).
 * Skipped (reported as skipped) otherwise, so `npm test` stays offline.
 */
import { Pool } from 'pg';
import type { Uuid } from '@/src/contracts';
import { createSyncEngine } from '../engine';
import { BetterSqliteFactory } from '../node/betterSqlite';
import { PgSyncTransport } from '../node/pgTransport';
import { ChaosTransport } from '../testing/chaosTransport';
import { FakeClock } from '../testing/fakeClock';
import type { GoedSyncEngine } from '../types';
import { ManualConnectivity } from '../util';
import { tempDir, uuid } from './harness';

const enabled = process.env.GB_SYNC_PG === '1';
const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const d = enabled ? describe : describe.skip;

d('engine x real Postgres RPCs', () => {
  const pool = new Pool({ connectionString: DB_URL, max: 6 });
  afterAll(() => pool.end());

  async function createUser(): Promise<Uuid> {
    const id = uuid();
    await pool.query(
      `insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
      [id, `sync-${id}@example.test`],
    );
    return id;
  }

  async function device(userId: Uuid, householdId: Uuid, clock: FakeClock) {
    const transport = new PgSyncTransport(pool, userId);
    const connectivity = new ManualConnectivity(true);
    const db = await new BetterSqliteFactory(tempDir()).open(userId);
    const engine: GoedSyncEngine = createSyncEngine(
      { db, transport, connectivity, userId, householdId, clock, uuid },
      { random: () => 0.5 },
    );
    await engine.start();
    await engine.syncNow();
    const offline = () => {
      transport.online = false;
      connectivity.set(false);
    };
    const online = () => {
      transport.online = true;
      connectivity.set(true);
    };
    const names = () => engine.getSnapshot().open.map((i) => `${i.name}:${i.quantity}`);
    return { engine, transport, offline, online, names };
  }

  async function sharedHousehold() {
    const a = await createUser();
    const b = await createUser();
    const ta = new PgSyncTransport(pool, a);
    const tb = new PgSyncTransport(pool, b);
    const created = await ta.call<{ ok: boolean; household: { id: Uuid } }>('select public.create_household() as r', []);
    const hh = created.household.id;
    const invite = await ta.call<{ code: string }>('select public.create_invite(p_household_id => $1) as r', [hh]);
    await tb.call('select public.create_household() as r', []);
    const accepted = await tb.call<{ ok: boolean }>('select public.accept_invite(p_code => $1) as r', [invite.code]);
    expect(accepted.ok).toBe(true);
    const clock = new FakeClock();
    return { hh, a, b, anna: await device(a, hh, clock), bram: await device(b, hh, clock) };
  }

  test('offline adds on two devices dedupe into one row with the summed quantity', async () => {
    const { anna, bram } = await sharedHousehold();
    anna.offline();
    bram.offline();
    await anna.engine.addItem({ name: 'Melk', quantity: 1, unit: 'stuk' });
    await bram.engine.addItem({ name: 'melk', quantity: 2, unit: 'stuk' });
    anna.online();
    bram.online();
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    await anna.engine.syncNow();
    expect(anna.names()).toEqual(['Melk:3']);
    expect(bram.names()).toEqual(['Melk:3']);
  });

  test('concurrent increments sum; delete beats a later edit; lost response replay is idempotent', async () => {
    const { anna, bram } = await sharedHousehold();
    const { itemId } = await anna.engine.addItem({ name: 'Bananen', quantity: 6, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    await anna.engine.incrementQuantity(itemId, 1);
    await bram.engine.incrementQuantity(itemId, 1);
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    await anna.engine.syncNow();
    expect(anna.names()).toEqual(['Bananen:8']);

    // lost response: apply, then pretend the reply never came
    await anna.engine.incrementQuantity(itemId, 2);
    const real = anna.transport.applyMutations.bind(anna.transport);
    let lost = false;
    anna.transport.applyMutations = async (req) => {
      const res = await real(req);
      if (!lost) {
        lost = true;
        throw new Error('connection reset');
      }
      return res;
    };
    await anna.engine.syncNow();
    await anna.engine.syncNow();
    expect(anna.names()).toEqual(['Bananen:10']);

    bram.offline();
    await bram.engine.updateItem(itemId, { note: 'rijp' });
    await anna.engine.deleteItem(itemId);
    await anna.engine.syncNow();
    bram.online();
    await bram.engine.syncNow();
    expect(bram.engine.getStatus().failed.map((f) => f.reason)).toEqual(['deleted']);
    expect(bram.names()).toEqual([]);
  });

  test('Wissen only clears ids still checked; undo of a merged add decrements', async () => {
    const { anna, bram } = await sharedHousehold();
    const x = await anna.engine.addItem({ name: 'X', quantity: 1, unit: 'stuk' });
    const y = await anna.engine.addItem({ name: 'Y', quantity: 1, unit: 'stuk' });
    await anna.engine.setChecked(x.itemId, true);
    await anna.engine.setChecked(y.itemId, true);
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    bram.offline();
    await anna.engine.setChecked(y.itemId, false);
    await anna.engine.syncNow();
    await bram.engine.clearChecked([x.itemId, y.itemId]);
    bram.online();
    await bram.engine.syncNow();
    expect(bram.names()).toEqual(['Y:1']);

    const m = await anna.engine.addItem({ name: 'y', quantity: 2, unit: 'stuk' });
    await anna.engine.syncNow();
    expect(anna.names()).toEqual(['Y:3']);
    await anna.engine.undo(m.undo);
    await anna.engine.syncNow();
    expect(anna.names()).toEqual(['Y:1']);
  });

  test('removed member: not_member keeps the outbox for unsent() and fires onMembershipLost', async () => {
    const { anna, bram, hh, b } = await sharedHousehold();
    const lost = jest.fn();
    bram.engine.onMembershipLost(lost);
    bram.offline();
    await bram.engine.addItem({ name: 'Wijn', quantity: 1, unit: 'stuk' });
    const removed = await (anna.transport as PgSyncTransport).call<{ ok: boolean }>(
      'select public.remove_member(p_household_id => $1, p_user_id => $2) as r',
      [hh, b],
    );
    expect(removed.ok).toBe(true);
    bram.online();
    await bram.engine.syncNow();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(bram.engine.unsent()).toMatchObject({ count: 1, text: expect.stringContaining('Wijn') });
  });

  test('household switched on another device: the next engine on the same file re-addresses the outbox via server aliases', async () => {
    const j = await createUser();
    const s = await createUser();
    const tj = new PgSyncTransport(pool, j);
    const ts = new PgSyncTransport(pool, s);
    const own = (await tj.call<{ household: { id: Uuid } }>('select public.create_household() as r', [])).household.id;
    const target = (await ts.call<{ household: { id: Uuid } }>('select public.create_household() as r', [])).household.id;
    const invite = await ts.call<{ code: string }>('select public.create_invite(p_household_id => $1) as r', [target]);
    const dir = tempDir();
    const clock = new FakeClock();
    const open = async (hh: Uuid) => {
      const connectivity = new ManualConnectivity(true);
      const transport = new PgSyncTransport(pool, j);
      const db = await new BetterSqliteFactory(dir).open(j);
      const engine = createSyncEngine({ db, transport, connectivity, userId: j, householdId: hh, clock, uuid }, { random: () => 0.5 });
      await engine.start();
      await engine.syncNow();
      return { engine, transport, connectivity };
    };
    const phoneB = await open(own);
    const melk = await phoneB.engine.addItem({ name: 'Melk', quantity: 2, unit: 'stuk' });
    await phoneB.engine.syncNow();
    phoneB.transport.online = false;
    phoneB.connectivity.set(false);
    await phoneB.engine.setChecked(melk.itemId, true); // an edit of an item the accept will move
    await phoneB.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
    // Phone A accepts the invite: open items move to the new household (with aliases), the old one is deleted.
    const accepted = await tj.call<{ ok: boolean; moved_items: number }>('select public.accept_invite(p_code => $1) as r', [invite.code]);
    expect(accepted).toMatchObject({ ok: true, moved_items: 1 });
    const lost = jest.fn();
    phoneB.engine.onMembershipLost(lost);
    phoneB.transport.online = true;
    phoneB.connectivity.set(true);
    await phoneB.engine.syncNow();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(phoneB.engine.unsent().count).toBe(2); // kept, not thrown away
    await phoneB.engine.dispose();

    const next = await open(target);
    await next.engine.syncNow();
    expect(next.engine.getStatus()).toMatchObject({ pendingCount: 0, failed: [] });
    expect(next.engine.getSnapshot().open.map((i) => i.name)).toEqual(['Brood']);
    expect(next.engine.getSnapshot().checked.map((i) => `${i.name}:${i.quantity}`)).toEqual(['Melk:2']);
    await next.engine.dispose();
  });

  test('reset_required after a real purge: local list rebuilt, outbox kept', async () => {
    const { anna, bram } = await sharedHousehold();
    const x = await anna.engine.addItem({ name: 'Weg', quantity: 1, unit: 'stuk' });
    await anna.engine.addItem({ name: 'Blijft', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await bram.engine.syncNow();
    bram.offline();
    await bram.engine.addItem({ name: 'Nieuw', quantity: 1, unit: 'stuk' });
    await anna.engine.deleteItem(x.itemId);
    await anna.engine.syncNow();
    await pool.query("select private.purge(interval '0 seconds')");
    bram.online();
    await bram.engine.syncNow();
    expect(bram.names().sort()).toEqual(['Blijft:1', 'Nieuw:1']);
    expect(anna.engine.getStatus().failed).toEqual([]);
  });

  test('an id that exists in another household is rejected without leaking', async () => {
    const one = await sharedHousehold();
    const two = await sharedHousehold();
    const secret = await two.anna.engine.addItem({ name: 'Geheim', quantity: 1, unit: 'stuk' });
    await two.anna.engine.syncNow();
    // A crafted mutation from household one that targets household two's item id.
    const res = await one.anna.transport.applyMutations({
      household_id: one.hh,
      mutations: [
        { id: uuid(), household_id: one.hh, kind: 'delete_item', payload: { item_id: secret.itemId }, client_created_at: new Date().toISOString() },
        { id: uuid(), household_id: one.hh, kind: 'add_item', payload: { id: secret.itemId, name: 'x', quantity: 1, unit: 'stuk' }, client_created_at: new Date().toISOString() },
      ],
    });
    expect(res.ok && res.results.map((r) => [r.status, r.reason])).toEqual([
      ['rejected', 'not_found'],
      ['rejected', 'invalid'],
    ]);
    await two.anna.engine.syncNow();
    expect(two.anna.names()).toEqual(['Geheim:1']);
  });

  test('chaos: random edits, lost responses, 5xx, offline and restarts converge to the server state', async () => {
    const extra = Number(process.env.GB_FUZZ_SEEDS ?? 0);
    for (const seed of [11, 23, 57, ...Array.from({ length: extra }, (_, i) => 500 + i)]) {
      let st = seed;
      const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const a = await createUser();
      const b = await createUser();
      const ta = new PgSyncTransport(pool, a);
      const hh = (await ta.call<{ household: { id: Uuid } }>('select public.create_household() as r', [])).household.id;
      const code = (await ta.call<{ code: string }>('select public.create_invite(p_household_id => $1) as r', [hh])).code;
      await new PgSyncTransport(pool, b).call('select public.accept_invite(p_code => $1) as r', [code]);
      const clock = new FakeClock();
      class ChaosDevice {
        factory = new BetterSqliteFactory(tempDir());
        transport: ChaosTransport;
        connectivity = new ManualConnectivity(true);
        e!: GoedSyncEngine;
        d!: Awaited<ReturnType<BetterSqliteFactory['open']>>;
        constructor(readonly userId: Uuid) {
          this.transport = new ChaosTransport(new PgSyncTransport(pool, userId));
        }
        async boot() {
          this.d = await this.factory.open(this.userId);
          this.e = createSyncEngine(
            { db: this.d, transport: this.transport, connectivity: this.connectivity, userId: this.userId, householdId: hh, clock, uuid },
            { random: () => 0.5, batchSize: 3, pullPageSize: 4 },
          );
          await this.e.start();
        }
        async restart() {
          await this.e.whenIdle();
          void this.e.stop();
          this.d.kill();
          await this.boot();
        }
      }
      const devs = [new ChaosDevice(a), new ChaosDevice(b)];
      for (const dv of devs) await dv.boot();
      const NAMES = ['Melk', 'melk', 'Brood', 'Kaas', 'Eieren'];
      for (let step = 0; step < 80; step++) {
        const dev = pick(devs);
        const snap = dev.e.getSnapshot();
        const all = [...snap.open, ...snap.checked];
        const any = all.length ? pick(all) : null;
        const r = rnd();
        if (r < 0.35) await dev.e.addItem({ name: pick(NAMES), quantity: 1 + Math.floor(rnd() * 3), unit: pick(['stuk', 'kg'] as const) });
        else if (r < 0.45 && any) await dev.e.incrementQuantity(any.id, pick([1, 2, -1]));
        else if (r < 0.55 && any) await dev.e.setChecked(any.id, !any.checked);
        else if (r < 0.6 && any) await dev.e.updateItem(any.id, { note: pick(['', 'bio']) });
        else if (r < 0.66 && any) {
          const res = await dev.e.deleteItem(any.id);
          if (rnd() < 0.3) await dev.e.undo(res.undo);
        } else if (r < 0.7 && snap.checked.length) await dev.e.clearChecked(snap.checked.map((i) => i.id));
        else if (r < 0.78) {
          dev.transport.online = !dev.transport.online;
          dev.connectivity.set(dev.transport.online);
        } else if (r < 0.83) dev.transport.loseNextResponses(1);
        else if (r < 0.86) dev.transport.failNext(1);
        else if (r < 0.9) await dev.restart();
        else {
          await clock.advance(Math.floor(rnd() * 3000));
          await dev.e.whenIdle();
        }
      }
      for (const dev of devs) {
        dev.transport.heal();
        dev.connectivity.set(true);
      }
      for (let round = 0; round < 4; round++) {
        await clock.advance(61_000);
        for (const dev of devs) await dev.e.syncNow();
      }
      const rows = await pool.query(
        'select id, name, quantity::float8 as quantity, unit, note, checked from public.list_items where household_id = $1 and deleted_at is null',
        [hh],
      );
      const serverView = rows.rows.map((i) => `${i.id}|${i.name}|${i.quantity}|${i.unit}|${i.note}|${i.checked}`).sort();
      for (const dev of devs) {
        const s = dev.e.getSnapshot();
        const v = [...s.open, ...s.checked].map((i) => `${i.id}|${i.name}|${i.quantity}|${i.unit}|${i.note}|${i.checked}`).sort();
        expect(v).toEqual(serverView);
        expect(dev.e.getStatus().pendingCount).toBe(0);
        // Legit concurrent outcomes only: edits of a row deleted elsewhere, or a -1 that the
        // server state (changed elsewhere) would take to 0.
        for (const f of dev.e.getStatus().failed) expect(`${f.kind}:${f.reason}`).toMatch(/:deleted$|^increment_quantity:invalid$/);
        await dev.e.dispose();
      }
    }
  }, 60_000);
});
