import type { VisibleItem } from '@/src/contracts';

import { StableOrder } from '../stableOrder';

let seq = 0;
function it_(name: string, position: number, checked = false, checked_at: string | null = null): VisibleItem {
  return {
    id: `id-${name}`,
    household_id: 'h',
    name,
    normalized_name: name.toLowerCase(),
    quantity: 1,
    unit: 'stuk',
    note: '',
    checked,
    checked_at,
    position,
    exclude_from_comparison: false,
    created_by: null,
    created_at: '2026-10-23T08:00:00Z',
    updated_by: null,
    updated_at: '2026-10-23T08:00:00Z',
    deleted_at: null,
    deleted_by: null,
    server_seq: ++seq,
    pending: false,
  };
}
const names = (xs: VisibleItem[]) => xs.map((x) => x.name);

describe('StableOrder (nothing moves under your finger)', () => {
  it('places new items directly in their section, newest open first', () => {
    const o = new StableOrder();
    const v = o.compute([it_('a', 1), it_('b', 3), it_('c', 2)], [it_('x', 0, true, '2026-10-23T09:00:00Z')]);
    expect(names(v.open)).toEqual(['b', 'c', 'a']);
    expect(names(v.checked)).toEqual(['x']);
    expect(v.lingering).toEqual([]);
  });

  it('keeps a just-checked row in its open slot until settle()', () => {
    const o = new StableOrder();
    o.compute([it_('a', 1), it_('b', 2)], []);
    const v = o.compute([it_('b', 2)], [it_('a', 1, true, '2026-10-23T09:00:00Z')]);
    expect(names(v.open)).toEqual(['b', 'a']);
    expect(v.open[1]!.checked).toBe(true);
    expect(v.lingering).toEqual(['id-a']);
    expect(o.settle()).toBe(true);
    const after = o.view();
    expect(names(after.open)).toEqual(['b']);
    expect(names(after.checked)).toEqual(['a']);
    expect(o.settle()).toBe(false);
  });

  it('keeps an unchecked row in Afgevinkt until settle, and new rows from others go on top', () => {
    const o = new StableOrder();
    o.compute([it_('a', 1)], [it_('x', 0, true, '2026-10-23T09:00:00Z'), it_('y', 0, true, '2026-10-23T08:00:00Z')]);
    const v = o.compute([it_('a', 1), it_('x', 0), it_('new', 9)], [it_('y', 0, true, '2026-10-23T08:00:00Z')]);
    expect(names(v.open)).toEqual(['new', 'a']);
    expect(names(v.checked)).toEqual(['x', 'y']);
    o.settle();
    expect(names(o.view().open)).toEqual(['new', 'a', 'x']);
  });

  it('drops deleted rows', () => {
    const o = new StableOrder();
    o.compute([it_('a', 1), it_('b', 2)], []);
    expect(names(o.compute([it_('b', 2)], []).open)).toEqual(['b']);
  });
});
