import type { ListItemRow, Mutation, MutationResult } from '@/src/contracts';
import { reduce, toLists } from '../reducer';
import type { OutboxEntry } from '../types';

const HH = 'hh';
const U = 'user';
let n = 0;
const iso = (i: number) => new Date(Date.UTC(2026, 9, 23, 8, 0, i)).toISOString();

function row(p: Partial<ListItemRow> & { id: string; name: string }): ListItemRow {
  return {
    household_id: HH,
    normalized_name: p.name.toLowerCase(),
    quantity: 1,
    unit: 'stuk',
    note: '',
    checked: false,
    checked_at: null,
    position: 1,
    exclude_from_comparison: false,
    created_by: U,
    created_at: iso(0),
    updated_by: U,
    updated_at: iso(0),
    deleted_at: null,
    deleted_by: null,
    server_seq: 1,
    ...p,
  };
}

function entry(m: Omit<Mutation, 'household_id' | 'client_created_at' | 'id'> & { id?: string }, ack?: MutationResult): OutboxEntry {
  n++;
  return {
    seq: n,
    mutation: { id: m.id ?? `m${n}`, household_id: HH, client_created_at: iso(n), ...m } as Mutation,
    state: ack ? 'acked' : 'pending',
    ackedSeq: ack?.server_seq ?? null,
    result: ack ?? null,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    localMeta: null,
  };
}

const base = (...rows: ListItemRow[]) => new Map(rows.map((r) => [r.id, r]));
const run = (rows: ListItemRow[], entries: OutboxEntry[]) => reduce({ base: base(...rows), entries, aliases: new Map(), userId: U });

describe('reducer', () => {
  test('does not mutate the base map rows', () => {
    const r = row({ id: 'a', name: 'Melk' });
    const frozen = Object.freeze({ ...r });
    const out = reduce({ base: new Map([['a', frozen]]), entries: [entry({ kind: 'increment_quantity', payload: { item_id: 'a', delta: 1 } })], aliases: new Map(), userId: U });
    expect(out.items.get('a')!.quantity).toBe(2);
    expect(frozen.quantity).toBe(1);
  });

  test('pending add merges into the most recent open duplicate, restores the latest checked one otherwise', () => {
    const rows = [
      row({ id: 'old', name: 'Melk', position: 1 }),
      row({ id: 'new', name: 'Melk', position: 5 }), // duplicate created by a rename (F41)
      row({ id: 'c1', name: 'Kaas', checked: true, checked_at: iso(1), position: 2 }),
      row({ id: 'c2', name: 'Kaas', checked: true, checked_at: iso(9), position: 3 }),
    ];
    const add1 = entry({ kind: 'add_item', payload: { id: 'x1', name: ' MELK', quantity: 2, unit: 'stuk' } });
    const add2 = entry({ kind: 'add_item', payload: { id: 'x2', name: 'kaas', quantity: 3, unit: 'stuk' } });
    const out = run(rows, [add1, add2]);
    expect(out.sims.get(add1.mutation.id)).toMatchObject({ outcome: 'merged', targetId: 'new' });
    expect(out.items.get('new')).toMatchObject({ quantity: 3, pending: true });
    expect(out.items.get('old')).toMatchObject({ quantity: 1, pending: false });
    expect(out.sims.get(add2.mutation.id)).toMatchObject({ outcome: 'restored', targetId: 'c2', prevQuantity: 1 });
    expect(out.items.get('c2')).toMatchObject({ checked: false, quantity: 3, position: 6 });
    expect(out.aliases.get('x1')).toBe('new');
  });

  test('different unit never merges', () => {
    const out = run([row({ id: 'g', name: 'Gehakt', unit: 'stuk' })], [entry({ kind: 'add_item', payload: { id: 'y', name: 'gehakt', quantity: 500, unit: 'g' } })]);
    expect(out.items.size).toBe(2);
  });

  test('acked add is replayed from the server result, not re-simulated', () => {
    // locally there is no duplicate, but the server merged into "t" (not pulled yet)
    const ack = entry({ kind: 'add_item', payload: { id: 'mine', name: 'Rijst', quantity: 1, unit: 'kg' } }, { id: 'm', status: 'merged', item_id: 't', server_seq: 9 });
    const edit = entry({ kind: 'update_item', payload: { item_id: 'mine', fields: { note: 'basmati' } } });
    const out = run([], [ack, edit]);
    expect(out.items.has('mine')).toBe(false);
    expect(out.items.get('t')).toMatchObject({ name: 'Rijst', note: 'basmati', pending: true, position: 9 });
  });

  test('delete wins over later local edits; restore clears the tombstone', () => {
    const rows = [row({ id: 'a', name: 'A' })];
    const out = run(rows, [
      entry({ kind: 'delete_item', payload: { item_id: 'a' } }),
      entry({ kind: 'update_item', payload: { item_id: 'a', fields: { name: 'B' } } }),
      entry({ kind: 'increment_quantity', payload: { item_id: 'a', delta: 1 } }),
    ]);
    expect(out.items.get('a')).toMatchObject({ name: 'A', quantity: 1 });
    expect(out.items.get('a')!.deleted_at).not.toBeNull();
    expect([...out.sims.values()].map((s) => s.wouldReject)).toEqual([undefined, 'deleted', 'deleted']);
    const out2 = run(rows, [entry({ kind: 'delete_item', payload: { item_id: 'a' } }), entry({ kind: 'restore_item', payload: { item_id: 'a' } })]);
    expect(out2.items.get('a')!.deleted_at).toBeNull();
  });

  test('increment never goes to zero or above the limit', () => {
    const out = run([row({ id: 'a', name: 'A', quantity: 1 })], [
      entry({ kind: 'increment_quantity', payload: { item_id: 'a', delta: -1 } }),
      entry({ kind: 'increment_quantity', payload: { item_id: 'a', delta: 99999 } }),
    ]);
    expect(out.items.get('a')!.quantity).toBe(1);
  });

  test('pending clear_checked skips unchecked; acked clear uses affected_ids', () => {
    const rows = [row({ id: 'a', name: 'A', checked: true, checked_at: iso(1) }), row({ id: 'b', name: 'B' })];
    const out = run(rows, [entry({ kind: 'clear_checked', payload: { item_ids: ['a', 'b', 'zz'] } })]);
    expect([...out.sims.values()][0]!.affectedIds).toEqual(['a']);
    expect(out.items.get('b')!.deleted_at).toBeNull();
    const out2 = run(rows, [entry({ kind: 'clear_checked', payload: { item_ids: ['a', 'b'] } }, { id: 'x', status: 'applied', affected_ids: [], server_seq: 3 })]);
    expect(out2.items.get('a')!.deleted_at).toBeNull();
  });

  test('toLists sorts open by position desc and checked by checked_at desc, drops tombstones', () => {
    const items = [
      { ...row({ id: 'a', name: 'A', position: 1 }), pending: false },
      { ...row({ id: 'b', name: 'B', position: 3 }), pending: false },
      { ...row({ id: 'c', name: 'C', checked: true, checked_at: iso(1) }), pending: false },
      { ...row({ id: 'd', name: 'D', checked: true, checked_at: iso(5) }), pending: false },
      { ...row({ id: 'e', name: 'E', deleted_at: iso(2) }), pending: false },
    ];
    const l = toLists(items);
    expect(l.open.map((i) => i.id)).toEqual(['b', 'a']);
    expect(l.checked.map((i) => i.id)).toEqual(['d', 'c']);
  });
});
