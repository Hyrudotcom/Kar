import type { ComparisonResult } from '@/src/contracts';
import { compareBaskets } from '../engine';
import { costForPackages, isPromotionUsable, packagesNeeded } from '../packaging';
import { contentMicro, requiredMicro, unitPrice } from '../units';
import { DatasetBuilder, NOW, daysAgo, inDays, input, item } from './fixtures';

const line = (r: ComparisonResult, chain: string, idx = 0) => r.stores.find((s) => s.chain_id === chain)!.lines[idx]!;

describe('required quantity -> packs (exact arithmetic)', () => {
  test.each([
    // [quantity, unit, ref qty, ref unit, pack content, expected packs]
    [1.5, 'l', 1000, 'ml', 1000, 2], // need 1.5 l, pack 1 l -> 2
    [1, 'l', 1000, 'ml', 1000, 1],
    [1.001, 'l', 1000, 'ml', 1000, 2],
    [0.3, 'kg', 1000, 'g', 300, 1], // 0.3*1000 in floats is 300.00000000000006: must still be 1 pack
    [0.7, 'kg', 1000, 'g', 100, 7],
    [2, 'stuk', 1000, 'ml', 1000, 2], // "2 melk" = 2 x 1 l
    [3, 'stuk', 0.1, 'ml', 0.3, 1], // tiny decimals
    [500, 'g', 1000, 'g', 750, 1],
    [1500, 'ml', 1000, 'ml', 500, 3],
    [0.001, 'kg', 1000, 'g', 1, 1],
    [99999, 'kg', 1000, 'g', 0.001, 99_999_000_000],
  ] as const)('%d %s (ref %d %s), pack %d -> %d', (q, u, rq, ru, pack, packs) => {
    const req = requiredMicro(q, u, rq, ru)!;
    expect(packagesNeeded(req, contentMicro(pack)!)).toBe(BigInt(packs));
  });

  test.each([
    [1, 'kg', 'ml'],
    [1, 'l', 'g'],
    [1, 'g', 'stuk'],
    [1, 'ml', 'stuk'],
  ] as const)('dimension mismatch %d %s vs reference %s -> null (unknown)', (q, u, ru) => {
    expect(requiredMicro(q, u, 1, ru)).toBeNull();
  });

  test('invalid quantity or reference -> null', () => {
    expect(requiredMicro(0, 'stuk', 1, 'stuk')).toBeNull();
    expect(requiredMicro(1, 'stuk', 0, 'stuk')).toBeNull();
    expect(requiredMicro(1, 'stuk', 1, 'kg' as never)).toBeNull();
    expect(requiredMicro(1, 'pak' as never, 1, 'stuk')).toBeNull();
  });

  test('engine: need 1,5 l melk with 1 l packs -> 2 packs, 500 ml overage (33%) is reported', () => {
    const b = new DatasetBuilder().catalog('melk-halfvol', ['melk'], 1000, 'ml');
    b.simple('melk-halfvol', 'ah', 119, 1000, 'ml');
    b.simple('melk-halfvol', 'jumbo', 115, 1000, 'ml');
    const r = compareBaskets(input([item('melk', 1.5, 'l')], b.data));
    expect(line(r, 'ah')).toMatchObject({ package_count: 2, package_content: 1000, package_unit: 'ml', line_total_cents: 238, overage: { amount: 500, unit: 'ml' } });
  });

  test('overage exactly 25% is not reported; just above is', () => {
    const b = new DatasetBuilder().catalog('gehakt', ['gehakt'], 400, 'g');
    b.simple('gehakt', 'ah', 359, 500, 'g'); // 500 for 400 = 25% exactly
    b.simple('gehakt', 'jumbo', 359, 300, 'g'); // 2x300=600 for 400 = 50%
    const r = compareBaskets(input([item('gehakt')], b.data));
    expect(line(r, 'ah').overage).toBeNull();
    expect(line(r, 'jumbo')).toMatchObject({ package_count: 2, overage: { amount: 200, unit: 'g' } });
  });

  test('design spec example: rundergehakt 500 g needed, 300 g packs -> 2x, "600 g, 100 g meer" not shown (20%)', () => {
    const b = new DatasetBuilder().catalog('rundergehakt', ['rundergehakt'], 500, 'g');
    b.simple('rundergehakt', 'ah', 359, 300, 'g');
    b.cover('jumbo');
    const r = compareBaskets(input([item('rundergehakt')], b.data));
    expect(line(r, 'ah')).toMatchObject({ package_count: 2, line_total_cents: 718, overage: null });
  });

  test('picks the cheapest total for the required quantity across linked products, not the cheapest pack', () => {
    const b = new DatasetBuilder().catalog('rijst', ['rijst'], 1000, 'g');
    const small = b.product({ ean: '2000000000048', net_content: 400, net_content_unit: 'g', name: 'Rijst 400 g' });
    const big = b.product({ ean: '2000000000055', net_content: 1000, net_content_unit: 'g', name: 'Rijst 1 kg' });
    b.link('rijst', 'ah', small).link('rijst', 'ah', big).price(small, 'ah', 99).price(big, 'ah', 249);
    b.cover('jumbo');
    // 3 x 99 = 297 vs 1 x 249 = 249
    const r = compareBaskets(input([item('rijst')], b.data));
    expect(line(r, 'ah')).toMatchObject({ product_name: 'Rijst 1 kg', package_count: 1, line_total_cents: 249 });
  });

  test('equal cost: smallest overage wins', () => {
    const b = new DatasetBuilder().catalog('rijst', ['rijst'], 900, 'g');
    const a = b.product({ ean: '2000000000062', net_content: 1000, net_content_unit: 'g', name: 'A 1 kg' });
    const c = b.product({ ean: '2000000000079', net_content: 450, net_content_unit: 'g', name: 'B 450 g' });
    b.link('rijst', 'ah', a).link('rijst', 'ah', c).price(a, 'ah', 200).price(c, 'ah', 100);
    b.cover('jumbo');
    expect(line(compareBaskets(input([item('rijst')], b.data)), 'ah')).toMatchObject({ product_name: 'B 450 g', package_count: 2, line_total_cents: 200 });
  });

  test('equal cost and overage: verified beats stale, then EAN order', () => {
    const b = new DatasetBuilder().catalog('rijst', ['rijst'], 1000, 'g');
    const x = b.product({ ean: '2000000000086', net_content: 1000, net_content_unit: 'g', name: 'X' });
    const y = b.product({ ean: '2000000000093', net_content: 1000, net_content_unit: 'g', name: 'Y' });
    b.link('rijst', 'ah', x).link('rijst', 'ah', y).price(x, 'ah', 200, daysAgo(9)).price(y, 'ah', 200, daysAgo(1));
    b.cover('jumbo');
    expect(line(compareBaskets(input([item('rijst')], b.data)), 'ah').product_name).toBe('Y');
    b.data.observations.find((o) => o.product_id === x.id)!.observed_at = daysAgo(1);
    expect(line(compareBaskets(input([item('rijst')], b.data)), 'ah').product_name).toBe('X'); // lower EAN
  });
});

describe('promotions', () => {
  const multi = { type: 'multi_buy' as const, min_quantity: 2, total_cents: 300 }; // 2 voor €3
  const onePlusOne = { type: 'x_plus_y' as const, buy: 1, free: 1 };

  test.each([
    [1n, 199, false, 199],
    [2n, 199, true, 300],
    [3n, 199, true, 499],
    [4n, 199, true, 600],
  ])('2 voor €3: %d packs at %d -> applied=%s, %d', (n, price, applied, total) => {
    expect(costForPackages(n, price, multi, true)).toEqual({ packages: n, cost_cents: BigInt(total), promotion_applied: applied });
  });

  test.each([
    [1n, false, 250],
    [2n, true, 250],
    [3n, true, 500],
    [4n, true, 500],
  ])('1+1: %d packs at 250 -> applied=%s, %d', (n, applied, total) => {
    expect(costForPackages(n, 250, onePlusOne, true)).toMatchObject({ cost_cents: BigInt(total), promotion_applied: applied });
  });

  test('2+1 (x_plus_y buy 2 free 1): 3 packs pay 2, 5 packs pay 4', () => {
    const p = { type: 'x_plus_y' as const, buy: 2, free: 1 };
    expect(costForPackages(3n, 100, p, true).cost_cents).toBe(200n);
    expect(costForPackages(5n, 100, p, true).cost_cents).toBe(400n);
    expect(costForPackages(6n, 100, p, true).cost_cents).toBe(400n);
  });

  test('a "promotion" that costs more than the shelf price is not applied', () => {
    expect(costForPackages(2n, 100, { type: 'multi_buy', min_quantity: 2, total_cents: 250 }, true)).toMatchObject({ cost_cents: 200n, promotion_applied: false });
  });

  test('validity: needs a known end in the future', () => {
    expect(isPromotionUsable(multi, inDays(1), NOW)).toBe(true);
    expect(isPromotionUsable(multi, new Date(NOW).toISOString(), NOW)).toBe(false);
    expect(isPromotionUsable(multi, daysAgo(1), NOW)).toBe(false);
    expect(isPromotionUsable(multi, null, NOW)).toBe(false);
    expect(isPromotionUsable(null, inDays(1), NOW)).toBe(false);
    expect(isPromotionUsable({ type: 'multi_buy', min_quantity: 1, total_cents: 100 }, inDays(1), NOW)).toBe(false);
    expect(isPromotionUsable({ type: 'multi_buy', min_quantity: 2, total_cents: 0 }, inDays(1), NOW)).toBe(false);
    expect(isPromotionUsable({ type: 'x_plus_y', buy: 1, free: 0 }, inDays(1), NOW)).toBe(false);
    expect(isPromotionUsable({ type: 'bogus' } as never, inDays(1), NOW)).toBe(false);
  });

  test('engine: promotion only when the required pack count reaches it', () => {
    const b = new DatasetBuilder().catalog('cola', ['cola'], 1500, 'ml');
    const p = b.product({ ean: '2000000000109', net_content: 1500, net_content_unit: 'ml', name: 'Cola 1,5 l' });
    b.link('cola', 'ah', p).promo(p, 'ah', 199, multi);
    b.cover('jumbo');
    expect(line(compareBaskets(input([item('cola', 1)], b.data)), 'ah')).toMatchObject({ line_total_cents: 199, promotion_applied: false });
    expect(line(compareBaskets(input([item('cola', 2)], b.data)), 'ah')).toMatchObject({ line_total_cents: 300, promotion_applied: true });
  });

  test('engine: an expired promotion falls back to the regular price', () => {
    const b = new DatasetBuilder().catalog('cola', ['cola'], 1500, 'ml');
    const p = b.product({ ean: '2000000000116', net_content: 1500, net_content_unit: 'ml' });
    b.link('cola', 'ah', p).promo(p, 'ah', 199, multi, daysAgo(0.5));
    b.cover('jumbo');
    expect(line(compareBaskets(input([item('cola', 2)], b.data)), 'ah')).toMatchObject({ line_total_cents: 398, promotion_applied: false });
  });
});

describe('unit price (display)', () => {
  test('per kg, per l, per stuk; rounded half up', () => {
    expect(unitPrice(249, 800, 'g')).toEqual({ cents: 311, per: 'kg' }); // 311.25
    expect(unitPrice(219, 1000, 'g')).toEqual({ cents: 219, per: 'kg' });
    expect(unitPrice(299, 570, 'ml')).toEqual({ cents: 525, per: 'l' }); // 524.56
    expect(unitPrice(1, 2000, 'ml')).toEqual({ cents: 1, per: 'l' }); // 0.5 -> 1
    expect(unitPrice(899, 18, 'stuk')).toEqual({ cents: 50, per: 'stuk' }); // 49.94
    expect(unitPrice(0, 1, 'stuk')).toBeNull();
    expect(unitPrice(100, 0, 'g')).toBeNull();
  });
});
