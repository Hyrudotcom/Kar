import type { HistoryEntry, VisibleItem } from '@/src/contracts';

import { CATALOG } from '../catalog';
import { getSuggestionIndex, SuggestionIndex } from '../search';

const checkedItem = (name: string): VisibleItem =>
  ({ id: `c-${name}`, name, normalized_name: name.toLowerCase(), quantity: 1, unit: 'stuk', note: '', checked: true }) as VisibleItem;
const hist = (display_name: string, use_count: number): HistoryEntry => ({ display_name, normalized_name: display_name.toLowerCase(), unit: 'stuk', use_count, last_used_at: 0 });

describe('SuggestionIndex', () => {
  const idx = new SuggestionIndex(['Kaas', 'Kaas jong belegen', 'Geraspte kaas', 'Crème fraîche', 'Kaastengels', 'Melk', 'Halfvolle melk']);

  it('matches on prefix and word start, prefix first', () => {
    expect(idx.suggest('kaas', {}, 5).map((s) => s.name)).toEqual(['Kaastengels', 'Kaas jong belegen', 'Geraspte kaas']);
    expect(idx.suggest('melk', {}, 5).map((s) => s.name)).toEqual(['Halfvolle melk']);
  });

  it('is diacritic-insensitive', () => {
    expect(idx.suggest('creme', {}).map((s) => s.name)).toEqual(['Crème fraîche']);
  });

  it('orders sources: checked items, then household history by frequency, then the catalog; max 3, no duplicates', () => {
    const r = idx.suggest('ka', { checked: [checkedItem('Kaasstengels oud')], history: [hist('Kale', 1), hist('Karnemelk', 7), hist('Kaas', 3)] });
    expect(r.map((s) => [s.name, s.source])).toEqual([
      ['Kaasstengels oud', 'checked'],
      ['Karnemelk', 'history'],
      ['Kaas', 'history'],
    ]);
  });

  it('never repeats what was typed (the add row covers it)', () => {
    expect(idx.suggest('Kaas', {}).map((s) => s.name)).not.toContain('Kaas');
  });

  it('ships a broad generic NL catalog without duplicates', () => {
    expect(CATALOG.length).toBeGreaterThan(900);
    expect(new Set(CATALOG.map((n) => n.toLowerCase())).size).toBe(CATALOG.length);
  });

  it('answers within the 16 ms per keystroke budget', () => {
    const full = getSuggestionIndex();
    const history = Array.from({ length: 300 }, (_, i) => hist(`Item ${i}`, i));
    full.suggest('k', { history });
    const queries = ['m', 'me', 'mel', 'melk', 'k', 'ka', 'kaa', 'kaas', 'b', 'br', 'bro', 'broo', 'a', 'ap', 'app'];
    const t0 = performance.now();
    for (const q of queries) full.suggest(q, { history });
    const perQuery = (performance.now() - t0) / queries.length;
    expect(perQuery).toBeLessThan(16);
  });
});
