/** pull_changes (docs/architecture.md 4.2) and private.purge. */
import { addItem, admin, apply, closePool, createHousehold, mutation, rpc, uuid } from './_helpers';
import type { ListItemRow } from '@/src/contracts';

afterAll(closePool);

const pull = (uid: string, hid: string, since: number, limit?: number) =>
  rpc(uid, 'pull_changes', { p_household_id: hid, p_since_seq: since, ...(limit !== undefined ? { p_limit: limit } : {}) });

describe('pull_changes', () => {
  test('returns ListItemRow wire format and the household', async () => {
    const H = await createHousehold();
    const id = await addItem(H.owner, H.hid, 'Melk', 2.5, 'l');
    const r = await pull(H.owner, H.hid, 0);
    expect(r).toMatchObject({ ok: true, server_seq: 1, has_more: false, reset_required: false });
    expect(r.household).toEqual({ id: H.hid, name: 'Thuis', created_at: expect.any(String), last_seq: 1 });
    expect(r.items).toHaveLength(1);
    const row: ListItemRow = r.items[0];
    expect(Object.keys(row).sort()).toEqual([
      'checked', 'checked_at', 'created_at', 'created_by', 'deleted_at', 'deleted_by', 'exclude_from_comparison',
      'household_id', 'id', 'name', 'normalized_name', 'note', 'position', 'quantity', 'server_seq', 'unit',
      'updated_at', 'updated_by',
    ]);
    expect(row).toMatchObject({ id, household_id: H.hid, name: 'Melk', normalized_name: 'melk', quantity: 2.5, unit: 'l',
      note: '', checked: false, checked_at: null, position: 1, exclude_from_comparison: false, deleted_at: null, server_seq: 1 });
    expect(typeof row.quantity).toBe('number');
    expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
  });

  test('from 0 leaves out tombstones; incremental pull includes them', async () => {
    const H = await createHousehold();
    const a = await addItem(H.owner, H.hid, 'A');
    const b = await addItem(H.owner, H.hid, 'B');
    const cur = (await pull(H.owner, H.hid, 0)).server_seq;
    await apply(H.owner, H.hid, [mutation(H.hid, 'delete_item', { item_id: a })]);
    const full = await pull(H.owner, H.hid, 0);
    expect(full.items.map((x: any) => x.id)).toEqual([b]);
    expect(full.server_seq).toBe(3);
    const inc = await pull(H.owner, H.hid, cur);
    expect(inc.items.map((x: any) => [x.id, x.deleted_at !== null])).toEqual([[a, true]]);
    expect(inc.server_seq).toBe(3);
  });

  test('pages with has_more and a cursor that never skips a row', async () => {
    const H = await createHousehold();
    const batch = Array.from({ length: 25 }, (_, i) => mutation(H.hid, 'add_item', { id: uuid(), name: `n${i}`, quantity: 1, unit: 'stuk' }));
    await apply(H.owner, H.hid, batch);
    // touch a few so seqs are interleaved
    await apply(H.owner, H.hid, [mutation(H.hid, 'delete_item', { item_id: batch[3]!.payload.id as string })]);
    const seen = new Map<string, any>();
    let since = 0;
    let pages = 0;
    for (;;) {
      const r = await pull(H.owner, H.hid, since, 10);
      pages++;
      for (const it of r.items) seen.set(it.id, it);
      expect(r.items.length).toBeLessThanOrEqual(10);
      const seqs = r.items.map((x: any) => x.server_seq);
      expect(seqs).toEqual([...seqs].sort((x: number, y: number) => x - y));
      since = r.server_seq;
      if (!r.has_more) break;
      expect(r.server_seq).toBe(seqs[seqs.length - 1]);
    }
    expect(pages).toBe(3);
    expect(since).toBe(26);
    // Later pages (since > 0) may carry tombstones even for an initial sync; clients upsert them.
    expect([...seen.values()].filter((x) => x.deleted_at === null)).toHaveLength(24);
    expect([...seen.values()].filter((x) => x.deleted_at !== null).map((x) => x.id)).toEqual([batch[3]!.payload.id]);
    const empty = await pull(H.owner, H.hid, since);
    expect(empty).toMatchObject({ items: [], server_seq: 26, has_more: false });
  });

  test('exactly limit rows -> has_more false', async () => {
    const H = await createHousehold();
    for (const n of ['a', 'b', 'c']) await addItem(H.owner, H.hid, n);
    const r = await pull(H.owner, H.hid, 0, 3);
    expect(r).toMatchObject({ has_more: false, server_seq: 3 });
    expect(r.items).toHaveLength(3);
  });

  test('cursor ahead of the server -> reset_required', async () => {
    const H = await createHousehold();
    await addItem(H.owner, H.hid, 'a');
    const r = await pull(H.owner, H.hid, 999);
    expect(r).toMatchObject({ ok: true, reset_required: true, items: [], server_seq: 0 });
  });

  test('purge removes old tombstones; cursors before the horizon must reset', async () => {
    const H = await createHousehold();
    const a = await addItem(H.owner, H.hid, 'oud');      // seq 1
    const b = await addItem(H.owner, H.hid, 'blijft');   // seq 2
    await apply(H.owner, H.hid, [mutation(H.hid, 'delete_item', { item_id: a })]); // seq 3
    await admin(`update public.list_items set deleted_at = now() - interval '31 days' where id = $1`, [a]);
    await admin(`insert into private.mutations (id, household_id, user_id, kind, result, received_at)
                 values ($1, $2, $3, 'add_item', '{}', now() - interval '91 days')`, [uuid(), H.hid, H.owner]);
    const res = (await admin(`select private.purge() as r`))[0].r;
    expect(res.tombstones).toBeGreaterThanOrEqual(1);
    expect(res.mutations).toBeGreaterThanOrEqual(1);
    expect(await admin(`select id from public.list_items where id = $1`, [a])).toEqual([]);
    expect((await admin(`select purged_before_seq from public.households where id = $1`, [H.hid]))[0].purged_before_seq).toBe('3');

    expect(await pull(H.owner, H.hid, 2)).toMatchObject({ reset_required: true, items: [] });
    expect(await pull(H.owner, H.hid, 3)).toMatchObject({ reset_required: false, items: [] });
    const full = await pull(H.owner, H.hid, 0);
    expect(full).toMatchObject({ reset_required: false, server_seq: 3 });
    expect(full.items.map((x: any) => x.id)).toEqual([b]);
  });

  test('not_authenticated and not_member', async () => {
    const H = await createHousehold();
    const other = await createHousehold();
    expect(await pull(other.owner, H.hid, 0)).toEqual({ ok: false, error: 'not_member' });
  });
});
