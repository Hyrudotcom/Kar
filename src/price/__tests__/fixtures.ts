/**
 * TEST FIXTURES ONLY. These prices are invented for unit tests and must never be seeded or shown.
 * Builder for PriceDataset with sensible defaults; every test states what it varies.
 */
import type {
  BaseUnit,
  BasketRequestItem,
  CatalogItem,
  CompareInput,
  PriceDataset,
  PriceObservation,
  PriceSource,
  Product,
  Promotion,
  Unit,
} from '@/src/contracts';
import { listFingerprint } from '../fingerprint';
import { DAY_MS } from '../status';

export const NOW = Date.parse('2026-10-23T12:00:00.000Z');
export const daysAgo = (d: number): string => new Date(NOW - d * DAY_MS).toISOString();
export const inDays = (d: number): string => new Date(NOW + d * DAY_MS).toISOString();

export const LICENSED: PriceSource = {
  id: 'test_feed',
  name: 'Testfeed',
  licence: 'test-licence',
  licence_url: null,
  attribution: null,
  channel: 'webshop',
  verified_for_consumer_display: true,
};

export const OPEN_PRICES: PriceSource = {
  id: 'open_prices',
  name: 'Open Prices',
  licence: 'ODbL-1.0',
  licence_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
  attribution: 'Open Food Facts contributors',
  channel: 'national',
  verified_for_consumer_display: false,
};

export const CHAINS = [
  { id: 'ah', name: 'Albert Heijn' },
  { id: 'jumbo', name: 'Jumbo' },
  { id: 'plus', name: 'Plus' },
  { id: 'lidl', name: 'Lidl' },
];

let seq = 0;
const id = (prefix: string): string => `${prefix}-${(++seq).toString().padStart(4, '0')}`;

export class DatasetBuilder {
  data: PriceDataset = {
    sources: [LICENSED],
    chains: [...CHAINS],
    catalog: [],
    products: [],
    links: [],
    observations: [],
    overrides: [],
  };

  catalog(cid: string, aliases: string[], reference_quantity: number, reference_unit: BaseUnit): this {
    const c: CatalogItem = { id: cid, display_name: cid, aliases, reference_quantity, reference_unit };
    this.data.catalog.push(c);
    return this;
  }

  product(p: Partial<Product> & { ean: string; net_content: number; net_content_unit: BaseUnit }): Product {
    const prod: Product = { id: p.id ?? id('prod'), chain_id: null, name: p.ean, brand: null, ...p };
    this.data.products.push(prod);
    return prod;
  }

  link(catalogId: string, chainId: string, product: Product, confidence = 1): this {
    this.data.links.push({ catalog_item_id: catalogId, chain_id: chainId, product_id: product.id, confidence });
    return this;
  }

  price(
    product: Product,
    chainId: string,
    price_cents: number,
    observed_at: string | null = daysAgo(1),
    extra: Partial<PriceObservation> = {},
  ): this {
    this.data.observations.push({
      id: id('obs'),
      product_id: product.id,
      chain_id: chainId,
      source_id: LICENSED.id,
      price_cents,
      unit_price_cents: null,
      unit_price_unit: null,
      promotion: null,
      promotion_valid_until: null,
      requires_loyalty: false,
      observed_at,
      ingested_at: observed_at ?? daysAgo(0),
      ...extra,
    });
    return this;
  }

  promo(product: Product, chainId: string, price_cents: number, promotion: Promotion, validUntil: string | null = inDays(3)): this {
    return this.price(product, chainId, price_cents, daysAgo(1), { promotion, promotion_valid_until: validUntil });
  }

  /** One linked, priced product per chain: shorthand for most tests. */
  simple(catalogId: string, chainId: string, price_cents: number, net_content: number, unit: BaseUnit, observed_at = daysAgo(1)): Product {
    const p = this.product({ ean: fakeEan(), net_content, net_content_unit: unit, name: `${catalogId} @${chainId}` });
    this.link(catalogId, chainId, p);
    this.price(p, chainId, price_cents, observed_at);
    return p;
  }

  override(catalogId: string, chainId: string, household_id = 'hh-1'): this {
    this.data.overrides.push({ household_id, catalog_item_id: catalogId, chain_id: chainId, created_by: null, created_at: daysAgo(0) });
    return this;
  }

  /** Gives `chainIds` coverage with an unrelated, fresh product so the comparison is "available". */
  cover(...chainIds: string[]): this {
    for (const c of chainIds) {
      const p = this.product({ ean: fakeEan(), net_content: 1, net_content_unit: 'stuk', name: `cover-${c}` });
      this.price(p, c, 100);
    }
    return this;
  }
}

let eanSeq = 0;
/** Valid GTIN-13s with prefix 200 (in-store/restricted range), unique per call. */
export function fakeEan(): string {
  const body = `200${(++eanSeq).toString().padStart(9, '0')}`;
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return body + ((10 - (sum % 10)) % 10).toString();
}

let itemSeq = 0;
export function item(name: string, quantity = 1, unit: Unit = 'stuk', excluded = false, listId?: string): BasketRequestItem {
  return {
    list_item_id: listId ?? `00000000-0000-4000-8000-${(++itemSeq).toString().padStart(12, '0')}`,
    name,
    normalized_name: name.toLowerCase().trim(),
    quantity,
    unit,
    excluded,
  };
}

export function input(items: BasketRequestItem[], data: PriceDataset, now = NOW): CompareInput {
  return { items, data, now, list_fingerprint: listFingerprint(items) };
}
