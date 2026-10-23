import type { ComparisonResult, StoreBasket } from '@/src/contracts';
import { compareBaskets } from '../engine';
import { DAY_MS } from '../status';
import { DatasetBuilder, LICENSED, NOW, OPEN_PRICES, daysAgo, fakeEan, inDays, input, item } from './fixtures';

const store = (r: ComparisonResult, chain: string): StoreBasket => {
  const s = r.stores.find((b) => b.chain_id === chain);
  if (!s) throw new Error(`no basket for ${chain}`);
  return s;
};

/** Melk 1 l + brood 800 g priced at AH and Jumbo. */
function twoChainBasket() {
  const b = new DatasetBuilder().catalog('melk-halfvol', ['melk', 'halfvolle melk'], 1000, 'ml').catalog('brood-volkoren', ['volkorenbrood'], 800, 'g');
  b.simple('melk-halfvol', 'ah', 119, 1000, 'ml');
  b.simple('melk-halfvol', 'jumbo', 115, 1000, 'ml');
  b.simple('brood-volkoren', 'ah', 249, 800, 'g');
  b.simple('brood-volkoren', 'jumbo', 259, 800, 'g');
  return b;
}

describe('state', () => {
  test('v1 today: no data at all -> unavailable, no stores, no numbers', () => {
    const r = compareBaskets(input([item('melk')], { sources: [OPEN_PRICES], chains: [], catalog: [], products: [], links: [], observations: [], overrides: [] }));
    expect(r.state).toBe('unavailable');
    expect(r.stores).toEqual([]);
    expect(r.oldest_price_age_days).toBeNull();
    expect(r.source_ids).toEqual([]);
    expect(r.compared_count).toBe(1);
  });

  test('prices from an unlicensed source (Open Prices, verified=false) never count -> unavailable', () => {
    const b = twoChainBasket();
    b.data.sources = [{ ...OPEN_PRICES }];
    for (const o of b.data.observations) o.source_id = OPEN_PRICES.id;
    const r = compareBaskets(input([item('melk')], b.data));
    expect(r.state).toBe('unavailable');
    expect(r.stores).toEqual([]);
  });

  test('a licensed source with a non national/webshop channel does not count', () => {
    const b = twoChainBasket();
    b.data.sources = [{ ...LICENSED, channel: 'store' as never }];
    expect(compareBaskets(input([item('melk')], b.data)).state).toBe('unavailable');
  });

  test('exactly 1 verified chain -> unavailable', () => {
    const b = new DatasetBuilder().catalog('melk-halfvol', ['melk'], 1000, 'ml');
    b.simple('melk-halfvol', 'ah', 119, 1000, 'ml');
    expect(compareBaskets(input([item('melk')], b.data)).state).toBe('unavailable');
  });

  test('a chain whose only prices are older than 14 days is not "verified coverage"', () => {
    const b = new DatasetBuilder().catalog('melk-halfvol', ['melk'], 1000, 'ml');
    b.simple('melk-halfvol', 'ah', 119, 1000, 'ml');
    b.simple('melk-halfvol', 'jumbo', 115, 1000, 'ml', daysAgo(15));
    expect(compareBaskets(input([item('melk')], b.data)).state).toBe('unavailable');
  });

  test('2 verified chains -> comparison available', () => {
    const r = compareBaskets(input([item('melk')], twoChainBasket().data));
    expect(r.state).toBe('ranked');
  });

  test('no compared items -> empty (all excluded counts too)', () => {
    const data = twoChainBasket().data;
    expect(compareBaskets(input([], data)).state).toBe('empty');
    const r = compareBaskets(input([item('melk', 1, 'stuk', true)], data));
    expect(r.state).toBe('empty');
    expect(r.excluded_count).toBe(1);
    expect(r.compared_count).toBe(0);
    expect(r.stores).toEqual([]);
  });

  test('unavailable wins over empty', () => {
    expect(compareBaskets(input([], new DatasetBuilder().data)).state).toBe('unavailable');
  });

  test('no complete basket -> no_complete, every store without total', () => {
    const r = compareBaskets(input([item('melk'), item('kaastengels')], twoChainBasket().data));
    expect(r.state).toBe('no_complete');
    for (const s of r.stores) {
      expect(s.complete).toBe(false);
      expect(s.total_cents).toBeNull();
      expect(s.delta_cents).toBeNull();
      expect(s.label).toBeNull();
    }
  });
});

describe('unknown is never zero', () => {
  test('an unmatched item is unknown with null total at every store', () => {
    const r = compareBaskets(input([item('melk'), item('cadeautje oma')], twoChainBasket().data));
    for (const s of r.stores) {
      const line = s.lines.find((l) => l.item_name === 'cadeautje oma')!;
      expect(line.status).toBe('unknown');
      expect(line.line_total_cents).toBeNull();
      expect(line.package_count).toBeNull();
      expect(line.catalog_item_id).toBeNull();
      expect(s.priced_count).toBe(1);
      expect(s.compared_count).toBe(2);
      expect(s.total_cents).toBeNull();
    }
  });

  test('an incomplete basket that would be "cheaper" if unknown counted as 0 is not ranked above a complete one', () => {
    const b = twoChainBasket().catalog('kaas', ['kaas'], 500, 'g');
    b.simple('kaas', 'ah', 650, 500, 'g'); // Jumbo has no kaas price
    const r = compareBaskets(input([item('melk'), item('volkorenbrood'), item('kaas')], b.data));
    expect(r.state).toBe('ranked');
    expect(r.stores.map((s) => s.chain_id)).toEqual(['ah', 'jumbo']);
    expect(store(r, 'ah')).toMatchObject({ complete: true, total_cents: 119 + 249 + 650, label: 'only_complete', delta_cents: null });
    expect(store(r, 'jumbo')).toMatchObject({ complete: false, total_cents: null, priced_count: 2, compared_count: 3, label: null });
  });

  test('a price of 0 cents in the data is ignored, never a free item', () => {
    const b = twoChainBasket();
    const melkAh = b.data.observations.find((o) => o.chain_id === 'ah' && o.price_cents === 119)!;
    melkAh.price_cents = 0;
    const r = compareBaskets(input([item('melk')], b.data));
    expect(store(r, 'ah').lines[0]!).toMatchObject({ status: 'unknown', line_total_cents: null });
    expect(store(r, 'ah').complete).toBe(false);
  });

  test('negative, fractional or NaN prices are ignored', () => {
    for (const bad of [-100, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const b = twoChainBasket();
      b.data.observations.find((o) => o.chain_id === 'ah' && o.price_cents === 119)!.price_cents = bad;
      const r = compareBaskets(input([item('melk')], b.data));
      expect(store(r, 'ah').lines[0]!.status).toBe('unknown');
    }
  });
});

describe('ranking and labels', () => {
  test('complete baskets ascending by total, cheapest label, deltas', () => {
    const b = twoChainBasket();
    b.simple('melk-halfvol', 'plus', 125, 1000, 'ml');
    b.simple('brood-volkoren', 'plus', 269, 800, 'g');
    const r = compareBaskets(input([item('melk'), item('volkorenbrood')], b.data));
    expect(r.stores.map((s) => [s.chain_id, s.total_cents, s.delta_cents, s.label])).toEqual([
      ['ah', 368, null, 'cheapest'],
      ['jumbo', 374, 6, null],
      ['plus', 394, 26, null],
    ]);
  });

  test('exact tie: no single "Goedkoopste", every tied store is "Even goedkoop" with no +€0,00 delta', () => {
    const b = new DatasetBuilder().catalog('melk-halfvol', ['melk'], 1000, 'ml');
    b.simple('melk-halfvol', 'jumbo', 119, 1000, 'ml');
    b.simple('melk-halfvol', 'ah', 119, 1000, 'ml');
    b.simple('melk-halfvol', 'plus', 125, 1000, 'ml');
    const r = compareBaskets(input([item('melk')], b.data));
    expect(r.stores.map((s) => [s.chain_name, s.label, s.delta_cents])).toEqual([
      ['Albert Heijn', 'tied', null],
      ['Jumbo', 'tied', null],
      ['Plus', null, 6],
    ]);
  });

  test('priced lines carry their exact observation time (age_days is floored)', () => {
    const b = new DatasetBuilder().catalog('melk-halfvol', ['melk'], 1000, 'ml').catalog('kaas', ['kaas'], 500, 'g');
    const at = new Date(NOW - 13.9 * 86_400_000).toISOString();
    b.simple('melk-halfvol', 'ah', 119, 1000, 'ml', at);
    b.simple('kaas', 'ah', 650, 500, 'g');
    b.simple('melk-halfvol', 'jumbo', 129, 1000, 'ml');
    const r = compareBaskets(input([item('melk'), item('kaas')], b.data));
    expect(store(r, 'ah').lines[0]).toMatchObject({ age_days: 13, observed_at: at, status: 'stale' });
  });

  test('tie with equal names falls back to chain id (fully deterministic)', () => {
    const b = new DatasetBuilder().catalog('melk-halfvol', ['melk'], 1000, 'ml');
    b.data.chains = [
      { id: 'z', name: 'Same' },
      { id: 'a', name: 'Same' },
    ];
    b.simple('melk-halfvol', 'z', 100, 1000, 'ml');
    b.simple('melk-halfvol', 'a', 100, 1000, 'ml');
    expect(compareBaskets(input([item('melk')], b.data)).stores.map((s) => s.chain_id)).toEqual(['a', 'z']);
  });

  test('incomplete baskets come after complete ones, by priced_count desc then name', () => {
    const b = twoChainBasket().catalog('kaas', ['kaas'], 500, 'g');
    b.simple('kaas', 'ah', 650, 500, 'g');
    b.simple('kaas', 'jumbo', 640, 500, 'g');
    b.simple('melk-halfvol', 'plus', 125, 1000, 'ml'); // plus: 1 of 3
    b.simple('melk-halfvol', 'lidl', 99, 1000, 'ml');
    b.simple('kaas', 'lidl', 599, 500, 'g'); // lidl: 2 of 3, much cheaper but incomplete
    const r = compareBaskets(input([item('melk'), item('volkorenbrood'), item('kaas')], b.data));
    expect(r.stores.map((s) => [s.chain_id, s.complete, s.priced_count])).toEqual([
      ['jumbo', true, 3], // 115 + 259 + 640 = 1014
      ['ah', true, 3], // 119 + 249 + 650 = 1018
      ['lidl', false, 2],
      ['plus', false, 1],
    ]);
    expect(store(r, 'jumbo').label).toBe('cheapest');
    expect(store(r, 'ah').delta_cents).toBe(4);
    expect(store(r, 'lidl').total_cents).toBeNull();
  });

  test('result is identical regardless of input order of data arrays', () => {
    const b = twoChainBasket();
    b.simple('melk-halfvol', 'plus', 115, 1000, 'ml');
    b.simple('brood-volkoren', 'plus', 249, 800, 'g');
    const items = [item('melk'), item('volkorenbrood')];
    const a = compareBaskets(input(items, b.data));
    const rev = {
      ...b.data,
      chains: [...b.data.chains].reverse(),
      products: [...b.data.products].reverse(),
      links: [...b.data.links].reverse(),
      observations: [...b.data.observations].reverse(),
      catalog: [...b.data.catalog].reverse(),
    };
    expect(compareBaskets(input(items, rev))).toEqual(a);
  });

  test('only chains with verified coverage appear; no store picker', () => {
    const r = compareBaskets(input([item('melk')], twoChainBasket().data));
    expect(r.stores.map((s) => s.chain_id).sort()).toEqual(['ah', 'jumbo']);
  });

  test('a covered chain with none of the list items still shows as incomplete (0 van N)', () => {
    const b = twoChainBasket().cover('plus');
    const r = compareBaskets(input([item('melk')], b.data));
    expect(store(r, 'plus')).toMatchObject({ complete: false, priced_count: 0, compared_count: 1, total_cents: null });
  });
});

describe('coverage: when is a comparison offered at all', () => {
  /** Regression: any non-unknown price of any product used to count, e.g. one 13-day-old unlinked price. */
  test('a chain with only stale prices does not count as verified', () => {
    const b = new DatasetBuilder().catalog('melk-halfvol', ['melk'], 1000, 'ml');
    b.simple('melk-halfvol', 'ah', 119, 1000, 'ml');
    b.simple('melk-halfvol', 'jumbo', 115, 1000, 'ml', daysAgo(13));
    expect(compareBaskets(input([item('melk')], b.data)).state).toBe('unavailable');
  });

  test('a chain whose prices are all for unlinked products does not count', () => {
    const b = new DatasetBuilder().catalog('melk-halfvol', ['melk'], 1000, 'ml');
    b.simple('melk-halfvol', 'ah', 119, 1000, 'ml');
    const loose = b.product({ ean: fakeEan(), net_content: 1000, net_content_unit: 'ml' });
    b.price(loose, 'jumbo', 99);
    expect(compareBaskets(input([item('melk')], b.data)).state).toBe('unavailable');
    b.link('melk-halfvol', 'jumbo', loose);
    expect(compareBaskets(input([item('melk')], b.data)).state).toBe('ranked');
  });
});

describe('status boundaries (7 / 14 days)', () => {
  const at = (ageMs: number) => {
    const b = new DatasetBuilder().catalog('melk-halfvol', ['melk'], 1000, 'ml').cover('jumbo');
    const observed = new Date(NOW - ageMs).toISOString();
    b.simple('melk-halfvol', 'ah', 119, 1000, 'ml', observed);
    b.cover('ah'); // keep AH covered even when the melk price is too old
    return store(compareBaskets(input([item('melk')], b.data)), 'ah');
  };

  test.each([
    [0, 'verified', 0],
    [7 * DAY_MS, 'verified', 7],
    [7 * DAY_MS + 1, 'stale', 7],
    [10 * DAY_MS, 'stale', 10],
    [14 * DAY_MS, 'stale', 14],
    [14 * DAY_MS + 1, 'unknown', null],
    [400 * DAY_MS, 'unknown', null],
  ])('age %d ms -> %s', (age, status, days) => {
    const s = at(age);
    expect(s.lines[0]!.status).toBe(status);
    expect(s.lines[0]!.age_days).toBe(days);
    expect(s.complete).toBe(status !== 'unknown');
    expect(s.stale_count).toBe(status === 'stale' ? 1 : 0);
  });

  test('stale prices count towards complete and are reported', () => {
    const b = twoChainBasket();
    b.data.observations.find((o) => o.chain_id === 'jumbo' && o.price_cents === 115)!.observed_at = daysAgo(4 + 7);
    const r = compareBaskets(input([item('melk'), item('volkorenbrood')], b.data));
    expect(store(r, 'jumbo')).toMatchObject({ complete: true, stale_count: 1, total_cents: 115 + 259 });
    expect(r.oldest_price_age_days).toBe(11);
  });

  test('missing observed_at -> unknown, never "fresh"', () => {
    const b = twoChainBasket();
    b.data.observations.find((o) => o.chain_id === 'ah' && o.price_cents === 119)!.observed_at = null;
    const r = compareBaskets(input([item('melk')], b.data));
    expect(store(r, 'ah').lines[0]!).toMatchObject({ status: 'unknown', line_total_cents: null });
  });

  test('garbage or far-future observed_at -> unknown', () => {
    for (const ts of ['gisteren', '', inDays(1)]) {
      const b = twoChainBasket();
      b.data.observations.find((o) => o.chain_id === 'ah' && o.price_cents === 119)!.observed_at = ts;
      const r = compareBaskets(input([item('melk')], b.data));
      expect(store(r, 'ah').lines[0]!.status).toBe('unknown');
    }
  });

  test('observed_at a minute ahead (clock skew) is accepted as age 0', () => {
    const b = twoChainBasket();
    b.data.observations.find((o) => o.chain_id === 'ah' && o.price_cents === 119)!.observed_at = new Date(NOW + 60_000).toISOString();
    expect(store(compareBaskets(input([item('melk')], b.data)), 'ah').lines[0]!).toMatchObject({ status: 'verified', age_days: 0 });
  });

  test('the latest observation wins, even when it is more expensive', () => {
    const b = twoChainBasket();
    const melkAh = b.data.observations.find((o) => o.chain_id === 'ah' && o.price_cents === 119)!;
    b.price(b.data.products.find((p) => p.id === melkAh.product_id)!, 'ah', 99, daysAgo(5));
    b.price(b.data.products.find((p) => p.id === melkAh.product_id)!, 'ah', 135, daysAgo(0));
    expect(store(compareBaskets(input([item('melk')], b.data)), 'ah').lines[0]!.line_total_cents).toBe(135);
  });

  test('a newer observation without observed_at does not hide an older dated one', () => {
    const b = twoChainBasket();
    const melkAh = b.data.observations.find((o) => o.chain_id === 'ah' && o.price_cents === 119)!;
    b.price(b.data.products.find((p) => p.id === melkAh.product_id)!, 'ah', 50, null);
    expect(store(compareBaskets(input([item('melk')], b.data)), 'ah').lines[0]!.line_total_cents).toBe(119);
  });

  test('observation with equal observed_at: later ingested_at wins', () => {
    const b = twoChainBasket();
    const melkAh = b.data.observations.find((o) => o.chain_id === 'ah' && o.price_cents === 119)!;
    const prod = b.data.products.find((p) => p.id === melkAh.product_id)!;
    b.price(prod, 'ah', 121, melkAh.observed_at, { ingested_at: daysAgo(0) });
    expect(store(compareBaskets(input([item('melk')], b.data)), 'ah').lines[0]!.line_total_cents).toBe(121);
  });

  test('a newer observation from an unlicensed source is ignored', () => {
    const b = twoChainBasket();
    b.data.sources.push(OPEN_PRICES);
    const melkAh = b.data.observations.find((o) => o.chain_id === 'ah' && o.price_cents === 119)!;
    b.price(b.data.products.find((p) => p.id === melkAh.product_id)!, 'ah', 10, daysAgo(0), { source_id: OPEN_PRICES.id });
    const r = compareBaskets(input([item('melk')], b.data));
    expect(store(r, 'ah').lines[0]!.line_total_cents).toBe(119);
    expect(r.source_ids).toEqual([LICENSED.id]);
  });

  test('loyalty-only prices never count; the regular price is used', () => {
    const b = twoChainBasket();
    const melkAh = b.data.observations.find((o) => o.chain_id === 'ah' && o.price_cents === 119)!;
    b.price(b.data.products.find((p) => p.id === melkAh.product_id)!, 'ah', 89, daysAgo(0), { requires_loyalty: true });
    expect(store(compareBaskets(input([item('melk')], b.data)), 'ah').lines[0]!.line_total_cents).toBe(119);
  });

  test('a chain covered only by loyalty prices is not covered', () => {
    const b = new DatasetBuilder().catalog('melk-halfvol', ['melk'], 1000, 'ml');
    b.simple('melk-halfvol', 'ah', 119, 1000, 'ml');
    const p = b.product({ ean: '2000000000017', net_content: 1000, net_content_unit: 'ml' });
    b.link('melk-halfvol', 'jumbo', p).price(p, 'jumbo', 100, daysAgo(1), { requires_loyalty: true });
    expect(compareBaskets(input([item('melk')], b.data)).state).toBe('unavailable');
  });

  test('an observation for a chain that is not in chains is ignored', () => {
    const b = twoChainBasket().cover('unknown-chain');
    const r = compareBaskets(input([item('melk')], b.data));
    expect(r.stores.map((s) => s.chain_id)).not.toContain('unknown-chain');
  });
});

describe('links and overrides', () => {
  test('a link below confidence 0.9 is never used', () => {
    const b = twoChainBasket();
    b.data.links.find((l) => l.chain_id === 'ah' && l.catalog_item_id === 'melk-halfvol')!.confidence = 0.89;
    expect(store(compareBaskets(input([item('melk')], b.data)), 'ah').lines[0]!.status).toBe('unknown');
  });

  test('confidence exactly 0.9 is used; > 1 or NaN is rejected', () => {
    const b = twoChainBasket();
    const l = b.data.links.find((x) => x.chain_id === 'ah' && x.catalog_item_id === 'melk-halfvol')!;
    l.confidence = 0.9;
    expect(store(compareBaskets(input([item('melk')], b.data)), 'ah').lines[0]!.status).toBe('verified');
    l.confidence = Number.NaN;
    expect(store(compareBaskets(input([item('melk')], b.data)), 'ah').lines[0]!.status).toBe('unknown');
    l.confidence = 1.5;
    expect(store(compareBaskets(input([item('melk')], b.data)), 'ah').lines[0]!.status).toBe('unknown');
  });

  test('"Verkeerd product" makes that item unknown at that store only, and the store incomplete', () => {
    const b = twoChainBasket();
    const before = compareBaskets(input([item('melk'), item('volkorenbrood')], b.data));
    expect(store(before, 'ah').label).toBe('cheapest');
    b.override('brood-volkoren', 'ah');
    const r = compareBaskets(input([item('melk'), item('volkorenbrood')], b.data));
    expect(store(r, 'ah')).toMatchObject({ complete: false, total_cents: null, priced_count: 1 });
    const line = store(r, 'ah').lines.find((x) => x.item_name === 'volkorenbrood')!;
    expect(line).toMatchObject({ status: 'unknown', catalog_item_id: 'brood-volkoren', line_total_cents: null });
    expect(store(r, 'jumbo')).toMatchObject({ complete: true, label: 'only_complete' });
    // the override never makes AH cheaper
    expect(r.stores[0]!.chain_id).toBe('jumbo');
  });

  test('override is reversible: removing it restores the original result', () => {
    const b = twoChainBasket();
    const items = [item('melk'), item('volkorenbrood')];
    const before = compareBaskets(input(items, b.data));
    b.override('brood-volkoren', 'ah');
    b.data.overrides = [];
    expect(compareBaskets(input(items, b.data))).toEqual(before);
  });

  test('a link to a product without a price at that chain is unknown', () => {
    const b = twoChainBasket();
    const p = b.product({ ean: '2000000000024', net_content: 1000, net_content_unit: 'ml' });
    b.catalog('karnemelk', ['karnemelk'], 1000, 'ml').link('karnemelk', 'ah', p).link('karnemelk', 'jumbo', p);
    b.price(p, 'jumbo', 99);
    const r = compareBaskets(input([item('karnemelk')], b.data));
    expect(store(r, 'ah').lines[0]!.status).toBe('unknown');
    expect(store(r, 'jumbo').lines[0]!.status).toBe('verified');
  });

  test('a price observed at another chain is never used (prices are per chain)', () => {
    const b = twoChainBasket();
    const p = b.product({ ean: '2000000000031', net_content: 1000, net_content_unit: 'ml' });
    b.catalog('karnemelk', ['karnemelk'], 1000, 'ml').link('karnemelk', 'ah', p).link('karnemelk', 'jumbo', p);
    b.price(p, 'jumbo', 99);
    expect(store(compareBaskets(input([item('karnemelk')], b.data)), 'ah').lines[0]!.line_total_cents).toBeNull();
  });

  test('an alias claimed by two catalog items is ambiguous -> unknown everywhere', () => {
    const b = twoChainBasket().catalog('melk-vol', ['melk', 'volle melk'], 1000, 'ml');
    b.simple('melk-vol', 'ah', 129, 1000, 'ml');
    b.simple('melk-vol', 'jumbo', 125, 1000, 'ml');
    const r = compareBaskets(input([item('melk'), item('volle melk')], b.data));
    for (const s of r.stores) {
      expect(s.lines[0]!).toMatchObject({ status: 'unknown', catalog_item_id: null });
      expect(s.lines[1]!).toMatchObject({ status: 'verified', catalog_item_id: 'melk-vol' });
    }
  });

  test('name matching uses the normalized name exactly (accents/case/spaces), never partial', () => {
    const b = twoChainBasket().catalog('creme-fraiche', ['creme fraiche'], 200, 'ml');
    b.simple('creme-fraiche', 'ah', 139, 200, 'ml');
    const it = { ...item('x'), name: '  Crème   Fraîche ', normalized_name: 'creme fraiche' };
    expect(store(compareBaskets(input([it], b.data)), 'ah').lines[0]!.status).toBe('verified');
    expect(store(compareBaskets(input([item('melk biologisch')], b.data)), 'ah').lines[0]!.status).toBe('unknown');
    expect(store(compareBaskets(input([item('mel')], b.data)), 'ah').lines[0]!.status).toBe('unknown');
  });

  test('the note is never used for matching (only name)', () => {
    // BasketRequestItem has no note field at all; a variant in the name is what counts.
    const b = twoChainBasket();
    const r = compareBaskets(input([item('melk halfvol lactosevrij')], b.data));
    expect(r.stores.every((s) => s.lines[0]!.status === 'unknown')).toBe(true);
  });
});

describe('items', () => {
  test('excluded items ("Niet vergelijken") are left out of every store and counted', () => {
    const r = compareBaskets(input([item('melk'), item('cadeautje oma', 1, 'stuk', true)], twoChainBasket().data));
    expect(r).toMatchObject({ state: 'ranked', compared_count: 1, excluded_count: 1 });
    for (const s of r.stores) {
      expect(s.lines).toHaveLength(1);
      expect(s.complete).toBe(true);
    }
  });

  test('duplicate list_item_id is counted once', () => {
    const m = item('melk');
    const r = compareBaskets(input([m, { ...m }], twoChainBasket().data));
    expect(r.compared_count).toBe(1);
    expect(store(r, 'ah').total_cents).toBe(119);
  });

  test('lines keep the list order', () => {
    const items = [item('volkorenbrood'), item('onbekend ding'), item('melk')];
    const r = compareBaskets(input(items, twoChainBasket().data));
    for (const s of r.stores) expect(s.lines.map((l) => l.list_item_id)).toEqual(items.map((i) => i.list_item_id));
  });

  test('invalid quantities (0, negative, NaN) -> unknown, never 0 packs', () => {
    for (const q of [0, -1, Number.NaN]) {
      const r = compareBaskets(input([item('melk', q)], twoChainBasket().data));
      for (const s of r.stores) expect(s.lines[0]!).toMatchObject({ status: 'unknown', package_count: null, line_total_cents: null });
    }
  });

  test('fingerprint and computed_at are passed through', () => {
    const inp = input([item('melk')], twoChainBasket().data);
    const r = compareBaskets(inp);
    expect(r.list_fingerprint).toBe(inp.list_fingerprint);
    expect(r.computed_at).toBe(NOW);
  });

  test('engine does not mutate its input', () => {
    const b = twoChainBasket();
    const inp = input([item('melk'), item('volkorenbrood')], b.data);
    const snapshot = JSON.stringify(inp);
    compareBaskets(inp);
    expect(JSON.stringify(inp)).toBe(snapshot);
  });
});

describe('line details (contract: promotion_valid_until, unit_price)', () => {
  test('unit price is the shelf price per kg / l of the chosen package; promotion end date only when applied', () => {
    const b = new DatasetBuilder().catalog('cola', ['cola'], 1500, 'ml').catalog('melk-halfvol', ['melk'], 1000, 'ml');
    const until = inDays(3);
    const colaAh = b.product({ ean: '8712100000013', net_content: 1500, net_content_unit: 'ml', name: 'Cola 1,5 l' });
    b.link('cola', 'ah', colaAh).promo(colaAh, 'ah', 200, { type: 'x_plus_y', buy: 1, free: 1 }, until);
    b.simple('cola', 'jumbo', 210, 1500, 'ml');
    b.simple('melk-halfvol', 'ah', 119, 1000, 'ml');
    b.simple('melk-halfvol', 'jumbo', 115, 1000, 'ml');
    const r = compareBaskets(input([item('cola', 2), item('melk')], b.data));
    const ahCola = store(r, 'ah').lines.find((l) => l.item_name === 'cola')!;
    expect(ahCola.promotion_applied).toBe(true);
    expect(ahCola.promotion_valid_until).toBe(until);
    expect(ahCola.unit_price).toEqual({ cents: 133, per: 'l' });
    const jumboCola = store(r, 'jumbo').lines.find((l) => l.item_name === 'cola')!;
    expect(jumboCola.promotion_applied).toBe(false);
    expect(jumboCola.promotion_valid_until).toBeNull();
    expect(store(r, 'jumbo').lines.find((l) => l.item_name === 'melk')!.unit_price).toEqual({ cents: 115, per: 'l' });
  });

  test('unknown lines carry no unit price and no promotion date', () => {
    const b = twoChainBasket();
    const r = compareBaskets(input([item('melk'), item('onbekend product')], b.data));
    const line = store(r, 'ah').lines.find((l) => l.item_name === 'onbekend product')!;
    expect(line.status).toBe('unknown');
    expect(line.unit_price).toBeNull();
    expect(line.promotion_valid_until).toBeNull();
    expect(line.line_total_cents).toBeNull();
  });
});
