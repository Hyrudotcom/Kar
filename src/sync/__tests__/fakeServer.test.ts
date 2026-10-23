/** The fake server must follow the contract, or the engine tests prove nothing. */
import type { Mutation } from '@/src/contracts';
import { FakeServer } from '../testing/fakeServer';
import { uuid } from './harness';

function setup() {
  const s = new FakeServer();
  const a = uuid();
  const b = uuid();
  const hA = s.createHousehold(a);
  const hB = s.createHousehold(b);
  let i = 0;
  const m = (hh: string, kind: Mutation['kind'], payload: unknown): Mutation =>
    ({ id: uuid(), household_id: hh, kind, payload, client_created_at: `c${i++}` }) as Mutation;
  return { s, a, b, hA, hB, m };
}

describe('FakeServer contract', () => {
  test('add dedupe: merged (+qty, alias), restored (checked), new row; seq per household', () => {
    const { s, a, hA, m } = setup();
    const id1 = uuid();
    const r1 = s.applyMutations(a, { household_id: hA, mutations: [m(hA, 'add_item', { id: id1, name: 'Melk', quantity: 1, unit: 'stuk' })] });
    expect(r1).toMatchObject({ ok: true, server_seq: 1, results: [{ status: 'applied', item_id: id1, server_seq: 1 }] });
    const id2 = uuid();
    const r2 = s.applyMutations(a, { household_id: hA, mutations: [m(hA, 'add_item', { id: id2, name: ' melk', quantity: 2, unit: 'stuk' })] });
    expect(r2).toMatchObject({ ok: true, results: [{ status: 'merged', item_id: id1, server_seq: 2 }] });
    // later edit addressed to the alias is redirected
    const r3 = s.applyMutations(a, { household_id: hA, mutations: [m(hA, 'set_checked', { item_id: id2, checked: true })] });
    expect(r3).toMatchObject({ ok: true, results: [{ status: 'applied', item_id: id1 }] });
    const r4 = s.applyMutations(a, { household_id: hA, mutations: [m(hA, 'add_item', { id: uuid(), name: 'MELK', quantity: 5, unit: 'stuk' })] });
    expect(r4).toMatchObject({ ok: true, results: [{ status: 'restored', item_id: id1 }] });
    expect(s.item(id1)).toMatchObject({ quantity: 5, checked: false, position: 4 });
  });

  test('idempotency: same id replays (replayed:true), other user gets rejected/invalid', () => {
    const { s, a, hA, m } = setup();
    const b2 = uuid();
    s.addMember(hA, b2);
    const mut = m(hA, 'add_item', { id: uuid(), name: 'Brood', quantity: 1, unit: 'stuk' });
    const first = s.applyMutations(a, { household_id: hA, mutations: [mut] });
    const again = s.applyMutations(a, { household_id: hA, mutations: [mut] });
    expect(again).toMatchObject({ ok: true, results: [{ ...(first.ok ? first.results[0] : {}), replayed: true }] });
    expect(s.list(hA)).toHaveLength(1);
    expect(s.applyMutations(b2, { household_id: hA, mutations: [mut] })).toMatchObject({ ok: true, results: [{ status: 'rejected', reason: 'invalid' }] });
  });

  test('separation: not_member, forbidden household, ids of another household rejected without leaking', () => {
    const { s, a, b, hA, hB, m } = setup();
    const idB = uuid();
    s.applyMutations(b, { household_id: hB, mutations: [m(hB, 'add_item', { id: idB, name: 'Geheim', quantity: 1, unit: 'stuk' })] });
    expect(s.applyMutations(a, { household_id: hB, mutations: [m(hB, 'delete_item', { item_id: idB })] })).toEqual({ ok: false, error: 'not_member' });
    expect(s.pullChanges(a, hB, 0)).toEqual({ ok: false, error: 'not_member' });
    const res = s.applyMutations(a, {
      household_id: hA,
      mutations: [
        m(hB, 'delete_item', { item_id: idB }),
        m(hA, 'add_item', { id: idB, name: 'Kaping', quantity: 1, unit: 'stuk' }),
        m(hA, 'delete_item', { item_id: idB }),
        m(hA, 'update_item', { item_id: idB, fields: { name: 'x' } }),
      ],
    });
    expect(res.ok && res.results.map((r) => [r.status, r.reason])).toEqual([
      ['rejected', 'forbidden'],
      ['rejected', 'invalid'],
      ['rejected', 'not_found'],
      ['rejected', 'not_found'],
    ]);
    expect(s.item(idB)).toMatchObject({ name: 'Geheim', deleted_at: null });
    expect(s.applyMutations(null, { household_id: hA, mutations: [m(hA, 'delete_item', { item_id: idB })] })).toEqual({ ok: false, error: 'not_authenticated' });
    expect(s.applyMutations(a, { household_id: hA, mutations: [] })).toEqual({ ok: false, error: 'invalid_batch' });
  });

  test('validation errors are rejected/invalid and leave no partial change; no-ops do not bump seq', () => {
    const { s, a, hA, m } = setup();
    const id = uuid();
    s.applyMutations(a, { household_id: hA, mutations: [m(hA, 'add_item', { id, name: 'Ei', quantity: 1, unit: 'stuk' })] });
    const res = s.applyMutations(a, {
      household_id: hA,
      mutations: [
        m(hA, 'increment_quantity', { item_id: id, delta: -1 }),
        m(hA, 'update_item', { item_id: id, fields: { name: 'Ei', quantity: 100000 } }),
        m(hA, 'add_item', { id: uuid(), name: '', quantity: 1, unit: 'stuk' }),
        m(hA, 'set_checked', { item_id: id, checked: false }),
        m(hA, 'restore_item', { item_id: id }),
      ],
    });
    expect(res.ok && res.results.map((r) => r.reason ?? r.status)).toEqual(['invalid', 'invalid', 'invalid', 'applied', 'applied']);
    expect(res.ok && res.server_seq).toBe(1);
    expect(s.item(id)!.quantity).toBe(1);
  });

  test('pull: tombstones excluded from 0, included incrementally; pagination; reset_required after purge', () => {
    const { s, a, hA, m } = setup();
    const ids = [uuid(), uuid(), uuid()];
    s.applyMutations(a, { household_id: hA, mutations: ids.map((id, i) => m(hA, 'add_item', { id, name: `N${i}`, quantity: 1, unit: 'stuk' })) });
    s.applyMutations(a, { household_id: hA, mutations: [m(hA, 'delete_item', { item_id: ids[0] })] });
    const p0 = s.pullChanges(a, hA, 0);
    expect(p0.ok && p0.items.map((i) => i.id)).toEqual([ids[1], ids[2]]);
    const p3 = s.pullChanges(a, hA, 3);
    expect(p3.ok && p3.items.map((i) => [i.id, !!i.deleted_at])).toEqual([[ids[0], true]]);
    const page = s.pullChanges(a, hA, 0, 1);
    expect(page).toMatchObject({ ok: true, has_more: true, server_seq: 2 });
    s.purgeTombstones(hA);
    expect(s.pullChanges(a, hA, 3)).toMatchObject({ ok: true, reset_required: true });
    // purged_before_seq = highest purged seq (backend): a cursor at it has seen the tombstone
    expect(s.pullChanges(a, hA, 4)).toMatchObject({ ok: true, reset_required: false });
    // a cursor ahead of the server (foreign/corrupt) also resets
    expect(s.pullChanges(a, hA, 99)).toMatchObject({ ok: true, reset_required: true, server_seq: 0 });
  });
});
