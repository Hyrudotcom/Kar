import type { BasketLine, ComparisonResult, StoreBasket } from '@/src/contracts';
import { isValidGtin } from '../ean';
import { fingerprintMatches, fnv1a64, listFingerprint } from '../fingerprint';
import {
  PRICE_COPY,
  formatAge,
  formatAmount,
  formatBasketTotal,
  formatCents,
  formatCoverage,
  formatDelta,
  formatLineAmount,
  formatMissing,
  formatOverage,
  formatPackages,
  formatResultHeader,
  formatStoreLabel,
} from '../format';
import { PRICE_PROVIDERS, providerAvailability, validateProviderObservation, type PriceProvider, type ProviderObservation } from '../provider';
import { emptyDataset, loadPriceDataset, PriceDataError, type PriceReadClient } from '../repository';
import { DAY_MS, ageMs, priceStatusOf } from '../status';
import { LICENSED, NOW, OPEN_PRICES, daysAgo, inDays, item } from './fixtures';

describe('priceStatusOf', () => {
  test('boundaries, confidence and overrides', () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(priceStatusOf(at(0), NOW, 1, false)).toBe('verified');
    expect(priceStatusOf(at(7 * DAY_MS), NOW, 1, false)).toBe('verified');
    expect(priceStatusOf(at(7 * DAY_MS + 1), NOW, 1, false)).toBe('stale');
    expect(priceStatusOf(at(14 * DAY_MS), NOW, 1, false)).toBe('stale');
    expect(priceStatusOf(at(14 * DAY_MS + 1), NOW, 1, false)).toBe('unknown');
    expect(priceStatusOf(null, NOW, 1, false)).toBe('unknown');
    expect(priceStatusOf('nonsense', NOW, 1, false)).toBe('unknown');
    expect(priceStatusOf(at(0), NOW, 0.89, false)).toBe('unknown');
    expect(priceStatusOf(at(0), NOW, 0.9, false)).toBe('verified');
    expect(priceStatusOf(at(0), NOW, 1, true)).toBe('unknown');
    expect(priceStatusOf(inDays(1), NOW, 1, false)).toBe('unknown');
  });

  test('timezone offsets are honoured', () => {
    expect(ageMs('2026-10-23T14:00:00+02:00', NOW)).toBe(0);
    expect(ageMs('2026-10-16T13:59:59+02:00', NOW)).toBe(7 * DAY_MS + 1000);
  });
});

describe('listFingerprint', () => {
  const a = item('melk', 2, 'l', false, 'aaaaaaaa-0000-4000-8000-000000000001');
  const b = item('brood', 1, 'stuk', false, 'aaaaaaaa-0000-4000-8000-000000000002');

  test('stable, order independent, versioned', () => {
    const f = listFingerprint([a, b]);
    expect(f).toBe(listFingerprint([b, a]));
    expect(f).toMatch(/^v1:2:[0-9a-f]{16}$/);
    expect(fingerprintMatches([b, a], f)).toBe(true);
    expect(fingerprintMatches([a], f)).toBe(false);
    expect(fingerprintMatches([a, b], null)).toBe(false);
  });

  test('changes with every compared field', () => {
    const f = listFingerprint([a, b]);
    expect(listFingerprint([{ ...a, quantity: 3 }, b])).not.toBe(f);
    expect(listFingerprint([{ ...a, unit: 'ml' }, b])).not.toBe(f);
    expect(listFingerprint([{ ...a, normalized_name: 'karnemelk' }, b])).not.toBe(f);
    expect(listFingerprint([{ ...a, excluded: true }, b])).not.toBe(f);
    expect(listFingerprint([{ ...a, list_item_id: 'x' }, b])).not.toBe(f);
  });

  test('display name and float noise do not change it', () => {
    const f = listFingerprint([a, b]);
    expect(listFingerprint([{ ...a, name: 'MELK' }, b])).toBe(f);
    expect(listFingerprint([{ ...a, quantity: 2.0000000001 }, b])).toBe(f);
  });

  test('separators cannot collide', () => {
    const x = { ...a, normalized_name: 'a","b' };
    const y = { ...a, normalized_name: 'a', unit: 'stuk' as const };
    expect(listFingerprint([x])).not.toBe(listFingerprint([y]));
  });

  test('FNV-1a 64 reference vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
    expect(fnv1a64('crème')).not.toBe(fnv1a64('creme'));
  });
});

describe('format (Dutch)', () => {
  const basket = (over: Partial<StoreBasket>): StoreBasket => ({
    chain_id: 'ah',
    chain_name: 'Albert Heijn',
    complete: true,
    total_cents: 3842,
    delta_cents: null,
    priced_count: 12,
    compared_count: 12,
    stale_count: 0,
    label: 'cheapest',
    lines: [],
    ...over,
  });
  const ln = (over: Partial<BasketLine>): BasketLine => ({
    list_item_id: 'x',
    item_name: 'Rundergehakt',
    status: 'verified',
    catalog_item_id: 'c',
    product_name: 'p',
    ean: '1',
    package_count: 2,
    package_content: 300,
    package_unit: 'g',
    line_total_cents: 718,
    overage: null,
    age_days: 1,
    promotion_applied: false,
    promotion_valid_until: null,
    unit_price: null,
    ...over,
  });

  test('money', () => {
    expect(formatCents(3842)).toBe('€38,42');
    expect(formatCents(5)).toBe('€0,05');
    expect(formatCents(123456)).toBe('€1.234,56');
    expect(formatCents(-268)).toBe('-€2,68');
    expect(() => formatCents(null as never)).toThrow();
    expect(() => formatCents(1.5)).toThrow();
    expect(formatDelta(268)).toBe('+€2,68');
    expect(formatDelta(null)).toBeNull();
  });

  test('incomplete baskets never get an amount', () => {
    expect(formatBasketTotal(basket({}))).toBe('€38,42');
    expect(formatBasketTotal(basket({ complete: false, total_cents: null }))).toBeNull();
    expect(formatBasketTotal(basket({ complete: false, total_cents: 100 }))).toBeNull();
    expect(formatCoverage(basket({ complete: false, priced_count: 10 }))).toBe('10 van 12 prijzen');
    expect(formatMissing(basket({ complete: false, priced_count: 10 }))).toBe('2 van 12 zonder prijs');
  });

  test('store labels', () => {
    expect(formatStoreLabel(basket({ stale_count: 1 }))).toBe('Goedkoopste · 1 verouderd');
    expect(formatStoreLabel(basket({ label: 'only_complete' }))).toBe('Enige complete mand');
    expect(formatStoreLabel(basket({ label: null }))).toBeNull();
    expect(formatStoreLabel(basket({ label: null, complete: false, stale_count: 2 }))).toBeNull();
  });

  test('lines', () => {
    expect(formatLineAmount(ln({}))).toBe('€7,18');
    expect(formatLineAmount(ln({ status: 'unknown', line_total_cents: null }))).toBe('Geen prijs');
    expect(formatLineAmount(ln({ status: 'unknown', line_total_cents: 0 }))).toBe('Geen prijs');
    expect(formatPackages(ln({}))).toBe('2×');
    expect(formatPackages(ln({ package_count: null }))).toBeNull();
    expect(formatOverage(ln({ overage: { amount: 100, unit: 'g' } }))).toBe('600 g, 100 g meer');
    expect(formatOverage(ln({}))).toBeNull();
    expect(formatAge(ln({ status: 'stale', age_days: 4 }))).toBe('4 d oud');
    expect(formatAge(ln({ status: 'verified', age_days: 4 }))).toBeNull();
    expect(formatAmount(1500, 'g')).toBe('1,5 kg');
    expect(formatAmount(570, 'ml')).toBe('570 ml');
    expect(formatAmount(2000, 'ml')).toBe('2 l');
    expect(formatAmount(1, 'stuk')).toBe('1 stuk');
    expect(formatAmount(16, 'stuk')).toBe('16 stuks');
  });

  test('result header', () => {
    const r = { compared_count: 12, excluded_count: 0, oldest_price_age_days: 4 } as ComparisonResult;
    expect(formatResultHeader(r)).toBe('12 items · oudste prijs 4 d');
    expect(formatResultHeader({ ...r, compared_count: 11, excluded_count: 1 })).toBe('11 van 12 items vergeleken · 1 uitgesloten · oudste prijs 4 d');
    expect(formatResultHeader({ ...r, compared_count: 1, oldest_price_age_days: null })).toBe('1 item');
  });

  test('unavailable copy', () => {
    expect(PRICE_COPY.unavailableTitle).toBe('Geen geverifieerde prijzen beschikbaar');
    expect(PRICE_COPY.unavailableBody).toBe('We laten liever niets zien dan een verkeerde vergelijking.');
  });
});

describe('provider', () => {
  test('no provider is wired today: honest "none available"', () => {
    expect(PRICE_PROVIDERS).toHaveLength(0);
    expect(Object.isFrozen(PRICE_PROVIDERS)).toBe(true);
    expect(providerAvailability()).toEqual({ available: false, reason: 'no_licensed_source' });
  });

  test('an unlicensed provider (Open Prices today) does not make prices available', () => {
    const fake: PriceProvider = { source: OPEN_PRICES, fetchObservations: async () => [] };
    expect(providerAvailability([fake])).toEqual({ available: false, reason: 'no_licensed_source' });
    const licensed: PriceProvider = { source: LICENSED, fetchObservations: async () => [] };
    expect(providerAvailability([fake, licensed])).toEqual({ available: true, providers: [licensed] });
  });

  const good: ProviderObservation = {
    ean: '8712800012078',
    chain_id: 'ah',
    price_cents: 119,
    net_content: 1000,
    net_content_unit: 'ml',
    unit_price_cents: 119,
    unit_price_unit: 'ml',
    promotion: null,
    promotion_valid_until: null,
    requires_loyalty: false,
    observed_at: daysAgo(1),
  };

  test('validation rejects impossible rows', () => {
    expect(validateProviderObservation(good)).toBeNull();
    expect(validateProviderObservation({ ...good, observed_at: null })).toBeNull(); // stored, always unknown
    expect(validateProviderObservation({ ...good, ean: '8712800012079' })).toBe('invalid_ean');
    expect(validateProviderObservation({ ...good, ean: 'abc' })).toBe('invalid_ean');
    expect(validateProviderObservation({ ...good, price_cents: 0 })).toBe('invalid_price');
    expect(validateProviderObservation({ ...good, price_cents: 1.19 })).toBe('invalid_price');
    expect(validateProviderObservation({ ...good, net_content: null })).toBe('invalid_content');
    expect(validateProviderObservation({ ...good, net_content: 0 })).toBe('invalid_content');
    expect(validateProviderObservation({ ...good, unit_price_unit: null })).toBe('invalid_unit_price');
    expect(validateProviderObservation({ ...good, observed_at: 'gisteren' })).toBe('invalid_observed_at');
    expect(validateProviderObservation({ ...good, promotion: { type: 'multi_buy', min_quantity: 1, total_cents: 100 } })).toBe('invalid_promotion');
    expect(validateProviderObservation({ ...good, promotion: { type: 'x_plus_y', buy: 1, free: 1 } })).toBeNull();
  });
});

describe('GTIN', () => {
  test('check digit and lengths', () => {
    expect(isValidGtin('8712800012078')).toBe(true);
    expect(isValidGtin('96385074')).toBe(true); // GTIN-8
    expect(isValidGtin('036000291452')).toBe(true); // GTIN-12
    expect(isValidGtin('10012345678902')).toBe(true); // GTIN-14
    expect(isValidGtin('8712800012077')).toBe(false);
    expect(isValidGtin('871280001207')).toBe(false); // 12 digits with wrong check digit
    expect(isValidGtin('123456789')).toBe(false);
    expect(isValidGtin(8712800012078)).toBe(false);
  });
});

describe('repository', () => {
  function client(tables: Record<string, unknown[]>, errors: Record<string, string> = {}) {
    const calls: string[] = [];
    const c: PriceReadClient = {
      from(table) {
        return {
          select(cols) {
            calls.push(`${table}:${cols}`);
            return Promise.resolve(errors[table] ? { data: null, error: { message: errors[table] } } : { data: tables[table] ?? [], error: null });
          },
        };
      },
    };
    return { c, calls };
  }

  test('v1: no verified source -> only price_sources is read', async () => {
    const { c, calls } = client({ price_sources: [{ ...OPEN_PRICES }] });
    const ds = await loadPriceDataset(c);
    expect(ds).toEqual(emptyDataset([OPEN_PRICES]));
    expect(calls).toHaveLength(1);
  });

  test('with a verified source, all tables are read and numerics coerced', async () => {
    const { c, calls } = client({
      price_sources: [LICENSED],
      chains: [{ id: 'ah', name: 'Albert Heijn' }],
      catalog_items: [{ id: 'melk', display_name: 'Melk', aliases: ['melk'], reference_quantity: '1000.000', reference_unit: 'ml' }],
      products: [{ id: 'p', ean: '8712800012078', chain_id: null, name: 'Melk', brand: null, net_content: '1000.000', net_content_unit: 'ml' }],
      catalog_product_links: [{ catalog_item_id: 'melk', chain_id: 'ah', product_id: 'p', confidence: '0.95' }],
      price_observations: [
        { id: 'o', product_id: 'p', chain_id: 'ah', source_id: LICENSED.id, price_cents: 119, unit_price_cents: null, unit_price_unit: null, promotion: null, promotion_valid_until: null, requires_loyalty: null, observed_at: null, ingested_at: daysAgo(0) },
      ],
      price_match_overrides: [
        { household_id: 'h1', catalog_item_id: 'melk', chain_id: 'ah', created_by: null, created_at: daysAgo(0) },
        { household_id: 'h2', catalog_item_id: 'melk', chain_id: 'ah', created_by: null, created_at: daysAgo(0) },
      ],
    });
    const ds = await loadPriceDataset(c, { householdId: 'h1' });
    expect(calls).toHaveLength(7);
    expect(ds.catalog[0]!.reference_quantity).toBe(1000);
    expect(ds.products[0]!.net_content).toBe(1000);
    expect(ds.links[0]!.confidence).toBe(0.95);
    expect(ds.observations[0]!.requires_loyalty).toBe(true); // null is not "no loyalty"
    expect(ds.overrides.map((o) => o.household_id)).toEqual(['h1']);
  });

  test('errors are surfaced, never turned into an empty (cheaper) dataset', async () => {
    const { c } = client({ price_sources: [LICENSED] }, { price_observations: 'permission denied' });
    await expect(loadPriceDataset(c)).rejects.toBeInstanceOf(PriceDataError);
  });
});
