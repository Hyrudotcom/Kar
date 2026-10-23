/**
 * apply_mutations semantics (docs/architecture.md 4.1): dedupe, idempotent replay, delete wins,
 * quantity deltas, per-field LWW, clear_checked, validation, retry, serialization.
 */
import { Client } from 'pg';
import {
  DB_URL,
  addItem,
  admin,
  apply,
  closePool,
  createHousehold,
  itemRow,
  lastSeq,
  mutation,
  pool,
  rpc,
  uuid,
} from './_helpers';

afterAll(closePool);

const add = (hid: string, name: string, quantity = 1, unit: 'stuk' | 'g' | 'kg' | 'ml' | 'l' = 'stuk', id = uuid(), note?: string) =>
  mutation(hid, 'add_item', { id, name, quantity, unit, ...(note !== undefined ? { note } : {}) });

describe('batch level', () => {
  test('not_authenticated, invalid_batch, not_member', async () => {
    const H = await createHousehold();
    expect(await apply(null as any, H.hid, []).catch((e) => e.code)).toBe('42501');
    expect(await apply(H.owner, H.hid, [])).toEqual({ ok: false, error: 'invalid_batch' });
    const many = Array.from({ length: 101 }, () => add(H.hid, 'x'));
    expect(await apply(H.owner, H.hid, many)).toEqual({ ok: false, error: 'invalid_batch' });
    expect(await rpc(H.owner, 'apply_mutations', { batch: { household_id: 'nope', mutations: [add(H.hid, 'x')] } })).toEqual({ ok: false, error: 'invalid_batch' });
    expect(await rpc(H.owner, 'apply_mutations', { batch: [1, 2] })).toEqual({ ok: false, error: 'invalid_batch' });
    expect(await apply(H.owner, H.hid, [{ ...add(H.hid, 'x'), id: 'not-a-uuid' }])).toEqual({ ok: false, error: 'invalid_batch' });
    expect(await apply(H.owner, H.hid, [{ kind: 'add_item' }])).toEqual({ ok: false, error: 'invalid_batch' });
    expect(await apply(H.owner, uuid(), [add(H.hid, 'x')])).toEqual({ ok: false, error: 'not_member' });
    // nothing applied by any of these
    expect(await lastSeq(H.hid)).toBe(0);
  });

  test('exactly 100 mutations are accepted, response server_seq = last_seq', async () => {
    const H = await createHousehold();
    const batch = Array.from({ length: 100 }, (_, i) => add(H.hid, `item ${i}`));
    const r = await apply(H.owner, H.hid, batch);
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(100);
    expect(r.server_seq).toBe(100);
    expect(r.results.map((x: any) => x.server_seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });
});

describe('add_item', () => {
  test('insert sets position = server_seq, created_by/updated_by, trimmed name', async () => {
    const H = await createHousehold();
    const id = uuid();
    const r = await apply(H.owner, H.hid, [add(H.hid, '  Crème Fraîche ', 2, 'stuk', id, 'halfvol')]);
    expect(r.results[0]).toEqual({ id: expect.any(String), status: 'applied', item_id: id, server_seq: 1 });
    const row = await itemRow(id);
    expect(row).toMatchObject({ name: 'Crème Fraîche', normalized_name: 'creme fraiche', quantity: '2.000', unit: 'stuk',
      note: 'halfvol', checked: false, position: '1', server_seq: '1', created_by: H.owner, updated_by: H.owner, deleted_at: null });
  });

  test('dedupe: open item with same normalized name + unit -> merged, quantity summed, alias recorded', async () => {
    const H = await createHousehold(2);
    const first = await addItem(H.owner, H.hid, 'Melk', 1);
    const aliasId = uuid();
    const r = await apply(H.members[0]!, H.hid, [add(H.hid, '  MELK ', 2, 'stuk', aliasId)]);
    expect(r.results[0]).toMatchObject({ status: 'merged', item_id: first, server_seq: 2 });
    expect((await itemRow(first)).quantity).toBe('3.000');
    expect(await itemRow(aliasId)).toBeNull();
    expect(await admin(`select target_id from private.item_aliases where alias_id = $1`, [aliasId])).toEqual([{ target_id: first }]);
    // other unit -> new row
    const g = await addItem(H.owner, H.hid, 'melk', 500, 'ml');
    expect(g).not.toBe(first);
    const count = await admin(`select count(*)::int as n from public.list_items where household_id = $1`, [H.hid]);
    expect(count[0].n).toBe(2);
  });

  test('two offline devices adding "melk" -> one row with summed quantity', async () => {
    const H = await createHousehold(2);
    const r1 = await apply(H.owner, H.hid, [add(H.hid, 'melk', 1)]);
    const r2 = await apply(H.members[0]!, H.hid, [add(H.hid, 'Melk', 1)]);
    expect(r1.results[0].status).toBe('applied');
    expect(r2.results[0].status).toBe('merged');
    const rows = await admin(`select quantity from public.list_items where household_id = $1 and deleted_at is null`, [H.hid]);
    expect(rows).toEqual([{ quantity: '2.000' }]);
  });

  test('checked duplicate -> restored with the typed quantity and new top position; note only replaced when given', async () => {
    const H = await createHousehold();
    const id = uuid();
    await apply(H.owner, H.hid, [add(H.hid, 'Kaas', 3, 'stuk', id, 'jong belegen')]);
    await addItem(H.owner, H.hid, 'Brood');
    await apply(H.owner, H.hid, [mutation(H.hid, 'set_checked', { item_id: id, checked: true })]);
    const r = await apply(H.owner, H.hid, [add(H.hid, 'kaas', 1)]);
    expect(r.results[0]).toMatchObject({ status: 'restored', item_id: id, server_seq: 4 });
    expect(await itemRow(id)).toMatchObject({ checked: false, checked_at: null, quantity: '1.000', position: '4', note: 'jong belegen' });
    await apply(H.owner, H.hid, [mutation(H.hid, 'set_checked', { item_id: id, checked: true })]);
    await apply(H.owner, H.hid, [add(H.hid, 'kaas', 2, 'stuk', uuid(), 'oud')]);
    expect((await itemRow(id)).note).toBe('oud');
  });

  test('deleted duplicates are not revived: a new row is inserted', async () => {
    const H = await createHousehold();
    const old = await addItem(H.owner, H.hid, 'Eieren');
    await apply(H.owner, H.hid, [mutation(H.hid, 'delete_item', { item_id: old })]);
    const r = await apply(H.owner, H.hid, [add(H.hid, 'eieren', 6)]);
    expect(r.results[0].status).toBe('applied');
    expect(r.results[0].item_id).not.toBe(old);
    expect((await itemRow(old)).deleted_at).not.toBeNull();
  });

  test('same item id under a new mutation id -> idempotent applied, no change, no seq bump', async () => {
    const H = await createHousehold();
    const id = uuid();
    await apply(H.owner, H.hid, [add(H.hid, 'Rijst', 1, 'stuk', id)]);
    const seq = await lastSeq(H.hid);
    const r = await apply(H.owner, H.hid, [add(H.hid, 'Rijst', 5, 'stuk', id)]);
    expect(r.results[0]).toMatchObject({ status: 'applied', item_id: id });
    expect(r.results[0].server_seq).toBeUndefined();
    expect((await itemRow(id)).quantity).toBe('1.000');
    expect(await lastSeq(H.hid)).toBe(seq);
  });

  test('re-adding with the alias id resolves to the target, no double merge', async () => {
    const H = await createHousehold();
    const target = await addItem(H.owner, H.hid, 'Boter');
    const aliasId = uuid();
    await apply(H.owner, H.hid, [add(H.hid, 'boter', 1, 'stuk', aliasId)]);
    const r = await apply(H.owner, H.hid, [add(H.hid, 'boter', 1, 'stuk', aliasId)]);
    expect(r.results[0]).toMatchObject({ status: 'applied', item_id: target });
    expect((await itemRow(target)).quantity).toBe('2.000');
  });

  test('validation: rejected/invalid and stored, rest of the batch continues', async () => {
    const H = await createHousehold();
    const bad = [
      add(H.hid, '', 1),
      add(H.hid, '   ', 1),
      add(H.hid, 'x'.repeat(121), 1),
      add(H.hid, 'Melk', 0),
      add(H.hid, 'Melk', -1),
      add(H.hid, 'Melk', 100000),
      add(H.hid, 'Melk', 0.0004),
      add(H.hid, 'Melk', 1, 'doos' as any),
      add(H.hid, 'Melk', 1, 'stuk', uuid(), 'n'.repeat(141)),
      { ...add(H.hid, 'Melk', 1), payload: { id: 'nope', name: 'Melk', quantity: 1, unit: 'stuk' } },
      { ...add(H.hid, 'Melk', 1), payload: { id: uuid(), name: 'Melk', quantity: '2', unit: 'stuk' } },
      { ...add(H.hid, 'Melk', 1), kind: 'drop_table' },
      { ...add(H.hid, 'Melk', 1), payload: 'string' },
      { ...add(H.hid, 'Melk', 1), household_id: 'nope' },
    ];
    const good = add(H.hid, 'Melk', 1.2345);
    const r = await apply(H.owner, H.hid, [...bad, good]);
    expect(r.ok).toBe(true);
    for (let i = 0; i < bad.length; i++) {
      expect([i, r.results[i].status, r.results[i].reason]).toEqual([i, 'rejected', 'invalid']);
    }
    expect(r.results[bad.length].status).toBe('applied');
    expect((await itemRow(good.payload.id as string)).quantity).toBe('1.235');
    const stored = await admin(`select count(*)::int as n from private.mutations where household_id = $1`, [H.hid]);
    expect(stored[0].n).toBe(bad.length + 1);
  });

  test('merge that would exceed 99999 is rejected/invalid and leaves the row alone', async () => {
    const H = await createHousehold();
    const id = await addItem(H.owner, H.hid, 'Suiker', 99990, 'g');
    const r = await apply(H.owner, H.hid, [add(H.hid, 'suiker', 10, 'g')]);
    expect(r.results[0]).toMatchObject({ status: 'rejected', reason: 'invalid' });
    expect((await itemRow(id)).quantity).toBe('99990.000');
    expect(await admin(`select count(*)::int as n from private.item_aliases where target_id = $1`, [id])).toEqual([{ n: 0 }]);
  });
});

describe('idempotent replay', () => {
  test('replaying a whole batch after a lost response returns the stored results with replayed:true and changes nothing', async () => {
    const H = await createHousehold();
    const item = await addItem(H.owner, H.hid, 'Yoghurt');
    const batch = [
      add(H.hid, 'yoghurt', 2),
      mutation(H.hid, 'increment_quantity', { item_id: item, delta: 1 }),
      add(H.hid, 'Pasta', 1),
      mutation(H.hid, 'update_item', { item_id: item, fields: { note: 'Grieks' } }),
      add(H.hid, '', 1),
    ];
    const first = await apply(H.owner, H.hid, batch);
    const rowAfterFirst = await itemRow(item);
    const seq = await lastSeq(H.hid);
    const second = await apply(H.owner, H.hid, batch);
    expect(second.results).toEqual(first.results.map((x: any) => ({ ...x, replayed: true })));
    expect(await itemRow(item)).toEqual(rowAfterFirst);
    expect(rowAfterFirst.quantity).toBe('4.000');
    expect(await lastSeq(H.hid)).toBe(seq);
    expect(second.server_seq).toBe(seq);
  });

  test('duplicate mutation id inside one batch is applied once', async () => {
    const H = await createHousehold();
    const item = await addItem(H.owner, H.hid, 'Water');
    const m = mutation(H.hid, 'increment_quantity', { item_id: item, delta: 1 });
    const r = await apply(H.owner, H.hid, [m, m, m]);
    expect(r.results.map((x: any) => x.replayed ?? false)).toEqual([false, true, true]);
    expect((await itemRow(item)).quantity).toBe('2.000');
  });

  test('concurrent replays of the same batch (timeout + retry) apply once', async () => {
    const H = await createHousehold();
    const item = await addItem(H.owner, H.hid, 'Sap');
    const batch = [mutation(H.hid, 'increment_quantity', { item_id: item, delta: 1 }), add(H.hid, 'Druiven', 1)];
    const results = await Promise.all([1, 2, 3, 4].map(() => apply(H.owner, H.hid, batch)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => !r.results[0].replayed)).toHaveLength(1);
    expect((await itemRow(item)).quantity).toBe('2.000');
    const n = await admin(`select count(*)::int as n from public.list_items where household_id = $1`, [H.hid]);
    expect(n[0].n).toBe(2);
  });

  test('a mutation id used by another user of the same household is rejected/invalid and not stored again', async () => {
    const H = await createHousehold(2);
    const m = add(H.hid, 'Peper', 1);
    await apply(H.owner, H.hid, [m]);
    const r = await apply(H.members[0]!, H.hid, [m]);
    expect(r.results[0]).toEqual({ id: m.id, status: 'rejected', reason: 'invalid' });
    const stored = await admin(`select user_id from private.mutations where id = $1`, [m.id]);
    expect(stored).toEqual([{ user_id: H.owner }]);
  });

  test('unexpected errors -> retry, not stored, and a later replay applies it', async () => {
    const H = await createHousehold();
    const item = await addItem(H.owner, H.hid, 'Zout');
    const m = mutation(H.hid, 'increment_quantity', { item_id: item, delta: 1 });
    const other = add(H.hid, 'Olie', 1);
    // Inject a transient failure for this one row with a temporary trigger (rolled back with the tx).
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`create function pg_temp.boom() returns trigger language plpgsql as $$
        begin if new.name = 'Zout' then raise exception 'simulated outage' using errcode = '57P03'; end if; return new; end $$`);
      await c.query(`create trigger boom before update on public.list_items for each row execute function pg_temp.boom()`);
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: H.owner, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      const res = await c.query(`select public.apply_mutations($1::jsonb) as r`, [JSON.stringify({ household_id: H.hid, mutations: [m, other] })]);
      const r = res.rows[0].r;
      expect(r.results[0]).toEqual({ id: m.id, status: 'retry' });
      expect(r.results[1].status).toBe('applied');
      await c.query('reset role');
      const stored = await c.query(`select id from private.mutations where id = any($1::uuid[])`, [[m.id, other.id]]);
      expect(stored.rows.map((x) => x.id)).toEqual([other.id]);
    } finally {
      await c.query('rollback');
      c.release();
    }
    const again = await apply(H.owner, H.hid, [m]);
    expect(again.results[0]).toMatchObject({ status: 'applied', item_id: item });
    expect((await itemRow(item)).quantity).toBe('2.000');
  });
});

describe('quantity deltas and LWW', () => {
  test('concurrent +1 and +1 from two connections -> +2 (household lock serializes)', async () => {
    const H = await createHousehold(2);
    const item = await addItem(H.owner, H.hid, 'Bananen', 1);
    const ups = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        apply(i % 2 ? H.owner : H.members[0]!, H.hid, [mutation(H.hid, 'increment_quantity', { item_id: item, delta: 1 })]),
      ),
    );
    expect(ups.every((u) => u.results[0].status === 'applied')).toBe(true);
    expect((await itemRow(item)).quantity).toBe('11.000');
    // seqs are unique and gap free
    const seqs = ups.map((u) => u.results[0].server_seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 10 }, (_, i) => i + 2));
  });

  test('increment rules: result must stay in (0, 99999], delta 0 is a no-op, decimals round to 3', async () => {
    const H = await createHousehold();
    const item = await addItem(H.owner, H.hid, 'Bloem', 2, 'kg');
    const r = await apply(H.owner, H.hid, [
      mutation(H.hid, 'increment_quantity', { item_id: item, delta: -2 }),
      mutation(H.hid, 'increment_quantity', { item_id: item, delta: 99998 }),
      mutation(H.hid, 'increment_quantity', { item_id: item, delta: 0 }),
      mutation(H.hid, 'increment_quantity', { item_id: item, delta: -0.5004 }),
      mutation(H.hid, 'increment_quantity', { item_id: item, delta: 'x' as any }),
    ]);
    expect(r.results.map((x: any) => [x.status, x.reason ?? null])).toEqual([
      ['rejected', 'invalid'],
      ['rejected', 'invalid'],
      ['applied', null],
      ['applied', null],
      ['rejected', 'invalid'],
    ]);
    expect(r.results[2].server_seq).toBeUndefined();
    expect((await itemRow(item)).quantity).toBe('1.500');
  });

  test('update_item: only present fields, exact quantity, last writer by server order wins per field', async () => {
    const H = await createHousehold(2);
    const item = await addItem(H.owner, H.hid, 'Tomaten', 4);
    await apply(H.owner, H.hid, [mutation(H.hid, 'update_item', { item_id: item, fields: { quantity: 6, note: 'trostomaten' } })]);
    await apply(H.members[0]!, H.hid, [mutation(H.hid, 'update_item', { item_id: item, fields: { quantity: 2 } })]);
    await apply(H.owner, H.hid, [mutation(H.hid, 'update_item', { item_id: item, fields: { name: 'Cherrytomaten', exclude_from_comparison: true } })]);
    expect(await itemRow(item)).toMatchObject({
      name: 'Cherrytomaten', normalized_name: 'cherrytomaten', quantity: '2.000', note: 'trostomaten',
      exclude_from_comparison: true, updated_by: H.owner,
    });
  });

  test('update_item: no-op does not bump seq; invalid fields rejected; rename never dedupes', async () => {
    const H = await createHousehold();
    const a = await addItem(H.owner, H.hid, 'Appel');
    const b = await addItem(H.owner, H.hid, 'Peer');
    const seq = await lastSeq(H.hid);
    const r = await apply(H.owner, H.hid, [
      mutation(H.hid, 'update_item', { item_id: a, fields: { name: 'Appel' } }),
      mutation(H.hid, 'update_item', { item_id: a, fields: {} }),
      mutation(H.hid, 'update_item', { item_id: a, fields: { name: '' } }),
      mutation(H.hid, 'update_item', { item_id: a, fields: { unit: 'zak' as any } }),
      mutation(H.hid, 'update_item', { item_id: a, fields: { quantity: 0 } }),
      mutation(H.hid, 'update_item', { item_id: a, fields: { checked: true } as any }),
      mutation(H.hid, 'update_item', { item_id: a, fields: { exclude_from_comparison: 'ja' as any } }),
      mutation(H.hid, 'update_item', { item_id: uuid(), fields: { name: 'x' } }),
    ]);
    expect(r.results.map((x: any) => [x.status, x.reason ?? null])).toEqual([
      ['applied', null], ['applied', null], ['rejected', 'invalid'], ['rejected', 'invalid'],
      ['rejected', 'invalid'], ['rejected', 'invalid'], ['rejected', 'invalid'], ['rejected', 'not_found'],
    ]);
    expect(await lastSeq(H.hid)).toBe(seq);
    const ren = await apply(H.owner, H.hid, [mutation(H.hid, 'update_item', { item_id: b, fields: { name: 'appel' } })]);
    expect(ren.results[0].status).toBe('applied');
    const open = await admin(`select id from public.list_items where household_id = $1 and normalized_name = 'appel'`, [H.hid]);
    expect(open).toHaveLength(2);
  });

  test('edits through an alias id land on the merged target', async () => {
    const H = await createHousehold();
    const target = await addItem(H.owner, H.hid, 'Uien');
    const aliasId = uuid();
    const r = await apply(H.owner, H.hid, [
      add(H.hid, 'uien', 2, 'stuk', aliasId),
      mutation(H.hid, 'increment_quantity', { item_id: aliasId, delta: 1 }),
      mutation(H.hid, 'set_checked', { item_id: aliasId, checked: true }),
    ]);
    expect(r.results.map((x: any) => x.item_id)).toEqual([target, target, target]);
    expect(await itemRow(target)).toMatchObject({ quantity: '4.000', checked: true });
  });
});

describe('delete wins', () => {
  test('edits after a delete are rejected/deleted; only restore brings it back', async () => {
    const H = await createHousehold(2);
    const item = await addItem(H.owner, H.hid, 'Kip');
    await apply(H.owner, H.hid, [mutation(H.hid, 'delete_item', { item_id: item })]);
    const r = await apply(H.members[0]!, H.hid, [
      mutation(H.hid, 'update_item', { item_id: item, fields: { name: 'Kipfilet' } }),
      mutation(H.hid, 'increment_quantity', { item_id: item, delta: 1 }),
      mutation(H.hid, 'set_checked', { item_id: item, checked: true }),
      mutation(H.hid, 'delete_item', { item_id: item }),
    ]);
    expect(r.results.map((x: any) => [x.status, x.reason ?? null])).toEqual([
      ['rejected', 'deleted'], ['rejected', 'deleted'], ['rejected', 'deleted'], ['applied', null],
    ]);
    expect(r.results[3].server_seq).toBeUndefined();
    const row = await itemRow(item);
    expect(row).toMatchObject({ name: 'Kip', deleted_by: H.owner, checked: false });
    const pos = row.position;

    const res = await apply(H.members[0]!, H.hid, [
      mutation(H.hid, 'restore_item', { item_id: item }),
      mutation(H.hid, 'restore_item', { item_id: item }),
    ]);
    expect(res.results.map((x: any) => x.status)).toEqual(['applied', 'applied']);
    expect(res.results[1].server_seq).toBeUndefined();
    expect(await itemRow(item)).toMatchObject({ deleted_at: null, deleted_by: null, position: pos });
    expect((await apply(H.owner, H.hid, [mutation(H.hid, 'update_item', { item_id: item, fields: { name: 'Kipfilet' } })])).results[0].status).toBe('applied');
  });

  test('unknown ids: not_found for delete/restore/set_checked/increment', async () => {
    const H = await createHousehold();
    const r = await apply(H.owner, H.hid, [
      mutation(H.hid, 'delete_item', { item_id: uuid() }),
      mutation(H.hid, 'restore_item', { item_id: uuid() }),
      mutation(H.hid, 'set_checked', { item_id: uuid(), checked: true }),
      mutation(H.hid, 'increment_quantity', { item_id: uuid(), delta: 1 }),
    ]);
    expect(r.results.map((x: any) => x.reason)).toEqual(['not_found', 'not_found', 'not_found', 'not_found']);
  });
});

describe('set_checked and clear_checked', () => {
  test('set_checked sets/clears checked_at; same value is a no-op', async () => {
    const H = await createHousehold();
    const item = await addItem(H.owner, H.hid, 'Sla');
    const r = await apply(H.owner, H.hid, [
      mutation(H.hid, 'set_checked', { item_id: item, checked: true }),
      mutation(H.hid, 'set_checked', { item_id: item, checked: true }),
    ]);
    expect(r.results[0].server_seq).toBe(2);
    expect(r.results[1].server_seq).toBeUndefined();
    expect((await itemRow(item)).checked_at).not.toBeNull();
    await apply(H.owner, H.hid, [mutation(H.hid, 'set_checked', { item_id: item, checked: false })]);
    expect(await itemRow(item)).toMatchObject({ checked: false, checked_at: null });
  });

  test('clear_checked tombstones only listed ids that are still checked', async () => {
    const H = await createHousehold(2);
    const a = await addItem(H.owner, H.hid, 'A');
    const b = await addItem(H.owner, H.hid, 'B');
    const c = await addItem(H.owner, H.hid, 'C');
    const d = await addItem(H.owner, H.hid, 'D');
    await apply(H.owner, H.hid, [a, b, c, d].map((id) => mutation(H.hid, 'set_checked', { item_id: id, checked: true })));
    // someone else unchecks b meanwhile; d is checked but was not on screen
    await apply(H.members[0]!, H.hid, [mutation(H.hid, 'set_checked', { item_id: b, checked: false })]);
    const r = await apply(H.owner, H.hid, [mutation(H.hid, 'clear_checked', { item_ids: [a, b, c, uuid()] })]);
    expect(r.results[0].status).toBe('applied');
    expect([...r.results[0].affected_ids].sort()).toEqual([a, c].sort());
    expect((await itemRow(a)).deleted_at).not.toBeNull();
    expect((await itemRow(b)).deleted_at).toBeNull();
    expect((await itemRow(c)).deleted_at).not.toBeNull();
    expect((await itemRow(d)).deleted_at).toBeNull();
    // undo = restore_item per affected id
    const u = await apply(H.owner, H.hid, r.results[0].affected_ids.map((id: string) => mutation(H.hid, 'restore_item', { item_id: id })));
    expect(u.results.every((x: any) => x.status === 'applied')).toBe(true);
    expect((await itemRow(a)).deleted_at).toBeNull();
    // malformed
    const bad = await apply(H.owner, H.hid, [
      mutation(H.hid, 'clear_checked', { item_ids: 'x' as any }),
      mutation(H.hid, 'clear_checked', { item_ids: ['nope'] }),
    ]);
    expect(bad.results.map((x: any) => x.reason)).toEqual(['invalid', 'invalid']);
  });
});

describe('server order', () => {
  test('server_seq is per household, strictly increasing, and no-ops never consume a seq', async () => {
    const A = await createHousehold();
    const B = await createHousehold();
    await addItem(A.owner, A.hid, 'x');
    await addItem(A.owner, A.hid, 'y');
    await addItem(B.owner, B.hid, 'x');
    expect(await lastSeq(A.hid)).toBe(2);
    expect(await lastSeq(B.hid)).toBe(1);
  });

  test('a writer waits for the household lock (no interleaving within a batch)', async () => {
    const H = await createHousehold();
    const item = await addItem(H.owner, H.hid, 'Lock');
    const locker = new Client({ connectionString: DB_URL });
    await locker.connect();
    try {
      await locker.query('begin');
      await locker.query('select 1 from public.households where id = $1 for update', [H.hid]);
      let done = false;
      const p = apply(H.owner, H.hid, [mutation(H.hid, 'increment_quantity', { item_id: item, delta: 1 })]).then((r) => {
        done = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      await locker.query('commit');
      const r = await p;
      expect(r.results[0].status).toBe('applied');
    } finally {
      await locker.end();
    }
  });
});
