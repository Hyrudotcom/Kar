/**
 * Variant traps from discovery/price-provider-verdict.md ("Variantvallen die we zagen").
 * All prices here are invented test values; EANs marked "verdict" are the real ones from the verdict.
 */
import type { ComparisonResult } from '@/src/contracts';
import { isValidGtin } from '../ean';
import { compareBaskets } from '../engine';
import { unitPrice } from '../units';
import { DatasetBuilder, input, item } from './fixtures';

const store = (r: ComparisonResult, chain: string) => r.stores.find((s) => s.chain_id === chain)!;

describe('Heinz Tomato Ketchup: regular is 570 ml; 500 ml is Bio / Hot Chilli / Lidl variant', () => {
  function heinz() {
    const b = new DatasetBuilder().catalog('ketchup-heinz-tomato', ['heinz ketchup', 'ketchup'], 570, 'ml');
    const regular = b.product({ ean: '8715700421698', net_content: 570, net_content_unit: 'ml', name: 'Heinz Tomato Ketchup 570 ml', brand: 'Heinz' });
    // verdict EAN for the 500 ml version: same name family, different variant
    const bio500 = b.product({ ean: '8715700017006', net_content: 500, net_content_unit: 'ml', name: 'Heinz Tomato Ketchup Bio 500 ml', brand: 'Heinz' });
    b.link('ketchup-heinz-tomato', 'ah', regular).link('ketchup-heinz-tomato', 'jumbo', regular);
    b.price(regular, 'ah', 349).price(regular, 'jumbo', 339);
    // a cheap price exists for the 500 ml variant at both chains, but it is not linked
    b.price(bio500, 'ah', 199).price(bio500, 'jumbo', 189);
    return { b, regular, bio500 };
  }

  test('the unlinked 500 ml variant is never used, however cheap', () => {
    const { b } = heinz();
    const r = compareBaskets(input([item('ketchup')], b.data));
    for (const chain of ['ah', 'jumbo']) {
      expect(store(r, chain).lines[0]!).toMatchObject({ ean: '8715700421698', package_content: 570, package_count: 1 });
    }
    expect(store(r, 'jumbo')).toMatchObject({ total_cents: 339, label: 'cheapest' });
  });

  test('if a chain only has the 500 ml variant, it is unknown there unless explicitly linked', () => {
    const { b } = heinz();
    b.data.observations = b.data.observations.filter((o) => !(o.chain_id === 'jumbo' && o.price_cents === 339));
    const r = compareBaskets(input([item('ketchup')], b.data));
    expect(store(r, 'jumbo').lines[0]!.status).toBe('unknown');
    expect(store(r, 'jumbo').complete).toBe(false);
  });

  test('explicitly linking 500 ml for 570 ml required means 2 packs (same quantity rule), with overage shown', () => {
    const { b, bio500 } = heinz();
    b.data.observations = b.data.observations.filter((o) => !(o.chain_id === 'jumbo' && o.price_cents === 339));
    b.data.links = b.data.links.filter((l) => l.chain_id !== 'jumbo');
    b.link('ketchup-heinz-tomato', 'jumbo', bio500);
    const r = compareBaskets(input([item('ketchup')], b.data));
    expect(store(r, 'jumbo').lines[0]!).toMatchObject({ package_count: 2, line_total_cents: 378, overage: { amount: 430, unit: 'ml' } });
    expect(r.stores[0]!.chain_id).toBe('ah'); // 349 < 378: the "cheaper bottle" does not win the basket
  });

  test('unit price per l differs per variant', () => {
    expect(unitPrice(349, 570, 'ml')).toEqual({ cents: 612, per: 'l' });
    expect(unitPrice(199, 500, 'ml')).toEqual({ cents: 398, per: 'l' });
  });
});

describe('Ariel Original vloeibaar: 900 ml = 20 wasbeurten, Plus 810 ml = 18 wasbeurten', () => {
  // Detergent catalog items count wasbeurten as `stuk`; product net_content = number of wasbeurten.
  function ariel() {
    const b = new DatasetBuilder().catalog('wasmiddel-ariel-original', ['ariel', 'wasmiddel ariel'], 20, 'stuk');
    const ah900 = b.product({ ean: '8700216604123', net_content: 20, net_content_unit: 'stuk', name: 'Ariel Original 900 ml (20 wasbeurten)' });
    const plus810 = b.product({ ean: '8700216604130', net_content: 18, net_content_unit: 'stuk', name: 'Ariel Original 810 ml (18 wasbeurten)' });
    b.link('wasmiddel-ariel-original', 'ah', ah900).link('wasmiddel-ariel-original', 'plus', plus810);
    b.price(ah900, 'ah', 1099).price(plus810, 'plus', 899);
    return b;
  }

  test('compared per wasbeurt: 20 wasbeurten needed -> AH 1 fles, Plus 2 flessen', () => {
    const r = compareBaskets(input([item('ariel')], ariel().data));
    expect(store(r, 'ah').lines[0]!).toMatchObject({ package_count: 1, line_total_cents: 1099, overage: null });
    expect(store(r, 'plus').lines[0]!).toMatchObject({ package_count: 2, line_total_cents: 1798, overage: { amount: 16, unit: 'stuk' } });
    expect(r.stores.map((s) => s.chain_id)).toEqual(['ah', 'plus']);
  });

  test('per bottle Plus looks cheaper, per wasbeurt AH is 55 ct vs Plus 50 ct, but the basket compares the required quantity', () => {
    expect(unitPrice(1099, 20, 'stuk')).toEqual({ cents: 55, per: 'stuk' });
    expect(unitPrice(899, 18, 'stuk')).toEqual({ cents: 50, per: 'stuk' });
    // need 36 wasbeurten: Plus 2 x 18 exactly = 1798, AH 2 x 20 = 2198
    const r = compareBaskets(input([item('ariel', 1.8)], ariel().data));
    expect(store(r, 'plus')).toMatchObject({ total_cents: 1798, label: 'cheapest' });
    expect(store(r, 'ah')).toMatchObject({ total_cents: 2198, delta_cents: 400 });
  });

  test('a bottle measured in ml cannot be linked to a per-wasbeurt catalog item', () => {
    const b = ariel();
    const ml = b.product({ ean: '8700216604147', net_content: 900, net_content_unit: 'ml', name: 'Ariel 900 ml' });
    b.data.links = b.data.links.filter((l) => l.chain_id !== 'plus');
    b.link('wasmiddel-ariel-original', 'plus', ml).price(ml, 'plus', 100);
    expect(store(compareBaskets(input([item('ariel')], b.data)), 'plus').lines[0]!.status).toBe('unknown');
  });

  test('"2 l ariel" (volume on the list) vs per-wasbeurt catalog -> unknown, no guessing', () => {
    const r = compareBaskets(input([item('ariel', 2, 'l')], ariel().data));
    for (const s of r.stores) expect(s.lines[0]!.status).toBe('unknown');
  });
});

describe('Calvé Pindakaas 350 g: 6+ variants with the same name and weight; only EAN decides', () => {
  function calve() {
    const b = new DatasetBuilder().catalog('pindakaas-calve-original', ['pindakaas', 'calve pindakaas'], 350, 'g');
    // verdict EANs
    const original = b.product({ ean: '8712423007253', net_content: 350, net_content_unit: 'g', name: 'Calvé Pindakaas 350 g', brand: 'Calvé' });
    const other = b.product({ ean: '8720182127426', net_content: 350, net_content_unit: 'g', name: 'Calvé Pindakaas 350 g', brand: 'Calvé' });
    const crunchy = b.product({ ean: '8712423007260', net_content: 350, net_content_unit: 'g', name: 'Calvé Pindakaas Crunchy 350 g', brand: 'Calvé' });
    b.link('pindakaas-calve-original', 'ah', original).link('pindakaas-calve-original', 'jumbo', original);
    b.price(original, 'ah', 349).price(original, 'jumbo', 625);
    b.price(other, 'jumbo', 249).price(crunchy, 'jumbo', 259).price(other, 'ah', 249);
    return { b, original, other };
  }

  test('two 350 g products with identical names but different EANs never cross-match', () => {
    const { b } = calve();
    const r = compareBaskets(input([item('pindakaas')], b.data));
    expect(store(r, 'jumbo').lines[0]!).toMatchObject({ ean: '8712423007253', line_total_cents: 625 });
    expect(store(r, 'ah').lines[0]!).toMatchObject({ ean: '8712423007253', line_total_cents: 349 });
  });

  test('without a link at a chain, an identically named product there does not count', () => {
    const { b } = calve();
    b.data.links = b.data.links.filter((l) => l.chain_id !== 'jumbo');
    const r = compareBaskets(input([item('pindakaas')], b.data));
    expect(store(r, 'jumbo').lines[0]!).toMatchObject({ status: 'unknown', ean: null, line_total_cents: null });
  });

  test('the verdict EANs are valid GTIN-13s', () => {
    for (const e of ['8712800012078', '8715700017006', '8712423007253', '8720182127426', '8076800195057', '8700216604123']) {
      expect(isValidGtin(e)).toBe(true);
    }
  });
});

describe('Bananen: tros, per kg, 5 stuks and los are different products', () => {
  test('catalog per kg: a per-kg product is used, a tros (stuk) product is never used', () => {
    const b = new DatasetBuilder().catalog('bananen', ['bananen'], 1000, 'g');
    const perKg = b.product({ ean: '2000000000123', net_content: 1000, net_content_unit: 'g', name: 'Bananen per kg' });
    const tros = b.product({ ean: '2000000000130', net_content: 5, net_content_unit: 'stuk', name: 'Bananen tros 5 stuks' });
    b.link('bananen', 'ah', perKg).link('bananen', 'jumbo', tros); // a wrong-dimension link is ignored
    b.price(perKg, 'ah', 219).price(tros, 'jumbo', 149);
    const r = compareBaskets(input([item('bananen', 1, 'kg')], b.data));
    expect(store(r, 'ah').lines[0]!).toMatchObject({ status: 'verified', line_total_cents: 219 });
    expect(store(r, 'jumbo').lines[0]!).toMatchObject({ status: 'unknown', line_total_cents: null });
  });

  test('need 1,5 kg with a per-kg product -> 2 x 1 kg (no estimated weight pricing), overage shown', () => {
    const b = new DatasetBuilder().catalog('bananen', ['bananen'], 1000, 'g');
    b.simple('bananen', 'ah', 219, 1000, 'g');
    b.cover('jumbo');
    const r = compareBaskets(input([item('bananen', 1.5, 'kg')], b.data));
    expect(store(r, 'ah').lines[0]!).toMatchObject({ package_count: 2, line_total_cents: 438, overage: { amount: 500, unit: 'g' } });
  });

  test('catalog per stuk: "6 bananen" with tros of 5 -> 2 trossen; "1 kg bananen" -> unknown (no stuk/kg guess)', () => {
    const b = new DatasetBuilder().catalog('bananen', ['bananen'], 1, 'stuk');
    b.simple('bananen', 'ah', 149, 5, 'stuk');
    b.simple('bananen', 'jumbo', 35, 1, 'stuk'); // los
    const six = compareBaskets(input([item('bananen', 6)], b.data));
    expect(store(six, 'ah').lines[0]!).toMatchObject({ package_count: 2, line_total_cents: 298 });
    expect(store(six, 'jumbo').lines[0]!).toMatchObject({ package_count: 6, line_total_cents: 210 });
    const kg = compareBaskets(input([item('bananen', 1, 'kg')], b.data));
    for (const s of kg.stores) expect(s.lines[0]!.status).toBe('unknown');
  });
});

describe('Huismerk volkorenbrood: per-chain EAN, equivalence only via an explicit link', () => {
  function huismerk() {
    const b = new DatasetBuilder().catalog('brood-volkoren-heel', ['volkorenbrood'], 800, 'g');
    const ahBrood = b.product({ ean: '8710400000017', chain_id: 'ah', net_content: 800, net_content_unit: 'g', name: 'AH Volkorenbrood heel' });
    const jumboBrood = b.product({ ean: '8718452000018', chain_id: 'jumbo', net_content: 800, net_content_unit: 'g', name: 'Jumbo Volkorenbrood heel' });
    b.link('brood-volkoren-heel', 'ah', ahBrood);
    b.price(ahBrood, 'ah', 229).price(jumboBrood, 'jumbo', 219);
    return { b, ahBrood, jumboBrood };
  }

  test('without an explicit Jumbo link, the Jumbo huismerk price is not used', () => {
    const { b } = huismerk();
    const r = compareBaskets(input([item('volkorenbrood')], b.data));
    expect(store(r, 'jumbo').lines[0]!.status).toBe('unknown');
    expect(store(r, 'ah')).toMatchObject({ complete: true, label: 'only_complete' });
  });

  test('with an explicit link, the Jumbo huismerk counts as the same item', () => {
    const { b, jumboBrood } = huismerk();
    b.link('brood-volkoren-heel', 'jumbo', jumboBrood);
    const r = compareBaskets(input([item('volkorenbrood')], b.data));
    expect(store(r, 'jumbo')).toMatchObject({ total_cents: 219, label: 'cheapest' });
    expect(store(r, 'jumbo').lines[0]!.product_name).toBe('Jumbo Volkorenbrood heel');
  });

  test('linking the AH huismerk product to Jumbo is rejected (a private label is sold only at its chain)', () => {
    const { b, ahBrood } = huismerk();
    b.link('brood-volkoren-heel', 'jumbo', ahBrood);
    b.price(ahBrood, 'jumbo', 199); // bogus observation of an AH product at Jumbo
    const r = compareBaskets(input([item('volkorenbrood')], b.data));
    expect(store(r, 'jumbo').lines[0]!.status).toBe('unknown');
  });
});
